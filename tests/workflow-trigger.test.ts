import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	DEFAULT_WORKFLOW_SETTINGS,
	isInteractiveUltracodeTrigger,
	loadWorkflowSettings,
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
		await saveWorkflowSettings(agentDir, { triggersEnabled: false, ultracodeEffortMode: "session" });
		assert.deepEqual(await loadWorkflowSettings(agentDir), { triggersEnabled: false, ultracodeEffortMode: "session" });
		assert.equal(path.basename(workflowSettingsPath(agentDir)), "settings.json");
		const parsed = JSON.parse(fs.readFileSync(workflowSettingsPath(agentDir), "utf8"));
		assert.deepEqual(parsed, { triggersEnabled: false, ultracodeEffortMode: "session" });
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
