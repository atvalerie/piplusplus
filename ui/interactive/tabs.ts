import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { fitLine } from "../foundation/text.ts";
import { fill, paint } from "../primitives/theme.ts";

export interface TabItem {
	id: string;
	label: string;
	content?: Component;
	disabled?: boolean;
}

export interface TabsOptions {
	theme: Theme;
	items: readonly TabItem[];
	activeId?: string;
	onChange?: (tab: TabItem, index: number) => void;
}

export class Tabs implements Component {
	private options: TabsOptions;
	private index = 0;

	constructor(options: TabsOptions) {
		this.options = options;
		const requested = options.items.findIndex((item) => item.id === options.activeId && !item.disabled);
		this.index = requested >= 0 ? requested : Math.max(0, options.items.findIndex((item) => !item.disabled));
	}

	get activeTab(): TabItem | undefined { return this.options.items[this.index]; }

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab)) this.move(1);
		else if (matchesKey(data, Key.shift("tab"))) this.move(-1);
		else this.activeTab?.content?.handleInput?.(data);
	}

	render(width: number): string[] {
		if (!this.options.items.length) return [paint(this.options.theme, "(no tabs)", "subtle")];
		const header = this.options.items.map((item, index) => {
			const label = ` ${item.label} `;
			if (index === this.index) return fill(this.options.theme, paint(this.options.theme, label, "accent", "strong"), "active");
			return paint(this.options.theme, label, item.disabled ? "subtle" : "muted");
		}).join(paint(this.options.theme, " ", "subtle"));
		const lines = [fitLine(header, width)];
		const content = this.activeTab?.content;
		if (content) lines.push(...content.render(width));
		return lines;
	}

	invalidate(): void { for (const item of this.options.items) item.content?.invalidate(); }

	private move(direction: 1 | -1): void {
		if (this.options.items.length < 2) return;
		let candidate = this.index;
		for (let checked = 0; checked < this.options.items.length; checked++) {
			candidate = (candidate + direction + this.options.items.length) % this.options.items.length;
			if (!this.options.items[candidate].disabled) {
				if (candidate !== this.index) {
					this.index = candidate;
					this.options.onChange?.(this.options.items[candidate], candidate);
				}
				return;
			}
		}
	}
}
