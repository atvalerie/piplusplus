import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dashboardCookie, fetchModelHub, normalizeModelHubTelemetry, type ModelHubBalance, type ModelHubCatalog, type ModelHubMe, type ModelHubUsage } from "./shared/modelhub.ts";
import { getSecretService } from "./shared/secret-service.ts";
import { getTelemetryService, registerTelemetrySource } from "./shared/telemetry-service.ts";

function apiKeys(): string[] {
	const values = [process.env.MODELHUB_API_KEY, ...Array.from({ length: 7 }, (_, index) => process.env[`MODELHUB_API_KEY_${index + 2}`]), ...(process.env.MODELHUB_API_KEYS?.split(",") ?? [])];
	return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export default function modelHubTelemetry(pi: ExtensionAPI) {
	let currentContext: ExtensionContext | undefined;
	const unregister = registerTelemetrySource({
		id: "modelhub",
		secret: {
			id: "modelhub.dashboard-cookie",
			title: "ModelHub dashboard session",
			description: "Paste the __Host-fas_session cookie from your signed-in ModelHub browser session.",
			placeholder: "__Host-fas_session=…",
			normalize: (value) => dashboardCookie(value) ?? "",
			async validate(value, signal) { await fetchModelHub<ModelHubMe>("/api/auth/me", { cookie: value, signal }); },
		},
		async refresh(signal) {
			const catalog = await fetchModelHub<ModelHubCatalog>("/api/wallet/prices", { signal });
			const cookie = process.env.MODELHUB_SESSION_COOKIE ?? getSecretService()?.get("modelhub.dashboard-cookie");
			let usage: ModelHubUsage | undefined;
			let balance: ModelHubBalance | undefined;
			let me: ModelHubMe | undefined;
			const errors: string[] = [];
			if (cookie) {
				const results = await Promise.allSettled([
					fetchModelHub<ModelHubUsage>("/api/auth/usage", { cookie, signal }),
					fetchModelHub<ModelHubBalance>("/api/wallet/balance", { cookie, signal }),
					fetchModelHub<ModelHubMe>("/api/auth/me", { cookie, signal }),
				]);
				if (results[0].status === "fulfilled") usage = results[0].value; else errors.push(results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason));
				if (results[1].status === "fulfilled") balance = results[1].value; else errors.push(results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason));
				if (results[2].status === "fulfilled") me = results[2].value; else errors.push(results[2].reason instanceof Error ? results[2].reason.message : String(results[2].reason));
			}
			// API-key quota calls are intentionally independent: one invalid key must not hide account telemetry.
			const configuredKeys = apiKeys();
			try {
				const resolved = await currentContext?.modelRegistry.getProviderAuth("modelhub");
				if (resolved?.auth.apiKey) configuredKeys.unshift(resolved.auth.apiKey);
			} catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
			const uniqueKeys = [...new Set(configuredKeys)];
			const quotas = await Promise.all(uniqueKeys.map(async (apiKey) => {
				try { return await fetchModelHub<Record<string, unknown>>("/api/quota", { apiKey, signal }); }
				catch (error) { errors.push(error instanceof Error ? error.message : String(error)); return undefined; }
			}));
			return normalizeModelHubTelemetry({ catalog, usage, balance, me, quota: quotas.filter((item): item is Record<string, unknown> => Boolean(item)), message: errors.length ? errors.join(" · ") : cookie || uniqueKeys.length ? undefined : "Run /login for API-key quota and /telemetry setup modelhub for account analytics." });
		},
	});
	pi.on("session_start", (_event, ctx) => { currentContext = ctx; void getTelemetryService()?.refresh("modelhub"); });
	pi.on("session_shutdown", () => { currentContext = undefined; unregister(); });
}
