import assert from "node:assert/strict";
import test from "node:test";
import { isPathWithinWriteScope } from "../extensions/workflows/permissions.ts";
import { applyWorkflowProfile, validateProfileOutput, WORKFLOW_PROFILES } from "../extensions/workflows/profiles.ts";
import { compileWorkflowRecipe, WORKFLOW_RECIPE_NAMES } from "../extensions/workflows/recipes.ts";
import { validateWorkflowScript } from "../extensions/workflows/runtime.ts";
import { executeSandboxedWorkflow } from "../extensions/workflows/sandbox.ts";

test("built-in workflow recipes compile as sandbox programs", () => {
	for (const name of WORKFLOW_RECIPE_NAMES) {
		const recipe = compileWorkflowRecipe(name);
		assert.equal(validateWorkflowScript(recipe.script), undefined, name);
	}
	assert.match(compileWorkflowRecipe("implement").script, /await approve/);
});

test("implement recipe crosses its semantic approval gate and completes its review cycle", async () => {
	let approvals = 0;
	const result = await executeSandboxedWorkflow(compileWorkflowRecipe("implement").script, {
		workflowPrompt: "Make the requested change", cwd: "/repo", platform: "linux", models: [], phase: () => {}, log: () => {},
		approve: async () => { approvals++; return true; },
		agent: async (_prompt, options: any) => ({
			planner: '{"status":"completed","targetFiles":["src"]}', implementer: '{"status":"completed"}',
			"quality-fixer": '{"status":"approved"}', reviewer: '{"status":"approved"}',
			"security-reviewer": '{"status":"approved"}', synthesizer: "verified synthesis",
		}[options.profile] ?? '{"status":"completed"}'),
	}, { timeoutMs: 2_000 });
	assert.equal(result, "verified synthesis");
	assert.equal(approvals, 1);
});

test("specialist profiles add evidence rules and validate structured status", () => {
	const applied = applyWorkflowProfile("Find the defect", "investigator");
	assert.match(applied.prompt, /never fabricate evidence/i);
	assert.deepEqual(validateProfileOutput(WORKFLOW_PROFILES.investigator, '{"status":"completed","findings":[]}').value, { status: "completed", findings: [] });
	assert.match(validateProfileOutput(WORKFLOW_PROFILES.investigator, "not json").error ?? "", /valid JSON/);
	assert.match(validateProfileOutput(WORKFLOW_PROFILES.reviewer, '{"status":"completed"}').error ?? "", /invalid status/);
});

test("declared write scopes reject direct edits outside their roots", () => {
	assert.equal(isPathWithinWriteScope("/repo", "src/api/file.ts", ["src/api"]), true);
	assert.equal(isPathWithinWriteScope("/repo", "src/other.ts", ["src/api"]), false);
	assert.equal(isPathWithinWriteScope("/repo", "../outside.ts", ["src"]), false);
	assert.equal(isPathWithinWriteScope("/repo", "README.md", undefined), true);
});
