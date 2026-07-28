import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentState, WorkflowController, WorkflowRun } from "./types.ts";

export type WorkflowStatusFilter = "all" | "active" | "completed" | "attention";
const STATUS_FILTERS: WorkflowStatusFilter[] = ["all", "active", "completed", "attention"];

function icon(status: string): string {
	return ({ queued: "○", running: "⏳", paused: "Ⅱ", completed: "✓", completed_with_flags: "⚑", flagged: "⚑", budget_exhausted: "⚠", failed: "✗", stopped: "■" } as Record<string, string>)[status] ?? "·";
}

function tokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function elapsed(run: WorkflowRun): string {
	const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt)) / 1_000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stats(run: WorkflowRun): string {
	return `${run.usage.turns} turns · ↑${tokens(run.usage.input)} ↓${tokens(run.usage.output)} · $${run.usage.cost.toFixed(4)} · ${elapsed(run)}`;
}

export class WorkflowBrowser {
	private level: "runs" | "phases" | "agents" | "detail" = "runs";
	private runIndex = 0;
	private phaseIndex = 0;
	private agentIndex = 0;
	private scroll = 0;
	private detailMaxScroll = 0;
	private statusFilter: WorkflowStatusFilter = "all";
	private readonly getRuns: () => WorkflowRun[];
	private readonly controllers: Map<string, WorkflowController>;
	private readonly theme: Theme;
	private readonly close: () => void;
	private readonly height: number;
	private readonly resumeRun?: (runId: string, restartAgentId?: string) => void;
	private readonly saveRun?: (runId: string) => void;

	constructor(
		getRuns: () => WorkflowRun[],
		controllers: Map<string, WorkflowController>,
		theme: Theme,
		close: () => void,
		height = 30,
		resumeRun?: (runId: string, restartAgentId?: string) => void,
		saveRun?: (runId: string) => void,
	) {
		this.getRuns = getRuns;
		this.controllers = controllers;
		this.theme = theme;
		this.close = close;
		this.height = height;
		this.resumeRun = resumeRun;
		this.saveRun = saveRun;
	}

