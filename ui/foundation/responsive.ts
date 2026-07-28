import { columns } from "./geometry.ts";

export type WidthClass = "compact" | "regular" | "wide";

export interface Breakpoints {
	regular: number;
	wide: number;
}

export const defaultBreakpoints: Readonly<Breakpoints> = Object.freeze({
	regular: 72,
	wide: 120,
});

export function widthClass(width: number, breakpoints: Breakpoints = defaultBreakpoints): WidthClass {
	const value = columns(width);
	if (value >= columns(breakpoints.wide)) return "wide";
	if (value >= columns(breakpoints.regular)) return "regular";
	return "compact";
}

export type ResponsiveValue<T> = T | {
	compact: T;
	regular?: T;
	wide?: T;
};

export function responsive<T>(value: ResponsiveValue<T>, width: number, breakpoints: Breakpoints = defaultBreakpoints): T {
	if (typeof value !== "object" || value === null || !("compact" in value)) return value as T;
	const mode = widthClass(width, breakpoints);
	if (mode === "wide") return value.wide ?? value.regular ?? value.compact;
	if (mode === "regular") return value.regular ?? value.compact;
	return value.compact;
}

export function whenWidth<T>(width: number, values: { compact: () => T; regular?: () => T; wide?: () => T }, breakpoints: Breakpoints = defaultBreakpoints): T {
	const mode = widthClass(width, breakpoints);
	if (mode === "wide") return (values.wide ?? values.regular ?? values.compact)();
	if (mode === "regular") return (values.regular ?? values.compact)();
	return values.compact();
}
