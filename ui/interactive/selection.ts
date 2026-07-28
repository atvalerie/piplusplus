import { clamp } from "../foundation/geometry.ts";

export class SelectionModel {
	private index = 0;
	private count: number;
	private readonly selectable: (index: number) => boolean;

	constructor(count = 0, selectable: (index: number) => boolean = () => true) {
		this.count = count;
		this.selectable = selectable;
		this.reconcile();
	}

	get selected(): number { return this.index; }

	setCount(count: number): void {
		this.count = Math.max(0, Math.floor(count));
		this.reconcile();
	}

	set(index: number): boolean {
		if (!this.count) { this.index = 0; return false; }
		const target = clamp(Math.floor(index), 0, this.count - 1);
		if (!this.selectable(target) || target === this.index) return false;
		this.index = target;
		return true;
	}

	move(delta: number): boolean {
		if (!this.count || delta === 0) return false;
		const direction = delta > 0 ? 1 : -1;
		let remaining = Math.abs(Math.trunc(delta));
		let candidate = this.index;
		while (remaining > 0) {
			let next = candidate + direction;
			while (next >= 0 && next < this.count && !this.selectable(next)) next += direction;
			if (next < 0 || next >= this.count) break;
			candidate = next;
			remaining--;
		}
		if (candidate === this.index) return false;
		this.index = candidate;
		return true;
	}

	first(): boolean { return this.set(this.find(0, 1)); }
	last(): boolean { return this.set(this.find(this.count - 1, -1)); }

	private find(start: number, direction: 1 | -1): number {
		for (let index = start; index >= 0 && index < this.count; index += direction) if (this.selectable(index)) return index;
		return 0;
	}

	private reconcile(): void {
		if (!this.count) { this.index = 0; return; }
		this.index = clamp(this.index, 0, this.count - 1);
		if (!this.selectable(this.index)) this.index = this.find(0, 1);
	}
}
