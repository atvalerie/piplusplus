import assert from "node:assert/strict";
import test from "node:test";
import { migrateWorkflowRun } from "../extensions/workflows/migration.ts";

test("legacy workflow state migrates to structured policy and scanning/cache defaults", () => {
	const run = migrateWorkflowRun({
		id: "legacy",
		cwd: "/repo",
		spec: {
			name: "legacy",
			why: "test",
			goal: "test",
			prompt: "test",
			script: "return 'done';",
			modelFamily: "OpenAI",
			userModelInstruction: "tylko OpenAI",
		},
		status: "stopped",
		createdAt: 1,
		currentPhase: "",
		agents: [{
			id: "a",
			label: "A",
			phase: "Workflow",
			prompt: "test",
			kind: "general",
			status: "completed",
			createdAt: 1,
			output: "safe",
		}],
	});
	assert.deepEqual(run.spec.modelPolicy.allowedFamilies, ["openai"]);
	assert.equal(run.spec.modelPolicy.defaultRouting, "inherit");
	assert.match(run.spec.modelPolicy.rationale, /not parsed/);
	assert.deepEqual(run.spec.turnPolicy, { mode: "off" });
	assert.equal(run.agents[0].rawOutput, "safe");
	assert.deepEqual(run.agents[0].scanFindings, []);
	assert.equal(run.agents[0].cached, false);
	assert.deepEqual(run.cacheInvalidations, []);
});

test("migration preserves an existing structured model policy", () => {
	const policy = { defaultRouting: "auto", allowedModels: ["modelhub/gpt"], rationale: "explicit" };
	const run = migrateWorkflowRun({
		id: "current",
		cwd: "/repo",
		spec: { name: "current", why: "x", goal: "x", prompt: "x", script: "return 1;", modelPolicy: policy },
		status: "completed",
		createdAt: 1,
		currentPhase: "Workflow",
		phases: [],
		agents: [],
		flags: [],
		usage: {},
		paused: false,
		logs: [],
	});
	assert.equal(run.spec.modelPolicy, policy);
});
