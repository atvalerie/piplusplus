import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { RenderCache } from "../foundation/cache.ts";
import { columns } from "../foundation/geometry.ts";
import { fitLine, visibleWidth } from "../foundation/text.ts";
import { paint, type Tone } from "./theme.ts";

export interface ProgressOptions {
	theme: Theme;
	value?: number;
	total?: number;
	label?: string;
	tone?: Tone;
	showValue?: boolean;
	ascii?: boolean;
	frame?: number;
}

function ratio(value?: number, total?: number): number | undefined {
	if (value === undefined || total === undefined || !Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return undefined;
	return Math.max(0, Math.min(1, value / total));
}

export class ProgressBar implements Component {
	private cache = new RenderCache<string[]>();
	private readonly options: ProgressOptions;
	constructor(options: ProgressOptions) { this.options = options; }

	render(width: number): string[] {
		const target = columns(width);
		const key = `${target}:${this.options.value}:${this.options.total}:${this.options.frame ?? 0}`;
		return this.cache.getOrCreate(key, () => {
			if (target === 0) return [""];
			const progress = ratio(this.options.value, this.options.total);
			const value = this.options.showValue === false ? "" : progress === undefined
				? ""
				: this.options.total !== undefined && this.options.value !== undefined
					? `${Math.max(0, this.options.value)}/${Math.max(0, this.options.total)}`
					: `${Math.round(progress * 100)}%`;
			const prefix = this.options.label ? `${this.options.label} ` : "";
			const suffix = value ? ` ${value}` : "";
			const chrome = visibleWidth(prefix) + visibleWidth(suffix);
			if (target - chrome < 4) return [fitLine(`${prefix}${value}`, target)];
			const barWidth = target - chrome;
			const full = this.options.ascii ? "=" : "━";
			const empty = this.options.ascii ? "-" : "─";
			let complete: number;
			if (progress === undefined) {
				const travel = Math.max(1, barWidth - 2);
				complete = Math.abs(Math.floor(this.options.frame ?? 0)) % travel;
				const markerWidth = Math.min(2, barWidth);
				const bar = `${paint(this.options.theme, empty.repeat(complete), "subtle")}${paint(this.options.theme, full.repeat(markerWidth), this.options.tone ?? "active")}${paint(this.options.theme, empty.repeat(Math.max(0, barWidth - complete - markerWidth)), "subtle")}`;
				return [fitLine(`${prefix}${bar}${suffix}`, target)];
			}
			complete = Math.round(barWidth * progress);
			const bar = `${paint(this.options.theme, full.repeat(complete), this.options.tone ?? "active")}${paint(this.options.theme, empty.repeat(barWidth - complete), "subtle")}`;
			return [fitLine(`${prefix}${bar}${suffix}`, target)];
		});
	}

	invalidate(): void { this.cache.invalidate(); }
}
