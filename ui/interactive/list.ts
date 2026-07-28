import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { columns } from "../foundation/geometry.ts";
import { symbols, type Symbols } from "../foundation/symbols.ts";
import { fitLine } from "../foundation/text.ts";
import { fill, paint, type Tone } from "../primitives/theme.ts";
import { statusSymbol, statusTone, type OperationalStatus } from "../primitives/status.ts";
import { SelectionModel } from "./selection.ts";
import { Viewport } from "./viewport.ts";

export interface ListItem<T = unknown> {
	id: string;
	label: string;
	description?: string;
	status?: OperationalStatus;
	disabled?: boolean;
	data?: T;
}

export interface ListOptions<T = unknown> {
	theme: Theme;
	items: readonly ListItem<T>[];
	height?: number;
	symbols?: Symbols;
	showScrollInfo?: boolean;
	onChange?: (item: ListItem<T>, index: number) => void;
	onSelect?: (item: ListItem<T>, index: number) => void;
}

export class List<T = unknown> implements Component {
	private options: ListOptions<T>;
	private viewport = new Viewport();
	private selection: SelectionModel;

	constructor(options: ListOptions<T>) {
		this.options = options;
		this.selection = new SelectionModel(options.items.length, (index) => !this.options.items[index]?.disabled);
	}

	get selectedIndex(): number { return this.selection.selected; }
	get selectedItem(): ListItem<T> | undefined { return this.options.items[this.selectedIndex]; }

	setItems(items: readonly ListItem<T>[]): void {
		this.options = { ...this.options, items };
		this.selection.setCount(items.length);
		this.invalidate();
	}

	handleInput(data: string): void {
		let changed = false;
		if (data === "j" || matchesKey(data, Key.down)) changed = this.selection.move(1);
		else if (data === "k" || matchesKey(data, Key.up)) changed = this.selection.move(-1);
		else if (matchesKey(data, Key.home) || data === "g") changed = this.selection.first();
		else if (matchesKey(data, Key.end) || data === "G") changed = this.selection.last();
		else if (matchesKey(data, Key.ctrl("d"))) changed = this.selection.move(Math.max(1, Math.floor((this.options.height ?? 10) / 2)));
		else if (matchesKey(data, Key.ctrl("u"))) changed = this.selection.move(-Math.max(1, Math.floor((this.options.height ?? 10) / 2)));
		else if (matchesKey(data, Key.enter)) {
			const item = this.selectedItem;
			if (item && !item.disabled) this.options.onSelect?.(item, this.selectedIndex);
		}
		if (changed) {
			this.options.onChange?.(this.selectedItem!, this.selectedIndex);
			this.invalidate();
		}
	}

	render(width: number): string[] {
		const target = columns(width);
		const set = this.options.symbols ?? symbols();
		const totalHeight = Math.max(1, columns((this.options.height ?? this.options.items.length) || 1));
		const showInfo = (this.options.showScrollInfo ?? true) && this.options.items.length > totalHeight;
		const rowHeight = Math.max(1, totalHeight - (showInfo ? 1 : 0));
		this.viewport.ensureVisible(this.selectedIndex, this.options.items.length, rowHeight);
		const range = this.viewport.range(this.options.items.length, rowHeight);
		const lines = this.options.items.slice(range.start, range.end).map((item, visibleIndex) => {
			const index = range.start + visibleIndex;
			const selected = index === this.selectedIndex;
			const marker = selected ? set.selected : " ";
			const status = item.status ? `${statusSymbol(item.status, set)} ` : "";
			const description = item.description ? ` · ${item.description}` : "";
			const tone: Tone = item.disabled ? "subtle" : selected ? "accent" : item.status ? statusTone(item.status) : "neutral";
			const raw = `${marker} ${status}${item.label}${description}`;
			const line = fitLine(paint(this.options.theme, raw, tone, selected ? "strong" : "normal"), target, { pad: selected });
			return selected ? fill(this.options.theme, line, "active") : line;
		});
		if (showInfo) lines.push(fitLine(paint(this.options.theme, `${range.before ? `↑${range.before}` : ""}${range.before && range.after ? " · " : ""}${range.after ? `↓${range.after}` : ""}`, "subtle"), target, { align: "right" }));
		return lines.length ? lines : [paint(this.options.theme, "(empty)", "subtle")];
	}

	invalidate(): void {}
}
