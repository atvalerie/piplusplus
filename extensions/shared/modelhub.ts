import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ProviderTelemetry, TelemetryKey, TelemetryLimit, TelemetryRecentRequest } from "./telemetry-service.ts";

export const MODELHUB_BASE_URL = "https://modelhub.my";

export interface ModelHubCatalogModel {
	id: string;
	provider: string;
	family: string;
	endpoints: string[];
	context_window: number;
	capabilities: { vision?: boolean; tools?: boolean; reasoning?: boolean; image_generation?: boolean; streaming?: boolean };
	free: boolean;
	sort_order?: number;
}
export interface ModelHubPrice { model: string; input_per_mtok: number; output_per_mtok: number; cache_read_per_mtok: number; is_tier?: boolean }
export interface ModelHubCatalog {
	catalog: ModelHubCatalogModel[];
	catalog_schema_version: number;
	currency: string;
	limits: { concurrent_streams?: number; free_rph?: number; free_rpm?: number; paid_rph?: number; paid_rpm?: number };
	prices: ModelHubPrice[];
	promo?: { active?: boolean; ends_at?: number; original?: Record<string, Omit<ModelHubPrice, "model">> };
	unit: string;
}

export type ModelHubFamily = string;

const MODEL_FAMILY_KEY = Symbol.for("piplusplus.modelhub-model-families");

function modelFamilies(): Map<string, ModelHubFamily> {
	const root = globalThis as any;
	return root[MODEL_FAMILY_KEY] ??= new Map<string, ModelHubFamily>();
}

function normalizeModelHubFamily(value: string): ModelHubFamily | undefined {
	const family = value.trim().toLowerCase();
	return family || undefined;
}

/** Preserve authoritative vendor metadata that Pi's generic Model type cannot carry. */
export function registerModelHubFamilies(catalog: Pick<ModelHubCatalog, "catalog">): void {
	const registry = modelFamilies();
	for (const model of catalog.catalog) {
		const family = normalizeModelHubFamily(model.family);
		if (family) registry.set(model.id, family);
	}
}

export function modelHubFamilyFor(model: { provider: string; id: string }): ModelHubFamily | undefined {
	if (!/^modelhub(?:-[2-8])?$/.test(model.provider.toLowerCase())) return undefined;
	return modelFamilies().get(model.id);
}

export interface ModelHubUsage {
	requests?: number; tokens?: number; cost?: number; spent_today?: number; spent_month?: number;
	success_requests?: number; cache_saved_tokens?: number; cache_base_tokens?: number;
	model_totals?: Array<{ model: string; input: number; output: number; cache: number; cost: number }>;
	recent?: Array<{ id: number | string; timestamp: string; model: string; input_tokens: number; output_tokens: number; cost: number; latency_ms?: number; success: boolean; error_reason?: string; cache_saving?: number }>;
}
export interface ModelHubBalance { available_usd?: number; balance_usd?: number; reserved_usd?: number }
export interface ModelHubMe {
	api_keys?: Array<{ id: number | string; name: string; is_active: boolean; rate_limit_rpm?: number; rate_limit_rph?: number; total_tokens_used?: number; total_cost?: number; total_requests?: number; spend_limit_usd?: number; expires_at?: string | null; auto_throttled?: boolean }>;
}

function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function apiFor(model: ModelHubCatalogModel): ProviderModelConfig["api"] {
	if (model.family === "anthropic" && model.endpoints.includes("/v1/messages")) return "anthropic-messages";
	if (model.family === "openai" && model.endpoints.includes("/v1/responses")) return "openai-responses";
	return "openai-completions";
}

function anthropicEffort(model: ModelHubCatalogModel): { adaptive: boolean; map?: Record<string, string> } {
	if (model.family !== "anthropic" || !model.capabilities.reasoning) return { adaptive: false };
	const adaptive = /^claude-(?:opus-(?:4-[6-9]|[5-9])|sonnet-(?:4-6|[5-9])|fable-[5-9])/i.test(model.id);
	if (!adaptive) return { adaptive: false };
	const nativeXhigh = /^claude-(?:opus-(?:4-[78]|[5-9])|sonnet-[5-9]|fable-[5-9])/i.test(model.id);
	return { adaptive: true, map: nativeXhigh ? { xhigh: "xhigh", max: "max" } : { max: "max" } };
}

