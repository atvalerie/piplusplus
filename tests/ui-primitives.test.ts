import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	asciiSymbols,
	Badge,
	badgeText,
	Breadcrumb,
	EmptyState,
	ErrorState,
	KeyHints,
	Label,
	Metric,
	ProgressBar,
	Rule,
	StateMessage,
	statusText,
	Surface,
	visibleWidth,
} from "../ui/index.ts";

const ansi = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const theme = {
	fg: (_color: string, text: string) => ansi(36, text),
	bg: (_color: string, text: string) => ansi(44, text),
	bold: (text: string) => ansi(1, text),
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

function assertFits(lines: readonly string[], width: number): void {
	assert.ok(lines.length > 0);
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
}

test("labels wrap styled Unicode and invalidate after updates", () => {
	const label = new Label({ theme, text: "Quiet control room 界面", tone: "accent" });
	assertFits(label.render(10), 10);
	label.setText("Changed");
	assert.equal(visibleWidth(label.render(10)[0]), 7);
});

test("badges and statuses remain compact semantic atoms", () => {
	assert.equal(visibleWidth(badgeText({ theme, label: "RUNNING", tone: "active" })), 9);
	assertFits(new Badge({ theme, label: "FAILED", tone: "danger", variant: "outline" }).render(8), 8);
	assert.equal(statusText(theme, "success", "done", asciiSymbols).replace(/\x1b\[[0-9;]*m/g, ""), "+ done");
});

test("rules, breadcrumbs, and key hints constrain navigation chrome", () => {
	assert.equal(visibleWidth(new Rule({ theme, label: "Agents" }).render(24)[0]), 24);
	const breadcrumb = new Breadcrumb({ theme, items: ["workflow", "long verification phase", "security agent"] });
	assertFits(breadcrumb.render(22), 22);
	const hints = new KeyHints({ theme, items: [{ key: "enter", label: "open" }, { key: "esc", label: "back" }] });
	assertFits(hints.render(18), 18);
});

test("progress bars support determinate, indeterminate, and narrow widths", () => {
	const determinate = new ProgressBar({ theme, label: "Agents", value: 3, total: 8 });
	assert.equal(visibleWidth(determinate.render(30)[0]), 30);
	const indeterminate = new ProgressBar({ theme, label: "Index", frame: 3, ascii: true });
	assert.equal(visibleWidth(indeterminate.render(20)[0]), 20);
	assertFits(determinate.render(5), 5);
});

test("metrics adapt from one line to two", () => {
	const metric = new Metric({ theme, label: "Tokens", value: "18.2k", detail: "$0.014" });
	assert.equal(metric.render(40).length, 1);
	assert.equal(metric.render(10).length, 2);
	assertFits(metric.render(10), 10);
});

test("surfaces frame arbitrary components at every practical width", () => {
	const body = new Label({ theme, text: "Agent output with a wide glyph 界", wrap: true });
	const surface = new Surface({ theme, title: "Inspector", subtitle: "running", body, border: "frame", padding: { left: 1, right: 1 }, symbols: asciiSymbols, background: "panel" });
	for (const width of [2, 12, 40]) {
		const lines = surface.render(width);
		assertFits(lines, width);
		assert.ok(lines.every((line) => visibleWidth(line) === width));
	}
});

test("empty and error states provide readable non-color hierarchy", () => {
	const empty = new EmptyState({ theme, icon: "○", title: "No workflows", detail: "Start one from a prompt", hint: "ultracode …" });
	const error = new ErrorState({ theme, icon: "×", title: "Agent failed", detail: "Process exited" });
	assertFits(empty.render(24), 24);
	assertFits(error.render(16), 16);
	assert.ok(new StateMessage({ theme, title: "State" }).render(10).length >= 1);
});
