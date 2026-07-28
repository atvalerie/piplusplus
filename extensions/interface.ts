import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ControlRoomEditor } from "../ui/interface/editor.ts";
import { EffortPicker, effortLevels, type EffortLevel } from "../ui/interface/effort.ts";
import { renderFooter } from "../ui/interface/footer.ts";
import { KeybindingBrowser } from "../ui/interface/keybindings.ts";
import { PiPlusPlusKeybindingRegistry } from "../ui/interface/piplusplus-keybindings.ts";
import { Surface } from "../ui/primitives/surface.ts";
import { getTelemetryService } from "./shared/telemetry-service.ts";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";

export default function interfaceExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;
	const registry = new PiPlusPlusKeybindingRegistry(path.join(getAgentDir(), "piplusplus-keybindings.json"));

	const showEffort = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const picker = new EffortPicker({
				theme,
				current: pi.getThinkingLevel() as EffortLevel,
				close: () => done(),
				select: (level) => {
					pi.setThinkingLevel(level);
					ctx.ui.notify(`Reasoning effort: ${pi.getThinkingLevel()}`, "info");
					done();
				},
			});
			const panel = new Surface({ theme, body: picker, border: "frame", borderTone: "accent", padding: { top: 1, right: 2, bottom: 1, left: 2 }, background: "panel" });
			return { render: (width) => panel.render(width), invalidate: () => panel.invalidate(), handleInput: (data) => { picker.handleInput(data); tui.requestRender(); } };
		}, { overlay: true, overlayOptions: { width: 68, maxHeight: 18, anchor: "center", margin: 1 } });
	};

	const showKeybindings = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			const browser = new KeybindingBrowser({
				theme,
				keybindings,
				height: Math.max(12, Math.floor(tui.terminal.rows * 0.8) - 4),
				close: () => done(),
				notify: (message, level) => ctx.ui.notify(message, level),
				configPath: path.join(getAgentDir(), "keybindings.json"),
				extraBindings: () => registry.getDefinitions().map((definition) => ({
					action: definition.id,
					description: definition.description,
					keys: registry.getKeys(definition.id),
					custom: registry.isCustomized(definition.id),
					set: (keys) => registry.set(definition.id, keys),
				})),
			});
			const panel = new Surface({ theme, body: browser, border: "frame", borderTone: "accent", padding: { top: 1, right: 2, bottom: 1, left: 2 }, background: "panel" });
			return { render: (width) => panel.render(width), invalidate: () => panel.invalidate(), handleInput: (data) => { browser.handleInput(data); tui.requestRender(); } };
		}, { overlay: true, overlayOptions: { width: "86%", maxHeight: "86%", anchor: "center", margin: 1 } });
	};

	pi.registerCommand("effort", {
		description: "Choose reasoning effort or set off|minimal|low|medium|high|xhigh|max",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase() as EffortLevel;
			if (!requested) { await showEffort(ctx); return; }
			if (!effortLevels.includes(requested)) { ctx.ui.notify("Usage: /effort [off|minimal|low|medium|high|xhigh|max]", "error"); return; }
			pi.setThinkingLevel(requested);
			ctx.ui.notify(`Reasoning effort: ${pi.getThinkingLevel()}`, "info");
		},
	});

	pi.registerCommand("keybindings", { description: "Browse, search, and configure every Pi keybinding", handler: async (_args, ctx) => showKeybindings(ctx) });

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const editor = new ControlRoomEditor(tui, editorTheme, keybindings, ctx.ui.theme);
			editor.onPiPlusPlusShortcut = (data) => {
				if (registry.matches(data, "piplusplus.keybindings.open")) { void showKeybindings(ctx); return true; }
				if (registry.matches(data, "piplusplus.effort.open")) { void showEffort(ctx); return true; }
				return false;
			};
			return editor;
		});

		ctx.ui.setWorkingIndicator({
			frames: [
				ctx.ui.theme.fg("dim", "·"),
				ctx.ui.theme.fg("muted", "•"),
				ctx.ui.theme.fg("accent", "●"),
				ctx.ui.theme.fg("muted", "•"),
			],
			intervalMs: 120,
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			const unsubscribeTelemetry = getTelemetryService()?.subscribe(() => tui.requestRender());
			return {
				dispose: () => { unsubscribeBranch(); unsubscribeTelemetry?.(); },
				invalidate() {},
				render(width: number): string[] {
					let inputTokens = 0;
					let outputTokens = 0;
					let cost = 0;
					let latestContextTokens: number | undefined;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const message = entry.message as AssistantMessage;
						inputTokens += message.usage.input;
						outputTokens += message.usage.output;
						cost += message.usage.cost.total;
						latestContextTokens = message.usage.totalTokens;
					}
					const contextPercent = latestContextTokens !== undefined && ctx.model?.contextWindow
						? latestContextTokens / ctx.model.contextWindow * 100
						: undefined;
					const telemetry = ctx.model?.provider.startsWith("modelhub") ? getTelemetryService()?.get("modelhub") : undefined;
					return renderFooter({
						project: path.basename(ctx.cwd),
						branch: footerData.getGitBranch() ?? undefined,
						model: ctx.model?.id ?? "no model",
						thinking: pi.getThinkingLevel(),
						inputTokens,
						outputTokens,
						contextPercent,
						cost,
						providerBalance: telemetry?.balance,
						providerSavings: telemetry?.estimatedSavings,
						statuses: [...footerData.getExtensionStatuses().values()],
					}, width, theme);
				},
			};
		});
	});
}
