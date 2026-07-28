import assert from "node:assert/strict";
import test from "node:test";
import { stableWorkflowHash } from "../extensions/workflows/cache.ts";
import { createWorkflowController } from "../extensions/workflows/runtime.ts";
import { zeroUsage, type WorkflowRun } from "../extensions/workflows/types.ts";

const model = {
	provider: "modelhub", id: "gpt-test", name: "GPT Test", reasoning: true,
	contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0 },
} as any;

function workflow(script = `const first = await agent(workflowPrompt, { id: "first" }); return await agent("second:" + first, { id: "second" });`): WorkflowRun {
	return {
		id: "resume-test",
		cwd: process.cwd(),
		spec: {
			name: "resume", why: "test", goal: "test", prompt: "original", script,
			modelPolicy: { defaultRouting: "inherit", rationale: "test" },
			maxRetries: 0,
		},
		status: "queued", createdAt: Date.now(), currentPhase: "Workflow", phases: [], agents: [],
		flags: [], usage: zeroUsage(), paused: false, logs: [],
	};
}

function callbacks() {
	return {
		changed: () => {},
		notify: () => {},
		requestPermission: async () => false,
		requestApproval: async () => true,
	};
}

test("stable workflow hashes ignore object key insertion order", () => {
	assert.equal(stableWorkflowHash({ b: 2, a: { d: 4, c: 3 } }), stableWorkflowHash({ a: { c: 3, d: 4 }, b: 2 }));
	assert.notEqual(stableWorkflowHash({ value: 1 }), stableWorkflowHash({ value: 2 }));
});

test("resume caches completed agents, restarts stopped agents, and does not re-charge cached usage", async () => {
	const run = workflow();
	const calls = new Map<string, number>();
	const runner = async (_cwd: string, agent: any) => {
		calls.set(agent.id, (calls.get(agent.id) ?? 0) + 1);
		agent.usage.input += 10;
		agent.usage.output += 2;
		agent.usage.cost += 0.01;
		agent.usage.turns += 1;
		return { exitCode: 0, output: `${agent.id}-result`, stderr: "", usage: zeroUsage(), model: "gpt-test", stopReason: "stop" };
	};
	await createWorkflowController(run, [model], model, callbacks(), { runChildAgent: runner as any }).execute();
	assert.equal(run.status, "completed");
	assert.deepEqual(Object.fromEntries(calls), { first: 1, second: 1 });
	assert.equal(run.usage.input, 20);

	run.status = "stopped";
	run.agents.find((agent) => agent.id === "second")!.status = "stopped";
	await createWorkflowController(run, [model], model, callbacks(), { runChildAgent: runner as any }).execute();
	assert.equal(run.status, "completed");
	assert.deepEqual(Object.fromEntries(calls), { first: 1, second: 2 });
	assert.equal(run.agents.find((agent) => agent.id === "first")!.cached, true);
	assert.equal(run.agents.find((agent) => agent.id === "first")!.usage.input, 10);
	assert.equal(run.agents.find((agent) => agent.id === "second")!.cached, false);
	assert.equal(run.usage.input, 30);
});

test("script changes and explicit upstream restarts invalidate every dependent cache entry", async () => {
	const run = workflow();
	const calls = new Map<string, number>();
	const runner = async (_cwd: string, agent: any) => {
		calls.set(agent.id, (calls.get(agent.id) ?? 0) + 1);
		return { exitCode: 0, output: `${agent.id}-same-result`, stderr: "", usage: zeroUsage(), model: "gpt-test", stopReason: "stop" };
	};
	await createWorkflowController(run, [model], model, callbacks(), { runChildAgent: runner as any }).execute();
	assert.deepEqual(Object.fromEntries(calls), { first: 1, second: 1 });

	run.status = "stopped";
	run.spec.script += "\n// changed";
	await createWorkflowController(run, [model], model, callbacks(), { runChildAgent: runner as any }).execute();
	assert.deepEqual(Object.fromEntries(calls), { first: 2, second: 2 });
	assert.equal(run.agents.every((agent) => !agent.cached), true);

	run.status = "stopped";
	run.cacheInvalidations = ["first"];
	await createWorkflowController(run, [model], model, callbacks(), { runChildAgent: runner as any }).execute();
	assert.deepEqual(Object.fromEntries(calls), { first: 3, second: 3 });
	assert.equal(run.agents.every((agent) => !agent.cached), true);
	assert.equal(run.cacheInvalidations?.length, 0);
	assert.ok((run.agents.find((agent) => agent.id === "second")?.dependencies ?? []).includes("first"));
});
