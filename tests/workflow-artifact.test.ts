import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { hasVerificationSection, writeWorkflowArtifact } from "../extensions/workflows/artifact.ts";
import { WorkflowBrowser } from "../extensions/workflows/tui.ts";
import { zeroUsage, type AgentState, type WorkflowRun } from "../extensions/workflows/types.ts";

function agent(overrides: Partial<AgentState> = {}): AgentState {
	return {
		id: "researcher", label: "Researcher", phase: "Research", prompt: "Inspect architecture", kind: "research",
		status: "completed", createdAt: 1, startedAt: 2, finishedAt: 3, rawOutput: "Architecture output", output: "Architecture output", scanFindings: [], flags: [],
		usage: { ...zeroUsage(), input: 100, output: 20, turns: 1 }, toolCalls: [{ name: "read", args: { path: "README.md" } }],
		messages: [], events: [], logs: [{ at: 2, type: "process_start" }, { at: 3, type: "process_exit", message: "0" }], attempt: 1,
		...overrides,
	};
}

function run(agents: AgentState[]): WorkflowRun {
	return {
		id: "wf_test", sessionId: "session", cwd: "/repo", spec: {
			name: "Audit", why: "Parallel research", goal: "Report", prompt: "Audit repository", script: "return await agent('Inspect architecture')",
			modelPolicy: { defaultRouting: "inherit", rationale: "Use the session model." },
		},
		status: "completed", createdAt: 1, startedAt: 2, finishedAt: 4, currentPhase: "Research", phases: ["Research"], agents,
		result: "Final summary", flags: [], usage: agents.reduce((usage, item) => ({ ...usage, input: usage.input + item.usage.input, output: usage.output + item.usage.output, turns: usage.turns + item.usage.turns }), zeroUsage()),
		paused: false, logs: [{ at: 2, event: "started", phase: "Starting", status: "running" }, { at: 4, event: "completed", phase: "Research", status: "completed" }],
	};
}

test("workflow browser uses a bounded, selection-following viewport", () => {
	const runs = Array.from({ length: 20 }, (_, index) => {
		const item = run([agent()]);
		item.id = `wf_${index}`;
		item.spec = { ...item.spec, name: `Audit ${index}` };
		return item;
	});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const browser = new WorkflowBrowser(() => runs, new Map(), theme, () => {}, 12);
	for (let index = 0; index < 15; index++) browser.handleInput("\x1b[B");
	const lines = browser.render(80);
	assert.equal(lines.length, 12);
	assert.match(lines.join("\n"), /Audit 15/);
	let closed = false;
	const dock = new WorkflowBrowser(() => runs.slice(0, 1), new Map(), theme, () => { closed = true; }, 12);
	dock.handleInput("\x1b[A");
	assert.equal(closed, true);
});

test("workflow browser shows effective and provider-specific worker effort", () => {
	const item = run([agent({
		thinking: "max",
		effectiveThinking: "max",
		providerThinking: "xhigh",
		resolvedModel: "modelhub/gpt-test",
	})]);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const browser = new WorkflowBrowser(() => [item], new Map(), theme, () => {}, 30);

	browser.handleInput("\x1b[C");
	browser.handleInput("\x1b[C");
	assert.match(browser.render(120).join("\n"), /effort max→xhigh/);
	browser.handleInput("\x1b[C");
	const detail = browser.render(120).join("\n");
	assert.match(detail, /Requested effort: max/);
	assert.match(detail, /Effective effort: max · provider value: xhigh/);
});

test("unverified workflows produce one consolidated parent-agent handoff", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-artifact-"));
	const workflow = run([agent()]);
	workflow.agents[0].events.push({ at: 3, attempt: 1, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Architecture output" }] } } });
	const artifactPath = await writeWorkflowArtifact(workflow, directory);
	assert.equal(artifactPath, path.join(directory, "wf_test.json"));
	const artifact = JSON.parse(fs.readFileSync(artifactPath!, "utf8"));
	assert.equal(artifact.schemaVersion, 6);
	assert.equal(artifact.kind, "piplusplus.workflow.state");
	assert.equal(artifact.workflow.modelPolicy.defaultRouting, "inherit");
	assert.equal(artifact.execution.verification.present, false);
	assert.equal(artifact.execution.agentCount, 1);
	assert.equal(artifact.summary, "Final summary");
	assert.equal(artifact.agents[0].prompt, "Inspect architecture");
	assert.equal(artifact.agents[0].requestedThinking, undefined);
	assert.equal(artifact.agents[0].output, "Architecture output");
	assert.equal(artifact.agents[0].rawOutput, "Architecture output");
	assert.deepEqual(artifact.agents[0].scanFindings, []);
	assert.equal(artifact.agents[0].logs.length, 2);
	assert.equal(artifact.agents[0].rawEvents[0].event.message.content[0].text, "Architecture output");
	assert.equal(artifact.logs.length, 2);
	assert.deepEqual(fs.readdirSync(directory), ["wf_test.json"]);
	fs.rmSync(directory, { recursive: true, force: true });
});

test("verification workflows still produce the complete artifact", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-artifact-"));
	const workflow = run([agent(), agent({ id: "verifier", label: "Verifier", phase: "Verification", kind: "general" })]);
	assert.equal(hasVerificationSection(workflow), true);
	const artifactPath = await writeWorkflowArtifact(workflow, directory);
	const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
	assert.equal(artifact.execution.verification.present, true);
	assert.deepEqual(artifact.execution.verification.agentIds, ["verifier"]);
	assert.deepEqual(fs.readdirSync(directory), ["wf_test.json"]);
	fs.rmSync(directory, { recursive: true, force: true });
});
