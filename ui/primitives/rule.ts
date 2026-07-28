import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RenderCache } from "../foundation/cache.ts";
import { columns } from "../foundation/geometry.ts";
import { symbols, type Symbols } from "../foundation/symbols.ts";
import { fitLine, visibleWidth } from "../foundation/text.ts";
import { paint, type Tone } from "./theme.ts";

export interface RuleOptions {
	theme: Theme;
	label?: string;
	tone?: Tone;
	symbols?: Symbols;
}

export class Rule implements Component {
	private cache = new RenderCache<string[]>();
	private readonly options: RuleOptions;
	constructor(options: RuleOptions) { this.options = options; }
	render(width: number): string[] {
		const target = columns(width);
		return this.cache.getOrCreate(target, () => {
			const set = this.options.symbols ?? symbols();
			const label = this.options.label ? ` ${this.options.label} ` : "";
			const clipped = fitLine(label, target, { ellipsis: "…" });
			const remaining = Math.max(0, target - visibleWidth(clipped));
			return [paint(this.options.theme, `${clipped}${set.horizontal.repeat(remaining)}`, this.options.tone ?? "subtle")];
		});
	}
	invalidate(): void { this.cache.invalidate(); }
}
