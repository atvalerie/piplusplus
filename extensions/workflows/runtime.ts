import vm from "node:vm";
import type { Model } from "@earendil-works/pi-ai";
import { runChildAgent } from "./child.ts";
import { resolveModel, serializeModels } from "./models.ts";
import { terminateProcessTree } from "./processes.ts";
import { applyWorkflowProfile, validateProfileOutput } from "./profiles.ts";
import { executeSandboxedWorkflow } from "./sandbox.ts";
import {
	aggregateUsage,
	type AgentOptions,
	type AgentState,
	type PermissionRequest,
	type StepKind,
	type WorkflowController,
	type WorkflowRun,
	zeroUsage,
} from "./types.ts";

const MAX_AGENTS = 1_000;
const MAX_CONCURRENCY = 16;
const MAX_FINAL_OUTPUT = 50_000;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export function normalizeWorkflowTools(value: unknown): string[] | undefined {
	if (value === undefined || value === null || value === "all") return undefined;
	if (value === "read-only") return [...READ_ONLY_TOOLS];
	if (typeof value === "string") return value.split(",").map((tool) => tool.trim()).filter(Boolean);
	if (Array.isArray(value) && value.every((tool) => typeof tool === "string")) return [...new Set(value.map((tool) => tool.trim()).filter(Boolean))];
	throw new Error("agent tools must be an array, comma-separated string, 'read-only', or 'all'");
}

class Scheduler {
	private active = 0;
	private paused = false;
	private stopped = false;
	private waiters: Array<() => void> = [];
	private readonly concurrency: number;

	constructor(concurrency: number) { this.concurrency = concurrency; }

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
	requestPermission(request: PermissionRequest): Promise<boolean>;
	requestApproval(title: string, detail: string): Promise<boolean>;
}

