import { columns, clamp } from "../foundation/geometry.ts";

export interface ViewportRange {
	start: number;
	end: number;
	before: number;
	after: number;
}

/** Stateful vertical viewport that keeps a selected row visible. */
export class Viewport {
	private offset = 0;

	getOffset(): number { return this.offset; }

	reset(): void { this.offset = 0; }

	scroll(delta: number, contentHeight: number, viewportHeight: number): void {
		const maximum = Math.max(0, columns(contentHeight) - columns(viewportHeight));
		this.offset = clamp(this.offset + Math.trunc(delta), 0, maximum);
	}

	ensureVisible(row: number, contentHeight: number, viewportHeight: number): void {
		const height = columns(viewportHeight);
		const maximum = Math.max(0, columns(contentHeight) - height);
		if (height === 0) { this.offset = 0; return; }
		const target = clamp(Math.trunc(row), 0, Math.max(0, contentHeight - 1));
		if (target < this.offset) this.offset = target;
		else if (target >= this.offset + height) this.offset = target - height + 1;
		this.offset = clamp(this.offset, 0, maximum);
	}

	range(contentHeight: number, viewportHeight: number): ViewportRange {
		const content = columns(contentHeight);
		const height = columns(viewportHeight);
		this.offset = clamp(this.offset, 0, Math.max(0, content - height));
		const end = Math.min(content, this.offset + height);
		return { start: this.offset, end, before: this.offset, after: Math.max(0, content - end) };
	}

	slice<T>(items: readonly T[], viewportHeight: number): T[] {
		const range = this.range(items.length, viewportHeight);
		return items.slice(range.start, range.end);
	}
}
