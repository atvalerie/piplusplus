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
	providerBalance?: number;
	providerSavings?: number;
	permissionMode?: string;
	statuses?: readonly string[];
}

export function formatCount(value: number): string {
	if (value < 1_000) return String(Math.max(0, Math.round(value)));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function spread(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return fitLine(right, width);
	const leftWidth = Math.max(1, width - rightWidth - 1);
	return `${fitLine(left, leftWidth)} ${right}`;
}

export function renderFooter(snapshot: FooterSnapshot, width: number, theme: Theme): string[] {
	const branch = snapshot.branch ? ` ${snapshot.branch}${snapshot.dirty ? "*" : ""}` : "";
	const project = paint(theme, `${snapshot.project}${branch}`, "muted");
	const model = paint(theme, `${snapshot.model} · ${snapshot.thinking}`, "muted");
	const context = snapshot.contextPercent === undefined ? "ctx —" : `ctx ${Math.max(0, Math.min(999, Math.round(snapshot.contextPercent)))}%`;
	const provider = snapshot.providerBalance === undefined ? "" : ` · bal $${snapshot.providerBalance.toFixed(2)}${snapshot.providerSavings === undefined ? "" : ` · saved ~$${snapshot.providerSavings.toFixed(3)}`}`;
	const usage = paint(theme, `${context} · ↑${formatCount(snapshot.inputTokens)} ↓${formatCount(snapshot.outputTokens)} · $${snapshot.cost.toFixed(3)}${provider}`, "subtle");
	const permission = snapshot.permissionMode
		? paint(theme, `perm:${snapshot.permissionMode}`, snapshot.permissionMode === "auto" ? "success" : snapshot.permissionMode === "manual" ? "warning" : "muted", "strong")
		: paint(theme, "perm:—", "subtle");
	if (width < 52) return [fitLine(`${permission} · ${model} · ${context}`, width)];
	const activity = snapshot.statuses?.filter(Boolean) ?? [];
	if (width < 92) {
		const status = width >= 72 && activity.length ? ` · ${activity[0]}` : "";
		return [spread(`${project} · ${permission}${status}`, `${model} · ${paint(theme, context, "subtle")}`, width)];
	}
	const status = activity.length ? ` · ${activity.slice(0, 3).join(" · ")}` : "";
	return [spread(`${project} · ${permission}${status}`, `${model}   ${usage}`, width)];
}