export function validateWorkflowScript(source: string): string | undefined {
	// Node vm is used only as a parser here; untrusted code is never executed in the host realm.
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
	let timedOut = false;
	const retryWaiters = new Map<string, () => void>();

	const waitForRetry = (agent: AgentState, delayMs: number) => new Promise<void>((resolve) => {
		const timer = setTimeout(finish, delayMs);
		function finish() { clearTimeout(timer); retryWaiters.delete(agent.id); resolve(); }
		retryWaiters.set(agent.id, finish);
	});

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
			for (const wake of retryWaiters.values()) wake();
			scheduler.stop();
			for (const agent of run.agents) {
				if (agent.status === "queued" || agent.status === "running") {
					agent.stopRequested = true;
					if (agent.process) terminateProcessTree(agent.process);
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
			retryWaiters.get(id)?.();
			if (agent.process) terminateProcessTree(agent.process);
			agent.status = "stopped";
			agent.finishedAt = Date.now();
			update("agent_stopped", agent);
		},
		restartAgent(id: string) {
			const agent = run.agents.find((candidate) => candidate.id === id);
			if (!agent || agent.status !== "running") return;
			agent.restartRequested = true;
			if (agent.process) terminateProcessTree(agent.process);
			update("agent_restarting", agent);
		},
	};

	const runAgent = async (prompt: unknown, options: AgentOptions = {}, requestedPhase = phase): Promise<string | null> => {
		if (stopped) return null;
		if (run.agents.length >= MAX_AGENTS) throw new Error(`Workflow agent limit exceeded (${MAX_AGENTS})`);
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent() requires a non-empty prompt string");
		const id = options.id ?? `agent_${++sequence}`;
		if (run.agents.some((agent) => agent.id === id)) throw new Error(`Duplicate agent id: ${id}`);
		const applied = applyWorkflowProfile(prompt, options.profile);
		const profile = applied.profile;
		const kind: StepKind = options.kind ?? profile?.kind ?? "general";
		const tools = normalizeWorkflowTools(options.tools ?? profile?.tools);
		const writePaths = options.writePaths === undefined ? undefined : Array.isArray(options.writePaths) && options.writePaths.every((item) => typeof item === "string") ? [...new Set(options.writePaths)] : (() => { throw new Error("writePaths must be an array of paths"); })();
		const agent: AgentState = {
			id,
			label: options.label ?? id,
			phase: requestedPhase,
			prompt: applied.prompt,
			kind,
			requestedModel: options.model,
			modelRationale: options.modelRationale,
			thinking: options.thinking,
			tools,
			profile: profile?.name,
			writePaths,
			status: "queued",
			createdAt: Date.now(),
			flags: [],
			usage: zeroUsage(),
			toolCalls: [],
			messages: [],
			events: [],
			logs: [],
			attempt: 0,
		};
		run.agents.push(agent);
		if (!run.phases.includes(requestedPhase)) run.phases.push(requestedPhase);
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
				const result = await runChildAgent(run.cwd, agent, model, () => update("agent_progress", agent), callbacks.requestPermission);
				if (agent.restartRequested) {
					agent.status = "queued";
					agent.error = undefined;
					agent.output = undefined;
					agent.flags = [];
					update("agent_restarted", agent);
					continue;
				}
				if (agent.stopRequested || stopped) { agent.status = "stopped"; agent.finishedAt = Date.now(); update("agent_stopped", agent); return null; }
				const validation = result.output ? validateProfileOutput(profile, result.output) : {};
				const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || !result.output || Boolean(validation.error);
				if (failed) {
					if (result.output) agent.output = result.output;
					const error = validation.error || result.errorMessage || result.stderr.trim() || `Worker exited with code ${result.exitCode}`;
					const maxRetries = Math.max(0, Math.min(10, run.spec.maxRetries ?? 3));
					if (agent.attempt <= maxRetries) {
						const base = Math.max(100, Math.min(60_000, run.spec.retryBaseMs ?? 1_000));
						const delay = Math.min(60_000, base * 2 ** (agent.attempt - 1));
						agent.status = "queued";
						agent.error = `${error} · retrying in ${(delay / 1_000).toFixed(delay < 1_000 ? 1 : 0)}s`;
						agent.nextRetryAt = Date.now() + delay;
						agent.logs.push({ at: Date.now(), type: "retry_scheduled", message: `attempt ${agent.attempt}/${maxRetries + 1}: ${error}` });
						update("agent_retry_scheduled", agent);
						await waitForRetry(agent, delay);
						agent.nextRetryAt = undefined;
						if (stopped || agent.stopRequested) continue;
						agent.error = undefined;
						continue;
					}
					agent.status = "failed";
					agent.error = error;
					agent.finishedAt = Date.now();
					callbacks.notify(`${run.spec.name} / ${agent.label} failed after ${agent.attempt} attempts: ${agent.error.slice(0, 300)}`, "error");
					update("agent_failed", agent);
					return null;
				}
				agent.output = result.output;
				agent.structuredOutput = validation.value;
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

	const execute = async (): Promise<void> => {
		run.status = "running";
		run.startedAt = Date.now();
		update("started");
		try {
			const value = await executeSandboxedWorkflow(run.spec.script, {
				agent: (prompt, options, agentPhase) => runAgent(prompt, (options ?? {}) as AgentOptions, agentPhase),
				approve: (title, detail) => callbacks.requestApproval(String(title), String(detail)),
				phase(name) {
					if (typeof name !== "string" || !name.trim()) throw new Error("phase() requires a name");
					phase = name;
					run.currentPhase = name;
					if (!run.phases.includes(name)) run.phases.push(name);
					update("phase_started");
				},
				models: serializeModels(models),
				workflowPrompt: run.spec.prompt,
				cwd: run.cwd,
				platform: process.platform,
				log: (value) => update(`log:${String(value).slice(0, 200)}`),
			}, {
				timeoutMs: run.spec.timeoutMs ?? 30 * 60_000,
				isAborted: () => stopped,
				onTimeout: () => {
					timedOut = true;
					stopped = true;
					for (const wake of retryWaiters.values()) wake();
					scheduler.stop();
					for (const agent of run.agents) {
						if (!["queued", "running"].includes(agent.status)) continue;
						agent.stopRequested = true;
						agent.status = "stopped";
						if (agent.process) terminateProcessTree(agent.process);
					}
				},
			});
			if (stopped) return;
			run.fullResult = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "(no result)";
			run.result = run.fullResult.slice(0, MAX_FINAL_OUTPUT);
			const resultFlags = run.fullResult.split("\n").map((line) => line.match(/^\s*(?:WORKFLOW_FLAG|FLAG)\s*:\s*(.+)$/i)?.[1]?.trim()).filter((flag): flag is string => Boolean(flag));
			for (const flag of resultFlags) if (!run.flags.includes(flag)) run.flags.push(flag);
			run.finishedAt = Date.now();
			const failed = run.agents.filter((agent) => agent.status === "failed").length;
			run.status = run.flags.length || failed ? "completed_with_flags" : "completed";
			if (failed) run.flags.push(`${failed} subagent(s) failed`);
			update(run.status);
		} catch (error) {
			if (stopped && !timedOut) return;
			run.status = "failed";
			run.finishedAt = Date.now();
			run.error = error instanceof Error ? error.message : String(error);
			callbacks.notify(`Workflow failed: ${run.spec.name}: ${run.error}`, "error");
			update(timedOut ? "timed_out" : "failed");
		}
	};

	return { controller, execute };
}
