import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJSONSchema, validateStructuredOutput } from "../extensions/workflows/profiles.ts";
import { createWorkflowController } from "../extensions/workflows/runtime.ts";
import { zeroUsage, type WorkflowRun } from "../extensions/workflows/types.ts";

const nestedSchema = {
	type: "object",
	properties: {
		user: {
			type: "object",
			properties: { name: { type: "string" }, roles: { type: "array", items: { enum: ["reader", "writer"] } } },
			required: ["name", "roles"],
			additionalProperties: false,
		},
	},
	required: ["user"],
	additionalProperties: false,
};

test("structured output validates nested values and reports actionable paths", () => {
	const valid = { user: { name: "Ada", roles: ["reader"] } };
	assert.deepEqual(validateStructuredOutput(nestedSchema, JSON.stringify(valid)), { structured: true, value: valid });
	assert.match(validateStructuredOutput(nestedSchema, '{"user":{"roles":[]}}').error ?? "", /\$\.user/);
	assert.match(validateStructuredOutput(nestedSchema, '{"user":{"name":"Ada","roles":[3]}}').error ?? "", /\$\.user\.roles\[0\]/);
	assert.match(validateStructuredOutput(nestedSchema, '{"user":{"name":"Ada","roles":[],"admin":true}}').error ?? "", /\$\.user/);
	assert.match(validateStructuredOutput(nestedSchema, "not json").error ?? "", /at \$.*valid JSON/i);
});

test("structured output supports arrays, scalars, and schema-authorized null", () => {
	assert.deepEqual(validateStructuredOutput({ type: "array", items: { type: "integer" } }, "[1,2]").value, [1, 2]);
	assert.equal(validateStructuredOutput({ type: "string" }, '"ok"').value, "ok");
	assert.equal(validateStructuredOutput({ type: "boolean" }, "true").value, true);
	assert.equal(validateStructuredOutput({ type: "null" }, "null").value, null);
	assert.match(validateStructuredOutput({ type: "string" }, "null").error ?? "", /must be string/);
	assert.deepEqual(validateStructuredOutput(undefined, "plain text"), { structured: false });
});

test("agent schemas are copied JSON data and reject non-schema roots", () => {
	const source = { type: "object", properties: { value: { type: "number" } } };
	const copy = normalizeJSONSchema(source);
	assert.deepEqual(copy, source);
	assert.notEqual(copy, source);
	assert.throws(() => normalizeJSONSchema([]), /object or boolean/);
	assert.throws(() => normalizeJSONSchema({ value: 1n }), /finite JSON data/);
});

test("invalid structured output retries and a valid retry reaches dependent QuickJS code", async () => {
	const model = {
		provider: "modelhub", id: "gpt-test", name: "GPT Test", reasoning: true,
		contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0 },
	} as any;
	const run: WorkflowRun = {
		id: "structured-retry",
		cwd: process.cwd(),
		spec: {
			name: "structured retry", why: "test", goal: "test", prompt: "test",
			script: `const value = await agent("Return a user", { id: "worker", schema: ${JSON.stringify(nestedSchema)} }); return value.user.name;`,
			modelPolicy: { defaultRouting: "inherit", rationale: "test" },
			maxRetries: 1,
			retryBaseMs: 100,
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
	let attempts = 0;
	let visiblePrompt = "";
	const { execute } = createWorkflowController(run, [model], model, {
		changed: () => {},
		notify: () => {},
		requestPermission: async () => false,
		requestApproval: async () => true,
	}, {
		runChildAgent: async (_cwd, agent) => {
			attempts++;
			visiblePrompt = agent.prompt;
			return {
				exitCode: 0,
				output: attempts === 1 ? '{"user":{"roles":[]}}' : '{"user":{"name":"Ada","roles":["writer"]}}',
				stderr: "",
				usage: zeroUsage(),
				model: "gpt-test",
				stopReason: "stop",
			};
		},
	});
	await execute();
	assert.equal(attempts, 2);
	assert.equal(run.status, "completed");
	assert.equal(run.fullResult, "Ada");
	assert.equal(visiblePrompt, "Return a user");
	assert.doesNotMatch(run.agents[0].prompt, /Structured output|JSON Schema/);
	assert.deepEqual(run.agents[0].structuredOutput, { user: { name: "Ada", roles: ["writer"] } });
	assert.equal(run.agents[0].attempt, 2);
	assert.ok(run.agents[0].logs.some((entry) => entry.type === "retry_scheduled" && entry.message?.includes("$.user")));
});
