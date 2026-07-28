import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { columns } from "../foundation/geometry.ts";
import { symbols, type Symbols } from "../foundation/symbols.ts";
import { fitLine, wrapLines } from "../foundation/text.ts";
import { paint, type Tone } from "../primitives/theme.ts";
import { Viewport } from "./viewport.ts";

export interface InspectorSection {
	id: string;
	label: string;
	content: string | readonly string[] | Component;
	collapsed?: boolean;
	tone?: Tone;
}

export interface InspectorOptions {
	theme: Theme;
	sections: readonly InspectorSection[];
	height?: number;
	symbols?: Symbols;
	onSectionChange?: (section: InspectorSection, index: number) => void;
	onToggle?: (section: InspectorSection, collapsed: boolean) => void;
}

export class Inspector implements Component {
	private options: InspectorOptions;
	private selected = 0;
	private collapsed = new Set<string>();
	private viewport = new Viewport();
	private lastContentHeight = 0;
	private lastViewportHeight = 20;
	private selectionDirty = true;

	constructor(options: InspectorOptions) {
		this.options = options;
		for (const section of options.sections) if (section.collapsed) this.collapsed.add(section.id);
	}

	get selectedSection(): InspectorSection | undefined { return this.options.sections[this.selected]; }

	handleInput(data: string): void {
		let changed = false;
		if (matchesKey(data, Key.down)) { this.selected = Math.min(this.options.sections.length - 1, this.selected + 1); changed = true; }
		else if (matchesKey(data, Key.up)) { this.selected = Math.max(0, this.selected - 1); changed = true; }
		else if (matchesKey(data, Key.home)) { this.selected = 0; changed = true; }
		else if (matchesKey(data, Key.end)) { this.selected = Math.max(0, this.options.sections.length - 1); changed = true; }
		else if (data === "j") this.viewport.scroll(1, this.lastContentHeight, this.lastViewportHeight);
		else if (data === "k") this.viewport.scroll(-1, this.lastContentHeight, this.lastViewportHeight);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || matchesKey(data, Key.right) || matchesKey(data, Key.left)) this.toggleSelected(data);
		if (changed && this.selectedSection) {
			this.selectionDirty = true;
			this.options.onSectionChange?.(this.selectedSection, this.selected);
		}
	}

	render(width: number): string[] {
		const rendered = this.renderAll(columns(width));
		const height = Math.max(1, columns(this.options.height ?? rendered.lines.length));
		this.lastContentHeight = rendered.lines.length;
		this.lastViewportHeight = height;
		const selectedRow = rendered.sectionRows[this.selected] ?? 0;
		if (this.selectionDirty) {
			this.viewport.ensureVisible(selectedRow, rendered.lines.length, height);
			this.selectionDirty = false;
		}
		return this.viewport.slice(rendered.lines, height);
	}

	invalidate(): void {
		for (const section of this.options.sections) if (typeof section.content === "object" && !Array.isArray(section.content)) section.content.invalidate();
	}

	private toggleSelected(data: string): void {
		const section = this.selectedSection;
		if (!section) return;
		const isCollapsed = this.collapsed.has(section.id);
		const expandOnly = matchesKey(data, Key.right);
		const collapseOnly = matchesKey(data, Key.left);
		const next = expandOnly ? false : collapseOnly ? true : !isCollapsed;
		if (next === isCollapsed) return;
		if (next) this.collapsed.add(section.id); else this.collapsed.delete(section.id);
		this.options.onToggle?.(section, next);
	}

	private renderAll(width: number): { lines: string[]; sectionRows: number[] } {
		const lines: string[] = [];
		const sectionRows: number[] = [];
		const set = this.options.symbols ?? symbols();
		for (let index = 0; index < this.options.sections.length; index++) {
			const section = this.options.sections[index];
			const isCollapsed = this.collapsed.has(section.id);
			sectionRows.push(lines.length);
			const marker = index === this.selected ? set.selected : " ";
			const disclosure = isCollapsed ? set.collapsed : set.expanded;
			lines.push(fitLine(paint(this.options.theme, `${marker} ${disclosure} ${section.label}`, index === this.selected ? "accent" : section.tone ?? "muted", index === this.selected ? "strong" : "normal"), width));
			if (isCollapsed) continue;
			const contentWidth = Math.max(0, width - 2);
			let content: string[];
			if (typeof section.content === "string") content = wrapLines(section.content, contentWidth);
			else if (Array.isArray(section.content)) content = section.content.flatMap((line) => wrapLines(line, contentWidth));
			else content = section.content.render(contentWidth);
			lines.push(...content.map((line) => fitLine(`  ${line}`, width)));
		}
		return { lines: lines.length ? lines : [paint(this.options.theme, "(no details)", "subtle")], sectionRows };
	}
}
