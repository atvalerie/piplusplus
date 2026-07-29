import type { Model } from "@earendil-works/pi-ai";
import { modelHubFamilyFor } from "../shared/modelhub.ts";
import type { DefaultModelRouting, ModelChoice, ModelFamily, StepKind, ThinkingLevel, WorkflowModelPolicy, WorkflowProvider } from "./types.ts";

export const SUPPORTED_WORKFLOW_PROVIDERS = ["opencode-go", "anthropic", "openai", "modelhub"] as const satisfies readonly WorkflowProvider[];
const SUPPORTED_PROVIDER_SET = new Set<string>(SUPPORTED_WORKFLOW_PROVIDERS);
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function supportedThinkingLevels(model: Pick<Model, "reasoning" | "thinkingLevelMap">): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Mirrors Pi's public thinking-level clamp without introducing a runtime dependency on Pi internals. */
export function resolveWorkflowThinking(
	model: Pick<Model, "reasoning" | "thinkingLevelMap">,
	requested: ThinkingLevel,
): { effective: ThinkingLevel; provider: string } {
	const supported = supportedThinkingLevels(model);
	let effective = supported.includes(requested) ? requested : undefined;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	if (!effective) {
		for (let index = requestedIndex; index < THINKING_LEVELS.length; index++) {
			const candidate = THINKING_LEVELS[index];
			if (supported.includes(candidate)) { effective = candidate; break; }
		}
	}
	if (!effective) {
		for (let index = requestedIndex - 1; index >= 0; index--) {
			const candidate = THINKING_LEVELS[index];
			if (supported.includes(candidate)) { effective = candidate; break; }
		}
	}
	effective ??= supported[0] ?? "off";
	return { effective, provider: model.thinkingLevelMap?.[effective] ?? effective };
}

/**
 * Normalize exact Pi provider IDs into the four provider groups supported by
 * workflows. Pi exposes ChatGPT Plus/Pro OAuth models through `openai-codex`,
 * while API-key OpenAI models use `openai`; both are OpenAI sources for policy
 * purposes, but the exact provider ID is preserved when launching a child.
 */
export function workflowProvider(model: Pick<Model, "provider">): WorkflowProvider | undefined {
	const provider = model.provider.trim().toLowerCase();
	if (/^modelhub(?:-[2-8])?$/.test(provider)) return "modelhub";
	if (provider === "openai-codex") return "openai";
	return SUPPORTED_PROVIDER_SET.has(provider) ? provider as WorkflowProvider : undefined;
}

export function filterSupportedWorkflowModels<T extends Pick<Model, "provider">>(models: T[]): T[] {
	return models.filter((model) => workflowProvider(model) !== undefined);
}

export function modelFamily(model: Pick<Model, "provider" | "id" | "name">): ModelFamily | undefined {
	const modelHub = modelHubFamilyFor(model);
	if (modelHub) return modelHub;
	const provider = model.provider.toLowerCase();
	if (provider === "openai" || provider === "openai-codex") return "openai";
	if (provider === "anthropic") return "anthropic";
	return undefined;
}

export function modelAllowedByPolicy(
	model: Pick<Model, "provider" | "id" | "name">,
	policy: WorkflowModelPolicy,
): boolean {
	const fullId = `${model.provider}/${model.id}`;
	if (policy.allowedProviders?.length) {
		const provider = workflowProvider(model);
		if (!provider || !policy.allowedProviders.includes(provider)) return false;
	}
	if (policy.allowedModels?.length && !policy.allowedModels.includes(fullId) && !policy.allowedModels.includes(model.id)) return false;
	if (policy.allowedFamilies?.length) {
		const family = modelFamily(model);
		if (!family || !policy.allowedFamilies.includes(family)) return false;
	}
	return true;
}

export function serializeModels(models: Model[]): ModelChoice[] {
	return models.map((model) => ({
		provider: model.provider,
		providerGroup: workflowProvider(model),
		id: model.id,
		name: model.name ?? model.id,
		reasoning: Boolean(model.reasoning),
		contextWindow: model.contextWindow ?? 0,
		maxTokens: model.maxTokens ?? 0,
		inputCost: model.cost?.input ?? 0,
		outputCost: model.cost?.output ?? 0,
		family: modelFamily(model),
	}));
}

export function modelCatalogText(models: ModelChoice[]): string {
	return models.map((model) =>
		`- ${model.provider}/${model.id}: ${model.name}; provider group ${model.providerGroup ?? "unsupported"}; family ${model.family ?? "unknown"}; ${model.reasoning ? "reasoning" : "non-reasoning"}; context ${model.contextWindow}; max output ${model.maxTokens}; $${model.inputCost}/$${model.outputCost} per M input/output`,
	).join("\n");
}

/** Bounded main-agent summary. Exact identities stay behind workflow_models. */
export function modelCatalogSummary(models: ModelChoice[]): string {
	const providerCounts = new Map<string, number>();
	const familyCounts = new Map<string, number>();
	let reasoning = 0;
	for (const model of models) {
		const provider = model.providerGroup ?? workflowProvider(model) ?? "unsupported";
		providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
		const family = (model.family ?? "unknown").trim().toLowerCase().slice(0, 32) || "unknown";
		familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
		if (model.reasoning) reasoning++;
	}
	const entries = [...familyCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
	const shown = entries.slice(0, 12);
	const hiddenFamilies = Math.max(0, entries.length - shown.length);
	const families = shown.map(([family, count]) => `${family}:${count}`).join(", ") || "none";
	const providers = [...providerCounts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([provider, count]) => `${provider}:${count}`)
		.join(", ") || "none";
	return `${models.length} authenticated supported models; providers ${providers}; families ${families}${hiddenFamilies ? `, +${hiddenFamilies} more families` : ""}; reasoning-capable:${reasoning}. Exact model IDs and prices are intentionally omitted here; call workflow_models before exact, provider, or cross-family routing.`;
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

export function resolveModel(
	models: Model[],
	requested: string | undefined,
	kind: StepKind,
	main?: Model,
	defaultRouting: DefaultModelRouting = "inherit",
): Model | undefined {
	if (requested && requested !== "auto") {
		if (requested === "inherit") {
			return main && models.some((model) => model.provider === main.provider && model.id === main.id) ? main : undefined;
		}
		return models.find((model) => `${model.provider}/${model.id}` === requested)
			?? models.find((model) => model.id === requested);
	}
	if (requested === "auto" || defaultRouting === "auto") return chooseAutoModel(models, kind, main);
	return main && models.some((model) => model.provider === main.provider && model.id === main.id) ? main : undefined;
}

export function reportedModelMatches(expected: Pick<Model, "provider" | "id">, reported: string | undefined): boolean {
	return reported === expected.id || reported === `${expected.provider}/${expected.id}`;
}
