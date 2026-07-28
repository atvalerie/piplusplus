import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowRun } from "./types.ts";

function verificationLike(value: string): boolean {
	return /(?:^|[\s_-])(verify|verification|verified|critic|critique|review)(?:$|[\s_-])/i.test(value);
}

/** A verification section counts only when at least one worker actually ran in it. */
export function hasVerificationSection(run: WorkflowRun): boolean {
	return run.agents.some((agent) => agent.startedAt !== undefined && (agent.kind === "verification" || verificationLike(agent.phase)));
}

/** Atomically writes the complete current workflow state, including in-progress runs. */
export async function writeWorkflowArtifact(run: WorkflowRun, directory: string): Promise<string> {
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	const target = path.join(directory, `${run.id}.json`);
	run.artifactPath = target;
	const verificationAgents = run.agents.filter((agent) => agent.startedAt !== undefined && (agent.kind === "verification" || verificationLike(agent.phase)));
	const statusCounts = Object.fromEntries(["queued", "running", "completed", "flagged", "failed", "stopped"].map((status) => [
		status,
		run.agents.filter((agent) => agent.status === status).length,
	]));
	const artifact = {
		schemaVersion: 2,
		kind: "piplusplus.workflow.state",
		reason: "Continuously updated workflow source of truth for live inspection and final handoff.",
		workflow: {
			id: run.id, name: run.spec.name, why: run.spec.why, goal: run.spec.goal, prompt: run.spec.prompt,
			userModelInstruction: run.spec.userModelInstruction, script: run.spec.script, concurrency: run.spec.concurrency ?? 4,
			timeoutMs: run.spec.timeoutMs ?? 30 * 60_000, maxRetries: run.spec.maxRetries ?? 3, retryBaseMs: run.spec.retryBaseMs ?? 1_000,
			cwd: run.cwd, sessionId: run.sessionId,
		},
		execution: {
			status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
			currentPhase: run.currentPhase, phases: run.phases,
			verification: { present: verificationAgents.length > 0, executedAgents: verificationAgents.length, agentIds: verificationAgents.map((agent) => agent.id) },
			agentCount: run.agents.length, agentStatusCounts: statusCounts, usage: run.usage,
			droppedLogEvents: run.droppedLogEvents ?? 0, flags: run.flags, error: run.error,
		},
		summary: run.fullResult ?? run.result ?? run.error ?? (run.status === "running" || run.status === "queued" || run.status === "paused" ? "Workflow is still in progress." : "No workflow result was returned."),
		agents: run.agents.map((agent) => ({
			id: agent.id, label: agent.label, phase: agent.phase, kind: agent.kind, prompt: agent.prompt,
			requestedModel: agent.requestedModel, resolvedModel: agent.resolvedModel, modelRationale: agent.modelRationale,
			thinking: agent.thinking, tools: agent.tools, status: agent.status, attempt: agent.attempt, nextRetryAt: agent.nextRetryAt,
			createdAt: agent.createdAt, startedAt: agent.startedAt, finishedAt: agent.finishedAt, usage: agent.usage,
			flags: agent.flags, toolCalls: agent.toolCalls,
			messages: agent.messages ?? [], rawEvents: agent.events ?? [], droppedEvents: agent.droppedEvents ?? 0,
			logs: agent.logs, droppedLogEvents: agent.droppedLogEvents ?? 0,
			output: agent.output, error: agent.error,
		})),
		logs: run.logs,
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
