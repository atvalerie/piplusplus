import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	loadSavedWorkflows,
	normalizeWorkflowArgs,
	parseSavedWorkflowArgs,
	parseSavedWorkflowSource,
	saveWorkflowSource,
	validateSavedWorkflowName,
} from "../extensions/workflows/saved.ts";

const source = (name: string, result: string) => `export const meta = {
	name: "${name}",
	description: "Saved workflow ${name}",
};
return ${JSON.stringify(result)} + ":" + JSON.stringify(args);`;

test("saved workflow parser validates meta and produces an executable body", async () => {
	const parsed = await parseSavedWorkflowSource(source("audit", "done"));
	assert.deepEqual(parsed.meta, { name: "audit", description: "Saved workflow audit" });
	assert.doesNotMatch(parsed.script, /\bexport\b/);
	assert.match(parsed.script, /JSON\.stringify\(args\)/);
	await assert.rejects(() => parseSavedWorkflowSource("return 1;"), /exactly one/);
	await assert.rejects(() => parseSavedWorkflowSource(`export const meta = { name: "../bad", description: "bad" }; return 1;`), /lowercase/);
	await assert.rejects(() => parseSavedWorkflowSource(`export const meta = { name: "bad", description: "bad", extra: true }; return 1;`), /Unknown/);
});

test("saved workflow parser accepts bounded Claude-style phase metadata", async () => {
	const parsed = await parseSavedWorkflowSource(`
		export const meta = {
			name: "two-stage",
			description: "Probe first, then verify",
			phases: [
				{ title: "Probe", detail: "parallel discovery" },
				{ title: "Adversarial", detail: "depends on probe results" },
			],
		};
		phase("Probe");
		const first = await parallel([() => agent("one"), () => agent("two")]);
		phase("Adversarial");
		return agent(JSON.stringify(first), { effort: "high", phase: "Adversarial" });
	`);
	assert.deepEqual(parsed.meta.phases, [
		{ title: "Probe", detail: "parallel discovery" },
		{ title: "Adversarial", detail: "depends on probe results" },
	]);
	assert.match(parsed.script, /effort: "high"/);
	await assert.rejects(() => parseSavedWorkflowSource(`
		export const meta = {
			name: "bad-phase",
			description: "bad",
			phases: [{ title: "Probe", unexpected: true }],
		};
		return 1;
	`), /Unknown saved workflow meta\.phases/);
});

test("structured saved-workflow args round-trip and reject non-JSON input", () => {
	assert.deepEqual(parseSavedWorkflowArgs('{"query":"x","limit":2}'), { query: "x", limit: 2 });
	assert.deepEqual(parseSavedWorkflowArgs(""), {});
	assert.equal(parseSavedWorkflowArgs("null"), null);
	assert.deepEqual(normalizeWorkflowArgs(["a", 2]), ["a", 2]);
	assert.throws(() => parseSavedWorkflowArgs("{bad"), /valid JSON/);
});

test("project saved workflows override personal workflows with the same safe name", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-saved-project-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-saved-agent-"));
	try {
		await saveWorkflowSource("personal", "audit", source("audit", "personal"), cwd, agentDir);
		await saveWorkflowSource("project", "audit", source("audit", "project"), cwd, agentDir);
		await saveWorkflowSource("personal", "personal-only", source("personal-only", "only"), cwd, agentDir);
		const loaded = await loadSavedWorkflows(cwd, agentDir);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.workflows.get("audit")?.scope, "project");
		assert.match(loaded.workflows.get("audit")?.script ?? "", /project/);
		assert.equal(loaded.workflows.get("personal-only")?.scope, "personal");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("saved workflow names and symlinked targets cannot escape their roots", async (t) => {
	assert.throws(() => validateSavedWorkflowName("../escape"), /without traversal/);
	assert.throws(() => validateSavedWorkflowName("UPPER"), /lowercase/);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-saved-symlink-project-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-saved-symlink-agent-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-saved-symlink-outside-"));
	try {
		const piDir = path.join(cwd, ".pi");
		try { fs.symlinkSync(outside, piDir, process.platform === "win32" ? "junction" : "dir"); }
		catch (error) { t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`); return; }
		await assert.rejects(() => saveWorkflowSource("project", "audit", source("audit", "bad"), cwd, agentDir), /symlink|junction/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});
