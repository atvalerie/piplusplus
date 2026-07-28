import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { fitLine } from "../foundation/text.ts";
import { paint } from "../primitives/theme.ts";

export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const levels: Array<{ level: EffortLevel; label: string; description: string }> = [
	{ level: "off", label: "Off", description: "No deliberate reasoning" },
	{ level: "minimal", label: "Minimal", description: "Shortest reasoning path" },
	{ level: "low", label: "Low", description: "Fast, lightweight reasoning" },
	{ level: "medium", label: "Medium", description: "Balanced default" },
	{ level: "high", label: "High", description: "Thorough reasoning" },
	{ level: "xhigh", label: "Extra high", description: "Deep reasoning for difficult work" },
	{ level: "max", label: "Maximum", description: "Highest available reasoning budget" },
];

export const effortLevels: readonly EffortLevel[] = levels.map((item) => item.level);

export interface EffortPickerOptions {
	theme: Theme;
	current: EffortLevel;
	select: (level: EffortLevel) => void;
	close: () => void;
}

export class EffortPicker implements Component {
	private readonly options: EffortPickerOptions;
	private selected: number;
	constructor(options: EffortPickerOptions) {
		this.options = options;
		this.selected = Math.max(0, levels.findIndex((item) => item.level === options.current));
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") { this.options.close(); return; }
		if (data === "j" || matchesKey(data, Key.down)) this.selected = Math.min(levels.length - 1, this.selected + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, Key.enter)) this.options.select(levels[this.selected].level);
	}
	render(width: number): string[] {
		const lines = [
			fitLine(`${paint(this.options.theme, "Reasoning effort", "accent", "strong")} ${paint(this.options.theme, `· current ${this.options.current}`, "muted")}`, width),
			paint(this.options.theme, "─".repeat(Math.max(0, width)), "subtle"),
		];
		for (let index = 0; index < levels.length; index++) {
			const item = levels[index];
			const active = index === this.selected;
			const current = item.level === this.options.current ? "●" : "○";
			const row = `${active ? "›" : " "} ${current} ${item.label.padEnd(11)} ${item.description}`;
			lines.push(fitLine(paint(this.options.theme, row, active ? "accent" : item.level === this.options.current ? "success" : "neutral", active ? "strong" : "normal"), width));
		}
		lines.push(paint(this.options.theme, "─".repeat(Math.max(0, width)), "subtle"));
		lines.push(fitLine(paint(this.options.theme, "↑↓ choose · enter apply · esc close", "subtle"), width));
		return lines;
	}
	invalidate(): void {}
}
