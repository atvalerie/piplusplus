import assert from "node:assert/strict";
import test from "node:test";
import { createTurnLimitGuard, shouldTerminateAtTurnLimit } from "../extensions/workflows/child.ts";
import {
	createWorkflowController,
	workflowBudgetWarnings,
	workflowUsageTokens,
	WORKFLOW_SIZE_AGENT_GUIDANCE,
} from "../extensions/workflows/runtime.ts";
import { zeroUsage, type WorkflowRun } from "../extensions/workflows/types.ts";

const model = {
	provider: "modelhub",
	id: "gpt-budget-test",
	name: "GPT Budget Test",
	reasoning: true,
	contextWindow: 128_000,
	maxTokens: 16_000,
	cost: { input: 0, output: 0 },
} as any;

function workflow(script: string, budgets?: WorkflowRun["spec"]["budgets"]): WorkflowRun {
	return {
		id: `budget-${Math.random()}`,
		cwd: process.cwd(),
		spec: {
			name: "budget test",
			why: "test",
			goal: "test",
			prompt: "test",
			script,
			modelPolicy: { defaultRouting: "inherit", rationale: "test" },
			budgets,
			maxRetries: 3,
		},
		status: "queued",
		createdAt: Date.now(),
		currentPhase: "Workflow",
		phases: [],
		agents: [],
		flags: [],
		usage: zeroUsage(),
		paused: false,
		logs: [],
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

function result(output: string) {
	return { exitCode: 0, output, stderr: "", usage: zeroUsage(), model: model.id, stopReason: "stop" };
}

const toolUseMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
	stopReason: "toolUse",
} as any;

test("agent turn limit terminates a tool-using worker exactly once", () => {
	let terminations = 0;
	const guard = createTurnLimitGuard(2, () => { terminations++; });
	assert.equal(shouldTerminateAtTurnLimit(toolUseMessage, 1, 2), false);
	assert.equal(guard(toolUseMessage, 1), false);
	assert.equal(guard(toolUseMessage, 2), true);
	assert.equal(guard(toolUseMessage, 3), false);
	assert.equal(terminations, 1);

	const completedMessage = { ...toolUseMessage, content: [{ type: "text", text: "done" }], stopReason: "stop" } as any;
	assert.equal(shouldTerminateAtTurnLimit(completedMessage, 2, 2), false);
});

test("size and large-run warning thresholds are exact", () => {
	assert.deepEqual(WORKFLOW_SIZE_AGENT_GUIDANCE, { small: 4, medium: 14, large: 49, unrestricted: 1_000 });
	assert.deepEqual(workflowBudgetWarnings(undefined, 25, 1_500_000), []);
	assert.match(workflowBudgetWarnings(undefined, 26, 1_500_000)[0], /25-agent/);
	assert.match(workflowBudgetWarnings(undefined, 25, 1_500_001)[0], /1\.5M-token/);
	assert.match(workflowBudgetWarnings("small", 5, 0)[0], /Declared size 'small'/);
	assert.deepEqual(workflowBudgetWarnings(undefined, 26, 1_500_001), workflowBudgetWarnings(undefined, 100, 9_000_000));
	assert.equal(workflowUsageTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0, turns: 0 }), 10);
});

test("agent budget prevents additional scheduling and preserves a partial result", async () => {
	const run = workflow(`
		const first = await agent("first", { id: "first" });
		const second = await agent("second", { id: "second" });
		return { first, second };
	`, { maxAgents: 1 });
	let calls = 0;
	await createWorkflowController(run, [model], model, callbacks(), {
		runChildAgent: (async () => { calls++; return result("first result"); }) as any,
	}).execute();

	assert.equal(calls, 1);
	assert.equal(run.agents.length, 1);
	assert.equal(run.status, "budget_exhausted");
	assert.match(run.budget?.exhausted ?? "", /Agent budget exhausted/);
	assert.deepEqual(JSON.parse(run.fullResult!), { first: "first result", second: null });
});

test("token and cost budgets stop later workers without retrying deterministic exhaustion", async (t) => {
	for (const budgetCase of [
		{ name: "tokens", budgets: { maxTokens: 10 }, charge: (run: any) => { run.usage.input += 10; } },
		{ name: "cost", budgets: { maxCost: 0.5 }, charge: (run: any) => { run.usage.cost += 0.5; } },
	]) {
		await t.test(budgetCase.name, async () => {
			const run = workflow(`
				const first = await agent("first", { id: "first" });
				const second = await agent("second", { id: "second" });
				return { first, second };
			`, budgetCase.budgets);
			let calls = 0;
			await createWorkflowController(run, [model], model, callbacks(), {
				runChildAgent: (async (_cwd: string, agent: any) => {
					calls++;
					budgetCase.charge(agent);
					return result("done");
				}) as any,
			}).execute();

			assert.equal(calls, 1);
			assert.equal(run.status, "budget_exhausted");
			assert.equal(run.agents[0].status, "completed");
			assert.equal(run.agents[1].status, "budget_exhausted");
		});
	}
});

