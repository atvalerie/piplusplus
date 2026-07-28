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

export async function writeUnverifiedWorkflowArtifact(run: WorkflowRun, directory: string): Promise<string | undefined> {
	if (hasVerificationSection(run)) return undefined;
	await fs.promises.mkdir(directory, { recursive: true });
	const target = path.join(directory, `${run.id}.json`);
	run.artifactPath = target;
	const statusCounts = Object.fromEntries(["queued", "running", "completed", "flagged", "failed", "stopped"].map((status) => [
		status,
		run.agents.filter((agent) => agent.status === status).length,
	]));
	const artifact = {
		schemaVersion: 1,
		kind: "piplusplus.workflow.handoff",
		reason: "No executed verification section was detected. This artifact preserves the complete workflow handoff for the parent agent.",
		workflow: {
			id: run.id,
			name: run.spec.name,
			why: run.spec.why,
			goal: run.spec.goal,
			prompt: run.spec.prompt,
			userModelInstruction: run.spec.userModelInstruction,
			script: run.spec.script,
			concurrency: run.spec.concurrency ?? 4,
			timeoutMs: run.spec.timeoutMs ?? 30 * 60_000,
			cwd: run.cwd,
			sessionId: run.sessionId,
		},
		execution: {
			status: run.status,
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			currentPhase: run.currentPhase,
			phases: run.phases,
			verification: { present: false, executedAgents: 0 },
			agentCount: run.agents.length,
			agentStatusCounts: statusCounts,
			usage: run.usage,
			droppedLogEvents: run.droppedLogEvents ?? 0,
			flags: run.flags,
			error: run.error,
		},
		summary: run.fullResult ?? run.result ?? run.error ?? "No workflow result was returned.",
		agents: run.agents.map((agent) => ({
			id: agent.id,
			label: agent.label,
			phase: agent.phase,
			kind: agent.kind,
			prompt: agent.prompt,
			requestedModel: agent.requestedModel,
			resolvedModel: agent.resolvedModel,
			modelRationale: agent.modelRationale,
			thinking: agent.thinking,
			tools: agent.tools,
			status: agent.status,
			attempt: agent.attempt,
			createdAt: agent.createdAt,
			startedAt: agent.startedAt,
			finishedAt: agent.finishedAt,
			usage: agent.usage,
			flags: agent.flags,
			toolCalls: agent.toolCalls,
			logs: agent.logs,
			droppedLogEvents: agent.droppedLogEvents ?? 0,
			output: agent.output,
			error: agent.error,
		})),
		logs: run.logs,
	};
	const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await fs.promises.writeFile(temp, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
	await fs.promises.rename(temp, target);
	return target;
}
