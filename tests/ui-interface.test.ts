import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { EffortPicker } from "../ui/interface/effort.ts";
import { formatCount, renderFooter, type FooterSnapshot } from "../ui/interface/footer.ts";
import { CommandAliasRegistry } from "../ui/interface/command-aliases.ts";
import { KeybindingBrowser } from "../ui/interface/keybindings.ts";
import { PiPlusPlusKeybindingRegistry } from "../ui/interface/piplusplus-keybindings.ts";
import { visibleWidth } from "../ui/foundation/text.ts";

const ansi = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const theme = {
	fg: (_color: string, text: string) => ansi(36, text),
	bg: (_color: string, text: string) => ansi(44, text),
	bold: (text: string) => ansi(1, text),
} as Theme;

const snapshot: FooterSnapshot = {
	project: "piplusplus",
	branch: "main",
	model: "gpt-5.4",
	thinking: "xhigh",
	inputTokens: 18_250,
	outputTokens: 2_100,
	contextPercent: 38.4,
	cost: 0.084,
	providerBalance: 1.65,
	providerSavings: 0.012,
	permissionMode: "auto",
	statuses: ["2 workflows"],
};

test("footer responds at compact, regular, and wide widths", () => {
	for (const width of [36, 72, 120]) {
		const lines = renderFooter(snapshot, width, theme);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
	}
	assert.match(renderFooter(snapshot, 36, theme)[0], /perm:auto/);
	assert.match(renderFooter(snapshot, 36, theme)[0], /gpt-5\.4/);
	assert.match(renderFooter(snapshot, 72, theme)[0], /piplusplus/);
	assert.match(renderFooter(snapshot, 72, theme)[0], /2 workflows/);
	assert.match(renderFooter(snapshot, 120, theme)[0], /2 workflows/);
	assert.match(renderFooter(snapshot, 160, theme)[0], /bal \$1\.65/);
	assert.match(renderFooter(snapshot, 160, theme)[0], /saved ~\$0\.012/);
});

test("token counts use compact stable formatting", () => {
	assert.equal(formatCount(42), "42");
	assert.equal(formatCount(1_250), "1.3k");
	assert.equal(formatCount(18_250), "18k");
	assert.equal(formatCount(2_300_000), "2.3m");
});

test("effort picker changes the selected reasoning level", () => {
	let selected = "";
	const picker = new EffortPicker({ theme, current: "medium", select: (level) => { selected = level; }, close: () => {} });
	picker.handleInput("j");
	picker.handleInput("\r");
	assert.equal(selected, "high");
	assert.ok(picker.render(60).every((line) => visibleWidth(line) <= 60));
});

test("keybinding browser captures and persists replacement keys", () => {
	let user: Record<string, unknown> = {};
	const effective: Record<string, unknown> = { "app.alpha": ["ctrl+a"], "tui.editor.beta": "down" };
	const manager = {
		getEffectiveConfig: () => ({ ...effective, ...user }),
		getUserBindings: () => user,
		getDefinition: (action: string) => ({ defaultKeys: effective[action], description: `Description ${action}` }),
		getConflicts: () => [],
		setUserBindings: (next: Record<string, unknown>) => { user = next; },
	} as unknown as KeybindingsManager;
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-keys-"));
	const configPath = path.join(directory, "keybindings.json");
	const browser = new KeybindingBrowser({ theme, keybindings: manager, height: 14, close: () => {}, notify: () => {}, configPath });
	browser.handleInput("e");
	browser.handleInput("z");
	assert.deepEqual(user["app.alpha"], ["z"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8"))["app.alpha"], ["z"]);
	assert.ok(browser.render(72).every((line) => visibleWidth(line) <= 72));
	fs.rmSync(directory, { recursive: true, force: true });
});

test("command aliases resolve before submission and persist edits", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-aliases-"));
	const configPath = path.join(directory, "aliases.json");
	const aliases = new CommandAliasRegistry(configPath);
	assert.equal(aliases.resolve("/exit"), "/quit");
	assert.equal(aliases.resolve("/exit now"), "/quit now");
	aliases.set("bye", "exit");
	assert.equal(aliases.resolve("/bye"), "/quit");
	assert.equal(new CommandAliasRegistry(configPath).resolve("/bye later"), "/quit later");
	assert.throws(() => aliases.set("exit", "bye"), /cycle/i);
	aliases.remove("exit");
	assert.equal(aliases.resolve("/exit"), "/exit");
	aliases.reset("exit");
	assert.equal(aliases.resolve("/exit"), "/quit");
	fs.rmSync(directory, { recursive: true, force: true });
});

test("Pi++ keybinding registry persists and matches shortcuts dynamically", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-own-keys-"));
	const configPath = path.join(directory, "piplusplus-keybindings.json");
	const registry = new PiPlusPlusKeybindingRegistry(configPath);
	assert.deepEqual(registry.getKeys("piplusplus.keybindings.open"), ["f1"]);
	assert.deepEqual(registry.getKeys("piplusplus.effort.open"), ["alt+e"]);
	registry.set("piplusplus.keybindings.open", ["z"]);
	assert.deepEqual(new PiPlusPlusKeybindingRegistry(configPath).getKeys("piplusplus.keybindings.open"), ["z"]);
	assert.equal(registry.matches("z", "piplusplus.keybindings.open"), true);
	registry.set("piplusplus.keybindings.open", undefined);
	assert.deepEqual(registry.getKeys("piplusplus.keybindings.open"), ["f1"]);
	fs.rmSync(directory, { recursive: true, force: true });
});