test("worker stream safety-limit failures are deterministic and never retried", async () => {
	const run = workflow(`return await agent("oversized", { id: "oversized" });`);
	let calls = 0;
	await createWorkflowController(run, [model], model, callbacks(), {
		runChildAgent: (async () => {
			calls++;
			return { ...result(""), exitCode: 1, stderr: "Workflow worker output exceeded 268435456 bytes" };
		}) as any,
	}).execute();

	assert.equal(calls, 1);
	assert.equal(run.status, "completed_with_flags");
	assert.equal(run.agents[0].status, "failed");
	assert.equal(run.agents[0].attempt, 1);
	assert.match(run.agents[0].error ?? "", /output exceeded/);
});

test("maxTurns exhaustion is deterministic and is never retried", async () => {
	const run = workflow(`return await agent("loop", { id: "loop", maxTurns: 2 });`);
	run.spec.turnPolicy = { mode: "model" };
	let calls = 0;
	await createWorkflowController(run, [model], model, callbacks(), {
		runChildAgent: (async (_cwd: string, agent: any) => {
			calls++;
			agent.usage.turns += 2;
			return { ...result("partial"), exitCode: 1, stopReason: "max_turns", errorMessage: "Worker reached maxTurns (2) before completing" };
		}) as any,
	}).execute();

	assert.equal(calls, 1);
	assert.equal(run.status, "budget_exhausted");
	assert.equal(run.agents[0].status, "budget_exhausted");
	assert.equal(run.agents[0].maxTurns, 2);
	assert.equal(run.agents[0].attempt, 1);
});

test("maxTurns is unlimited by default and a custom user limit overrides the script", async () => {
	const unlimited = workflow(`return await agent("unlimited", { id: "unlimited", maxTurns: 2 });`);
	let unlimitedLimit: number | undefined;
	await createWorkflowController(unlimited, [model], model, callbacks(), {
		runChildAgent: (async (_cwd: string, agent: any) => {
			unlimitedLimit = agent.maxTurns;
			return result("done");
		}) as any,
	}).execute();
	assert.equal(unlimitedLimit, undefined);
	assert.equal(unlimited.agents[0].maxTurns, undefined);

	const custom = workflow(`return await agent("custom", { id: "custom", maxTurns: 2 });`);
	custom.spec.turnPolicy = { mode: "custom", maxTurns: 19 };
	let customLimit: number | undefined;
	await createWorkflowController(custom, [model], model, callbacks(), {
		runChildAgent: (async (_cwd: string, agent: any) => {
			customLimit = agent.maxTurns;
			return result("done");
		}) as any,
	}).execute();
	assert.equal(customLimit, 19);
	assert.equal(custom.agents[0].maxTurns, 19);
});

test("cached results are reused without consuming a second token budget", async () => {
	const run = workflow(`
		const first = await agent("first", { id: "first" });
		return await agent("second:" + first, { id: "second" });
	`, { maxTokens: 20 });
	let calls = 0;
	const runner = async (_cwd: string, agent: any) => {
		calls++;
		agent.usage.input += 10;
		return result(`${agent.id} result`);
	};

	await createWorkflowController(run, [model], model, callbacks(), { runChildAgent: runner as any }).execute();
	assert.equal(calls, 2);
	assert.equal(run.status, "budget_exhausted");
	assert.equal(run.usage.input, 20);

	run.status = "stopped";
	await createWorkflowController(run, [model], model, callbacks(), { runChildAgent: runner as any }).execute();
	assert.equal(calls, 2);
	assert.equal(run.usage.input, 20);
	assert.equal(run.agents.every((agent) => agent.cached), true);
	assert.equal(run.status, "budget_exhausted");
});

test("Claude-style effort and per-agent phase options map to worker state", async () => {
	const run = workflow(`
		phase("Probe");
		return await agent("verify", { id: "verify", effort: "high", phase: "Adversarial" });
	`);
	let observed: { thinking?: string; effectiveThinking?: string; providerThinking?: string; phase?: string } = {};
	await createWorkflowController(run, [model], model, callbacks(), {
		runChildAgent: (async (_cwd: string, agent: any) => {
			observed = {
				thinking: agent.thinking,
				effectiveThinking: agent.effectiveThinking,
				providerThinking: agent.providerThinking,
				phase: agent.phase,
			};
			return result("verified");
		}) as any,
	}).execute();

	assert.deepEqual(observed, { thinking: "high", effectiveThinking: "high", providerThinking: "high", phase: "Adversarial" });
	assert.equal(run.agents[0].thinking, "high");
	assert.equal(run.agents[0].effectiveThinking, "high");
	assert.equal(run.agents[0].phase, "Adversarial");
	assert.deepEqual(run.phases, ["Probe", "Adversarial"]);
	assert.equal(run.status, "completed");
});

test("omitted worker effort inherits the session and records model/provider clamping", async () => {
	const mappedModel = { ...model, thinkingLevelMap: { max: "xhigh" } };
	const run = workflow(`return await agent("inherit effort", { id: "inherit-effort" });`);
	await createWorkflowController(run, [mappedModel], mappedModel, callbacks(), {
		sessionThinking: "max",
		runChildAgent: (async () => result("done")) as any,
	}).execute();

	assert.equal(run.agents[0].thinking, undefined);
	assert.equal(run.agents[0].effectiveThinking, "max");
	assert.equal(run.agents[0].providerThinking, "xhigh");
});
