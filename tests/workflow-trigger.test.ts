import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	applyWorkflowBudgetSettings,
	applyWorkflowSettings,
	DEFAULT_WORKFLOW_SETTINGS,
	describeWorkflowBudgetSettings,
	describeWorkflowMaxTurnsSettings,
	isInteractiveUltracodeTrigger,
	loadWorkflowSettings,
	normalizeCustomBudgets,
	normalizeCustomMaxTurns,
	saveWorkflowSettings,
	workflowSettingsPath,
} from "../extensions/workflows/settings.ts";

test("literal ultracode trigger accepts only authenticated interactive input", () => {
	assert.equal(isInteractiveUltracodeTrigger("interactive", "ultracode audit this", true), true);
	assert.equal(isInteractiveUltracodeTrigger("interactive", "please ULTRACODE this", true), true);
	assert.equal(isInteractiveUltracodeTrigger("rpc", "ultracode audit this", true), false);
	assert.equal(isInteractiveUltracodeTrigger("extension", "ultracode audit this", true), false);
	assert.equal(isInteractiveUltracodeTrigger("interactive", "ultracode audit this", false), false);
	assert.equal(isInteractiveUltracodeTrigger("interactive", "superultracode", true), false);
});

test("workflow trigger and effort settings persist independently from runs and artifacts", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-workflow-settings-"));
	try {
		assert.deepEqual(await loadWorkflowSettings(agentDir), DEFAULT_WORKFLOW_SETTINGS);
		await saveWorkflowSettings(agentDir, { triggersEnabled: false, ultracodeEffortMode: "session", budgetMode: "off", maxTurnsMode: "off" });
		assert.deepEqual(await loadWorkflowSettings(agentDir), { triggersEnabled: false, ultracodeEffortMode: "session", budgetMode: "off", maxTurnsMode: "off" });
		assert.equal(path.basename(workflowSettingsPath(agentDir)), "settings.json");
		const parsed = JSON.parse(fs.readFileSync(workflowSettingsPath(agentDir), "utf8"));
		assert.deepEqual(parsed, { triggersEnabled: false, ultracodeEffortMode: "session", budgetMode: "off", maxTurnsMode: "off" });
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("user-owned workflow budget mode overrides model-proposed limits", () => {
	const spec = {
		name: "budget",
		why: "test",
		goal: "test",
		prompt: "test",
		script: "return 1",
		modelPolicy: { defaultRouting: "inherit", rationale: "test" },
		budgets: { maxAgents: 3, maxTokens: 60_000, maxCost: 3 },
	} as any;
	assert.equal(applyWorkflowBudgetSettings(spec, { ...DEFAULT_WORKFLOW_SETTINGS, budgetMode: "off" }).budgets, undefined);
	assert.deepEqual(
		applyWorkflowBudgetSettings(spec, {
			...DEFAULT_WORKFLOW_SETTINGS,
			budgetMode: "custom",
			customBudgets: { maxAgents: 2, maxTokens: 250_000 },
		}).budgets,
		{ maxAgents: 2, maxTokens: 250_000 },
	);
	assert.deepEqual(
		applyWorkflowBudgetSettings(spec, { ...DEFAULT_WORKFLOW_SETTINGS, budgetMode: "model" }).budgets,
		spec.budgets,
	);
	assert.deepEqual(normalizeCustomBudgets({ maxTokens: 200_000, maxCost: 5 }), { maxTokens: 200_000, maxCost: 5 });
	assert.throws(() => normalizeCustomBudgets({ maxTokens: 0 }), /positive integer/);
	assert.match(describeWorkflowBudgetSettings(DEFAULT_WORKFLOW_SETTINGS), /^off/);
});

test("user-owned maxTurns mode defaults to unlimited and overrides script limits", () => {
	const spec = {
		name: "turns", why: "test", goal: "test", prompt: "test",
		script: `return agent("work", { maxTurns: 2 })`,
		modelPolicy: { defaultRouting: "inherit", rationale: "test" },
	} as any;

	assert.deepEqual(applyWorkflowSettings(spec, DEFAULT_WORKFLOW_SETTINGS).turnPolicy, { mode: "off" });
	assert.deepEqual(
		applyWorkflowSettings(spec, { ...DEFAULT_WORKFLOW_SETTINGS, maxTurnsMode: "custom", customMaxTurns: 17 }).turnPolicy,
		{ mode: "custom", maxTurns: 17 },
	);
	assert.deepEqual(
		applyWorkflowSettings(spec, { ...DEFAULT_WORKFLOW_SETTINGS, maxTurnsMode: "model" }).turnPolicy,
		{ mode: "model" },
	);
	assert.equal(normalizeCustomMaxTurns("1000"), 1000);
	assert.throws(() => normalizeCustomMaxTurns(0), /1 to 1000/);
	assert.match(describeWorkflowMaxTurnsSettings(DEFAULT_WORKFLOW_SETTINGS), /unlimited/);
});
