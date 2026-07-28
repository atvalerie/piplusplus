import assert from "node:assert/strict";
import test from "node:test";
import { modelCatalogSummary, modelCatalogText } from "../extensions/workflows/models.ts";
import { buildWorkflowSystemInstructions, workflowPolicyContext } from "../extensions/workflows/system-prompt.ts";
import type { ModelChoice } from "../extensions/workflows/types.ts";

function models(count: number, uniqueFamilies = false): ModelChoice[] {
	return Array.from({ length: count }, (_, index) => ({
		provider: `modelhub-${(index % 8) + 1}`,
		providerGroup: "modelhub",
		id: `private-exact-model-id-${index}`,
		name: `Model ${index}`,
		reasoning: index % 2 === 0,
		contextWindow: 128_000,
		maxTokens: 16_000,
		inputCost: 0.1,
		outputCost: 0.5,
		family: uniqueFamilies ? `family-${index}` : ["openai", "anthropic", "xai", "china"][index % 4],
	}));
}

test("main workflow system instructions stay bounded as the catalog grows", () => {
	const small = buildWorkflowSystemInstructions({ models: models(24), ultracodeTriggered: false, ultracodeEffortMode: "one-prompt" });
	const huge = buildWorkflowSystemInstructions({ models: models(2_000, true), ultracodeTriggered: false, ultracodeEffortMode: "one-prompt" });
	assert.ok(small.length < 3_500, `small prompt was ${small.length} chars`);
	assert.ok(huge.length < 3_500, `huge prompt was ${huge.length} chars`);
	assert.ok(Math.abs(huge.length - small.length) < 600);
	assert.doesNotMatch(huge, /private-exact-model-id-/);
	assert.match(huge, /workflow_models/);
	assert.match(huge, /original language/);
});

test("compact catalog summary materially reduces a representative ModelHub prompt", () => {
	const catalog = models(24);
	const full = modelCatalogText(catalog);
	const compact = modelCatalogSummary(catalog);
	assert.ok(compact.length < full.length / 4, `${compact.length} was not less than one quarter of ${full.length}`);
	assert.doesNotMatch(compact, /private-exact-model-id-/);
	assert.match(compact, /openai:6/);
	assert.match(compact, /providers modelhub:24/);
	assert.match(compact, /Exact model IDs.*workflow_models/);
});

test("run-specific context contains the active policy rather than a model catalog", () => {
	const policy = {
		defaultRouting: "inherit",
		allowedFamilies: ["openai"],
		allowedModels: ["modelhub/gpt-5"],
		rationale: "Polish request semantically required OpenAI only.",
	} as const;
	const context = workflowPolicyContext(policy);
	assert.match(context, /"allowedFamilies":\["openai"\]/);
	assert.match(context, /modelhub\/gpt-5/);
	assert.doesNotMatch(context, /contextWindow|inputCost|outputCost|Authenticated models/);
});
