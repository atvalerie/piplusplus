import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { columns } from "../foundation/geometry.ts";
import { symbols, type Symbols } from "../foundation/symbols.ts";
import { fitLine } from "../foundation/text.ts";
import { fill, paint } from "../primitives/theme.ts";
import { statusSymbol, statusTone, type OperationalStatus } from "../primitives/status.ts";
import { Viewport } from "./viewport.ts";

export interface TreeNode<T = unknown> {
	id: string;
	label: string;
	description?: string;
	status?: OperationalStatus;
	children?: readonly TreeNode<T>[];
	data?: T;
}

interface FlatNode<T> {
	node: TreeNode<T>;
	depth: number;
	parentId?: string;
}

export interface TreeOptions<T = unknown> {
	theme: Theme;
	nodes: readonly TreeNode<T>[];
	height?: number;
	symbols?: Symbols;
	initiallyExpanded?: readonly string[] | "all";
	onChange?: (node: TreeNode<T>) => void;
	onSelect?: (node: TreeNode<T>) => void;
	onToggle?: (node: TreeNode<T>, expanded: boolean) => void;
}

export class Tree<T = unknown> implements Component {
	private options: TreeOptions<T>;
	private expanded = new Set<string>();
	private selectedId?: string;
	private viewport = new Viewport();

	constructor(options: TreeOptions<T>) {
		this.options = options;
		if (options.initiallyExpanded === "all") this.visit(options.nodes, (node) => { if (node.children?.length) this.expanded.add(node.id); });
		else for (const id of options.initiallyExpanded ?? []) this.expanded.add(id);
		this.selectedId = this.flatten()[0]?.node.id;
	}

	get selectedNode(): TreeNode<T> | undefined { return this.flatten().find((item) => item.node.id === this.selectedId)?.node; }

	setNodes(nodes: readonly TreeNode<T>[]): void {
		this.options = { ...this.options, nodes };
		const flat = this.flatten();
		if (!flat.some((item) => item.node.id === this.selectedId)) this.selectedId = flat[0]?.node.id;
		this.invalidate();
	}

	handleInput(data: string): void {
		const flat = this.flatten();
		if (!flat.length) return;
		let index = Math.max(0, flat.findIndex((item) => item.node.id === this.selectedId));
		const current = flat[index];
		let changed = false;
		if (data === "j" || matchesKey(data, Key.down)) { index = Math.min(flat.length - 1, index + 1); changed = true; }
		else if (data === "k" || matchesKey(data, Key.up)) { index = Math.max(0, index - 1); changed = true; }
		else if (matchesKey(data, Key.home) || data === "g") { index = 0; changed = true; }
		else if (matchesKey(data, Key.end) || data === "G") { index = flat.length - 1; changed = true; }
		else if (matchesKey(data, Key.right)) {
			if (current.node.children?.length && !this.expanded.has(current.node.id)) this.toggle(current.node, true);
			else if (current.node.children?.length) { index = Math.min(flat.length - 1, index + 1); changed = true; }
		} else if (matchesKey(data, Key.left)) {
			if (this.expanded.has(current.node.id)) this.toggle(current.node, false);
			else if (current.parentId) { const parent = flat.findIndex((item) => item.node.id === current.parentId); if (parent >= 0) { index = parent; changed = true; } }
		} else if (matchesKey(data, Key.space)) this.toggle(current.node, !this.expanded.has(current.node.id));
		else if (matchesKey(data, Key.enter)) this.options.onSelect?.(current.node);
		if (changed && flat[index]?.node.id !== this.selectedId) {
			this.selectedId = flat[index].node.id;
			this.options.onChange?.(flat[index].node);
		}
	}

	render(width: number): string[] {
		const target = columns(width);
		const flat = this.flatten();
		if (!flat.length) return [paint(this.options.theme, "(empty)", "subtle")];
		const height = Math.max(1, columns(this.options.height ?? flat.length));
		const selected = Math.max(0, flat.findIndex((item) => item.node.id === this.selectedId));
		this.viewport.ensureVisible(selected, flat.length, height);
		const range = this.viewport.range(flat.length, height);
		const set = this.options.symbols ?? symbols();
		return flat.slice(range.start, range.end).map((item, row) => {
			const active = range.start + row === selected;
			const hasChildren = Boolean(item.node.children?.length);
			const disclosure = hasChildren ? (this.expanded.has(item.node.id) ? set.expanded : set.collapsed) : " ";
			const status = item.node.status ? `${statusSymbol(item.node.status, set)} ` : "";
			const description = item.node.description ? ` · ${item.node.description}` : "";
			const raw = `${active ? set.selected : " "} ${"  ".repeat(item.depth)}${disclosure} ${status}${item.node.label}${description}`;
			const tone = active ? "accent" : item.node.status ? statusTone(item.node.status) : "neutral";
			const line = fitLine(paint(this.options.theme, raw, tone, active ? "strong" : "normal"), target, { pad: active });
			return active ? fill(this.options.theme, line, "active") : line;
		});
	}

	invalidate(): void {}

	private toggle(node: TreeNode<T>, expanded: boolean): void {
		if (!node.children?.length) return;
		if (expanded) this.expanded.add(node.id); else this.expanded.delete(node.id);
		this.options.onToggle?.(node, expanded);
	}

	private flatten(): FlatNode<T>[] {
		const result: FlatNode<T>[] = [];
		const walk = (nodes: readonly TreeNode<T>[], depth: number, parentId?: string) => {
			for (const node of nodes) {
				result.push({ node, depth, parentId });
				if (node.children?.length && this.expanded.has(node.id)) walk(node.children, depth + 1, node.id);
			}
		};
		walk(this.options.nodes, 0);
		return result;
	}

	private visit(nodes: readonly TreeNode<T>[], callback: (node: TreeNode<T>) => void): void {
		for (const node of nodes) { callback(node); if (node.children) this.visit(node.children, callback); }
	}
}
