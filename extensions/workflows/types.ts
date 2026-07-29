import type { ChildProcess } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import type { OutputScanFinding } from "./output-scan.ts";

export type StepKind = "research" | "discovery" | "planning" | "implementation" | "review" | "verification" | "synthesis" | "general";
export type ModelFamily = string;
export type WorkflowProvider = "opencode-go" | "anthropic" | "openai" | "modelhub";
export type DefaultModelRouting = "inherit" | "auto";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkflowSize = "small" | "medium" | "large" | "unrestricted";
export type RunStatus = "queued" | "running" | "paused" | "completed" | "completed_with_flags" | "budget_exhausted" | "failed" | "stopped";
export type AgentStatus = "queued" | "running" | "completed" | "flagged" | "budget_exhausted" | "failed" | "stopped";
/** JSON Schema is copied as inert JSON data across the QuickJS boundary. */
export type JSONSchema = boolean | Record<string, unknown>;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface ModelChoice {
	provider: string;
	/** Canonical supported workflow provider; ModelHub key aliases collapse to `modelhub`. */
	providerGroup?: WorkflowProvider;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	inputCost: number;
	outputCost: number;
	family?: ModelFamily;
}

export interface WorkflowModelPolicy {
	/**
	 * Claude-compatible default is inherit. Auto is used only when the
	 * orchestrating model deliberately delegates omitted choices to the router.
	 */
	defaultRouting: DefaultModelRouting;
	/** Hard source/provider allowlist interpreted by the orchestrating model. */
	allowedProviders?: WorkflowProvider[];
	/** Hard underlying-family and exact-model allowlists. */
	allowedFamilies?: ModelFamily[];
	allowedModels?: string[];
	/** Human-readable explanation persisted for approval and auditing. */
	rationale: string;
}

export interface AgentOptions {
	id?: string;
	label?: string;
	/** Optional per-agent phase override; otherwise the current phase() value is used. */
	phase?: string;
	kind?: StepKind;
	model?: string;
	modelRationale?: string;
	thinking?: ThinkingLevel;
	/** Claude Workflow-compatible alias for thinking. */
	effort?: ThinkingLevel;
	tools?: string[] | string;
	profile?: string;
	writePaths?: string[];
	maxTurns?: number;
	/**
	 * When present, the worker must return one JSON value that validates against
	 * this schema. The parsed value (including arrays, scalars, and null when
	 * permitted by the schema) is returned to the workflow script.
	 */
	schema?: JSONSchema;
}

export interface AgentLogEntry {
	at: number;
	type: string;
	tool?: string;
	message?: string;
}

export interface WorkflowLogEntry {
	at: number;
	event: string;
	phase: string;
	status: RunStatus;
	agentId?: string;
	agentStatus?: AgentStatus;
}

export interface AgentState {
	id: string;
	label: string;
	phase: string;
	/** User-visible assignment only; profile/schema control instructions stay in the child system prompt. */
	prompt: string;
	kind: StepKind;
	requestedModel?: string;
	modelRationale?: string;
	resolvedModel?: string;
	reportedModel?: string;
	/** Explicit worker request; omitted means inherit the current session effort. */
	thinking?: ThinkingLevel;
	/** Pi-level effort after session inheritance and model capability clamping. */
	effectiveThinking?: ThinkingLevel;
	/** Provider/model-specific effort value after thinkingLevelMap translation. */
	providerThinking?: string;
	tools?: string[];
	profile?: string;
	writePaths?: string[];
	maxTurns?: number;
	schema?: JSONSchema;
	structuredOutput?: unknown;
	status: AgentStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Exact worker text. Sensitive: persisted for audit, never returned downstream. */
	rawOutput?: string;
	/** Scanned text representation safe for downstream prompts. */
	output?: string;
	scanFindings: OutputScanFinding[];
	invocationHash?: string;
	resultHash?: string;
	dependencies?: string[];
	cacheGeneration?: number;
	cached?: boolean;
	error?: string;
	flags: string[];
	usage: UsageStats;
	toolCalls: Array<{ name: string; args?: unknown; error?: boolean }>;
	/** Counts omitted after the bounded tool-call summary fills. */
	droppedToolCalls?: number;
	/** Legacy pre-v7 transcript fields. New runs keep these empty to avoid duplicating every Pi event/message. */
	messages?: Message[];
	events?: Array<{ at: number; attempt: number; event: unknown }>;
	/** Lightweight diagnostics retained instead of complete raw transcripts. */
	observedMessages?: number;
	observedEvents?: number;
	logs: AgentLogEntry[];
	droppedLogEvents?: number;
	droppedEvents?: number;
	/** Set on reload-only state when large values were clipped; disables unsafe cache reuse. */
	persistenceTruncated?: boolean;
	attempt: number;
	nextRetryAt?: number;
	/** Runtime-only fields are omitted by JSON persistence. */
	process?: ChildProcess;
	restartRequested?: boolean;
	stopRequested?: boolean;
}

