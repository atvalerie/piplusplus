import vm from "node:vm";
import type { Model } from "@earendil-works/pi-ai";
import { stableWorkflowHash } from "./cache.ts";
import { runChildAgent } from "./child.ts";
import { filterSupportedWorkflowModels, modelAllowedByPolicy, reportedModelMatches, resolveModel, resolveWorkflowThinking, serializeModels } from "./models.ts";
import { scanWorkflowText, scanWorkflowValue } from "./output-scan.ts";
import { terminateProcessTree } from "./processes.ts";
import { applyWorkflowProfile, normalizeJSONSchema, validateStructuredOutput } from "./profiles.ts";
import { executeSandboxedWorkflow } from "./sandbox.ts";
import {
	aggregateUsage,
	type AgentOptions,
	type AgentState,
	type PermissionRequest,
	type StepKind,
	type UsageStats,
	type WorkflowController,
	type WorkflowRun,
	type WorkflowSize,
	zeroUsage,
} from "./types.ts";

const MAX_AGENTS = 1_000;
const MAX_CONCURRENCY = 16;
const MAX_FINAL_OUTPUT = 50_000;
const LARGE_AGENT_WARNING = 25;
const LARGE_TOKEN_WARNING = 1_500_000;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const WORKFLOW_SIZE_AGENT_GUIDANCE = { small: 4, medium: 14, large: 49, unrestricted: MAX_AGENTS } as const;

