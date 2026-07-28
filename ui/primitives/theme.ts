import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

type ThemeBg = Parameters<Theme["bg"]>[0];

export type Tone = "neutral" | "accent" | "muted" | "subtle" | "info" | "active" | "success" | "warning" | "danger";
export type Emphasis = "normal" | "strong" | "quiet";

const foreground: Record<Tone, ThemeColor> = {
	neutral: "text",
	accent: "accent",
	muted: "muted",
	subtle: "dim",
	info: "accent",
	active: "accent",
	success: "success",
	warning: "warning",
	danger: "error",
};

const background: Partial<Record<Tone, ThemeBg>> = {
	active: "selectedBg",
	success: "toolSuccessBg",
	warning: "toolPendingBg",
	danger: "toolErrorBg",
};

export function colorFor(tone: Tone): ThemeColor {
	return foreground[tone];
}

export function backgroundFor(tone: Tone): ThemeBg | undefined {
	return background[tone];
}

export function paint(theme: Theme, value: string, tone: Tone = "neutral", emphasis: Emphasis = "normal"): string {
	let output = theme.fg(colorFor(emphasis === "quiet" && tone === "neutral" ? "muted" : tone), value);
	if (emphasis === "strong") output = theme.bold(output);
	return output;
}

export function fill(theme: Theme, value: string, tone: Tone): string {
	const background = backgroundFor(tone);
	return background ? theme.bg(background, value) : value;
}
