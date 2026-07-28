import { zeroUsage, type UsageStats, type WorkflowRun } from "./types.ts";

function usage(value: Partial<UsageStats> | undefined): UsageStats {
	return { ...zeroUsage(), ...(value ?? {}) };
}

/** Normalize persisted pre-v6 run state without interpreting legacy prose. */
export function migrateWorkflowRun(value: unknown): WorkflowRun {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Persisted workflow state must be an object.");
	const run = value as WorkflowRun & {
		spec: WorkflowRun["spec"] & { modelFamily?: string; userModelInstruction?: string };
	};
	if (!run.spec || typeof run.spec !== "object" || typeof run.spec.script !== "string") throw new Error("Persisted workflow state has no executable spec.");
	if (!run.spec.modelPolicy) {
		const family = typeof run.spec.modelFamily === "string" && run.spec.modelFamily.trim()
			? run.spec.modelFamily.trim().toLowerCase()
			: undefined;
		run.spec.modelPolicy = {
			defaultRouting: "inherit",
			allowedFamilies: family ? [family] : undefined,
			rationale: run.spec.userModelInstruction
				? "Migrated from a legacy free-text routing instruction. The prose is retained in the old state but is not parsed into new constraints; review before resume."
				: "Migrated legacy workflow with Claude-compatible session-model inheritance.",
		};
	}
	run.spec.turnPolicy ??= { mode: "off" };
	run.currentPhase ||= "Workflow";
	run.phases ??= [];
	run.agents ??= [];
	run.flags ??= [];
	run.logs ??= [];
	run.usage = usage(run.usage);
	run.paused ??= false;
	run.cacheInvalidations ??= [];
	for (const agent of run.agents) {
		agent.logs ??= [];
		agent.messages ??= [];
		agent.events ??= [];
		agent.flags ??= [];
		agent.toolCalls ??= [];
		agent.scanFindings ??= [];
		agent.usage = usage(agent.usage);
		agent.attempt ??= 0;
		agent.createdAt ??= run.createdAt;
		agent.rawOutput ??= agent.output;
		agent.cached ??= false;
	}
	return run;
}
