import * as fs from "node:fs";
import * as path from "node:path";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, parseKey, type Component, type KeyId, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { columns } from "../foundation/geometry.ts";
import { symbols } from "../foundation/symbols.ts";
import { fitLine } from "../foundation/text.ts";
import { paint } from "../primitives/theme.ts";
import { Viewport } from "../interactive/viewport.ts";

export interface ExtraKeybinding {
	action: string;
	description: string;
	keys: KeyId[];
	custom: boolean;
	set: (keys: KeyId[] | undefined) => void;
}

interface BindingRow {
	action: string;
	description: string;
	keys: KeyId[];
	custom: boolean;
	extra?: ExtraKeybinding;
}

export interface KeybindingBrowserOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	height: number;
	close: () => void;
	notify: (message: string, level: "info" | "warning" | "error") => void;
	configPath: string;
	extraBindings?: () => readonly ExtraKeybinding[];
}

type CaptureMode = "replace" | "add";

export class KeybindingBrowser implements Component {
	private readonly options: KeybindingBrowserOptions;
	private viewport = new Viewport();
	private selected = 0;
	private query = "";
	private searching = false;
	private capture?: CaptureMode;

	constructor(options: KeybindingBrowserOptions) { this.options = options; }

	handleInput(data: string): void {
		if (this.capture) { this.captureKey(data); return; }
		if (this.searching) { this.handleSearch(data); return; }
		const rows = this.rows();
		if (matchesKey(data, Key.escape) || data === "q") { this.options.close(); return; }
		if (data === "/") { this.searching = true; return; }
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, Key.home) || data === "g") this.selected = 0;
		else if (matchesKey(data, Key.end) || data === "G") this.selected = Math.max(0, rows.length - 1);
		else if (data === "e" || matchesKey(data, Key.enter)) this.capture = "replace";
		else if (data === "a") this.capture = "add";
		else if (data === "r") this.updateSelected(undefined, "Restored default binding");
		else if (data === "x") this.updateSelected([], "Action unbound");
	}

	render(width: number): string[] {
		const target = columns(width);
		const rows = this.rows();
		this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
		const height = Math.max(6, columns(this.options.height));
		const bodyHeight = Math.max(1, height - 8);
		this.viewport.ensureVisible(this.selected, rows.length, bodyHeight);
		const range = this.viewport.range(rows.length, bodyHeight);
		const set = symbols();
		const title = `${paint(this.options.theme, "Keybindings", "accent", "strong")} ${paint(this.options.theme, `· ${rows.length} actions`, "muted")}`;
		const search = this.searching
			? `${paint(this.options.theme, "/", "accent", "strong")} ${this.query || paint(this.options.theme, "type to filter…", "subtle")}`
			: this.query ? `${paint(this.options.theme, "filter", "muted")} ${this.query}` : paint(this.options.theme, "Press / to filter", "subtle");
		const actionWidth = Math.max(18, Math.min(42, Math.floor(target * 0.48)));
		const keyWidth = Math.max(8, target - actionWidth - 3);
		const lines = [fitLine(title, target), fitLine(search, target), paint(this.options.theme, "─".repeat(target), "subtle")];
		for (let visible = range.start; visible < range.end; visible++) {
			const row = rows[visible];
			const active = visible === this.selected;
			const marker = active ? set.selected : " ";
			const custom = row.custom ? paint(this.options.theme, "*", "warning") : " ";
			const action = fitLine(`${marker}${custom} ${row.description}`, actionWidth, { pad: true });
			const keys = row.keys.length ? row.keys.join(", ") : "unbound";
			const text = `${active ? paint(this.options.theme, action, "accent", "strong") : action} ${paint(this.options.theme, "│", "subtle")} ${paint(this.options.theme, fitLine(keys, keyWidth), row.keys.length ? "muted" : "warning")}`;
			lines.push(fitLine(text, target));
		}
		while (lines.length < bodyHeight + 3) lines.push("");
		const selected = rows[this.selected];
		lines.push(paint(this.options.theme, "─".repeat(target), "subtle"));
		if (this.capture) lines.push(fitLine(paint(this.options.theme, `${this.capture === "add" ? "Add" : "Replace with"}: press a key · ctrl+c cancel`, "warning", "strong"), target));
		else lines.push(fitLine(selected ? `${paint(this.options.theme, selected.action, "neutral")} ${paint(this.options.theme, selected.custom ? "· customized" : "· default", selected.custom ? "warning" : "subtle")}` : "No matching actions", target));
		const assignments = new Map<string, number>();
		for (const row of rows) for (const key of row.keys) assignments.set(key, (assignments.get(key) ?? 0) + 1);
		const conflicts = [...assignments.values()].filter((count) => count > 1).length;
		lines.push(fitLine(conflicts ? paint(this.options.theme, `${conflicts} conflict${conflicts === 1 ? "" : "s"}`, "warning") : paint(this.options.theme, "No conflicts", "success"), target));
		lines.push(fitLine(paint(this.options.theme, "↑↓ navigate · enter/e replace · a add · r default · x unbind · / search · esc close", "subtle"), target));
		return lines.slice(0, height).map((line) => fitLine(line, target));
	}

	invalidate(): void {}

	private rows(): BindingRow[] {
		const effective = this.options.keybindings.getEffectiveConfig();
		const user = this.options.keybindings.getUserBindings();
		const needle = this.query.toLowerCase();
		const core: BindingRow[] = Object.entries(effective).map(([action, configured]) => {
			let description = action;
			try { description = this.options.keybindings.getDefinition(action as never).description ?? action; } catch { /* extension action */ }
			const keys = (Array.isArray(configured) ? configured : configured ? [configured] : []) as KeyId[];
			return { action, description, keys, custom: Object.prototype.hasOwnProperty.call(user, action) };
		});
		const extra: BindingRow[] = (this.options.extraBindings?.() ?? []).map((binding) => ({ ...binding, extra: binding }));
		return [...core, ...extra].filter((row) => !needle || row.action.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle) || row.keys.some((key) => key.toLowerCase().includes(needle)))
			.sort((a, b) => a.action.localeCompare(b.action));
	}

	private handleSearch(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { this.searching = false; return; }
		if (matchesKey(data, Key.backspace)) this.query = this.query.slice(0, -1);
		else {
			const parsed = parseKey(data);
			if (parsed?.length === 1 && !parsed.includes("+")) this.query += parsed;
		}
		this.selected = 0;
		this.viewport.reset();
	}

	private captureKey(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) { this.capture = undefined; return; }
		const parsed = parseKey(data) as KeyId | undefined;
		if (!parsed) { this.options.notify("That terminal sequence cannot be used as a keybinding", "warning"); return; }
		const row = this.rows()[this.selected];
		if (!row) { this.capture = undefined; return; }
		const keys = this.capture === "add" ? [...row.keys.filter((key) => key !== parsed), parsed] : [parsed];
		this.capture = undefined;
		this.updateRow(row, keys, `Bound ${row.action} to ${keys.join(", ")}`);
	}

	private updateSelected(keys: KeyId[] | undefined, message: string): void {
		const row = this.rows()[this.selected];
		if (row) this.updateRow(row, keys, `${message}: ${row.action}`);
	}

	private updateRow(row: BindingRow, keys: KeyId[] | undefined, message: string): void {
		if (row.extra) {
			try {
				row.extra.set(keys);
				this.options.notify(message, "info");
			} catch (error) {
				this.options.notify(`Could not save Pi++ keybindings: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}
		this.update(row.action, keys, message);
	}

	private update(action: string, keys: KeyId[] | undefined, message: string): void {
		const user: KeybindingsConfig = { ...this.options.keybindings.getUserBindings() };
		if (keys === undefined) delete user[action]; else user[action] = keys;
		try {
			const target = this.options.configPath;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const temp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(temp, `${JSON.stringify(user, null, 2)}\n`, { mode: 0o600 });
			fs.renameSync(temp, target);
			this.options.keybindings.setUserBindings(user);
			this.options.notify(message, "info");
		} catch (error) {
			this.options.notify(`Could not save keybindings: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}
}