	private visibleRuns(): WorkflowRun[] {
		return this.getRuns().filter((run) => {
			if (this.statusFilter === "all") return true;
			if (this.statusFilter === "active") return ["queued", "running", "paused"].includes(run.status);
			if (this.statusFilter === "completed") return run.status === "completed";
			return ["completed_with_flags", "budget_exhausted", "failed", "stopped"].includes(run.status);
		});
	}
	private run(): WorkflowRun | undefined { return this.visibleRuns()[this.runIndex]; }
	private phases(): string[] { return this.run()?.phases ?? []; }
	private agents(): AgentState[] {
		const run = this.run();
		const phase = this.phases()[this.phaseIndex];
		return run?.agents.filter((agent) => agent.phase === phase) ?? [];
	}
	private agent(): AgentState | undefined { return this.agents()[this.agentIndex]; }

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			if (this.level === "runs") this.close();
			else this.level = this.level === "phases" ? "runs" : this.level === "agents" ? "phases" : "agents";
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) { this.close(); return; }
		if (data === "f") {
			this.statusFilter = STATUS_FILTERS[(STATUS_FILTERS.indexOf(this.statusFilter) + 1) % STATUS_FILTERS.length];
			this.level = "runs";
			this.runIndex = 0;
			this.phaseIndex = 0;
			this.agentIndex = 0;
			this.scroll = 0;
			return;
		}
		if (data === "s") {
			const run = this.run();
			if (run) this.saveRun?.(run.id);
			return;
		}
		if (data === "p") {
			const run = this.run(); const controller = run ? this.controllers.get(run.id) : undefined;
			if (run?.status === "stopped") this.resumeRun?.(run.id);
			else if (run?.status === "paused") controller?.resume();
			else controller?.pause();
			return;
		}
		if (data === "x") {
			const run = this.run(); const controller = run ? this.controllers.get(run.id) : undefined;
			if (this.level === "agents" || this.level === "detail") { const agent = this.agent(); if (agent) controller?.stopAgent(agent.id); }
			else controller?.stop();
			return;
		}
		if (data === "X") {
			const run = this.run();
			if (run) this.controllers.get(run.id)?.hardStop();
			return;
		}
		if (data === "r" && (this.level === "agents" || this.level === "detail")) {
			const run = this.run(); const agent = this.agent();
			if (run && agent) {
				this.controllers.get(run.id)?.restartAgent(agent.id);
				if (["stopped", "completed", "completed_with_flags", "budget_exhausted", "failed"].includes(run.status)) this.resumeRun?.(run.id, agent.id);
			}
			return;
		}
		if (this.level === "detail") {
			const mouse = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
			const button = mouse ? Number(mouse[1]) : undefined;
			if (data === "j" || matchesKey(data, Key.down) || (button !== undefined && (button & 64) !== 0 && (button & 1) === 1)) this.scroll++;
			if (data === "k" || matchesKey(data, Key.up) || (button !== undefined && (button & 64) !== 0 && (button & 1) === 0)) this.scroll = Math.max(0, this.scroll - 1);
			if (matchesKey(data, Key.pageDown)) this.scroll += Math.max(1, this.height - 12);
			if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - Math.max(1, this.height - 12));
			this.scroll = Math.max(0, Math.min(this.detailMaxScroll, this.scroll));
			return;
		}
		const max = this.level === "runs" ? this.visibleRuns().length : this.level === "phases" ? this.phases().length : this.agents().length;
		if (matchesKey(data, Key.up)) {
			if (this.level === "runs" && this.runIndex === 0) { this.close(); return; }
			if (this.level === "runs") this.runIndex = Math.max(0, this.runIndex - 1);
			else if (this.level === "phases") this.phaseIndex = Math.max(0, this.phaseIndex - 1);
			else this.agentIndex = Math.max(0, this.agentIndex - 1);
		}
		if (matchesKey(data, Key.down)) {
			if (this.level === "runs") this.runIndex = Math.min(Math.max(0, max - 1), this.runIndex + 1);
			else if (this.level === "phases") this.phaseIndex = Math.min(Math.max(0, max - 1), this.phaseIndex + 1);
			else this.agentIndex = Math.min(Math.max(0, max - 1), this.agentIndex + 1);
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			if (!max) return;
			if (this.level === "runs") { this.level = "phases"; this.phaseIndex = 0; }
			else if (this.level === "phases") { this.level = "agents"; this.agentIndex = 0; }
			else { this.level = "detail"; this.scroll = 0; }
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = ["", `  ${th.fg("accent", th.bold("Dynamic workflows"))} ${th.fg("dim", `· ${this.level} · filter:${this.statusFilter}`)}`, ""];
		let focusLine = 3;
		const runs = this.visibleRuns();
		this.runIndex = Math.min(this.runIndex, Math.max(0, runs.length - 1));
		if (this.level === "runs") {
			if (!runs.length) lines.push(`  ${th.fg("dim", "No workflows in this session")}`);
			for (let i = 0; i < runs.length; i++) {
				const run = runs[i];
				const selected = i === this.runIndex ? th.fg("accent", ">") : " ";
				if (i === this.runIndex) focusLine = lines.length;
				lines.push(` ${selected} ${icon(run.status)} ${th.fg("text", run.spec.name)} ${th.fg("dim", `· ${run.agents.length} agents · ${stats(run)}`)}`);
				if (i === this.runIndex) lines.push(`     ${th.fg("muted", run.spec.why)}`);
			}
		} else if (this.level === "phases") {
			const run = this.run()!;
			lines.push(`  ${icon(run.status)} ${th.bold(run.spec.name)} ${th.fg("dim", `· ${run.id}`)}`, `  ${th.fg("muted", "Goal: ")}${run.spec.goal}`, "");
			const phases = this.phases();
			for (let i = 0; i < phases.length; i++) {
				const agents = run.agents.filter((agent) => agent.phase === phases[i]);
				const done = agents.filter((agent) => !["queued", "running"].includes(agent.status)).length;
				if (i === this.phaseIndex) focusLine = lines.length;
				lines.push(` ${i === this.phaseIndex ? th.fg("accent", ">") : " "} ${th.fg("accent", phases[i])} ${th.fg("dim", `· ${done}/${agents.length}`)}`);
			}
			lines.push("", `  ${th.fg("dim", stats(run))}`);
			if (run.budget) {
				const limits = [
					`${run.agents.length}/${run.budget.maxAgents} agents`,
					run.budget.maxTokens === undefined ? undefined : `${tokens(run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite)}/${tokens(run.budget.maxTokens)} tokens`,
					run.budget.maxCost === undefined ? undefined : `$${run.usage.cost.toFixed(4)}/$${run.budget.maxCost.toFixed(4)}`,
					`${tokens(run.budget.projectedTokens)} projected`,
				].filter(Boolean).join(" · ");
				lines.push(`  ${th.fg(run.budget.exhausted ? "warning" : "dim", `Budget: ${limits}`)}`);
				for (const warning of run.budget.warnings) lines.push(`  ${th.fg("warning", `⚠ ${warning}`)}`);
			}
			for (const flag of run.flags) lines.push(`  ${th.fg("warning", `⚑ ${flag}`)}`);
			if (run.error) lines.push(`  ${th.fg("error", run.error)}`);
		} else if (this.level === "agents") {
			const run = this.run()!; const phase = this.phases()[this.phaseIndex]; const agents = this.agents();
			this.agentIndex = Math.min(this.agentIndex, Math.max(0, agents.length - 1));
			lines.push(`  ${th.bold(run.spec.name)} ${th.fg("dim", "›")} ${th.fg("accent", phase)}`, "");
			for (let i = 0; i < agents.length; i++) {
				const agent = agents[i];
				if (i === this.agentIndex) focusLine = lines.length;
				lines.push(` ${i === this.agentIndex ? th.fg("accent", ">") : " "} ${icon(agent.status)} ${agent.label} ${th.fg("dim", `· ${agent.resolvedModel ?? agent.requestedModel ?? "auto"} · ${agent.cached ? "cached" : "live"} · ${agent.usage.turns} turns · $${agent.usage.cost.toFixed(4)}`)}`);
				if (agent.error) lines.push(`     ${th.fg("error", agent.error)}`);
			}
		} else {
			const agent = this.agent()!;
			lines.push(`  ${icon(agent.status)} ${th.bold(agent.label)} ${th.fg("dim", `· ${agent.id}`)}`);
			lines.push(`  ${th.fg("muted", "Requested model: ")}${agent.requestedModel ?? "omitted (inherit by policy)"}`);
			lines.push(`  ${th.fg("muted", "Resolved model: ")}${agent.resolvedModel ?? "(not resolved)"}`);
			lines.push(`  ${th.fg("muted", "Reported model: ")}${agent.reportedModel ?? "(not reported)"}${agent.modelRationale ? th.fg("dim", ` — ${agent.modelRationale}`) : ""}`);
			if (agent.profile) lines.push(`  ${th.fg("muted", "Profile: ")}${agent.profile}${agent.writePaths ? th.fg("dim", ` · write scope: ${agent.writePaths.join(", ")}`) : ""}`);
			lines.push(`  ${th.fg("muted", "State: ")}${agent.status} · ${agent.cached ? "cached" : "live"} · attempt ${agent.attempt} · ${agent.usage.turns}${agent.maxTurns ? `/${agent.maxTurns}` : ""} turns · $${agent.usage.cost.toFixed(4)}`, "");
			const detail: string[] = [th.fg("accent", "Prompt"), ...wrapTextWithAnsi(agent.prompt, Math.max(10, width - 4)), "", th.fg("accent", "Tool calls")];
			if (!agent.toolCalls.length) detail.push(th.fg("dim", "(none)"));
			for (const tool of agent.toolCalls) detail.push(`${tool.error ? th.fg("error", "✗") : "→"} ${tool.name} ${th.fg("dim", JSON.stringify(tool.args ?? {}).slice(0, 300))}`);
			detail.push("", th.fg("accent", agent.error ? "Error" : "Result"));
			detail.push(...wrapTextWithAnsi(agent.error ? th.fg("error", agent.error) : agent.output ?? th.fg("dim", "(running)") , Math.max(10, width - 4)));
			const windowSize = Math.max(4, this.height - 13);
			this.detailMaxScroll = Math.max(0, detail.length - windowSize);
			this.scroll = Math.max(0, Math.min(this.detailMaxScroll, this.scroll));
			const window = detail.slice(this.scroll, this.scroll + windowSize);
			lines.push(...window.map((line) => `  ${line}`));
			if (detail.length > windowSize) lines.push(`  ${th.fg("dim", `j/k, pgup/pgdn, or wheel · ${this.scroll + 1}-${Math.min(detail.length, this.scroll + windowSize)}/${detail.length}`)}`);
		}
		const footer = ["", `  ${th.fg("dim", "enter/→ details · esc/← back · f filter · s save · p pause/resume · x stop (resumable) · X hard stop · r restart selected")}`, ""];
		const header = lines.slice(0, 3);
		const body = lines.slice(3);
		const available = Math.max(1, this.height - header.length - footer.length);
		const relativeFocus = Math.max(0, focusLine - header.length);
		const start = Math.max(0, Math.min(Math.max(0, body.length - available), relativeFocus - available + 1));
		return [...header, ...body.slice(start, start + available), ...footer].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}