export type PermissionMode = "manual" | "auto" | "read-only";

export interface PermissionRequest {
	agentId: string;
	agentLabel: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface WorkflowBudgets {
	maxAgents?: number;
	maxTokens?: number;
	maxCost?: number;
}

export interface WorkflowTurnPolicy {
	/** off: unlimited; custom: one user-owned limit for every worker; model: accept per-agent maxTurns. */
	mode: "off" | "custom" | "model";
	maxTurns?: number;
}

export interface WorkflowSpec {
	name: string;
	why: string;
	goal: string;
	prompt: string;
	/** Copied JSON arguments exposed to the orchestration script as global `args`. */
	args?: unknown;
	script: string;
	recipe?: string;
	modelPolicy: WorkflowModelPolicy;
	size?: WorkflowSize;
	budgets?: WorkflowBudgets;
	/** User-owned worker turn policy, applied after the orchestrator emits the script. */
	turnPolicy?: WorkflowTurnPolicy;
	concurrency?: number;
	background?: boolean;
	timeoutMs?: number;
	/** Retries after a failed child attempt. Defaults to 3. */
	maxRetries?: number;
	/** Initial exponential retry delay. Defaults to 1000ms. */
	retryBaseMs?: number;
}

export interface WorkflowRun {
	id: string;
	sessionId?: string;
	cwd: string;
	spec: WorkflowSpec;
	status: RunStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	currentPhase: string;
	phases: string[];
	agents: AgentState[];
	result?: string;
	/** Complete returned value for persistence; `result` may be presentation-truncated. */
	fullResult?: string;
	error?: string;
	flags: string[];
	usage: UsageStats;
	paused: boolean;
	logs: WorkflowLogEntry[];
	droppedLogEvents?: number;
	artifactPath?: string;
	scriptHash?: string;
	/** Agent IDs explicitly invalidated by a user restart before the next execution. */
	cacheInvalidations?: string[];
	budget?: {
		maxAgents: number;
		maxTokens?: number;
		maxCost?: number;
		projectedTokens: number;
		warnings: string[];
		exhausted?: string;
	};
}

export interface ChildResult {
	exitCode: number;
	output: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface WorkflowController {
	pause(): void;
	resume(): void;
	/** Stop current workers while retaining same-session resume/cache state. */
	stop(): void;
	/** Terminate current workers and mark the run terminal, without a normal resume path. */
	hardStop(): void;
	stopAgent(id: string): void;
	restartAgent(id: string): void;
}

export const zeroUsage = (): UsageStats => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

export function aggregateUsage(agents: AgentState[]): UsageStats {
	const total = zeroUsage();
	for (const agent of agents) {
		total.input += agent.usage.input;
		total.output += agent.usage.output;
		total.cacheRead += agent.usage.cacheRead;
		total.cacheWrite += agent.usage.cacheWrite;
		total.cost += agent.usage.cost;
		total.turns += agent.usage.turns;
	}
	return total;
}
