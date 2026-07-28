import type { ChildProcess } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";

export type StepKind = "research" | "discovery" | "planning" | "implementation" | "review" | "verification" | "synthesis" | "general";
export type ModelFamilyPolicy = "gpt" | "openai" | "claude";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RunStatus = "queued" | "running" | "paused" | "completed" | "completed_with_flags" | "failed" | "stopped";
export type AgentStatus = "queued" | "running" | "completed" | "flagged" | "failed" | "stopped";

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
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	inputCost: number;
	outputCost: number;
}

export interface AgentOptions {
	id?: string;
	label?: string;
	kind?: StepKind;
	model?: string;
	modelRationale?: string;
	thinking?: ThinkingLevel;
	tools?: string[] | string;
	profile?: string;
	writePaths?: string[];
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
	prompt: string;
	kind: StepKind;
	requestedModel?: string;
	modelRationale?: string;
	resolvedModel?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	profile?: string;
	writePaths?: string[];
	structuredOutput?: unknown;
	status: AgentStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	output?: string;
	error?: string;
	flags: string[];
	usage: UsageStats;
	toolCalls: Array<{ name: string; args?: unknown; error?: boolean }>;
	/** Complete assistant/tool messages emitted by all attempts. */
	messages: Message[];
	/** Bounded raw Pi JSON-mode stream, preserving reasoning and tool result events when emitted. */
	events: Array<{ at: number; attempt: number; event: unknown }>;
	logs: AgentLogEntry[];
	droppedLogEvents?: number;
	droppedEvents?: number;
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

export interface WorkflowSpec {
	name: string;
	why: string;
	goal: string;
	prompt: string;
	script: string;
	recipe?: string;
	modelFamily?: ModelFamilyPolicy;
	userModelInstruction?: string;
	concurrency?: number;
	background?: boolean;
	approval?: "prompt" | "skip";
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
	stop(): void;
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
