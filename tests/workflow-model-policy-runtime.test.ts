import assert from "node:assert/strict";
import test from "node:test";
import { registerModelHubFamilies } from "../extensions/shared/modelhub.ts";
import { createWorkflowController } from "../extensions/workflows/runtime.ts";
import { zeroUsage, type WorkflowRun } from "../extensions/workflows/types.ts";

registerModelHubFamilies({ catalog: [
	{ id: "gpt-policy-test", family: "openai" },
	{ id: "claude-policy-test", family: "anthropic" },
] as any });

const openai = {
	provider: "modelhub", id: "gpt-policy-test", name: "GPT", reasoning: true,
	contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0 },
} as any;
const anthropic = {
	provider: "modelhub-2", id: "claude-policy-test", name: "Claude", reasoning: true,
	contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0 },
} as any;
const openCodeGo = {
	provider: "opencode-go", id: "kimi-k2.7-code", name: "Kimi", reasoning: true,
	contextWindow: 262_144, maxTokens: 262_144, cost: { input: 0, output: 0 },
} as any;
const unsupportedGoogle = {
	provider: "google", id: "gemini-test", name: "Gemini", reasoning: true,
	contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0 },
} as any;
const directOpenAI = {
	provider: "openai", id: "gpt-direct-test", name: "GPT Direct", reasoning: true,
	contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0 },
} as any;
const directAnthropic = {
	provider: "anthropic", id: "claude-direct-test", name: "Claude Direct", reasoning: true,
	contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0 },
} as any;

function run(script: string): WorkflowRun {
	return {
		id: "policy-runtime",
		cwd: process.cwd(),
		spec: {
			name: "OpenAI only",
			why: "test",
			goal: "test",
			prompt: "Puść workflow tylko z modelami od OpenAI",
			script,
			modelPolicy: {
				defaultRouting: "inherit",
				allowedFamilies: ["openai"],
				rationale: "The Polish request semantically restricts every worker to OpenAI.",
			},
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

const callbacks = {
	changed: () => {},
	notify: () => {},
	requestPermission: async () => false,
	requestApproval: async () => true,
};

test("OpenAI-only policy prevents an Anthropic worker from launching", async () => {
	const workflow = run(`return await agent("wrong vendor", { id: "wrong", model: "modelhub-2/claude-policy-test" });`);
	let calls = 0;
	await createWorkflowController(workflow, [openai, anthropic], anthropic, callbacks, {
		runChildAgent: (async () => { calls++; throw new Error("must not launch"); }) as any,
	}).execute();
	assert.equal(calls, 0);
	assert.match(workflow.agents[0].error ?? "", /outside the workflow allowlist/);
});

test("OpenAI-only policy rejects output reported by a different model without retry", async () => {
	const workflow = run(`return await agent("right vendor", { id: "right", model: "modelhub/gpt-policy-test" });`);
	let calls = 0;
	await createWorkflowController(workflow, [openai, anthropic], anthropic, callbacks, {
		runChildAgent: (async () => {
			calls++;
			return { exitCode: 0, output: "untrusted result", stderr: "", usage: zeroUsage(), model: "claude-policy-test", stopReason: "stop" };
		}) as any,
	}).execute();
	assert.equal(calls, 1);
	assert.equal(workflow.agents[0].status, "failed");
	assert.match(workflow.agents[0].error ?? "", /Model identity mismatch/);
	assert.equal(workflow.agents[0].attempt, 1);
});

test("omitted model does not escape policy through an ineligible inherited session model", async () => {
	const workflow = run(`return await agent("inherit", { id: "inherit" });`);
	let calls = 0;
	await createWorkflowController(workflow, [openai, anthropic], anthropic, callbacks, {
		runChildAgent: (async () => { calls++; throw new Error("must not launch"); }) as any,
	}).execute();
	assert.equal(calls, 0);
	assert.match(workflow.agents[0].error ?? "", /outside the workflow allowlist|inherited session model is unavailable/);
});

test("OpenCode Go can be selected as a supported provider while unsupported providers fail closed", async () => {
	const workflow = run(`return await agent("OpenCode Go", { id: "go", model: "opencode-go/kimi-k2.7-code" });`);
	workflow.spec.modelPolicy = {
		defaultRouting: "inherit",
		allowedProviders: ["opencode-go"],
		rationale: "The user requested OpenCode Go.",
	};
	let calls = 0;
	await createWorkflowController(workflow, [openCodeGo, unsupportedGoogle], unsupportedGoogle, callbacks, {
		runChildAgent: (async () => {
			calls++;
			return { exitCode: 0, output: "go result", stderr: "", usage: zeroUsage(), model: "kimi-k2.7-code", stopReason: "stop" };
		}) as any,
	}).execute();
	assert.equal(calls, 1);
	assert.equal(workflow.status, "completed");
	assert.equal(workflow.agents[0].resolvedModel, "opencode-go/kimi-k2.7-code");

	const rejected = run(`return await agent("unsupported", { id: "google", model: "google/gemini-test" });`);
	rejected.spec.modelPolicy = { defaultRouting: "inherit", rationale: "No provider override." };
	await createWorkflowController(rejected, [openCodeGo, unsupportedGoogle], unsupportedGoogle, callbacks, {
		runChildAgent: (async () => { throw new Error("unsupported provider must not launch"); }) as any,
	}).execute();
	assert.equal(rejected.agents[0].status, "failed");
	assert.match(rejected.agents[0].error ?? "", /unavailable within the workflow policy/);
});

test("all four supported provider groups pass the same runtime allowlist boundary", async () => {
	const cases = [
		{ group: "openai", model: directOpenAI },
		{ group: "anthropic", model: directAnthropic },
		{ group: "opencode-go", model: openCodeGo },
		{ group: "modelhub", model: openai },
	] as const;
	for (const item of cases) {
		const workflow = run(`return await agent("provider", { id: "provider", model: ${JSON.stringify(`${item.model.provider}/${item.model.id}`)} });`);
		workflow.spec.modelPolicy = {
			defaultRouting: "inherit",
			allowedProviders: [item.group],
			rationale: `Use only ${item.group}.`,
		};
		let calls = 0;
		await createWorkflowController(workflow, cases.map((entry) => entry.model), item.model, callbacks, {
			runChildAgent: (async () => {
				calls++;
				return { exitCode: 0, output: "ok", stderr: "", usage: zeroUsage(), model: item.model.id, stopReason: "stop" };
			}) as any,
		}).execute();
		assert.equal(calls, 1, item.group);
		assert.equal(workflow.status, "completed", item.group);
		assert.equal(workflow.agents[0].resolvedModel, `${item.model.provider}/${item.model.id}`, item.group);
	}
});
