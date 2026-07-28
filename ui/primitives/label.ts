import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RenderCache } from "../foundation/cache.ts";
import { columns } from "../foundation/geometry.ts";
import { fitLine, wrapLines, type HorizontalAlign } from "../foundation/text.ts";
import { paint, type Emphasis, type Tone } from "./theme.ts";

export interface LabelOptions {
	theme: Theme;
	text: string;
	tone?: Tone;
	emphasis?: Emphasis;
	align?: HorizontalAlign;
	wrap?: boolean;
	pad?: boolean;
	maxLines?: number;
}

export class Label implements Component {
	private cache = new RenderCache<string[]>();
	private options: LabelOptions;

	constructor(options: LabelOptions) { this.options = options; }

	setText(text: string): void {
		if (text === this.options.text) return;
		this.options.text = text;
		this.invalidate();
	}

	render(width: number): string[] {
		const target = columns(width);
		return this.cache.getOrCreate(target, () => {
			const styled = paint(this.options.theme, this.options.text, this.options.tone, this.options.emphasis);
			let lines = this.options.wrap === false
				? styled.split(/\r?\n/).map((line) => fitLine(line, target, { align: this.options.align, pad: this.options.pad }))
				: wrapLines(styled, target).map((line) => fitLine(line, target, { align: this.options.align, pad: this.options.pad }));
			if (this.options.maxLines !== undefined) lines = lines.slice(0, columns(this.options.maxLines));
			return lines;
		});
	}

	invalidate(): void { this.cache.invalidate(); }
}
