import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { columns } from "./geometry.ts";

export type HorizontalAlign = "left" | "center" | "right";

export interface FitOptions {
	align?: HorizontalAlign;
	ellipsis?: string;
	pad?: boolean;
}

export function blank(width: number): string {
	return " ".repeat(columns(width));
}

/** Fit one styled line to a terminal width and optionally pad it exactly. */
export function fitLine(line: string, width: number, options: FitOptions = {}): string {
	const target = columns(width);
	if (target === 0) return "";
	const clipped = truncateToWidth(line.replace(/[\r\n]/g, " "), target, options.ellipsis ?? "…");
	if (!options.pad) return clipped;
	const remaining = Math.max(0, target - visibleWidth(clipped));
	if (options.align === "right") return `${" ".repeat(remaining)}${clipped}`;
	if (options.align === "center") {
		const left = Math.floor(remaining / 2);
		return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
	}
	return `${clipped}${" ".repeat(remaining)}`;
}

export function wrapLines(text: string, width: number): string[] {
	const target = columns(width);
	if (target === 0) return text.length ? [] : [""];
	return wrapTextWithAnsi(text, target).map((line) => fitLine(line, target));
}

/** Slice lines by terminal column and row while preserving ANSI state. */
export function clipLines(
	lines: readonly string[],
	options: { left?: number; top?: number; width: number; height?: number },
): string[] {
	const left = columns(options.left ?? 0);
	const top = columns(options.top ?? 0);
	const width = columns(options.width);
	const height = options.height === undefined ? Math.max(0, lines.length - top) : columns(options.height);
	return lines.slice(top, top + height).map((line) => sliceByColumn(line, left, width, true));
}

export function maxLineWidth(lines: readonly string[]): number {
	return lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
}

export function linesFit(lines: readonly string[], width: number): boolean {
	const target = columns(width);
	return lines.every((line) => !line.includes("\n") && !line.includes("\r") && visibleWidth(line) <= target);
}

export function constrainLines(lines: readonly string[], width: number): string[] {
	const target = columns(width);
	return lines.flatMap((line) => line.split(/\r?\n/)).map((line) => fitLine(line, target));
}

export { visibleWidth };
