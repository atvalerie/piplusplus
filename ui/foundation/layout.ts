import { columns, normalizeInsets, type InsetsInput } from "./geometry.ts";
import { blank, fitLine } from "./text.ts";

export type VerticalAlign = "top" | "middle" | "bottom";

export function stack(blocks: readonly (readonly string[])[], gap = 0): string[] {
	const separator = Array.from({ length: columns(gap) }, () => "");
	const result: string[] = [];
	for (const block of blocks) {
		if (result.length) result.push(...separator);
		result.push(...block);
	}
	return result;
}

/** Add whitespace around a block while preserving an exact outer width. */
export function inset(lines: readonly string[], width: number, input: InsetsInput = 0): string[] {
	const outerWidth = columns(width);
	const edge = normalizeInsets(input);
	const contentWidth = Math.max(0, outerWidth - edge.left - edge.right);
	const empty = blank(outerWidth);
	const result = Array.from({ length: edge.top }, () => empty);
	for (const line of lines) {
		const content = fitLine(line, contentWidth, { pad: true });
		result.push(fitLine(`${blank(edge.left)}${content}${blank(edge.right)}`, outerWidth, { pad: true, ellipsis: "" }));
	}
	result.push(...Array.from({ length: edge.bottom }, () => empty));
	return result;
}

function verticalOffset(containerHeight: number, contentHeight: number, align: VerticalAlign): number {
	const spare = Math.max(0, containerHeight - contentHeight);
	if (align === "bottom") return spare;
	if (align === "middle") return Math.floor(spare / 2);
	return 0;
}

export interface JoinColumnsOptions {
	widths: readonly number[];
	gap?: number;
	align?: VerticalAlign | readonly VerticalAlign[];
	pad?: boolean;
}

/** Compose independently rendered blocks into ANSI-safe fixed-width columns. */
export function joinColumns(blocks: readonly (readonly string[])[], options: JoinColumnsOptions): string[] {
	if (blocks.length !== options.widths.length) throw new Error("joinColumns requires one width per block");
	if (!blocks.length) return [];
	const widths = options.widths.map(columns);
	const gap = blank(options.gap ?? 0);
	const height = Math.max(0, ...blocks.map((block) => block.length));
	const aligns = Array.isArray(options.align) ? options.align : blocks.map(() => options.align ?? "top");
	return Array.from({ length: height }, (_, row) => blocks.map((block, index) => {
		const offset = verticalOffset(height, block.length, aligns[index] ?? "top");
		const line = row >= offset && row < offset + block.length ? block[row - offset] : "";
		return fitLine(line, widths[index], { pad: options.pad ?? true, ellipsis: "" });
	}).join(gap));
}

export function totalColumnsWidth(widths: readonly number[], gap = 0): number {
	return widths.reduce((total, width) => total + columns(width), 0) + Math.max(0, widths.length - 1) * columns(gap);
}
