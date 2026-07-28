import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RenderCache } from "../foundation/cache.ts";
import { fitLine } from "../foundation/text.ts";
import { paint } from "./theme.ts";

export interface KeyHintItem {
	key: string;
	label: string;
}

export interface KeyHintsOptions {
	theme: Theme;
	items: readonly KeyHintItem[];
	separator?: string;
}

export function keyHintText(theme: Theme, item: KeyHintItem): string {
	return `${paint(theme, item.key, "accent", "strong")} ${paint(theme, item.label, "muted")}`;
}

export class KeyHints implements Component {
	private cache = new RenderCache<string[]>();
	private readonly options: KeyHintsOptions;
	constructor(options: KeyHintsOptions) { this.options = options; }
	render(width: number): string[] {
		return this.cache.getOrCreate(width, () => {
			const separator = paint(this.options.theme, this.options.separator ?? " · ", "subtle");
			return [fitLine(this.options.items.map((item) => keyHintText(this.options.theme, item)).join(separator), width)];
		});
	}
	invalidate(): void { this.cache.invalidate(); }
}
