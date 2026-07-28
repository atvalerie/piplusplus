import type { Model } from "@earendil-works/pi-ai";
import type { ModelChoice, ModelFamilyPolicy, StepKind } from "./types.ts";

export function modelMatchesFamily(model: Pick<Model, "provider" | "id" | "name">, family: ModelFamilyPolicy): boolean {
	const name = `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
	if (family === "gpt") return /(?:^|[^a-z])gpt(?:[^a-z]|$)/i.test(name);
	if (family === "openai") return /openai|gpt|codex|(?:^|[\/\s])o[134](?:[-\s.]|$)/i.test(name);
	return /anthropic|claude/i.test(name);
}

export function inferModelFamilyInstruction(...values: Array<string | undefined>): ModelFamilyPolicy | undefined {
	const text = values.filter(Boolean).join("\n").toLowerCase();
	if (/\b(?:compare|mix|both|different)\b[^\n.]{0,80}\b(?:gpt|openai)\b[^\n.]{0,80}\b(?:claude|anthropic)\b|\b(?:compare|mix|both|different)\b[^\n.]{0,80}\b(?:claude|anthropic)\b[^\n.]{0,80}\b(?:gpt|openai)\b/.test(text)) return undefined;
	const gpt = /\b(?:use|pick|choose|select|must use|only use|all)\b[^\n.]{0,60}\b(?:gpt|openai)\b|\b(?:gpt|openai)(?:[-\s]+only)?\s+models?\b/.test(text);
	const claude = /\b(?:use|pick|choose|select|must use|only use|all)\b[^\n.]{0,60}\b(?:claude|anthropic)\b|\b(?:claude|anthropic)(?:[-\s]+only)?\s+models?\b/.test(text);
	if (gpt === claude) return undefined;
	if (gpt) return /\bopenai\b/.test(text) && !/\bgpt\b/.test(text) ? "openai" : "gpt";
	return "claude";
}

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
		const inputCost = Math.max(0, model.cost?.input ?? 0);
		const outputCost = Math.max(0, model.cost?.output ?? 0);
		let score = Math.log2(Math.max(model.contextWindow ?? 0, 8_000));
		if (model.reasoning) score += strong ? 14 : 2;
		if (fast) {
			if (/spark|haiku|flash|mini|nano|small|fast/.test(name)) score += 18;
			score -= Math.log2(1 + inputCost + outputCost) * 8;
		} else if (kind === "implementation") {
			if (/codex|coder|code/.test(name)) score += 12;
			if (/mini|nano|small/.test(name)) score -= 4;
		} else if (strong) {
			score += Math.log2(Math.max(model.maxTokens ?? 0, 4_096)) * 0.5;
			if (/mini|nano|small/.test(name)) score -= 10;
		}
		score += Math.min(versionScore(name), 100) / 20;
		if (main && model.provider === main.provider && model.id === main.id && !fast) score += 2;
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
