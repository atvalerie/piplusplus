import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RenderCache } from "../foundation/cache.ts";
import { fitLine } from "../foundation/text.ts";
import { fill, paint, type Tone } from "./theme.ts";

export type BadgeVariant = "solid" | "outline" | "plain";

export interface BadgeOptions {
	theme: Theme;
	label: string;
	tone?: Tone;
	variant?: BadgeVariant;
}

export function badgeText(options: BadgeOptions): string {
	const tone = options.tone ?? "neutral";
	const label = paint(options.theme, options.label, tone, "strong");
	if (options.variant === "plain") return label;
	if (options.variant === "outline") return paint(options.theme, `[ ${options.label} ]`, tone, "strong");
	return fill(options.theme, ` ${label} `, tone);
}

export class Badge implements Component {
	private cache = new RenderCache<string[]>();
	private readonly options: BadgeOptions;
	constructor(options: BadgeOptions) { this.options = options; }
	render(width: number): string[] {
		return this.cache.getOrCreate(width, () => [fitLine(badgeText(this.options), width)]);
	}
	invalidate(): void { this.cache.invalidate(); }
}
