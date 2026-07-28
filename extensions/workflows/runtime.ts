import vm from "node:vm";
import type { Model } from "@earendil-works/pi-ai";
import { runChildAgent } from "./child.ts";
import { resolveModel, serializeModels } from "./models.ts";
import {
	aggregateUsage,
	type AgentOptions,
	type AgentState,
	type StepKind,
	type WorkflowController,
	type WorkflowRun,
	zeroUsage,
} from "./types.ts";

const MAX_AGENTS = 1_000;
const MAX_CONCURRENCY = 16;
const MAX_AGENT_OUTPUT = 50_000;
const MAX_FINAL_OUTPUT = 50_000;

class Scheduler {
	private active = 0;
	private paused = false;
	private stopped = false;
	private waiters: Array<() => void> = [];

	constructor(private readonly concurrency: number) {}

	async acquire(): Promise<boolean> {
		while (!this.stopped && (this.paused || this.active >= this.concurrency)) {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		if (this.stopped) return false;
		this.active++;
		return true;
	}

	release(): void {
		this.active = Math.max(0, this.active - 1);
		this.flush();
	}

	pause(): void { this.paused = true; }
	resume(): void { this.paused = false; this.flush(); }
	stop(): void { this.stopped = true; this.flush(); }
	private flush(): void { for (const resolve of this.waiters.splice(0)) resolve(); }
}

export interface RuntimeCallbacks {
	changed(event: string, agent?: AgentState): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export function validateWorkflowScript(source: string): string | undefined {
	try {
		new vm.Script(`(async () => {\n${source}\n})()`, { filename: "dynamic-workflow.js" });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function createWorkflowController(
	run: WorkflowRun,
	models: Model[],
	mainModel: Model | undefined,
	callbacks: RuntimeCallbacks,
): { controller: WorkflowController; execute: () => Promise<void> } {
	const scheduler = new Scheduler(Math.max(1, Math.min(run.spec.concurrency ?? 4, MAX_CONCURRENCY)));
	let phase = "Workflow";
	let sequence = 0;
	let stopped = false;

	const update = (event: string, agent?: AgentState) => {
		run.usage = aggregateUsage(run.agents);
		callbacks.changed(event, agent);
	};

	const controller: WorkflowController = {
		pause() {
			if (run.status !== "running") return;
			run.paused = true;
			run.status = "paused";
			scheduler.pause();
			update("paused");
		},
		resume() {
			if (run.status !== "paused") return;
			run.paused = false;
			run.status = "running";
			scheduler.resume();
			update("resumed");
		},
		stop() {
			if (!["queued", "running", "paused"].includes(run.status)) return;
			stopped = true;
			scheduler.stop();
			for (const agent of run.agents) {
				if (agent.status === "queued" || agent.status === "running") {
					agent.stopRequested = true;
					agent.process?.kill("SIGTERM");
					agent.status = "stopped";
				}
			}
			run.status = "stopped";
			run.finishedAt = Date.now();
			update("stopped");
		},
		stopAgent(id: string) {
			const agent = run.agents.find((candidate) => candidate.id === id);
			if (!agent || !["queued", "running"].includes(agent.status)) return;
			agent.stopRequested = true;
			agent.process?.kill("SIGTERM");
			agent.status = "stopped";
			agent.finishedAt = Date.now();
			update("agent_stopped", agent);
		},
		restartAgent(id: string) {
			const agent = run.agents.find((candidate) => candidate.id === id);
			if (!agent || agent.status !== "running") return;
			agent.restartRequested = true;
			agent.process?.kill("SIGTERM");
			update("agent_restarting", agent);
		},
	};

	const runAgent = async (prompt: unknown, options: AgentOptions = {}): Promise<string | null> => {
		if (stopped) return null;
		if (run.agents.length >= MAX_AGENTS) throw new Error(`Workflow agent limit exceeded (${MAX_AGENTS})`);
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent() requires a non-empty prompt string");
		const id = options.id ?? `agent_${++sequence}`;
		if (run.agents.some((agent) => agent.id === id)) throw new Error(`Duplicate agent id: ${id}`);
		const kind: StepKind = options.kind ?? "general";
		const agent: AgentState = {
			id,
			label: options.label ?? id,
			phase,
			prompt,
			kind,
			requestedModel: options.model,
			modelRationale: options.modelRationale,
			thinking: options.thinking,
			tools: options.tools,
			status: "queued",
			createdAt: Date.now(),
			flags: [],
			usage: zeroUsage(),
			toolCalls: [],
			attempt: 0,
		};
		run.agents.push(agent);
		if (!run.phases.includes(phase)) run.phases.push(phase);
		update("agent_queued", agent);
		if (!await scheduler.acquire()) { agent.status = "stopped"; return null; }
		try {
			while (!stopped && !agent.stopRequested) {
				const model = resolveModel(models, options.model, kind, mainModel);
				if (!model) {
					agent.status = "failed";
					agent.error = options.model ? `Requested model is unavailable: ${options.model}` : "No authenticated model is available";
					agent.finishedAt = Date.now();
					callbacks.notify(`${run.spec.name} / ${agent.label}: ${agent.error}`, "error");
					update("agent_failed", agent);
					return null;
				}
				agent.resolvedModel = `${model.provider}/${model.id}`;
				agent.status = "running";
				agent.startedAt ??= Date.now();
				agent.attempt++;
				agent.restartRequested = false;
				update("agent_started", agent);
				const result = await runChildAgent(run.cwd, agent, model, () => update("agent_progress", agent));
				agent.usage.input += result.usage.input;
				agent.usage.output += result.usage.output;
				agent.usage.cacheRead += result.usage.cacheRead;
				agent.usage.cacheWrite += result.usage.cacheWrite;
				agent.usage.cost += result.usage.cost;
				agent.usage.turns += result.usage.turns;
				if (agent.restartRequested) {
					agent.status = "queued";
					agent.error = undefined;
					agent.output = undefined;
					agent.flags = [];
					update("agent_restarted", agent);
					continue;
				}
				if (agent.stopRequested || stopped) { agent.status = "stopped"; agent.finishedAt = Date.now(); update("agent_stopped", agent); return null; }
				const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || !result.output;
				if (failed) {
					agent.status = "failed";
					agent.error = result.errorMessage || result.stderr.trim() || `Worker exited with code ${result.exitCode}`;
					agent.finishedAt = Date.now();
					callbacks.notify(`${run.spec.name} / ${agent.label} failed: ${agent.error.slice(0, 300)}`, "error");
					update("agent_failed", agent);
					return null;
				}
				agent.output = result.output.slice(0, MAX_AGENT_OUTPUT);
				agent.flags = result.output.split("\n").map((line) => line.match(/^\s*(?:WORKFLOW_FLAG|FLAG)\s*:\s*(.+)$/i)?.[1]?.trim()).filter((flag): flag is string => Boolean(flag));
				agent.status = agent.flags.length ? "flagged" : "completed";
				agent.finishedAt = Date.now();
				if (agent.flags.length) {
					run.flags.push(...agent.flags.map((flag) => `${agent.label}: ${flag}`));
					callbacks.notify(`${run.spec.name} / ${agent.label} flagged: ${agent.flags.join("; ")}`, "warning");
				}
				update(agent.flags.length ? "agent_flagged" : "agent_completed", agent);
				return agent.output;
			}
			return null;
		} finally {
			scheduler.release();
		}
	};

	const parallel = async (tasks: unknown[]): Promise<unknown[]> => {
		if (!Array.isArray(tasks)) throw new Error("parallel() requires an array");
		return Promise.all(tasks.map((task) => typeof task === "function" ? (task as () => unknown)() : task));
	};

	const pipeline = async (items: unknown[], ...stages: Array<(item: unknown, index: number) => unknown>): Promise<unknown[]> => {
		if (!Array.isArray(items)) throw new Error("pipeline() requires an array as its first argument");
		let current = items;
		for (const stage of stages) current = await Promise.all(current.map((item, index) => stage(item, index)));
		return current;
	};

	const execute = async (): Promise<void> => {
		run.status = "running";
		run.startedAt = Date.now();
		update("started");
		try {
			const context = vm.createContext({
				agent: runAgent,
				parallel,
				pipeline,
				phase(name: unknown) {
					if (typeof name !== "string" || !name.trim()) throw new Error("phase() requires a name");
					phase = name;
					run.currentPhase = name;
					if (!run.phases.includes(name)) run.phases.push(name);
					update("phase_started");
				},
				models: () => serializeModels(models),
				workflowPrompt: run.spec.prompt,
				log: (value: unknown) => update(`log:${String(value).slice(0, 200)}`),
				JSON,
			}, { codeGeneration: { strings: false, wasm: false } });
			const script = new vm.Script(`(async () => {\n${run.spec.script}\n})()`, { filename: `${run.spec.name}.workflow.js` });
			const value = await script.runInContext(context, { timeout: 1_000 });
			if (stopped) return;
			run.result = (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "(no result)").slice(0, MAX_FINAL_OUTPUT);
			run.finishedAt = Date.now();
			const failed = run.agents.filter((agent) => agent.status === "failed").length;
			run.status = run.flags.length || failed ? "completed_with_flags" : "completed";
			if (failed) run.flags.push(`${failed} subagent(s) failed`);
			update(run.status);
		} catch (error) {
			if (stopped) return;
			run.status = "failed";
			run.finishedAt = Date.now();
			run.error = error instanceof Error ? error.message : String(error);
			callbacks.notify(`Workflow failed: ${run.spec.name}: ${run.error}`, "error");
			update("failed");
		}
	};

	return { controller, execute };
}
