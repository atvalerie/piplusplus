import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { hasVerificationSection, writeUnverifiedWorkflowArtifact } from "../extensions/workflows/artifact.ts";
import { zeroUsage, type AgentState, type WorkflowRun } from "../extensions/workflows/types.ts";

function agent(overrides: Partial<AgentState> = {}): AgentState {
	return {
		id: "researcher", label: "Researcher", phase: "Research", prompt: "Inspect architecture", kind: "research",
		status: "completed", createdAt: 1, startedAt: 2, finishedAt: 3, output: "Architecture output", flags: [],
		usage: { ...zeroUsage(), input: 100, output: 20, turns: 1 }, toolCalls: [{ name: "read", args: { path: "README.md" } }],
		logs: [{ at: 2, type: "process_start" }, { at: 3, type: "process_exit", message: "0" }], attempt: 1,
		...overrides,
	};
}

function run(agents: AgentState[]): WorkflowRun {
	return {
		id: "wf_test", sessionId: "session", cwd: "/repo", spec: {
			name: "Audit", why: "Parallel research", goal: "Report", prompt: "Audit repository", script: "return await agent('Inspect architecture')",
		},
		status: "completed", createdAt: 1, startedAt: 2, finishedAt: 4, currentPhase: "Research", phases: ["Research"], agents,
		result: "Final summary", flags: [], usage: agents.reduce((usage, item) => ({ ...usage, input: usage.input + item.usage.input, output: usage.output + item.usage.output, turns: usage.turns + item.usage.turns }), zeroUsage()),
		paused: false, logs: [{ at: 2, event: "started", phase: "Starting", status: "running" }, { at: 4, event: "completed", phase: "Research", status: "completed" }],
	};
}

test("unverified workflows produce one consolidated parent-agent handoff", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-artifact-"));
	const workflow = run([agent()]);
	const artifactPath = await writeUnverifiedWorkflowArtifact(workflow, directory);
	assert.equal(artifactPath, path.join(directory, "wf_test.json"));
	const artifact = JSON.parse(fs.readFileSync(artifactPath!, "utf8"));
	assert.equal(artifact.kind, "piplusplus.workflow.handoff");
	assert.equal(artifact.execution.verification.present, false);
	assert.equal(artifact.execution.agentCount, 1);
	assert.equal(artifact.summary, "Final summary");
	assert.equal(artifact.agents[0].prompt, "Inspect architecture");
	assert.equal(artifact.agents[0].output, "Architecture output");
	assert.equal(artifact.agents[0].logs.length, 2);
	assert.equal(artifact.logs.length, 2);
	assert.deepEqual(fs.readdirSync(directory), ["wf_test.json"]);
	fs.rmSync(directory, { recursive: true, force: true });
});

test("an actually executed verification worker suppresses the fallback artifact", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-artifact-"));
	const workflow = run([agent(), agent({ id: "verifier", label: "Verifier", phase: "Verification", kind: "general" })]);
	assert.equal(hasVerificationSection(workflow), true);
	assert.equal(await writeUnverifiedWorkflowArtifact(workflow, directory), undefined);
	assert.deepEqual(fs.readdirSync(directory), []);
	fs.rmSync(directory, { recursive: true, force: true });
});
