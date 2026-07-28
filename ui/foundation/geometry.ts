export interface Size {
	width: number;
	height: number;
}

export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export type InsetsInput = number | Partial<Insets>;

export const space = {
	none: 0,
	xs: 1,
	sm: 2,
	md: 3,
	lg: 4,
	xl: 6,
} as const;

export function columns(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function normalizeInsets(input: InsetsInput = 0): Insets {
	if (typeof input === "number") {
		const value = columns(input);
		return { top: value, right: value, bottom: value, left: value };
	}
	return {
		top: columns(input.top ?? 0),
		right: columns(input.right ?? 0),
		bottom: columns(input.bottom ?? 0),
		left: columns(input.left ?? 0),
	};
}

export function innerSize(size: Size, input: InsetsInput = 0): Size {
	const inset = normalizeInsets(input);
	return {
		width: Math.max(0, columns(size.width) - inset.left - inset.right),
		height: Math.max(0, columns(size.height) - inset.top - inset.bottom),
	};
}

export function clamp(value: number, minimum: number, maximum: number): number {
	const low = Math.min(minimum, maximum);
	const high = Math.max(minimum, maximum);
	return Math.min(high, Math.max(low, value));
}

/**
 * Allocate a fixed total across weighted tracks. The returned integers always
 * add up to `total`; remainder columns go to tracks with the largest fractions.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
	const available = columns(total);
	if (!weights.length) return [];
	const safe = weights.map((weight) => Number.isFinite(weight) ? Math.max(0, weight) : 0);
	const sum = safe.reduce((result, weight) => result + weight, 0);
	if (sum === 0) {
		const base = Math.floor(available / safe.length);
		return safe.map((_, index) => base + (index < available % safe.length ? 1 : 0));
	}
	const exact = safe.map((weight) => available * weight / sum);
	const result = exact.map(Math.floor);
	let remainder = available - result.reduce((value, width) => value + width, 0);
	const priority = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
	for (let index = 0; remainder > 0; index++, remainder--) result[priority[index % priority.length].index]++;
	return result;
}
