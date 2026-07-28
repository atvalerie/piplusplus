import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { UiGallery } from "../ui/gallery.ts";
import {
	asciiSymbols,
	Inspector,
	List,
	SearchField,
	SelectionModel,
	SplitPane,
	Tabs,
	Tree,
	Viewport,
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

class Stub implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private readonly text: string;
	constructor(text: string) { this.text = text; }
	render(width: number): string[] { return [this.text.slice(0, width)]; }
	handleInput(data: string): void { this.inputs.push(data); }
	invalidate(): void {}
}

function assertFits(lines: readonly string[], width: number): void {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
}

test("selection skips disabled rows and viewport follows it", () => {
	const selection = new SelectionModel(5, (index) => index !== 1 && index !== 3);
	assert.equal(selection.move(1), true);
	assert.equal(selection.selected, 2);
	assert.equal(selection.move(1), true);
	assert.equal(selection.selected, 4);
	const viewport = new Viewport();
	viewport.ensureVisible(8, 20, 5);
	assert.deepEqual(viewport.range(20, 5), { start: 4, end: 9, before: 4, after: 11 });
});

test("list navigation emits change and selection with constrained rows", () => {
	const changes: string[] = [];
	const selected: string[] = [];
	const list = new List({
		theme, height: 4, symbols: asciiSymbols,
		items: Array.from({ length: 8 }, (_, index) => ({ id: String(index), label: `Agent ${index}`, disabled: index === 1 })),
		onChange: (item) => changes.push(item.id), onSelect: (item) => selected.push(item.id),
	});
	list.handleInput("j");
	assert.equal(list.selectedIndex, 2);
	list.handleInput("\r");
	assert.deepEqual(changes, ["2"]);
	assert.deepEqual(selected, ["2"]);
	const lines = list.render(22);
	assert.equal(lines.length, 4);
	assertFits(lines, 22);
});

test("tree expands, enters children, and returns to parents", () => {
	const tree = new Tree({ theme, symbols: asciiSymbols, height: 5, nodes: [{ id: "root", label: "Workflow", children: [{ id: "phase", label: "Phase" }] }] });
	assert.equal(tree.render(30).length, 1);
	tree.handleInput("\x1b[C");
	assert.equal(tree.render(30).length, 2);
	tree.handleInput("\x1b[C");
	assert.equal(tree.selectedNode?.id, "phase");
	tree.handleInput("\x1b[D");
	assert.equal(tree.selectedNode?.id, "root");
});

test("tabs switch content and route unhandled input", () => {
	const first = new Stub("first");
	const second = new Stub("second");
	const tabs = new Tabs({ theme, items: [{ id: "a", label: "A", content: first }, { id: "b", label: "B", content: second }] });
	tabs.handleInput("\t");
	assert.equal(tabs.activeTab?.id, "b");
	tabs.handleInput("x");
	assert.deepEqual(second.inputs, ["x"]);
	assertFits(tabs.render(12), 12);
});

test("search field propagates focus, edits, and changes", () => {
	const values: string[] = [];
	const search = new SearchField({ theme, placeholder: "Filter", onChange: (value) => values.push(value) });
	search.focused = true;
	search.handleInput("a");
	search.handleInput("b");
	assert.equal(search.value, "ab");
	assert.deepEqual(values, ["a", "ab"]);
	assertFits(search.render(12), 12);
});

test("split pane switches focus and collapses responsively", () => {
	const left = new Stub("left");
	const right = new Stub("right");
	const split = new SplitPane({ theme, panes: [{ id: "left", component: left, minWidth: 10 }, { id: "right", component: right, minWidth: 10 }], gap: 2 });
	split.focused = true;
	assert.equal(left.focused, true);
	assert.equal(right.focused, false);
	split.handleInput("\t");
	assert.equal(right.focused, true);
	assert.equal(split.render(15)[0].includes("right"), true);
	const wide = split.render(40);
	assert.ok(wide.every((line) => visibleWidth(line) === 40));
});

test("inspector collapses sections and permits content scrolling", () => {
	const inspector = new Inspector({ theme, height: 4, symbols: asciiSymbols, sections: [
		{ id: "prompt", label: "Prompt", content: "one two three four five six seven eight nine ten" },
		{ id: "result", label: "Result", content: "done" },
	] });
	assert.equal(inspector.render(12).length, 4);
	inspector.handleInput("j");
	assertFits(inspector.render(12), 12);
	inspector.handleInput(" ");
	assert.ok(inspector.render(12).length <= 4);
});

test("component gallery renders and simulates responsive widths", () => {
	let closed = false;
	const gallery = new UiGallery(theme, () => { closed = true; });
	gallery.setMaxHeight(22);
	for (const width of [40, 80, 140]) assertFits(gallery.render(width), width);
	gallery.handleInput("w");
	gallery.handleInput("\t");
	gallery.tick();
	assertFits(gallery.render(100), 100);
	gallery.handleInput("q");
	assert.equal(closed, true);
});
