import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { allocate, columns } from "./foundation/geometry.ts";
import { joinColumns, stack } from "./foundation/layout.ts";
import { symbols } from "./foundation/symbols.ts";
import { fitLine } from "./foundation/text.ts";
import { Inspector } from "./interactive/inspector.ts";
import { List } from "./interactive/list.ts";
import { SplitPane } from "./interactive/split-pane.ts";
import { Tabs } from "./interactive/tabs.ts";
import { Tree } from "./interactive/tree.ts";
import { badgeText } from "./primitives/badge.ts";
import { Breadcrumb } from "./primitives/breadcrumb.ts";
import { KeyHints } from "./primitives/hint.ts";
import { Label } from "./primitives/label.ts";
import { Metric } from "./primitives/metric.ts";
import { ProgressBar } from "./primitives/progress.ts";
import { Rule } from "./primitives/rule.ts";
import { EmptyState, ErrorState } from "./primitives/state.ts";
import { statusText } from "./primitives/status.ts";
import { Surface } from "./primitives/surface.ts";
import { paint } from "./primitives/theme.ts";

class OverviewPage implements Component {
	private readonly theme: Theme;
	constructor(theme: Theme) { this.theme = theme; }
	render(width: number): string[] {
		const status = [
			statusText(this.theme, "running", "running"),
			statusText(this.theme, "success", "complete"),
			statusText(this.theme, "warning", "flagged"),
			statusText(this.theme, "failed", "failed"),
		].join(paint(this.theme, "   ", "subtle"));
		const badges = [
			badgeText({ theme: this.theme, label: "ACTIVE", tone: "active" }),
			badgeText({ theme: this.theme, label: "VERIFIED", tone: "success", variant: "outline" }),
			badgeText({ theme: this.theme, label: "PAUSED", tone: "warning", variant: "plain" }),
		].join("  ");
		const metrics = [
			new Metric({ theme: this.theme, label: "Agents", value: "7/10", compact: true }),
			new Metric({ theme: this.theme, label: "Tokens", value: "18.2k", compact: true }),
			new Metric({ theme: this.theme, label: "Cost", value: "$0.014", compact: true }),
		];
		const metricWidths = allocate(Math.max(0, width - 4), [1, 1, 1]);
		const metricLines = width >= 52 ? joinColumns(metrics.map((metric, index) => metric.render(metricWidths[index])), { widths: metricWidths, gap: 2 }) : metrics.flatMap((metric) => metric.render(width));
		return stack([
			new Breadcrumb({ theme: this.theme, items: ["workflows", "repository audit", "verification"] }).render(width),
			new Rule({ theme: this.theme, label: "Semantic status" }).render(width),
			[fitLine(status, width)],
			new Rule({ theme: this.theme, label: "Badges" }).render(width),
			[fitLine(badges, width)],
			new Rule({ theme: this.theme, label: "Metrics" }).render(width),
			metricLines,
			new Label({ theme: this.theme, text: "Quiet hierarchy comes from alignment and rhythm. Color is reserved for focus and operational state.", tone: "muted" }).render(width),
		], 1);
	}
	invalidate(): void {}
}

class ProgressPage implements Component {
	frame = 0;
	private readonly theme: Theme;
	constructor(theme: Theme) { this.theme = theme; }
	render(width: number): string[] {
		return stack([
			new ProgressBar({ theme: this.theme, label: "Research", value: 8, total: 8, tone: "success" }).render(width),
			new ProgressBar({ theme: this.theme, label: "Verification", value: 5, total: 9, tone: "active" }).render(width),
			new ProgressBar({ theme: this.theme, label: "Synthesis", frame: this.frame, tone: "active" }).render(width),
			new Rule({ theme: this.theme, label: "States" }).render(width),
			new EmptyState({ theme: this.theme, icon: "○", title: "No queued agents", detail: "New agents appear here when a phase fans out.", hint: "ultracode …" }).render(width),
			new ErrorState({ theme: this.theme, icon: "×", title: "Permission audit failed", detail: "Worker exited before producing a report." }).render(width),
		], 1);
	}
	invalidate(): void {}
}

class NavigationPage implements Component {
	private readonly list: List;
	constructor(theme: Theme) {
		this.list = new List({ theme, height: 11, items: [
			{ id: "architecture", label: "Architecture", description: "completed", status: "success" },
			{ id: "api", label: "API surface", description: "2 flags", status: "warning" },
			{ id: "security", label: "Security review", description: "running", status: "running" },
			{ id: "permissions", label: "Permission audit", description: "failed", status: "failed" },
			{ id: "concurrency", label: "Concurrency", status: "success" },
			{ id: "tests", label: "Test coverage", status: "pending" },
			{ id: "disabled", label: "Optional benchmark", disabled: true },
		] });
	}
	render(width: number): string[] { return this.list.render(width); }
	handleInput(data: string): void { this.list.handleInput(data); }
	invalidate(): void { this.list.invalidate(); }
}

