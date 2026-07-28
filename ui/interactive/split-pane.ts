import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, isFocusable, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { allocate, columns } from "../foundation/geometry.ts";
import { joinColumns } from "../foundation/layout.ts";
import { fitLine } from "../foundation/text.ts";
import { paint } from "../primitives/theme.ts";

export interface Pane {
	id: string;
	component: Component;
	title?: string;
	weight?: number;
	minWidth?: number;
}

export interface SplitPaneOptions {
	theme: Theme;
	panes: readonly Pane[];
	gap?: number;
	collapseBelow?: number;
	activeId?: string;
	onFocusChange?: (pane: Pane, index: number) => void;
}

export class SplitPane implements Component, Focusable {
	private readonly options: SplitPaneOptions;
	private active = 0;
	private _focused = false;

	constructor(options: SplitPaneOptions) {
		this.options = options;
		const requested = options.panes.findIndex((pane) => pane.id === options.activeId);
		if (requested >= 0) this.active = requested;
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.propagateFocus(); }
	get activePane(): Pane | undefined { return this.options.panes[this.active]; }

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab)) { this.move(1); return; }
		if (matchesKey(data, Key.shift("tab"))) { this.move(-1); return; }
		this.activePane?.component.handleInput?.(data);
	}

	render(width: number): string[] {
		const target = columns(width);
		if (!this.options.panes.length) return [paint(this.options.theme, "(no panes)", "subtle")];
		const gap = columns(this.options.gap ?? 2);
		const minimum = this.options.panes.reduce((sum, pane) => sum + columns(pane.minWidth ?? 20), 0) + gap * Math.max(0, this.options.panes.length - 1);
		if (target < (this.options.collapseBelow ?? minimum)) return this.renderPane(this.options.panes[this.active], target, true);
		const available = Math.max(0, target - gap * Math.max(0, this.options.panes.length - 1));
		const widths = this.allocateWithMinimum(available);
		const blocks = this.options.panes.map((pane, index) => this.renderPane(pane, widths[index], index === this.active));
		return joinColumns(blocks, { widths, gap, align: "top" });
	}

	invalidate(): void { for (const pane of this.options.panes) pane.component.invalidate(); }

	private renderPane(pane: Pane, width: number, active: boolean): string[] {
		const lines: string[] = [];
		if (pane.title) lines.push(fitLine(paint(this.options.theme, pane.title, active ? "accent" : "muted", active ? "strong" : "normal"), width));
		lines.push(...pane.component.render(width));
		return lines;
	}

	private move(direction: 1 | -1): void {
		if (this.options.panes.length < 2) return;
		this.active = (this.active + direction + this.options.panes.length) % this.options.panes.length;
		this.propagateFocus();
		this.options.onFocusChange?.(this.options.panes[this.active], this.active);
	}

	private propagateFocus(): void {
		for (let index = 0; index < this.options.panes.length; index++) {
			const component = this.options.panes[index].component;
			if (isFocusable(component)) component.focused = this._focused && index === this.active;
		}
	}

	private allocateWithMinimum(total: number): number[] {
		const result = allocate(total, this.options.panes.map((pane) => pane.weight ?? 1));
		const minimums = this.options.panes.map((pane) => columns(pane.minWidth ?? 20));
		for (let index = 0; index < result.length; index++) {
			const needed = Math.max(0, minimums[index] - result[index]);
			if (!needed) continue;
			for (let donor = result.length - 1; donor >= 0 && result[index] < minimums[index]; donor--) {
				if (donor === index) continue;
				const take = Math.min(result[donor] - minimums[donor], minimums[index] - result[index]);
				if (take > 0) { result[donor] -= take; result[index] += take; }
			}
		}
		return result;
	}
}
