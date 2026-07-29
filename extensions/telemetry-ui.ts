import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type Terminal } from "@earendil-works/pi-tui";
import { fitLine } from "../ui/foundation/text.ts";
import { Inspector, type InspectorSection } from "../ui/interactive/inspector.ts";
import { Surface } from "../ui/primitives/surface.ts";
import { paint } from "../ui/primitives/theme.ts";
import { formatCount } from "../ui/interface/footer.ts";
import { getSecretService } from "./shared/secret-service.ts";
import { getTelemetryService, type ProviderTelemetry } from "./shared/telemetry-service.ts";
import { registerPiPlusPlusSettingsSection } from "./shared/settings-service.ts";

function money(value: number | undefined): string { return value === undefined ? "—" : `$${value.toFixed(value < 1 ? 4 : 2)}`; }

function sections(snapshot: ProviderTelemetry): InspectorSection[] {
	const success = snapshot.requests && snapshot.successRequests !== undefined ? `${Math.round(snapshot.successRequests / snapshot.requests * 100)}%` : "—";
	const result: InspectorSection[] = [{
		id: "overview", label: "Overview", content: [
			`Balance       ${money(snapshot.balance)}${snapshot.reservedBalance ? ` (${money(snapshot.reservedBalance)} reserved)` : ""}`,
			`Today         ${money(snapshot.spentToday)}`,
			`This month    ${money(snapshot.spentMonth)}`,
			`Lifetime      ${money(snapshot.totalCost)}`,
			`Requests      ${snapshot.requests ?? "—"} (${success} successful)`,
			`Tokens        ${snapshot.tokens === undefined ? "—" : formatCount(snapshot.tokens)}`,
			`Est. saved    ${money(snapshot.estimatedSavings)}`,
			`Cache saved   ${snapshot.cacheSavedTokens === undefined ? "—" : formatCount(snapshot.cacheSavedTokens)} tokens${snapshot.estimatedCacheSavings === undefined ? "" : ` · est. ${money(snapshot.estimatedCacheSavings)}`}`,
		],
	}];
	if (snapshot.limits?.length) result.push({ id: "limits", label: "Platform limits", content: snapshot.limits.map((limit) => `${limit.label}: ${limit.used === undefined ? "" : `${limit.used}/`}${limit.limit ?? "—"}${limit.window ? ` per ${limit.window}` : ""}`) });
	if (snapshot.keys?.length) result.push({ id: "keys", label: `API keys (${snapshot.keys.length})`, content: snapshot.keys.map((key) => `${key.active ? "●" : "○"} ${key.name} · ${key.requests ?? "—"} req · ${money(key.cost)}${key.spendLimit ? `/${money(key.spendLimit)}` : ""}${key.rpm ? ` · ${key.rpm} RPM` : ""}${key.rph ? ` · ${key.rph} RPH` : ""}${key.autoThrottled ? " · throttled" : ""}`) });
	if (snapshot.models?.length) result.push({ id: "models", label: "Usage by model", collapsed: true, content: snapshot.models.map((model) => `${model.model} · ${model.requests ?? "—"} req · ${formatCount(model.input ?? model.tokens ?? 0)} in · ${formatCount(model.output ?? 0)} out · ${money(model.cost)}`) });
	if (snapshot.recent?.length) result.push({ id: "recent", label: "Recent requests", collapsed: true, content: snapshot.recent.slice(0, 30).map((request) => `${request.success ? "✓" : "×"} ${request.model} · ${formatCount(request.inputTokens)}→${formatCount(request.outputTokens)} · ${money(request.cost)}${request.latencyMs === undefined ? "" : ` · ${(request.latencyMs / 1000).toFixed(1)}s`}${request.error ? ` · ${request.error}` : ""}`) });
	if (snapshot.message) result.push({ id: "notice", label: "Notice", content: snapshot.message, tone: "warning" });
	return result;
}

class TelemetryPanel implements Component {
	private readonly inspector: Inspector;
	private readonly theme: Theme;
	private readonly close: () => void;
	constructor(snapshot: ProviderTelemetry, theme: Theme, height: number, close: () => void) { this.theme = theme; this.close = close; this.inspector = new Inspector({ theme, sections: sections(snapshot), height }); }
	handleInput(data: string): void { if (matchesKey(data, Key.escape) || data === "q") this.close(); else this.inspector.handleInput(data); }
	render(width: number): string[] { return [fitLine(paint(this.theme, "Provider telemetry", "accent", "strong"), width), "", ...this.inspector.render(width), "", fitLine("↑↓ sections · j/k, pgup/pgdn, or wheel scroll · enter expand · q close", width)]; }
	invalidate(): void { this.inspector.invalidate(); }
}

