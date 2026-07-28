import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, type Component, type Focusable } from "@earendil-works/pi-tui";
import { fitLine } from "../ui/foundation/text.ts";
import { Surface } from "../ui/primitives/surface.ts";
import { paint } from "../ui/primitives/theme.ts";
import { FileSecretStore, installSecretService, removeSecretService, type SecretPromptOptions, type SecretService } from "./shared/secret-service.ts";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";

class MaskedSecretInput implements Component, Focusable {
	private readonly input = new Input();
	private readonly theme: Theme;
	private readonly options: SecretPromptOptions;
	private _focused = false;
	constructor(theme: Theme, options: SecretPromptOptions, done: (value: string | null) => void) {
		this.theme = theme;
		this.options = options;
		this.input.onSubmit = (value) => done(value);
		this.input.onEscape = () => done(null);
	}
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }
	handleInput(data: string): void { this.input.handleInput(data); }
	render(width: number): string[] {
		const length = this.input.getValue().length;
		const mask = length ? `${"•".repeat(Math.min(12, length))}${length > 12 ? "…" : ""} (${length} chars)` : this.options.placeholder ?? "Paste secret";
		return [
			fitLine(paint(this.theme, this.options.title, "accent", "strong"), width),
			...(this.options.description ? [fitLine(paint(this.theme, this.options.description, "muted"), width)] : []),
			"",
			fitLine(`${length ? paint(this.theme, mask, "neutral") : paint(this.theme, mask, "subtle")}${this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : ""}`, width),
			"",
			fitLine(paint(this.theme, "enter save · esc cancel · value is masked and never enters chat history", "subtle"), width),
		];
	}
	invalidate(): void { this.input.invalidate(); }
}

export default function secretsExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;
	const store = new FileSecretStore(path.join(getAgentDir(), "piplusplus-secrets.json"));
	const service: SecretService = {
		get: (id) => store.get(id), has: (id) => store.has(id), set: (id, value) => store.set(id, value), delete: (id) => store.delete(id), list: () => store.list(),
		async promptAndStore(id, options, ctx) {
			if (ctx.mode !== "tui") { ctx.ui.notify("Secret setup requires interactive TUI mode.", "warning"); return false; }
			const value = await ctx.ui.custom<string | null>((tui: any, theme: Theme, _keys: unknown, done: (value: string | null) => void) => {
				const body = new MaskedSecretInput(theme, options, done);
				const panel = new Surface({ theme, body, border: "frame", borderTone: "accent", padding: { top: 1, right: 2, bottom: 1, left: 2 }, background: "panel" });
				return { get focused() { return body.focused; }, set focused(value: boolean) { body.focused = value; }, render: (width: number) => panel.render(width), invalidate: () => panel.invalidate(), handleInput: (data: string) => { body.handleInput(data); tui.requestRender(); } };
			}, { overlay: true, overlayOptions: { width: 68, maxHeight: 14, anchor: "center", margin: 1 } });
			if (value === null) return false;
			const normalized = options.normalize?.(value) ?? value.trim();
			if (!normalized) { ctx.ui.notify("Secret cannot be empty.", "error"); return false; }
			try { await options.validate?.(normalized); await store.set(id, normalized); return true; }
			catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return false; }
		},
	};
	installSecretService(service);
	pi.on("session_shutdown", () => removeSecretService(service));
}
