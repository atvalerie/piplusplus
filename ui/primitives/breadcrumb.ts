import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RenderCache } from "../foundation/cache.ts";
import { columns } from "../foundation/geometry.ts";
import { symbols, type Symbols } from "../foundation/symbols.ts";
import { fitLine, visibleWidth } from "../foundation/text.ts";
import { paint } from "./theme.ts";

export interface BreadcrumbOptions {
	theme: Theme;
	items: readonly string[];
	symbols?: Symbols;
}

export class Breadcrumb implements Component {
	private cache = new RenderCache<string[]>();
	private readonly options: BreadcrumbOptions;
	constructor(options: BreadcrumbOptions) { this.options = options; }
	render(width: number): string[] {
		const target = columns(width);
		return this.cache.getOrCreate(target, () => {
			if (!this.options.items.length || target === 0) return [""];
			const separator = ` ${this.options.symbols?.arrow ?? symbols().arrow} `;
			const full = this.options.items.join(separator);
			let items = [...this.options.items];
			if (visibleWidth(full) > target && items.length > 2) items = [items[0], "…", items.at(-1)!];
			if (visibleWidth(items.join(separator)) > target && items.length > 2) items = ["…", items.at(-1)!];
			const styled = items.map((item, index) => paint(
				this.options.theme,
				item,
				index === items.length - 1 ? "neutral" : "muted",
				index === items.length - 1 ? "strong" : "normal",
			)).join(paint(this.options.theme, separator, "subtle"));
			return [fitLine(styled, target)];
		});
	}
	invalidate(): void { this.cache.invalidate(); }
}