export function catalogToModels(catalog: ModelHubCatalog): ProviderModelConfig[] {
	registerModelHubFamilies(catalog);
	const prices = new Map(catalog.prices.map((price) => [price.model, price]));
	return catalog.catalog
		.filter((model) => model.capabilities.streaming && !model.capabilities.image_generation && model.context_window > 0)
		.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
		.map((model) => {
			const price = prices.get(model.id);
			const api = apiFor(model);
			const modelHubGptEffort = model.family === "openai" && /^gpt-/i.test(model.id) && model.capabilities.reasoning
				? { xhigh: "xhigh", max: "xhigh" }
				: undefined;
			const claudeEffort = anthropicEffort(model);
			return {
				id: model.id,
				name: `${model.id} · ${model.provider}${model.free ? " · free" : ""}`,
				api,
				baseUrl: api === "anthropic-messages" ? MODELHUB_BASE_URL : `${MODELHUB_BASE_URL}/v1`,
				reasoning: Boolean(model.capabilities.reasoning),
				thinkingLevelMap: modelHubGptEffort ?? claudeEffort.map,
				input: model.capabilities.vision ? ["text", "image"] : ["text"],
				cost: { input: price?.input_per_mtok ?? 0, output: price?.output_per_mtok ?? 0, cacheRead: price?.cache_read_per_mtok ?? 0, cacheWrite: 0 },
				contextWindow: model.context_window,
				maxTokens: Math.min(model.context_window, 65_536),
				compat: claudeEffort.adaptive ? { forceAdaptiveThinking: true } : api === "openai-completions" && model.capabilities.reasoning ? { supportsReasoningEffort: true } : undefined,
			} satisfies ProviderModelConfig;
		});
}

export function dashboardCookie(value: string | undefined): string | undefined {
	const cookie = value?.trim();
	if (!cookie) return undefined;
	return cookie.includes("=") ? cookie : `__Host-fas_session=${cookie}`;
}

export async function fetchModelHub<T>(path: string, options: { apiKey?: string; cookie?: string; signal?: AbortSignal } = {}): Promise<T> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
	if (options.cookie) { headers.cookie = dashboardCookie(options.cookie)!; headers["x-requested-with"] = "XMLHttpRequest"; }
	const response = await fetch(`${MODELHUB_BASE_URL}${path}`, { headers, signal: options.signal });
	if (!response.ok) throw new Error(`ModelHub ${path}: HTTP ${response.status}`);
	return response.json() as Promise<T>;
}

export function estimateCacheSavings(usage: ModelHubUsage, catalog: ModelHubCatalog): number | undefined {
	if (!usage.recent?.length) return undefined;
	const prices = new Map(catalog.prices.map((price) => [price.model, price]));
	let total = 0;
	let known = false;
	for (const request of usage.recent) {
		const price = prices.get(request.model);
		if (!price || !request.success || !request.cache_saving) continue;
		total += request.cache_saving / 1_000_000 * Math.max(0, price.input_per_mtok - price.cache_read_per_mtok);
		known = true;
	}
	return known ? total : undefined;
}

export function estimateModelHubSavings(usage: ModelHubUsage, catalog: ModelHubCatalog): number | undefined {
	if (!usage.recent?.length) return undefined;
	const current = new Map(catalog.prices.map((price) => [price.model, price]));
	let total = 0;
	let known = false;
	for (const request of usage.recent) {
		if (!request.success) continue;
		const original = catalog.promo?.active ? catalog.promo.original?.[request.model] : undefined;
		const price = current.get(request.model);
		if (!price && !original) continue;
		const baseline = request.input_tokens / 1_000_000 * (original?.input_per_mtok ?? price!.input_per_mtok) + request.output_tokens / 1_000_000 * (original?.output_per_mtok ?? price!.output_per_mtok);
		total += Math.max(0, baseline - request.cost);
		known = true;
	}
	return known ? total : undefined;
}

