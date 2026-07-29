import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentLogEntry, AgentState, WorkflowLogEntry, WorkflowRun } from "./types.ts";

const ARTIFACT_INLINE_TEXT_BYTES = 64 * 1024;
const ARTIFACT_AGENT_TEXT_BUDGET = 512 * 1024;
const PERSISTED_STATE_TEXT_BYTES = 128 * 1024;
const PERSISTED_STATE_TEXT_BUDGET = 2 * 1024 * 1024;
const ARTIFACT_AGENT_LOGS = 100;
const ARTIFACT_TOTAL_AGENT_LOGS = 2_000;
const ARTIFACT_RUN_LOGS = 2_000;
const ARTIFACT_TOOL_CALLS = 100;
const ARTIFACT_TOTAL_TOOL_CALLS = 1_000;

type ArtifactText = { text?: string; storage?: { bytes: number; sha256: string; truncated: boolean; ref?: string } };
const agentTextCache = new WeakMap<AgentState, Map<string, { directory: string; value: string | undefined; maxBytes: number; result: ArtifactText }>>();

function budgetDenominator(count: number): number {
	return 2 ** Math.ceil(Math.log2(Math.max(1, count)));
}

function verificationLike(value: string): boolean {
	return /(?:^|[\s_-])(verify|verification|verified|critic|critique|review)(?:$|[\s_-])/i.test(value);
}

/** A verification section counts only when at least one worker actually ran in it. */
export function hasVerificationSection(run: WorkflowRun): boolean {
	return run.agents.some((agent) => agent.startedAt !== undefined && (agent.kind === "verification" || verificationLike(agent.phase)));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** Clip without retaining a second giant encoded string or ending on a partial UTF-8 sequence. */
export function clipWorkflowText(value: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
	const bytes = utf8Bytes(value);
	if (bytes <= maxBytes) return { text: value, bytes, truncated: false };
	const clipped = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
	return { text: `${clipped}\n\n[truncated]`, bytes, truncated: true };
}

function compactJson(value: unknown, maxBytes = ARTIFACT_INLINE_TEXT_BYTES): unknown {
	if (value === undefined) return undefined;
	let json: string;
	try { json = JSON.stringify(value); }
	catch { return { unavailable: true, reason: "Value could not be serialized." }; }
	const clipped = clipWorkflowText(json, maxBytes);
	if (!clipped.truncated) return value;
	return { truncated: true, bytes: clipped.bytes, sha256: sha256(json), preview: clipped.text };
}

function boundedEntries<T>(items: T[] | undefined, maximum: number): { entries: T[]; omitted: number } {
	if (!items?.length) return { entries: [], omitted: 0 };
	if (items.length <= maximum) return { entries: items, omitted: 0 };
	// Keep process/setup context and the most recent diagnostic evidence.
	return { entries: [items[0], ...items.slice(-(maximum - 1))], omitted: items.length - maximum };
}

function compactAgentLogs(logs: AgentLogEntry[] | undefined, maximum: number): { entries: AgentLogEntry[]; omitted: number } {
	const bounded = boundedEntries(logs, maximum);
	return {
		entries: bounded.entries.map((entry) => ({
			...entry,
			message: entry.message === undefined ? undefined : clipWorkflowText(entry.message, 512).text,
		})),
		omitted: bounded.omitted,
	};
}

function compactRunLogs(logs: WorkflowLogEntry[] | undefined): { entries: WorkflowLogEntry[]; omitted: number } {
	return boundedEntries(logs, ARTIFACT_RUN_LOGS);
}

function safePayloadName(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
	return safe || "payload";
}

async function storeLargePayload(directory: string, runId: string, value: string): Promise<string> {
	const payloadDirectory = path.join(directory, `${safePayloadName(runId)}.data`);
	await fs.promises.mkdir(payloadDirectory, { recursive: true, mode: 0o700 });
	const digest = sha256(value);
	const target = path.join(payloadDirectory, `${digest}.txt`);
	try {
		await fs.promises.access(target, fs.constants.F_OK);
		return target;
	} catch { /* immutable content-addressed payload does not exist yet */ }
	const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await fs.promises.writeFile(temp, value, { mode: 0o600, flag: "wx" });
		try { await fs.promises.rename(temp, target); }
		catch (error) {
			if (!fs.existsSync(target)) throw error;
		}
		try { await fs.promises.chmod(target, 0o600); } catch { /* best effort */ }
	} finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
	return target;
}

async function artifactText(
	directory: string,
	runId: string,
	value: string | undefined,
	maxBytes = ARTIFACT_INLINE_TEXT_BYTES,
): Promise<ArtifactText> {
	if (value === undefined) return {};
	const clipped = clipWorkflowText(value, maxBytes);
	const storage = { bytes: clipped.bytes, sha256: sha256(value), truncated: clipped.truncated } as { bytes: number; sha256: string; truncated: boolean; ref?: string };
	if (clipped.truncated) storage.ref = await storeLargePayload(directory, runId, value);
	return { text: clipped.text, storage };
}

