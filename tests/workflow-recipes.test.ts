import assert from "node:assert/strict";
import test from "node:test";
import { isPathWithinWriteScope } from "../extensions/workflows/permissions.ts";
import { applyWorkflowProfile, validateProfileOutput, WORKFLOW_PROFILES } from "../extensions/workflows/profiles.ts";
import { compileWorkflowRecipe, WORKFLOW_RECIPE_NAMES } from "../extensions/workflows/recipes.ts";
import { validateWorkflowScript } from "../extensions/workflows/runtime.ts";
import {
	chooseAutoModel,
	filterSupportedWorkflowModels,
	modelAllowedByPolicy,
	modelFamily,
	reportedModelMatches,
	resolveModel,
	workflowProvider,
} from "../extensions/workflows/models.ts";
import { executeSandboxedWorkflow } from "../extensions/workflows/sandbox.ts";
import { registerModelHubFamilies } from "../extensions/shared/modelhub.ts";

test("the orchestrator's structured model policy uses authoritative ModelHub families", () => {
	registerModelHubFamilies({ catalog: [
		{ id: "gpt-5-mini", family: "openai" },
		{ id: "claude-opus-4-6", family: "anthropic" },
	] as any });
	const cheap = { provider: "modelhub", id: "gpt-5-mini", name: "opaque-a", contextWindow: 128_000, maxTokens: 16_000, reasoning: true, cost: { input: 0.2, output: 1 } } as any;
	const opus = { provider: "modelhub-2", id: "claude-opus-4-6", name: "opaque-b", contextWindow: 200_000, maxTokens: 32_000, reasoning: true, cost: { input: 15, output: 75 } } as any;
	const openAiOnly = { defaultRouting: "inherit", allowedFamilies: ["openai"], rationale: "The user requested OpenAI workers." } as const;
	assert.equal(modelFamily(cheap), "openai");
	assert.equal(modelFamily(opus), "anthropic");
	assert.equal(modelAllowedByPolicy(cheap, openAiOnly), true);
	assert.equal(modelAllowedByPolicy(opus, openAiOnly), false);
	assert.equal(reportedModelMatches(cheap, "gpt-5-mini"), true);
	assert.equal(reportedModelMatches(cheap, "modelhub/gpt-5-mini"), true);
	assert.equal(reportedModelMatches(cheap, "claude-opus-4-6"), false);
	assert.equal(chooseAutoModel([opus, cheap], "research"), cheap);
});

test("omitted worker models inherit while auto routing remains explicit", () => {
	const main = { provider: "modelhub", id: "gpt-4.1-mini", name: "GPT Mini", contextWindow: 128_000, maxTokens: 16_000, reasoning: true, cost: { input: 0.4, output: 1.6 } } as any;
	const opus = { provider: "modelhub", id: "claude-opus-4-6", name: "Claude Opus", contextWindow: 200_000, maxTokens: 65_536, reasoning: true, cost: { input: 15, output: 75 } } as any;
	assert.equal(resolveModel([main, opus], undefined, "planning", main)?.id, main.id);
	assert.equal(resolveModel([main, opus], "inherit", "planning", main)?.id, main.id);
	assert.equal(resolveModel([main, opus], "auto", "planning", main)?.id, opus.id);
	assert.equal(resolveModel([main, opus], undefined, "planning", main, "auto")?.id, opus.id);
	assert.equal(resolveModel([opus], undefined, "planning", main), undefined);
});