export function normalizeModelHubTelemetry(input: { catalog: ModelHubCatalog; usage?: ModelHubUsage; balance?: ModelHubBalance; me?: ModelHubMe; quota?: Record<string, unknown>[]; message?: string }): ProviderTelemetry {
	const { catalog, usage, balance, me } = input;
	const limits: TelemetryLimit[] = [];
	for (const [id, label, value, unit, window] of [
		["paid-rpm", "Paid requests/min", catalog.limits.paid_rpm, "requests", "minute"],
		["paid-rph", "Paid requests/hour", catalog.limits.paid_rph, "requests", "hour"],
		["free-rpm", "Free requests/min", catalog.limits.free_rpm, "requests", "minute"],
		["free-rph", "Free requests/hour", catalog.limits.free_rph, "requests", "hour"],
		["streams", "Concurrent streams", catalog.limits.concurrent_streams, "streams", undefined],
	] as const) if (finite(value) !== undefined) limits.push({ id, label, limit: value, unit, window });
	const keys: TelemetryKey[] = (me?.api_keys ?? []).map((key) => ({
		id: String(key.id), name: key.name, active: key.is_active, requests: finite(key.total_requests), tokens: finite(key.total_tokens_used), cost: finite(key.total_cost),
		spendLimit: finite(key.spend_limit_usd), rpm: finite(key.rate_limit_rpm), rph: finite(key.rate_limit_rph),
		expiresAt: key.expires_at ? Date.parse(key.expires_at) : undefined, autoThrottled: key.auto_throttled,
	}));
	for (let index = 0; index < (input.quota?.length ?? 0); index++) {
		const quota = input.quota![index];
		const explicitId = quota.id ?? quota.key_id;
		const id = String(explicitId ?? `configured-${index + 1}`);
		const parsed: TelemetryKey = {
			id, name: String(quota.name ?? quota.key_name ?? `Configured key ${index + 1}`), active: quota.is_active !== false,
			requests: finite(quota.total_requests ?? quota.requests_used ?? quota.requests), tokens: finite(quota.total_tokens_used ?? quota.tokens_used ?? quota.tokens),
			cost: finite(quota.total_cost ?? quota.spend_used_usd ?? quota.spent_usd ?? quota.cost), spendLimit: finite(quota.spend_limit_usd ?? quota.max_spend_usd),
			rpm: finite(quota.rate_limit_rpm ?? quota.rpm_limit ?? quota.rpm), rph: finite(quota.rate_limit_rph ?? quota.rph_limit ?? quota.rph),
			expiresAt: typeof quota.expires_at === "string" ? Date.parse(quota.expires_at) : finite(quota.expires_at), autoThrottled: quota.auto_throttled === true,
		};
		let existing = explicitId === undefined ? -1 : keys.findIndex((key) => key.id === String(explicitId));
		if (existing < 0 && explicitId === undefined && parsed.cost !== undefined) {
			const matching = keys.map((key, keyIndex) => ({ key, keyIndex })).filter(({ key }) => key.cost !== undefined && Math.abs(key.cost - parsed.cost!) < 1e-9);
			if (matching.length === 1) existing = matching[0].keyIndex;
		}
		if (existing < 0 && explicitId === undefined && keys.length === 1 && input.quota?.length === 1) existing = 0;
		if (existing >= 0) {
			const identity = keys[existing];
			keys[existing] = { ...identity, ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)), id: identity.id, name: identity.name } as TelemetryKey;
		} else keys.push(parsed);
	}
	const recent: TelemetryRecentRequest[] = (usage?.recent ?? []).map((request) => ({ id: String(request.id), timestamp: Date.parse(request.timestamp), model: request.model, inputTokens: request.input_tokens, outputTokens: request.output_tokens, cost: request.cost, latencyMs: request.latency_ms, success: request.success, error: request.error_reason || undefined, cacheSavedTokens: request.cache_saving }));
	return {
		provider: "modelhub", label: "ModelHub", fetchedAt: Date.now(), currency: catalog.currency,
		balance: finite(balance?.available_usd ?? balance?.balance_usd), reservedBalance: finite(balance?.reserved_usd), spentToday: finite(usage?.spent_today), spentMonth: finite(usage?.spent_month),
		totalCost: finite(usage?.cost), requests: finite(usage?.requests), tokens: finite(usage?.tokens), successRequests: finite(usage?.success_requests),
		cacheSavedTokens: finite(usage?.cache_saved_tokens), cacheBaseTokens: finite(usage?.cache_base_tokens), estimatedCacheSavings: usage ? estimateCacheSavings(usage, catalog) : undefined,
		estimatedSavings: usage ? estimateModelHubSavings(usage, catalog) : undefined,
		limits, keys, models: usage?.model_totals?.map((model) => ({ model: model.model, input: model.input, output: model.output, cache: model.cache, cost: model.cost })), recent, message: input.message,
	};
}
