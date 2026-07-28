/** A deliberately small cache for terminal renders, normally keyed by width. */
export class RenderCache<T> {
	private key: unknown;
	private value: T | undefined;
	private populated = false;

	get(key: unknown): T | undefined {
		return this.populated && Object.is(this.key, key) ? this.value : undefined;
	}

	set(key: unknown, value: T): T {
		this.key = key;
		this.value = value;
		this.populated = true;
		return value;
	}

	getOrCreate(key: unknown, create: () => T): T {
		const cached = this.get(key);
		if (this.populated && Object.is(this.key, key)) return cached as T;
		return this.set(key, create());
	}

	invalidate(): void {
		this.key = undefined;
		this.value = undefined;
		this.populated = false;
	}
}

/** Combine width and caller-owned state revision into a stable primitive key. */
export function renderKey(width: number, revision = 0): string {
	return `${Math.max(0, Math.floor(width))}:${revision}`;
}
