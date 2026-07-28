import assert from "node:assert/strict";
import test from "node:test";
import { catalogToModels, dashboardCookie, estimateCacheSavings, estimateModelHubSavings, modelHubFamilyFor, normalizeModelHubTelemetry, type ModelHubCatalog } from "../extensions/shared/modelhub.ts";

const catalog: ModelHubCatalog = {
	catalog_schema_version: 2, currency: "USD", unit: "per_1m_tokens",
	limits: { concurrent_streams: 20, free_rph: 150, free_rpm: 15, paid_rph: 600, paid_rpm: 60 },
	catalog: [
		{ id: "claude-test", provider: "Anthropic", family: "anthropic", endpoints: ["/v1/messages"], context_window: 200_000, capabilities: { vision: true, reasoning: true, streaming: true }, free: false },
		{ id: "gpt-test", provider: "OpenAI", family: "openai", endpoints: ["/v1/responses"], context_window: 256_000, capabilities: { vision: true, reasoning: true, streaming: true }, free: true },
		{ id: "grok-test", provider: "xAI", family: "xai", endpoints: ["/v1/chat/completions"], context_window: 128_000, capabilities: { reasoning: true, streaming: true }, free: false },
		{ id: "image-test", provider: "OpenAI", family: "openai", endpoints: ["/v1/images/generations"], context_window: 0, capabilities: { image_generation: true, streaming: false }, free: false },
	],
	prices: [
		{ model: "claude-test", input_per_mtok: 0.2, output_per_mtok: 1, cache_read_per_mtok: 0.02 },
		{ model: "gpt-test", input_per_mtok: 0.03, output_per_mtok: 0.15, cache_read_per_mtok: 0.005 },
		{ model: "grok-test", input_per_mtok: 0.1, output_per_mtok: 0.5, cache_read_per_mtok: 0.01 },
	],
};

test("ModelHub provider imports against the Pi 0.82 public API surface", async () => {
	const provider = await import("../extensions/modelhub-provider.ts");
	assert.equal(typeof provider.default, "function");
});

test("ModelHub catalog maps compatible endpoints, capabilities, and live prices", () => {
	const models = catalogToModels(catalog);
	assert.equal(models.length, 3);
	assert.equal(models[0].api, "anthropic-messages");
	assert.equal(models[0].baseUrl, "https://modelhub.my");
	assert.deepEqual(models[0].input, ["text", "image"]);
	assert.equal(models[0].cost.input, 0.2);
	assert.equal(models[1].api, "openai-responses");
	assert.equal(models[1].baseUrl, "https://modelhub.my/v1");
	assert.equal(models[1].cost.cacheRead, 0.005);
	assert.deepEqual(models[1].thinkingLevelMap, { xhigh: "xhigh", max: "xhigh" });
	assert.equal(models[0].thinkingLevelMap, undefined);
	assert.equal(modelHubFamilyFor({ provider: "modelhub", id: "claude-test" }), "anthropic");
	assert.equal(modelHubFamilyFor({ provider: "modelhub-8", id: "gpt-test" }), "openai");
	assert.equal(modelHubFamilyFor({ provider: "modelhub", id: "grok-test" }), "xai");
	assert.equal(modelHubFamilyFor({ provider: "other", id: "gpt-test" }), undefined);

	const claudeModels = catalogToModels({ ...catalog, prices: [], catalog: [
		{ ...catalog.catalog[0], id: "claude-opus-4-8" },
		{ ...catalog.catalog[0], id: "claude-sonnet-4-6" },
		{ ...catalog.catalog[0], id: "claude-haiku-4-5" },
	] });
	assert.deepEqual(claudeModels[0].thinkingLevelMap, { xhigh: "xhigh", max: "max" });
	assert.deepEqual(claudeModels[0].compat, { forceAdaptiveThinking: true });
	assert.deepEqual(claudeModels[1].thinkingLevelMap, { max: "max" });
	assert.equal(claudeModels[2].thinkingLevelMap, undefined);
});

test("ModelHub dashboard cookie accepts either the JWT value or complete cookie", () => {
	assert.equal(dashboardCookie("abc.def.ghi"), "__Host-fas_session=abc.def.ghi");
	assert.equal(dashboardCookie("__Host-fas_session=abc"), "__Host-fas_session=abc");
	assert.equal(dashboardCookie(undefined), undefined);
});

test("ModelHub telemetry normalizes account and multiple key limits", () => {
	const usage = {
		requests: 10, success_requests: 9, tokens: 100_000, cost: 0.12, spent_today: 0.02, spent_month: 0.12, cache_saved_tokens: 50_000, cache_base_tokens: 100_000,
		recent: [{ id: 1, timestamp: "2026-07-28T00:00:00Z", model: "claude-test", input_tokens: 10_000, output_tokens: 100, cost: 0.001, success: true, cache_saving: 5_000 }],
	};
	assert.ok(Math.abs((estimateCacheSavings(usage, catalog) ?? 0) - 0.0009) < 1e-12);
	assert.ok(Math.abs((estimateModelHubSavings(usage, catalog) ?? 0) - 0.0011) < 1e-12);
	const snapshot = normalizeModelHubTelemetry({
		catalog, usage, balance: { available_usd: 1.5, reserved_usd: 0.1 },
		me: { api_keys: [{ id: 7, name: "main", is_active: true, total_requests: 10, total_cost: 0.12, spend_limit_usd: 1, rate_limit_rpm: 12 }] },
		quota: [{ key_id: 8, key_name: "secondary", requests_used: 2, max_spend_usd: 0.5, rate_limit_rph: 30 }],
	});
	assert.equal(snapshot.balance, 1.5);
	assert.equal(snapshot.keys?.length, 2);
	assert.equal(snapshot.keys?.[1].rph, 30);
	assert.equal(snapshot.limits?.find((limit) => limit.id === "paid-rpm")?.limit, 60);
	assert.equal(snapshot.recent?.[0].cacheSavedTokens, 5_000);

	const merged = normalizeModelHubTelemetry({
		catalog,
		me: { api_keys: [{ id: 7, name: "main", is_active: true, total_cost: 0.12, total_requests: 10 }] },
		quota: [{ total_cost: 0.12, rate_limit_rpm: 60, rate_limit_rph: 600 }],
	});
	assert.equal(merged.keys?.length, 1);
	assert.equal(merged.keys?.[0].name, "main");
	assert.equal(merged.keys?.[0].rpm, 60);
});