async function cachedAgentText(directory: string, runId: string, agent: AgentState, key: string, value: string | undefined, maxBytes: number): Promise<ArtifactText> {
	let cache = agentTextCache.get(agent);
	if (!cache) {
		cache = new Map();
		agentTextCache.set(agent, cache);
	}
	const prior = cache.get(key);
	if (prior && prior.directory === directory && prior.value === value && prior.maxBytes === maxBytes) return prior.result;
	const result = await artifactText(directory, runId, value, maxBytes);
	cache.set(key, { directory, value, maxBytes, result });
	return result;
}

/**
 * Build the small reload/UI state. Full results and raw Pi transcripts are not
 * required for same-process resume, and unsafe partial cache hits are disabled
 * when a value had to be clipped for disk persistence.
 */
export function workflowRunForPersistence(run: WorkflowRun): WorkflowRun {
	const perAgentTextBytes = Math.max(1_024, Math.min(PERSISTED_STATE_TEXT_BYTES, Math.floor(PERSISTED_STATE_TEXT_BUDGET / budgetDenominator(run.agents.length))));
	return {
		...run,
		fullResult: undefined,
		result: run.result === undefined ? undefined : clipWorkflowText(run.result, PERSISTED_STATE_TEXT_BYTES).text,
		agents: run.agents.map((agent) => {
			const prompt = clipWorkflowText(agent.prompt, perAgentTextBytes);
			const output = agent.output === undefined ? undefined : clipWorkflowText(agent.output, perAgentTextBytes);
			let structuredOutput = agent.structuredOutput;
			let structuredTruncated = false;
			if (structuredOutput !== undefined) {
				try {
					if (utf8Bytes(JSON.stringify(structuredOutput)) > perAgentTextBytes) {
						structuredOutput = undefined;
						structuredTruncated = true;
					}
				} catch {
					structuredOutput = undefined;
					structuredTruncated = true;
				}
			}
			const persistenceTruncated = prompt.truncated || Boolean(output?.truncated) || structuredTruncated;
			return {
				...agent,
				process: undefined,
				prompt: prompt.text,
				output: output?.text,
				rawOutput: undefined,
				structuredOutput,
				resultHash: persistenceTruncated ? undefined : agent.resultHash,
				persistenceTruncated: persistenceTruncated || undefined,
				// Legacy fields remain loadable, but live runs no longer retain duplicate transcripts.
				messages: [],
				events: [],
			};
		}),
	};
}

