import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Symbols } from "../foundation/symbols.ts";
import { symbols as defaultSymbols } from "../foundation/symbols.ts";
import { paint, type Tone } from "./theme.ts";

export type OperationalStatus = "pending" | "running" | "paused" | "success" | "warning" | "failed" | "stopped";

const tones: Record<OperationalStatus, Tone> = {
	pending: "subtle",
	running: "active",
	paused: "warning",
	success: "success",
	warning: "warning",
	failed: "danger",
	stopped: "muted",
};

export function statusTone(status: OperationalStatus): Tone {
	return tones[status];
}

export function statusSymbol(status: OperationalStatus, set: Symbols = defaultSymbols()): string {
	if (status === "failed") return set.error;
	return set[status];
}

export function statusText(theme: Theme, status: OperationalStatus, label?: string, set?: Symbols): string {
	const glyph = statusSymbol(status, set);
	return paint(theme, label ? `${glyph} ${label}` : glyph, statusTone(status), status === "running" ? "strong" : "normal");
}

export const spinnerFrames = ["·", "•", "●", "•"] as const;

export function spinnerText(theme: Theme, frame: number, label?: string): string {
	const glyph = spinnerFrames[Math.abs(Math.floor(frame)) % spinnerFrames.length];
	return paint(theme, label ? `${glyph} ${label}` : glyph, "active", "strong");
}
