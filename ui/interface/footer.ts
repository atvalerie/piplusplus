import type { Theme } from "@earendil-works/pi-coding-agent";
import { fitLine, visibleWidth } from "../foundation/text.ts";
import { paint } from "../primitives/theme.ts";

export interface FooterSnapshot {
	project: string;
	branch?: string;
	dirty?: boolean;
	model: string;
	thinking: string;
	inputTokens: number;
	outputTokens: number;
	contextPercent?: number;
	cost: number;
	statuses?: readonly string[];
}

export function formatCount(value: number): string {
	if (value < 1_000) return String(Math.max(0, Math.round(value)));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function spread(left: string, right: string, width: number): string {
	const room = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return fitLine(`${left}${" ".repeat(room)}${right}`, width);
}

export function renderFooter(snapshot: FooterSnapshot, width: number, theme: Theme): string[] {
	const branch = snapshot.branch ? ` ${snapshot.branch}${snapshot.dirty ? "*" : ""}` : "";
	const project = paint(theme, `${snapshot.project}${branch}`, "muted");
	const model = paint(theme, `${snapshot.model} · ${snapshot.thinking}`, "muted");
	const context = snapshot.contextPercent === undefined ? "ctx —" : `ctx ${Math.max(0, Math.min(999, Math.round(snapshot.contextPercent)))}%`;
	const usage = paint(theme, `${context} · ↑${formatCount(snapshot.inputTokens)} ↓${formatCount(snapshot.outputTokens)} · $${snapshot.cost.toFixed(3)}`, "subtle");
	if (width < 52) return [fitLine(`${model} · ${context}`, width)];
	if (width < 92) return [spread(project, `${model} · ${paint(theme, context, "subtle")}`, width)];
	const status = snapshot.statuses?.length ? ` · ${snapshot.statuses.slice(0, 2).join(" · ")}` : "";
	return [spread(`${project}${status}`, `${model}   ${usage}`, width)];
}