/** Atomically writes a compact workflow index; large final payloads live in immutable sidecars. */
export async function writeWorkflowArtifact(run: WorkflowRun, directory: string): Promise<string> {
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	const target = path.join(directory, `${run.id}.json`);
	run.artifactPath = target;
	const verificationAgents = run.agents.filter((agent) => agent.startedAt !== undefined && (agent.kind === "verification" || verificationLike(agent.phase)));
	const statusCounts = Object.fromEntries(["queued", "running", "completed", "flagged", "budget_exhausted", "failed", "stopped"].map((status) => [
		status,
		run.agents.filter((agent) => agent.status === status).length,
	]));
	const summaryValue = run.fullResult ?? run.result ?? run.error ?? (run.status === "running" || run.status === "queued" || run.status === "paused" ? "Workflow is still in progress." : "No workflow result was returned.");
	const summary = await artifactText(directory, run.id, summaryValue);
	const agentBudgetCount = budgetDenominator(run.agents.length);
	const perAgentTextBytes = Math.max(512, Math.min(ARTIFACT_INLINE_TEXT_BYTES, Math.floor(ARTIFACT_AGENT_TEXT_BUDGET / agentBudgetCount)));
	const perAgentLogs = Math.max(1, Math.min(ARTIFACT_AGENT_LOGS, Math.floor(ARTIFACT_TOTAL_AGENT_LOGS / agentBudgetCount)));
	const perAgentTools = Math.max(1, Math.min(ARTIFACT_TOOL_CALLS, Math.floor(ARTIFACT_TOTAL_TOOL_CALLS / agentBudgetCount)));
	const agents = await Promise.all(run.agents.map(async (agent) => {
		const prompt = clipWorkflowText(agent.prompt, perAgentTextBytes);
		const output = await cachedAgentText(directory, run.id, agent, "output", agent.output, perAgentTextBytes);
		const rawSameAsOutput = agent.rawOutput !== undefined && agent.rawOutput === agent.output;
		const raw = rawSameAsOutput ? {} : await cachedAgentText(directory, run.id, agent, "rawOutput", agent.rawOutput, perAgentTextBytes);
		const logs = compactAgentLogs(agent.logs, perAgentLogs);
		const tools = boundedEntries(agent.toolCalls, perAgentTools);
		const structuredJson = agent.structuredOutput === undefined ? undefined : agent.output ?? JSON.stringify(agent.structuredOutput);
		const structuredOutput = structuredJson !== undefined && utf8Bytes(structuredJson) <= perAgentTextBytes
			? agent.structuredOutput
			: undefined;
		return {
			id: agent.id, label: agent.label, phase: agent.phase, kind: agent.kind, prompt: prompt.text,
			promptStorage: { bytes: prompt.bytes, sha256: sha256(agent.prompt), truncated: prompt.truncated },
			requestedModel: agent.requestedModel, resolvedModel: agent.resolvedModel, reportedModel: agent.reportedModel, modelRationale: agent.modelRationale,
			requestedThinking: agent.thinking, effectiveThinking: agent.effectiveThinking, providerThinking: agent.providerThinking,
			tools: agent.tools, profile: agent.profile, writePaths: agent.writePaths, maxTurns: agent.maxTurns, schema: compactJson(agent.schema, perAgentTextBytes), status: agent.status, attempt: agent.attempt, nextRetryAt: agent.nextRetryAt,
			createdAt: agent.createdAt, startedAt: agent.startedAt, finishedAt: agent.finishedAt, usage: agent.usage,
			flags: agent.flags,
			toolCalls: tools.entries.map((tool) => ({ name: tool.name, error: tool.error, args: compactJson(tool.args, 512) })),
			droppedToolCalls: (agent.droppedToolCalls ?? 0) + tools.omitted,
			cache: { cached: agent.cached ?? false, invocationHash: agent.invocationHash, resultHash: agent.resultHash, generation: agent.cacheGeneration ?? 0, dependencies: agent.dependencies ?? [] },
			diagnostics: {
				observedEvents: agent.observedEvents ?? 0,
				observedMessages: agent.observedMessages ?? 0,
				droppedEvents: agent.droppedEvents ?? 0,
				legacyMessagesRetained: agent.messages?.length ?? 0,
				legacyRawEventsRetained: agent.events?.length ?? 0,
			},
			logs: logs.entries, droppedLogEvents: (agent.droppedLogEvents ?? 0) + logs.omitted,
			rawOutput: raw.text, rawOutputStorage: rawSameAsOutput ? { sameAs: structuredOutput === undefined ? "output" : "structuredOutput" } : raw.storage,
			output: structuredOutput === undefined ? output.text : undefined,
			outputStorage: structuredOutput === undefined ? output.storage : { ...output.storage, representedBy: "structuredOutput" },
			structuredOutput,
			structuredOutputStorage: structuredJson !== undefined && structuredOutput === undefined
				? { bytes: utf8Bytes(structuredJson), sha256: sha256(structuredJson), ref: output.storage?.ref, representedBy: "output" }
				: undefined,
			scanFindings: agent.scanFindings ?? [], error: agent.error,
		};
	}));
	const runLogs = compactRunLogs(run.logs);
	const artifact = {
		schemaVersion: 7,
		kind: "piplusplus.workflow.state",
		reason: "Compact workflow index for live inspection and final handoff. Large payloads are content-addressed sidecars; duplicate Pi transcripts are not retained by default.",
		workflow: {
			id: run.id, name: run.spec.name, recipe: run.spec.recipe, modelPolicy: run.spec.modelPolicy, why: run.spec.why, goal: run.spec.goal,
			prompt: clipWorkflowText(run.spec.prompt, ARTIFACT_INLINE_TEXT_BYTES).text, args: compactJson(run.spec.args),
			script: clipWorkflowText(run.spec.script, ARTIFACT_INLINE_TEXT_BYTES).text, scriptHash: run.scriptHash, size: run.spec.size, budgets: run.spec.budgets, turnPolicy: run.spec.turnPolicy, concurrency: run.spec.concurrency ?? 4,
			timeoutMs: run.spec.timeoutMs ?? 30 * 60_000, maxRetries: run.spec.maxRetries ?? 3, retryBaseMs: run.spec.retryBaseMs ?? 1_000,
			cwd: run.cwd, sessionId: run.sessionId,
		},
		execution: {
			status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
			currentPhase: run.currentPhase, phases: run.phases,
			verification: { present: verificationAgents.length > 0, executedAgents: verificationAgents.length, agentIds: verificationAgents.map((agent) => agent.id) },
			agentCount: run.agents.length, agentStatusCounts: statusCounts, usage: run.usage, budget: run.budget,
			droppedLogEvents: (run.droppedLogEvents ?? 0) + runLogs.omitted, flags: run.flags, error: run.error,
		},
		summary: summary.text,
		summaryStorage: summary.storage,
		agents,
		logs: runLogs.entries,
	};
	const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await fs.promises.writeFile(temp, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
		await fs.promises.rename(temp, target);
		try { await fs.promises.chmod(target, 0o600); } catch { /* best effort */ }
	} finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
	return target;
}

/** @deprecated Kept for extension API compatibility; artifacts are no longer conditional. */
export const writeUnverifiedWorkflowArtifact = writeWorkflowArtifact;
