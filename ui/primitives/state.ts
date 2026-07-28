import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RenderCache } from "../foundation/cache.ts";
import { columns } from "../foundation/geometry.ts";
import { fitLine, wrapLines } from "../foundation/text.ts";
import { paint, type Tone } from "./theme.ts";

export interface StateOptions {
	theme: Theme;
	title: string;
	detail?: string;
	icon?: string;
	hint?: string;
	tone?: Tone;
	align?: "left" | "center";
}

export class StateMessage implements Component {
	private cache = new RenderCache<string[]>();
	private readonly options: StateOptions;
	constructor(options: StateOptions) { this.options = options; }
	render(width: number): string[] {
		const target = columns(width);
		return this.cache.getOrCreate(target, () => {
			const align = this.options.align ?? "center";
			const lines: string[] = [];
			if (this.options.icon) lines.push(fitLine(paint(this.options.theme, this.options.icon, this.options.tone ?? "muted"), target, { align }));
			lines.push(fitLine(paint(this.options.theme, this.options.title, this.options.tone ?? "neutral", "strong"), target, { align }));
			if (this.options.detail) lines.push(...wrapLines(paint(this.options.theme, this.options.detail, "muted"), target).map((line) => fitLine(line, target, { align })));
			if (this.options.hint) lines.push("", fitLine(paint(this.options.theme, this.options.hint, "subtle"), target, { align }));
			return lines;
		});
	}
	invalidate(): void { this.cache.invalidate(); }
}

export class EmptyState extends StateMessage {
	constructor(options: Omit<StateOptions, "tone"> & { tone?: Tone }) {
		super({ tone: "muted", ...options });
	}
}

export class ErrorState extends StateMessage {
	constructor(options: Omit<StateOptions, "tone">) {
		super({ tone: "danger", ...options });
	}
}
