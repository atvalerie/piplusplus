import type { Model } from "@earendil-works/pi-ai";
import type { ModelChoice, StepKind } from "./types.ts";

export function serializeModels(models: Model[]): ModelChoice[] {
	return models.map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning: Boolean(model.reasoning),
		contextWindow: model.contextWindow ?? 0,
		maxTokens: model.maxTokens ?? 0,
		inputCost: model.cost?.input ?? 0,
		outputCost: model.cost?.output ?? 0,
	}));
}

export function modelCatalogText(models: ModelChoice[]): string {
	return models.map((model) =>
		`- ${model.provider}/${model.id}: ${model.name}; ${model.reasoning ? "reasoning" : "non-reasoning"}; context ${model.contextWindow}; max output ${model.maxTokens}; $${model.inputCost}/$${model.outputCost} per M input/output`,
	).join("\n");
}

function versionScore(name: string): number {
	const numbers = [...name.matchAll(/(?:^|[^0-9])(\d+)(?:[.-](\d+))?/g)];
	if (!numbers.length) return 0;
	const last = numbers[numbers.length - 1];
	return Number(last[1] ?? 0) * 10 + Number(last[2] ?? 0);
}

/**
 * Auto is a fallback, not the primary planner. It deliberately relies on model
 * family/capability metadata rather than treating a high price as high quality.
 */
export function chooseAutoModel(models: Model[], kind: StepKind, main?: Model): Model | undefined {
	if (!models.length) return main;
	const fast = kind === "research" || kind === "discovery";
	const strong = kind === "planning" || kind === "review" || kind === "verification" || kind === "synthesis";
	const scored = models.map((model) => {
		const name = `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
		let score = Math.log2(Math.max(model.contextWindow ?? 0, 8_000));
		if (model.reasoning) score += strong ? 14 : 3;
		if (fast) {
			if (/spark|haiku|flash|mini|nano|small|fast/.test(name)) score += 30;
			if (/opus|max|pro|gpt-5\.5/.test(name)) score -= 12;
		} else if (kind === "implementation") {
			if (/codex|coder|code|sonnet/.test(name)) score += 18;
			if (/mini|nano|small/.test(name)) score -= 5;
		} else if (strong) {
			if (/opus|gpt-5\.5|max|pro|o3|o4/.test(name)) score += 24;
			if (/spark|haiku|flash|mini|nano|small/.test(name)) score -= 15;
		}
		score += Math.min(versionScore(name), 100) / 10;
		if (main && model.provider === main.provider && model.id === main.id && !fast) score += 5;
		return { model, score };
	});
	return scored.sort((a, b) => b.score - a.score)[0]?.model ?? main;
}

export function resolveModel(models: Model[], requested: string | undefined, kind: StepKind, main?: Model): Model | undefined {
	if (requested && requested !== "auto") {
		return models.find((model) => `${model.provider}/${model.id}` === requested)
			?? models.find((model) => model.id === requested);
	}
	return chooseAutoModel(models, kind, main);
}