class TreePage implements Component {
	private readonly tree: Tree;
	constructor(theme: Theme) {
		this.tree = new Tree({ theme, height: 14, initiallyExpanded: ["workflow", "research", "verify"], nodes: [{
			id: "workflow", label: "Repository audit", status: "running", children: [
				{ id: "research", label: "Research", status: "success", children: [
					{ id: "architecture", label: "Architecture", status: "success" },
					{ id: "api", label: "API surface", status: "warning" },
				] },
				{ id: "verify", label: "Verification", status: "running", children: [
					{ id: "security", label: "Security review", status: "running" },
					{ id: "permissions", label: "Permission audit", status: "failed" },
				] },
				{ id: "synthesis", label: "Synthesis", status: "pending" },
			],
		}] });
	}
	render(width: number): string[] { return this.tree.render(width); }
	handleInput(data: string): void { this.tree.handleInput(data); }
	invalidate(): void { this.tree.invalidate(); }
}

class InspectorPage implements Component {
	private readonly inspector: Inspector;
	constructor(theme: Theme) {
		this.inspector = new Inspector({ theme, height: 16, sections: [
			{ id: "model", label: "Model", content: "openai-codex/gpt-5.5 · high · attempt 1" },
			{ id: "prompt", label: "Prompt", content: "Adversarially inspect the collected architecture and API reports. Verify every claim against repository evidence and flag uncertainty." },
			{ id: "tools", label: "Tool activity", content: ["✓ read  extensions/workflows/runtime.ts", "✓ grep  authorization", "→ bash  npm test"] },
			{ id: "result", label: "Result", content: "Waiting for the final tool operation to complete…" },
		] });
	}
	render(width: number): string[] { return this.inspector.render(width); }
	handleInput(data: string): void { this.inspector.handleInput(data); }
	invalidate(): void { this.inspector.invalidate(); }
}

class ResponsivePage implements Component {
	private readonly split: SplitPane;
	constructor(theme: Theme) {
		const list = new NavigationPage(theme);
		const inspector = new InspectorPage(theme);
		this.split = new SplitPane({ theme, gap: 3, collapseBelow: 68, panes: [
			{ id: "agents", title: "AGENTS", component: list, minWidth: 25, weight: 2 },
			{ id: "inspector", title: "INSPECTOR", component: inspector, minWidth: 38, weight: 3 },
		] });
	}
	render(width: number): string[] { return this.split.render(width); }
	handleInput(data: string): void { this.split.handleInput(data); }
	invalidate(): void { this.split.invalidate(); }
}

export type GalleryWidth = "auto" | 50 | 80 | 120;

export class UiGallery implements Component {
	private readonly tabs: Tabs;
	private readonly progress: ProgressPage;
	private readonly theme: Theme;
	private readonly close: () => void;
	private widthMode: GalleryWidth = "auto";
	private maxHeight = 24;

	constructor(theme: Theme, close: () => void) {
		this.theme = theme;
		this.close = close;
		this.progress = new ProgressPage(theme);
		this.tabs = new Tabs({ theme, items: [
			{ id: "overview", label: "Overview", content: new OverviewPage(theme) },
			{ id: "progress", label: "Progress", content: this.progress },
			{ id: "list", label: "List", content: new NavigationPage(theme) },
			{ id: "tree", label: "Tree", content: new TreePage(theme) },
			{ id: "inspector", label: "Inspector", content: new InspectorPage(theme) },
			{ id: "responsive", label: "Responsive", content: new ResponsivePage(theme) },
		] });
	}

	setMaxHeight(height: number): void { this.maxHeight = Math.max(8, columns(height)); }
	tick(): void { this.progress.frame++; }

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") { this.close(); return; }
		if (data === "w") {
			const modes: GalleryWidth[] = ["auto", 50, 80, 120];
			this.widthMode = modes[(modes.indexOf(this.widthMode) + 1) % modes.length];
			return;
		}
		this.tabs.handleInput(data);
	}

	render(width: number): string[] {
		const actual = columns(width);
		const requested = this.widthMode === "auto" ? actual : this.widthMode;
		const previewWidth = Math.max(20, Math.min(actual, requested));
		const mode = this.widthMode === "auto" ? `auto · ${actual} cols` : `${this.widthMode} cols${this.widthMode > actual ? " · clipped" : ""}`;
		const title = `${paint(this.theme, "Pi++ UI Gallery", "accent", "strong")} ${paint(this.theme, `· ${mode}`, "muted")}`;
		const hints = new KeyHints({ theme: this.theme, items: [
			{ key: "tab", label: "page" }, { key: "w", label: "width" }, { key: "arrows/jk", label: "interact" }, { key: "q", label: "close" },
		] });
		const body = new Surface({ theme: this.theme, title: this.tabs.activeTab?.label ?? "Gallery", border: "frame", body: this.tabs });
		let lines = [fitLine(title, previewWidth), "", ...body.render(previewWidth), "", ...hints.render(previewWidth)];
		lines = lines.slice(0, this.maxHeight);
		if (previewWidth < actual) {
			const left = Math.floor((actual - previewWidth) / 2);
			lines = lines.map((line) => `${" ".repeat(left)}${line}`);
		}
		return lines.map((line) => fitLine(line, actual));
	}

	invalidate(): void { this.tabs.invalidate(); }
}
