import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RenderCache } from "../foundation/cache.ts";
import { fitLine, visibleWidth } from "../foundation/text.ts";
import { paint, type Tone } from "./theme.ts";

export interface MetricOptions {
	theme: Theme;
	label: string;
	value: string;
	detail?: string;
	tone?: Tone;
	compact?: boolean;
}

export function metricText(options: MetricOptions): string {
	return `${paint(options.theme, options.label, "muted")} ${paint(options.theme, options.value, options.tone ?? "neutral", "strong")}`;
}

export class Metric implements Component {
	private cache = new RenderCache<string[]>();
	private readonly options: MetricOptions;
	constructor(options: MetricOptions) { this.options = options; }
	render(width: number): string[] {
		return this.cache.getOrCreate(width, () => {
			const inline = metricText(this.options);
			const detail = this.options.detail ? ` ${paint(this.options.theme, this.options.detail, "subtle")}` : "";
			if (this.options.compact || visibleWidth(`${inline}${detail}`) <= width) return [fitLine(`${inline}${detail}`, width)];
			return [
				fitLine(paint(this.options.theme, this.options.label, "muted"), width),
				fitLine(`${paint(this.options.theme, this.options.value, this.options.tone ?? "neutral", "strong")}${detail}`, width),
			];
		});
	}
	invalidate(): void { this.cache.invalidate(); }
}