export function workflowUsageTokens(usage: UsageStats): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function workflowBudgetWarnings(size: WorkflowSize | undefined, scheduledAgents: number, projectedTokens: number): string[] {
	const warnings: string[] = [];
	if (scheduledAgents > LARGE_AGENT_WARNING) warnings.push("Large workflow: scheduled agent count exceeded the 25-agent caution threshold.");
	if (projectedTokens > LARGE_TOKEN_WARNING) warnings.push("Large workflow: projected output capacity exceeded the 1.5M-token caution threshold.");
	if (size && scheduledAgents > WORKFLOW_SIZE_AGENT_GUIDANCE[size]) {
		warnings.push(`Declared size '${size}' guides workflows to at most ${WORKFLOW_SIZE_AGENT_GUIDANCE[size]} agents, but the workflow exceeded that guidance.`);
	}
	return warnings;
}

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
	dependencies: { runChildAgent?: typeof runChildAgent; sessionThinking?: import("./types.ts").ThinkingLevel } = {},
): { controller: WorkflowController; execute: () => Promise<void> } {
	const modelPolicy = run.spec.modelPolicy;
	if (run.spec.budgets?.maxAgents !== undefined && (!Number.isInteger(run.spec.budgets.maxAgents) || run.spec.budgets.maxAgents < 1 || run.spec.budgets.maxAgents > MAX_AGENTS)) {
		throw new Error(`budgets.maxAgents must be an integer from 1 to ${MAX_AGENTS}`);
	}
	if (run.spec.budgets?.maxTokens !== undefined && (!Number.isInteger(run.spec.budgets.maxTokens) || run.spec.budgets.maxTokens < 1)) {
		throw new Error("budgets.maxTokens must be a positive integer");
	}
	if (run.spec.budgets?.maxCost !== undefined && (!Number.isFinite(run.spec.budgets.maxCost) || run.spec.budgets.maxCost <= 0)) {
		throw new Error("budgets.maxCost must be a positive finite number");
	}
	const turnPolicy = run.spec.turnPolicy ?? { mode: "off" as const };
	if (!["off", "custom", "model"].includes(turnPolicy.mode)) throw new Error("turnPolicy.mode must be off, custom, or model");
	if (turnPolicy.mode === "custom" && (!Number.isInteger(turnPolicy.maxTurns) || Number(turnPolicy.maxTurns) < 1 || Number(turnPolicy.maxTurns) > 1_000)) {
		throw new Error("turnPolicy.maxTurns must be an integer from 1 to 1000 in custom mode");
	}
	const supportedModels = filterSupportedWorkflowModels(models);
	const eligibleModels = supportedModels.filter((model) => modelAllowedByPolicy(model, modelPolicy));
	const eligibleMainModel = mainModel
		&& filterSupportedWorkflowModels([mainModel]).length > 0
		&& modelAllowedByPolicy(mainModel, modelPolicy)
		? mainModel
		: undefined;
	const scheduler = new Scheduler(Math.max(1, Math.min(run.spec.concurrency ?? 4, MAX_CONCURRENCY)));
	const priorAgents = new Map(run.agents.map((agent) => [agent.id, agent]));
	const scriptHash = stableWorkflowHash(run.spec.script);
	const pendingInvalidations = new Set(run.cacheInvalidations ?? []);
	const completedResults = new Map<string, { resultHash: string; generation: number }>();
	const scheduledAgentIds = new Set(priorAgents.keys());
	const configuredMaxAgents = Math.max(1, Math.min(MAX_AGENTS, run.spec.budgets?.maxAgents ?? MAX_AGENTS));
	const configuredMaxTokens = run.spec.budgets?.maxTokens;
	const configuredMaxCost = run.spec.budgets?.maxCost;
	let phase = "Workflow";
	let sequence = 0;
	let stopped = false;
	let timedOut = false;
	let budgetStopsScheduling = false;
	const childRunner = dependencies.runChildAgent ?? runChildAgent;
	const retryWaiters = new Map<string, () => void>();

	run.budget = {
		maxAgents: configuredMaxAgents,
		maxTokens: configuredMaxTokens,
		maxCost: configuredMaxCost,
		projectedTokens: 0,
		warnings: [],
	};

	const waitForRetry = (agent: AgentState, delayMs: number) => new Promise<void>((resolve) => {
		const timer = setTimeout(finish, delayMs);
		function finish() { clearTimeout(timer); retryWaiters.delete(agent.id); resolve(); }
		retryWaiters.set(agent.id, finish);
	});

	const markBudgetExhausted = (reason: string) => {
		if (run.budget?.exhausted) return;
		run.budget!.exhausted = reason;
		budgetStopsScheduling = true;
		scheduler.stop();
		callbacks.notify(`${run.spec.name}: ${reason}. Already-running agents may finish; no new agents will start.`, "warning");
	};

	const refreshBudgetWarnings = () => {
		for (const warning of workflowBudgetWarnings(run.spec.size, scheduledAgentIds.size, run.budget?.projectedTokens ?? 0)) {
			if (run.budget!.warnings.includes(warning)) continue;
			run.budget!.warnings.push(warning);
			callbacks.notify(`${run.spec.name}: ${warning}`, "warning");
		}
	};

	const refreshHardBudgets = () => {
		if (stopped || run.budget?.exhausted) return;
		const consumedTokens = workflowUsageTokens(run.usage);
		if (configuredMaxTokens !== undefined && consumedTokens >= configuredMaxTokens) {
			markBudgetExhausted(`Token budget exhausted (${consumedTokens}/${configuredMaxTokens})`);
		} else if (configuredMaxCost !== undefined && run.usage.cost >= configuredMaxCost) {
			markBudgetExhausted(`Cost budget exhausted ($${run.usage.cost.toFixed(4)}/$${configuredMaxCost.toFixed(4)})`);
		}
	};

	const update = (event: string, agent?: AgentState) => {
		run.usage = aggregateUsage(run.agents);
		refreshHardBudgets();
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
		hardStop() {
			if (!["queued", "running", "paused"].includes(run.status)) return;
			stopped = true;
			for (const wake of retryWaiters.values()) wake();
			scheduler.stop();
			for (const agent of run.agents) {
				if (agent.status === "queued" || agent.status === "running") {
					agent.stopRequested = true;
					if (agent.process) terminateProcessTree(agent.process);
					agent.status = "stopped";
					agent.finishedAt = Date.now();
				}
			}
			run.status = "failed";
			run.error = "Workflow was hard-stopped by the user and is not resumable without an explicit agent restart.";
			run.finishedAt = Date.now();
			update("hard_stopped");
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
			if (!agent) return;
			if (agent.status === "running") {
				agent.restartRequested = true;
				if (agent.process) terminateProcessTree(agent.process);
				update("agent_restarting", agent);
				return;
			}
			if (["completed", "flagged", "failed", "stopped"].includes(agent.status)) {
				pendingInvalidations.add(id);
				run.cacheInvalidations = [...pendingInvalidations];
				agent.cached = false;
				agent.logs.push({ at: Date.now(), type: "cache_invalidated", message: "Explicit restart requested; this agent and downstream dependencies will run live on resume." });
				update("agent_cache_invalidated", agent);
			}
		},
	};

	const runAgent = async (prompt: unknown, options: AgentOptions = {}, requestedPhase = phase): Promise<unknown> => {
		if (stopped) return null;
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent() requires a non-empty prompt string");
		if (options.phase !== undefined) {
			if (typeof options.phase !== "string" || !options.phase.trim()) throw new Error("agent phase must be a non-empty string");
			requestedPhase = options.phase.trim();
		}
		const requestedThinking = options.thinking ?? options.effort;
		if (requestedThinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(requestedThinking)) {
			throw new Error("agent thinking/effort must be off, minimal, low, medium, high, xhigh, or max");
		}
		const id = options.id ?? `agent_${++sequence}`;
		if (run.agents.some((agent) => agent.id === id)) throw new Error(`Duplicate agent id: ${id}`);
		const proposedMaxTurns = options.maxTurns;
		const maxTurns = turnPolicy.mode === "off"
			? undefined
			: turnPolicy.mode === "custom"
				? turnPolicy.maxTurns
				: proposedMaxTurns === undefined
					? undefined
					: Number.isInteger(proposedMaxTurns) && proposedMaxTurns >= 1 && proposedMaxTurns <= 1_000
						? proposedMaxTurns
						: (() => { throw new Error("maxTurns must be an integer from 1 to 1000"); })();
		if (!scheduledAgentIds.has(id)) {
			if (scheduledAgentIds.size >= configuredMaxAgents) {
				markBudgetExhausted(`Agent budget exhausted (${scheduledAgentIds.size}/${configuredMaxAgents})`);
				update("budget_exhausted");
				return null;
			}
			scheduledAgentIds.add(id);
			refreshBudgetWarnings();
		}
		const applied = applyWorkflowProfile(prompt, options.profile);
		const profile = applied.profile;
		const schema = normalizeJSONSchema(options.schema) ?? profile?.schema;
		const workerPrompt = applied.prompt;
		const kind: StepKind = options.kind ?? profile?.kind ?? "general";
		const tools = normalizeWorkflowTools(options.tools ?? profile?.tools);
		const writePaths = options.writePaths === undefined ? undefined : Array.isArray(options.writePaths) && options.writePaths.every((item) => typeof item === "string") ? [...new Set(options.writePaths)] : (() => { throw new Error("writePaths must be an array of paths"); })();
		const requestedModel = options.model;
		const fixedRouting = requestedModel === "inherit"
			|| (requestedModel === undefined && modelPolicy.defaultRouting === "inherit")
			|| Boolean(requestedModel && requestedModel !== "auto");
		const fixedCandidate = fixedRouting
			? resolveModel(supportedModels, requestedModel, kind, mainModel, modelPolicy.defaultRouting)
			: undefined;
		const model = resolveModel(eligibleModels, requestedModel, kind, eligibleMainModel, modelPolicy.defaultRouting);
		const inheritedThinking = requestedThinking ?? dependencies.sessionThinking ?? "medium";
		const resolvedThinking = model ? resolveWorkflowThinking(model, inheritedThinking) : undefined;
		const dependencySnapshot = [...completedResults.entries()]
			.map(([dependencyId, value]) => ({ id: dependencyId, ...value }))
			.sort((left, right) => left.id.localeCompare(right.id));
		const invocationHash = stableWorkflowHash({
			scriptHash,
			id,
			label: options.label ?? id,
			phase: requestedPhase,
			prompt: workerPrompt,
			kind,
			requestedModel,
			resolvedModel: model ? `${model.provider}/${model.id}` : undefined,
			modelRationale: options.modelRationale,
			requestedThinking,
			effectiveThinking: resolvedThinking?.effective,
			providerThinking: resolvedThinking?.provider,
			tools,
			profile: profile?.name,
			profileInstruction: profile?.instruction,
			writePaths,
			maxTurns,
			schema,
			modelPolicy,
			workflowArgs: run.spec.args,
			dependencies: dependencySnapshot,
		});
		const prior = priorAgents.get(id);
		const reusable = Boolean(
			prior
			&& ["completed", "flagged"].includes(prior.status)
			&& prior.invocationHash === invocationHash
			&& prior.resultHash
			&& !pendingInvalidations.has(id)
			&& model,
		);
		if (reusable && prior) {
			Object.assign(prior, {
				label: options.label ?? id,
				phase: requestedPhase,
				prompt: workerPrompt,
				kind,
				requestedModel,
				resolvedModel: model ? `${model.provider}/${model.id}` : prior.resolvedModel,
				modelRationale: options.modelRationale,
				thinking: requestedThinking,
				effectiveThinking: resolvedThinking?.effective,
				providerThinking: resolvedThinking?.provider,
				tools,
				profile: profile?.name,
				writePaths,
				maxTurns,
				schema,
				dependencies: dependencySnapshot.map((dependency) => dependency.id),
				cached: true,
				stopRequested: false,
				restartRequested: false,
			});
			run.agents.push(prior);
			if (!run.phases.includes(requestedPhase)) run.phases.push(requestedPhase);
			completedResults.set(id, { resultHash: prior.resultHash!, generation: prior.cacheGeneration ?? 0 });
			for (const flag of prior.flags) {
				const labeled = `${prior.label}: ${flag}`;
				if (!run.flags.includes(labeled)) run.flags.push(labeled);
			}
			update("agent_cached", prior);
			return schema !== undefined ? prior.structuredOutput : prior.output;
		}
		const generation = prior ? (prior.cacheGeneration ?? 0) + 1 : 0;
		const agent: AgentState = {
			id,
			label: options.label ?? id,
			phase: requestedPhase,
			prompt: workerPrompt,
			kind,
			requestedModel: options.model,
			modelRationale: options.modelRationale,
			thinking: requestedThinking,
			effectiveThinking: resolvedThinking?.effective,
			providerThinking: resolvedThinking?.provider,
			tools,
			profile: profile?.name,
			writePaths,
			maxTurns,
			schema,
			invocationHash,
			dependencies: dependencySnapshot.map((dependency) => dependency.id),
			cacheGeneration: generation,
			cached: false,
			status: "queued",
			createdAt: prior?.createdAt ?? Date.now(),
			flags: [],
			usage: prior ? { ...prior.usage } : zeroUsage(),
			toolCalls: prior ? [...prior.toolCalls] : [],
			droppedToolCalls: prior?.droppedToolCalls,
			messages: [],
			events: [],
			observedMessages: prior?.observedMessages,
			observedEvents: prior?.observedEvents,
			logs: prior ? [...prior.logs] : [],
			scanFindings: [],
			droppedLogEvents: prior?.droppedLogEvents,
			droppedEvents: prior?.droppedEvents,
			attempt: prior?.attempt ?? 0,
		};
		if (prior) agent.logs.push({
			at: Date.now(),
			type: pendingInvalidations.has(id) ? "cache_invalidated" : "cache_miss",
			message: pendingInvalidations.has(id) ? "Explicit restart invalidated the cached result." : "Invocation changed or the prior attempt was not reusable; running live.",
		});
		pendingInvalidations.delete(id);
		run.cacheInvalidations = [...pendingInvalidations];
		run.agents.push(agent);
		if (!run.phases.includes(requestedPhase)) run.phases.push(requestedPhase);
		update("agent_queued", agent);
		if (fixedCandidate && !modelAllowedByPolicy(fixedCandidate, modelPolicy)) {
			agent.status = "failed";
			agent.error = `Model policy violation: ${fixedCandidate.provider}/${fixedCandidate.id} is outside the workflow allowlist`;
			agent.logs.push({ at: Date.now(), type: "model_policy_denied", message: agent.error });
			agent.finishedAt = Date.now();
			callbacks.notify(`${run.spec.name} / ${agent.label}: ${agent.error}`, "error");
			update("agent_failed", agent);
			return null;
		}
		if (!model) {
			agent.status = "failed";
			agent.error = !eligibleModels.length
				? "No authenticated model satisfies the workflow model policy; fallback outside the allowlist is forbidden"
				: requestedModel && requestedModel !== "inherit"
					? `Requested model is unavailable within the workflow policy: ${requestedModel}`
					: "The inherited session model is unavailable within the workflow policy; the orchestrator must route an eligible model explicitly or choose auto";
			agent.finishedAt = Date.now();
			callbacks.notify(`${run.spec.name} / ${agent.label}: ${agent.error}`, "error");
			update("agent_failed", agent);
			return null;
		}
		agent.resolvedModel = `${model.provider}/${model.id}`;
		run.budget!.projectedTokens += Math.max(0, model.maxTokens ?? 0);
		refreshBudgetWarnings();
		if (budgetStopsScheduling) {
			agent.status = "budget_exhausted";
			agent.error = run.budget?.exhausted ?? "Workflow budget exhausted";
			agent.finishedAt = Date.now();
			update("agent_budget_exhausted", agent);
			return null;
		}
		if (!await scheduler.acquire()) {
			agent.status = budgetStopsScheduling ? "budget_exhausted" : "stopped";
			agent.error = budgetStopsScheduling ? run.budget?.exhausted : agent.error;
			agent.finishedAt = Date.now();
			update(budgetStopsScheduling ? "agent_budget_exhausted" : "agent_stopped", agent);
			return null;
		}
		try {
			while (!stopped && !agent.stopRequested) {
				agent.status = "running";
				agent.startedAt ??= Date.now();
				agent.attempt++;
				agent.restartRequested = false;
				update("agent_started", agent);
				const result = await childRunner(run.cwd, agent, model, () => update("agent_progress", agent), callbacks.requestPermission);
				agent.reportedModel = result.model;
				agent.rawOutput = result.output || undefined;
				update("agent_progress", agent);
				if (agent.restartRequested) {
					if (budgetStopsScheduling) {
						agent.status = "budget_exhausted";
						agent.error = run.budget?.exhausted ?? "Workflow budget exhausted";
						agent.finishedAt = Date.now();
						update("agent_budget_exhausted", agent);
						return null;
					}
					agent.status = "queued";
					agent.error = undefined;
					agent.output = undefined;
					agent.structuredOutput = undefined;
					agent.rawOutput = undefined;
					agent.scanFindings = [];
					agent.resultHash = undefined;
					agent.cacheGeneration = (agent.cacheGeneration ?? 0) + 1;
					agent.flags = [];
					update("agent_restarted", agent);
					continue;
				}
				if (agent.stopRequested || stopped) { agent.status = "stopped"; agent.finishedAt = Date.now(); update("agent_stopped", agent); return null; }
				if (result.stopReason === "max_turns") {
					if (result.output) {
						const scanned = scanWorkflowText(result.output);
						agent.output = scanned.value;
						agent.scanFindings = scanned.findings;
					}
					agent.status = "budget_exhausted";
					agent.error = result.errorMessage ?? `Worker reached maxTurns (${agent.maxTurns}) before completing`;
					agent.finishedAt = Date.now();
					agent.logs.push({ at: Date.now(), type: "budget_exhausted", message: agent.error });
					markBudgetExhausted(`${agent.label}: ${agent.error}`);
					update("agent_budget_exhausted", agent);
					return null;
				}
				const validation = result.output ? validateStructuredOutput(schema, result.output) : { structured: schema !== undefined };
				const modelMismatch = Boolean(result.output) && !reportedModelMatches(model, result.model);
				if (modelMismatch) agent.logs.push({
					at: Date.now(),
					type: "model_identity_mismatch",
					message: `Requested ${model.provider}/${model.id}, child reported ${result.model ?? "(none)"}`,
				});
				const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || !result.output || Boolean(validation.error) || modelMismatch;
				if (failed) {
					if (result.output) {
						const scanned = scanWorkflowText(result.output);
						agent.output = scanned.value;
						agent.scanFindings = scanned.findings;
					}
					const error = modelMismatch
						? `Model identity mismatch: requested ${model.provider}/${model.id}, child reported ${result.model ?? "(none)"}`
						: validation.error || result.errorMessage || result.stderr.trim() || `Worker exited with code ${result.exitCode}`;
					const deterministicChildFailure = /Workflow worker output exceeded|oversized NDJSON line/i.test(error);
					const maxRetries = modelMismatch || validation.schemaError || budgetStopsScheduling || deterministicChildFailure ? 0 : Math.max(0, Math.min(10, run.spec.maxRetries ?? 3));
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
				const scanned = validation.structured ? scanWorkflowValue(validation.value) : scanWorkflowText(result.output);
				agent.scanFindings = scanned.findings;
				agent.structuredOutput = validation.structured ? scanned.value : undefined;
				agent.output = validation.structured ? JSON.stringify(scanned.value) : scanned.value as string;
				agent.resultHash = stableWorkflowHash(validation.structured ? agent.structuredOutput : agent.output);
				completedResults.set(agent.id, { resultHash: agent.resultHash, generation: agent.cacheGeneration ?? 0 });
				if (agent.scanFindings.length) agent.logs.push({ at: Date.now(), type: "output_scanned", message: `${agent.scanFindings.length} untrusted output pattern(s) escaped or marked` });
				agent.flags = agent.output.split("\n").map((line) => line.match(/^\s*(?:WORKFLOW_FLAG|FLAG)\s*:\s*(.+)$/i)?.[1]?.trim()).filter((flag): flag is string => Boolean(flag));
				agent.status = agent.flags.length ? "flagged" : "completed";
				agent.finishedAt = Date.now();
				if (agent.flags.length) {
					run.flags.push(...agent.flags.map((flag) => `${agent.label}: ${flag}`));
					callbacks.notify(`${run.spec.name} / ${agent.label} flagged: ${agent.flags.join("; ")}`, "warning");
				}
				update(agent.flags.length ? "agent_flagged" : "agent_completed", agent);
				return validation.structured ? agent.structuredOutput : agent.output;
			}
			return null;
		} finally {
			scheduler.release();
		}
	};

	const partialBudgetResult = (): string => JSON.stringify({
		status: "budget_exhausted",
		reason: run.budget?.exhausted ?? "Workflow budget exhausted",
		partialResults: Object.fromEntries(run.agents
			.filter((agent) => ["completed", "flagged"].includes(agent.status))
			.map((agent) => [agent.id, agent.structuredOutput !== undefined ? agent.structuredOutput : agent.output])),
	}, null, 2);

	const finalizeBudgetExhaustion = (value?: unknown, scriptError?: string) => {
		const serialized = value === undefined || value === null
			? partialBudgetResult()
			: typeof value === "string"
				? value
				: JSON.stringify(value, null, 2) ?? partialBudgetResult();
		run.fullResult = serialized;
		run.result = serialized.slice(0, MAX_FINAL_OUTPUT);
		run.status = "budget_exhausted";
		run.finishedAt = Date.now();
		const reason = run.budget?.exhausted ?? "Workflow budget exhausted";
		run.error = scriptError ? `${reason}. Script stopped with: ${scriptError}` : reason;
		const flag = `Budget exhausted: ${reason}`;
		if (!run.flags.includes(flag)) run.flags.push(flag);
		update("budget_exhausted");
	};

	const execute = async (): Promise<void> => {
		if (priorAgents.size) {
			run.agents = [];
			run.phases = [];
			run.flags = [];
			run.result = undefined;
			run.fullResult = undefined;
			run.error = undefined;
			run.finishedAt = undefined;
			run.currentPhase = "Workflow";
		}
		run.scriptHash = scriptHash;
		run.cacheInvalidations = [...pendingInvalidations];
		run.paused = false;
		run.status = "running";
		run.startedAt ??= Date.now();
		refreshBudgetWarnings();
		update(priorAgents.size ? "resumed_execution" : "started");
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
				models: serializeModels(supportedModels),
				args: run.spec.args,
				workflowPrompt: run.spec.prompt,
				cwd: run.cwd,
				platform: process.platform,
				log: (value) => update(`log:${String(value).slice(0, 200)}`),
			}, {
				timeoutMs: run.spec.timeoutMs ?? 30 * 60_000,
				isAborted: () => stopped,
				onTimeout: () => {
					timedOut = true;
					markBudgetExhausted(`Wall-clock deadline exhausted (${run.spec.timeoutMs ?? 30 * 60_000}ms)`);
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
			if (stopped) {
				if (timedOut) finalizeBudgetExhaustion(value);
				return;
			}
			if (run.budget?.exhausted) {
				finalizeBudgetExhaustion(value);
				return;
			}
			run.fullResult = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "(no result)";
			run.result = run.fullResult.slice(0, MAX_FINAL_OUTPUT);
			const resultFlags = run.fullResult.split("\n").map((line) => line.match(/^\s*(?:WORKFLOW_FLAG|FLAG)\s*:\s*(.+)$/i)?.[1]?.trim()).filter((flag): flag is string => Boolean(flag));
			for (const flag of resultFlags) if (!run.flags.includes(flag)) run.flags.push(flag);
			run.finishedAt = Date.now();
			const failed = run.agents.filter((agent) => agent.status === "failed").length;
			run.status = run.flags.length || failed ? "completed_with_flags" : "completed";
			if (failed) run.flags.push(`${failed} subagent(s) failed`);
			run.cacheInvalidations = [];
			update(run.status);
		} catch (error) {
			if (stopped && !timedOut) return;
			const message = error instanceof Error ? error.message : String(error);
			if (run.budget?.exhausted || timedOut) {
				finalizeBudgetExhaustion(undefined, message);
				return;
			}
			run.status = "failed";
			run.finishedAt = Date.now();
			run.error = message;
			callbacks.notify(`Workflow failed: ${run.spec.name}: ${run.error}`, "error");
			update(timedOut ? "timed_out" : "failed");
		}
	};

	return { controller, execute };
}