test("workflow provider groups distinguish source constraints from underlying model families", () => {
	const directOpenAI = { provider: "openai", id: "gpt-direct", name: "GPT Direct" } as any;
	const directAnthropic = { provider: "anthropic", id: "claude-direct", name: "Claude Direct" } as any;
	const openCodeGo = { provider: "opencode-go", id: "kimi-k2.7-code", name: "Kimi" } as any;
	const modelHubAlias = { provider: "modelhub-8", id: "gpt-5-mini", name: "GPT through ModelHub" } as any;
	const unsupported = { provider: "google", id: "gemini", name: "Gemini" } as any;

	assert.equal(workflowProvider(directOpenAI), "openai");
	assert.equal(workflowProvider(directAnthropic), "anthropic");
	assert.equal(workflowProvider(openCodeGo), "opencode-go");
	assert.equal(workflowProvider(modelHubAlias), "modelhub");
	assert.equal(workflowProvider(unsupported), undefined);
	assert.deepEqual(filterSupportedWorkflowModels([directOpenAI, directAnthropic, openCodeGo, modelHubAlias, unsupported]), [
		directOpenAI,
		directAnthropic,
		openCodeGo,
		modelHubAlias,
	]);

	assert.equal(modelAllowedByPolicy(openCodeGo, {
		defaultRouting: "inherit",
		allowedProviders: ["opencode-go"],
		rationale: "Use only OpenCode Go.",
	}), true);
	assert.equal(modelAllowedByPolicy(directOpenAI, {
		defaultRouting: "inherit",
		allowedProviders: ["opencode-go"],
		rationale: "Use only OpenCode Go.",
	}), false);
	assert.equal(modelAllowedByPolicy(modelHubAlias, {
		defaultRouting: "inherit",
		allowedProviders: ["modelhub"],
		allowedFamilies: ["openai"],
		rationale: "Use only OpenAI-family models served by ModelHub.",
	}), true);
	assert.equal(modelAllowedByPolicy(directOpenAI, {
		defaultRouting: "inherit",
		allowedProviders: ["modelhub"],
		allowedFamilies: ["openai"],
		rationale: "Use only OpenAI-family models served by ModelHub.",
	}), false);
});

test("built-in workflow recipes compile as sandbox programs", () => {
	for (const name of WORKFLOW_RECIPE_NAMES) {
		const recipe = compileWorkflowRecipe(name);
		assert.equal(validateWorkflowScript(recipe.script), undefined, name);
	}
	assert.match(compileWorkflowRecipe("implement").script, /await approve/);
	assert.doesNotMatch(compileWorkflowRecipe("implement").script, /JSON\.parse/);
	assert.doesNotMatch(compileWorkflowRecipe("review").script, /JSON\.parse/);
});

test("implement recipe crosses its semantic approval gate and completes its review cycle", async () => {
	let approvals = 0;
	const result = await executeSandboxedWorkflow(compileWorkflowRecipe("implement").script, {
		workflowPrompt: "Make the requested change", cwd: "/repo", platform: "linux", models: [], phase: () => {}, log: () => {},
		approve: async () => { approvals++; return true; },
		agent: async (_prompt, options: any) => ({
			planner: { status: "completed", requirements: [], targetFiles: ["src"], steps: [], verification: [], risks: [], summary: "plan" },
			implementer: { status: "completed", filesModified: [], tests: [], verification: [], remainingRisks: [], summary: "done" },
			"quality-fixer": { status: "approved", commands: [], fixes: [], failures: [], summary: "clean" },
			reviewer: { status: "approved", findings: [], strengths: [], summary: "approved" },
			"security-reviewer": { status: "approved", findings: [], unverifiedBoundaries: [], summary: "approved" },
			synthesizer: "verified synthesis",
		}[options.profile] ?? { status: "completed" }),
	}, { timeoutMs: 2_000 });
	assert.equal(result, "verified synthesis");
	assert.equal(approvals, 1);
});

test("specialist profiles keep evidence rules separate from the visible assignment and validate structured status", () => {
	const applied = applyWorkflowProfile("Find the defect", "investigator");
	assert.equal(applied.prompt, "Find the defect");
	assert.match(applied.profile?.instruction ?? "", /never fabricate evidence/i);
	const valid = { status: "completed", paths: [], findings: [{ claim: "cause", evidence: ["src/a.ts:1"] }], unexplored: [], summary: "done" };
	assert.deepEqual(validateProfileOutput(WORKFLOW_PROFILES.investigator, JSON.stringify(valid)).value, valid);
	assert.match(validateProfileOutput(WORKFLOW_PROFILES.investigator, "not json").error ?? "", /valid JSON/);
	assert.match(validateProfileOutput(WORKFLOW_PROFILES.investigator, JSON.stringify({ ...valid, findings: [{ claim: "cause", evidence: [1] }] })).error ?? "", /\$\.findings\[0\]\.evidence\[0\]/);
});

test("declared write scopes reject direct edits outside their roots", () => {
	assert.equal(isPathWithinWriteScope("/repo", "src/api/file.ts", ["src/api"]), true);
	assert.equal(isPathWithinWriteScope("/repo", "src/other.ts", ["src/api"]), false);
	assert.equal(isPathWithinWriteScope("/repo", "../outside.ts", ["src"]), false);
	assert.equal(isPathWithinWriteScope("/repo", "README.md", undefined), true);
});
