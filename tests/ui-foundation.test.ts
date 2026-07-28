import assert from "node:assert/strict";
import test from "node:test";
import {
	allocate,
	asciiSymbols,
	clipLines,
	fitLine,
	inset,
	joinColumns,
	linesFit,
	RenderCache,
	responsive,
	stack,
	symbols,
	totalColumnsWidth,
	unicodeSymbols,
	visibleWidth,
	widthClass,
	wrapLines,
} from "../ui/foundation/index.ts";

const red = (value: string) => `\x1b[31m${value}\x1b[39m`;

test("fitLine measures terminal columns rather than string length", () => {
	const fitted = fitLine(red("界面"), 6, { align: "right", pad: true });
	assert.equal(visibleWidth(fitted), 6);
	assert.ok(fitted.startsWith("  "));
	assert.equal(visibleWidth(fitLine("abcdefgh", 5)), 5);
});

test("wrapping and clipping preserve width invariants", () => {
	const wrapped = wrapLines(`${red("alpha beta")} 界面 gamma`, 8);
	assert.ok(wrapped.length > 1);
	assert.ok(linesFit(wrapped, 8));
	const clipped = clipLines(wrapped, { left: 1, top: 0, width: 4, height: 2 });
	assert.equal(clipped.length, 2);
	assert.ok(linesFit(clipped, 4));
});

test("weighted allocation is integral and exact", () => {
	assert.deepEqual(allocate(10, [1, 2, 1]), [3, 5, 2]);
	assert.deepEqual(allocate(5, [0, 0]), [3, 2]);
	assert.equal(allocate(101, [2, 3]).reduce((sum, value) => sum + value, 0), 101);
});

test("layout composition produces exact-width rows", () => {
	const left = [red("one"), "two"];
	const right = ["details"];
	const joined = joinColumns([left, right], { widths: [6, 8], gap: 2, align: ["top", "bottom"] });
	assert.equal(totalColumnsWidth([6, 8], 2), 16);
	assert.equal(joined.length, 2);
	assert.ok(joined.every((line) => visibleWidth(line) === 16));
	const padded = inset(stack([["title"], ["body"]], 1), 12, { top: 1, left: 2, right: 2 });
	assert.ok(padded.every((line) => visibleWidth(line) === 12));
});

test("responsive values fall back from wide to regular to compact", () => {
	assert.equal(widthClass(50), "compact");
	assert.equal(widthClass(80), "regular");
	assert.equal(widthClass(140), "wide");
	const value = { compact: "one", regular: "two" } as const;
	assert.equal(responsive(value, 50), "one");
	assert.equal(responsive(value, 80), "two");
	assert.equal(responsive(value, 140), "two");
});

test("render cache supports undefined values and explicit invalidation", () => {
	const cache = new RenderCache<string | undefined>();
	let calls = 0;
	assert.equal(cache.getOrCreate(80, () => { calls++; return undefined; }), undefined);
	assert.equal(cache.getOrCreate(80, () => { calls++; return "new"; }), undefined);
	assert.equal(calls, 1);
	cache.invalidate();
	assert.equal(cache.getOrCreate(80, () => { calls++; return "new"; }), "new");
	assert.equal(calls, 2);
});

test("symbols provide explicit Unicode and ASCII modes", () => {
	assert.equal(symbols({ ascii: true }), asciiSymbols);
	assert.equal(symbols({ ascii: false }), unicodeSymbols);
	assert.equal(symbols({ environment: { TERM: "dumb" } }), asciiSymbols);
});
