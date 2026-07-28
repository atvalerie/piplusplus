import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { columns, normalizeInsets, type InsetsInput } from "../foundation/geometry.ts";
import { inset, stack } from "../foundation/layout.ts";
import { symbols, type Symbols } from "../foundation/symbols.ts";
import { fitLine, visibleWidth } from "../foundation/text.ts";
import { paint, type Tone } from "./theme.ts";

export type SurfaceBorder = "none" | "line" | "frame";

export interface SurfaceOptions {
	theme: Theme;
	body: Component;
	title?: string;
	subtitle?: string;
	border?: SurfaceBorder;
	borderTone?: Tone;
	padding?: InsetsInput;
	symbols?: Symbols;
	background?: "none" | "panel";
}

export class Surface implements Component {
	private readonly options: SurfaceOptions;
	constructor(options: SurfaceOptions) { this.options = options; }

	render(width: number): string[] {
		const target = columns(width);
		if (target === 0) return [];
		const finish = (lines: string[]) => this.options.background === "panel"
			? lines.map((line) => this.options.theme.bg("customMessageBg", fitLine(line, target, { pad: true, ellipsis: "" })))
			: lines;
		const border = this.options.border ?? "none";
		const edge = normalizeInsets(this.options.padding ?? (border === "none" ? 0 : { left: 1, right: 1 }));
		const chrome = border === "frame" ? 2 : 0;
		const bodyWidth = Math.max(0, target - chrome - edge.left - edge.right);
		const body = inset(this.options.body.render(bodyWidth), Math.max(0, target - chrome), edge);
		if (border === "none") {
			const heading = this.heading(target);
			return finish(heading.length ? stack([heading, body], 1) : body);
		}
		const set = this.options.symbols ?? symbols();
		const tone = this.options.borderTone ?? "subtle";
		if (border === "line") {
			const title = this.titleText();
			const label = title ? ` ${title} ` : "";
			const clipped = fitLine(label, target);
			const rule = `${clipped}${set.horizontal.repeat(Math.max(0, target - visibleWidth(clipped)))}`;
			return finish([paint(this.options.theme, rule, tone), ...body]);
		}
		if (target === 1) return finish(body.map(() => paint(this.options.theme, set.vertical, tone)));
		const inside = target - 2;
		const title = this.titleText();
		const topLabel = title ? ` ${title} ` : "";
		const clippedTitle = fitLine(topLabel, inside);
		const top = `${set.topLeft}${clippedTitle}${set.horizontal.repeat(Math.max(0, inside - visibleWidth(clippedTitle)))}${set.topRight}`;
		const framedBody = body.map((line) => `${paint(this.options.theme, set.vertical, tone)}${fitLine(line, inside, { pad: true, ellipsis: "" })}${paint(this.options.theme, set.vertical, tone)}`);
		const bottom = `${set.bottomLeft}${set.horizontal.repeat(inside)}${set.bottomRight}`;
		return finish([paint(this.options.theme, top, tone), ...framedBody, paint(this.options.theme, bottom, tone)]);
	}

	private titleText(): string {
		return [this.options.title, this.options.subtitle].filter(Boolean).join(" · ");
	}

	private heading(width: number): string[] {
		if (!this.options.title) return [];
		const title = paint(this.options.theme, this.options.title, "neutral", "strong");
		const subtitle = this.options.subtitle ? paint(this.options.theme, ` · ${this.options.subtitle}`, "muted") : "";
		return [fitLine(`${title}${subtitle}`, width)];
	}

	invalidate(): void { this.options.body.invalidate(); }
}
