import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { hasVerificationSection, workflowRunForPersistence, writeWorkflowArtifact } from "../extensions/workflows/artifact.ts";
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
	assert.equal(artifact.schemaVersion, 7);
	assert.equal(artifact.kind, "piplusplus.workflow.state");
	assert.equal(artifact.workflow.modelPolicy.defaultRouting, "inherit");
	assert.equal(artifact.execution.verification.present, false);
	assert.equal(artifact.execution.agentCount, 1);
	assert.equal(artifact.summary, "Final summary");
	assert.equal(artifact.agents[0].prompt, "Inspect architecture");
	assert.equal(artifact.agents[0].requestedThinking, undefined);
	assert.equal(artifact.agents[0].output, "Architecture output");
	assert.equal(artifact.agents[0].rawOutput, undefined);
	assert.equal(artifact.agents[0].rawOutputStorage.sameAs, "output");
	assert.deepEqual(artifact.agents[0].scanFindings, []);
	assert.equal(artifact.agents[0].logs.length, 2);
	assert.equal(artifact.agents[0].diagnostics.legacyRawEventsRetained, 1);
	assert.equal(artifact.agents[0].rawEvents, undefined);
	assert.equal(artifact.logs.length, 2);
	assert.deepEqual(fs.readdirSync(directory), ["wf_test.json"]);
	fs.rmSync(directory, { recursive: true, force: true });
});

test("small structured results are represented once", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-artifact-"));
	const value = { status: "completed", findings: ["one"] };
	const text = JSON.stringify(value);
	const workflow = run([agent({ output: text, rawOutput: text, structuredOutput: value })]);
	const artifactPath = await writeWorkflowArtifact(workflow, directory);
	const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
	assert.deepEqual(artifact.agents[0].structuredOutput, value);
	assert.equal(artifact.agents[0].output, undefined);
	assert.equal(artifact.agents[0].outputStorage.representedBy, "structuredOutput");
	assert.equal(artifact.agents[0].rawOutputStorage.sameAs, "structuredOutput");
	fs.rmSync(directory, { recursive: true, force: true });
});

test("large and duplicate worker payloads stay out of the compact JSON index", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-artifact-"));
	const large = "large-result-line\n".repeat(30_000);
	const item = agent({
		output: large,
		rawOutput: large,
		resultHash: "result-hash",
		messages: [{ role: "assistant", content: [{ type: "text", text: large } as never] } as never],
		events: [{ at: 3, attempt: 1, event: { type: "message_end", message: { content: large } } }],
	});
	const workflow = run([item]);
	workflow.fullResult = large;
	workflow.result = large.slice(0, 50_000);
	const artifactPath = await writeWorkflowArtifact(workflow, directory);
	const serialized = fs.readFileSync(artifactPath, "utf8");
	const artifact = JSON.parse(serialized);

	assert.ok(Buffer.byteLength(serialized) < 250_000, `compact artifact was ${Buffer.byteLength(serialized)} bytes`);
	assert.equal(artifact.agents[0].rawOutput, undefined);
	assert.equal(artifact.agents[0].diagnostics.legacyMessagesRetained, 1);
	assert.equal(artifact.agents[0].diagnostics.legacyRawEventsRetained, 1);
	assert.equal(artifact.agents[0].outputStorage.truncated, true);
	assert.equal(fs.readFileSync(artifact.agents[0].outputStorage.ref, "utf8"), large);
	assert.equal(fs.readFileSync(artifact.summaryStorage.ref, "utf8"), large);
	assert.equal(artifact.agents[0].outputStorage.ref, artifact.summaryStorage.ref);
	assert.equal(fs.readdirSync(path.dirname(artifact.summaryStorage.ref)).length, 1);
	assert.doesNotMatch(serialized, /message_end/);

	const persisted = workflowRunForPersistence(workflow);
	assert.equal(persisted.fullResult, undefined);
	assert.equal(persisted.agents[0].rawOutput, undefined);
	assert.deepEqual(persisted.agents[0].messages, []);
	assert.deepEqual(persisted.agents[0].events, []);
	assert.equal(persisted.agents[0].resultHash, undefined);
	assert.equal(persisted.agents[0].persistenceTruncated, true);
	fs.rmSync(directory, { recursive: true, force: true });
});

test("verification workflows remain represented in the compact artifact", async () => {
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