export default function telemetryUi(pi: ExtensionAPI) {
	const handleTelemetry = async (args: string, ctx: ExtensionCommandContext) => {
			const service = getTelemetryService();
			if (!service) { ctx.ui.notify("Enable the telemetry-core extension first.", "warning"); return; }
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const action = parts[0];
			const activeProvider = ctx.model?.provider.startsWith("modelhub") ? "modelhub" : undefined;
			if (action === "setup") {
				const provider = parts[1] ?? activeProvider ?? service.getAll()[0]?.provider;
				const source = provider ? service.getSource(provider) : undefined;
				if (!source?.secret) { ctx.ui.notify(`No secret setup is available for ${provider ?? "this provider"}.`, "warning"); return; }
				const secrets = getSecretService();
				if (!secrets) { ctx.ui.notify("Enable the secrets extension first.", "warning"); return; }
				const saved = await secrets.promptAndStore(source.secret.id, source.secret, ctx);
				if (!saved) return;
				await service.refresh(provider);
				ctx.ui.notify(`${source.secret.title} saved.`, "info");
				return;
			}
			if (action === "clear" || action === "logout") {
				const provider = parts[1] ?? activeProvider ?? service.getAll()[0]?.provider;
				const source = provider ? service.getSource(provider) : undefined;
				const secrets = getSecretService();
				if (!source?.secret || !secrets) { ctx.ui.notify("No stored telemetry secret is available.", "warning"); return; }
				await secrets.delete(source.secret.id);
				await service.refresh(provider);
				ctx.ui.notify(`${source.secret.title} removed. Environment configuration, if present, may still take precedence.`, "info");
				return;
			}
			const requested = action;
			await service.refresh(requested || undefined);
			const snapshot = requested ? service.get(requested) : service.get(activeProvider);
			if (!snapshot) { ctx.ui.notify("No telemetry source is available.", "warning"); return; }
			if (ctx.mode !== "tui") { ctx.ui.notify(`${snapshot.label}: balance ${money(snapshot.balance)}, month ${money(snapshot.spentMonth)}`, "info"); return; }
			let mouseTerminal: Terminal | undefined;
			try {
				await ctx.ui.custom<void>((tui, theme, _keys, done) => {
					mouseTerminal = tui.terminal;
					mouseTerminal.write("\x1b[?1000h\x1b[?1006h");
					const body = new TelemetryPanel(snapshot, theme, Math.max(8, Math.floor(tui.terminal.rows * 0.9) - 9), done);
					const panel = new Surface({ theme, body, border: "frame", borderTone: "accent", padding: { top: 1, right: 2, bottom: 1, left: 2 }, background: "panel" });
					return { render: (width) => panel.render(width), invalidate: () => panel.invalidate(), handleInput: (data) => { body.handleInput(data); tui.requestRender(); } };
				}, { overlay: true, overlayOptions: { width: "48%", minWidth: 48, maxHeight: "90%", anchor: "right-center", margin: 1 } });
			} finally { mouseTerminal?.write("\x1b[?1006l\x1b[?1000l"); }
	};

	pi.registerCommand("telemetry", {
		description: "View telemetry or run setup|clear [provider]",
		handler: handleTelemetry,
	});

	const unregisterSettings = registerPiPlusPlusSettingsSection({
		id: "integrations",
		label: "Integrations",
		description: "Provider telemetry and owner-only credential setup",
		order: 40,
		summary: () => {
			const service = getTelemetryService();
			const count = service?.getAll().length ?? 0;
			return `${count} telemetry source${count === 1 ? "" : "s"}`;
		},
		open: async (ctx) => {
			while (ctx.hasUI) {
				const service = getTelemetryService();
				const providers = service?.getAll().map((item) => item.provider) ?? [];
				const selected = await ctx.ui.select("Pi++ integrations", ["View provider telemetry", "Set up telemetry credential", "Clear telemetry credential", "Back"]);
				if (!selected || selected === "Back") return;
				let provider: string | undefined;
				if (providers.length > 1) provider = await ctx.ui.select("Provider", providers);
				else provider = providers[0];
				if (providers.length > 1 && !provider) continue;
				if (selected === "View provider telemetry") await handleTelemetry(provider ?? "", ctx);
				else if (selected === "Set up telemetry credential") await handleTelemetry(`setup${provider ? ` ${provider}` : ""}`, ctx);
				else await handleTelemetry(`clear${provider ? ` ${provider}` : ""}`, ctx);
			}
		},
	});
	pi.on("session_shutdown", () => unregisterSettings());
}
