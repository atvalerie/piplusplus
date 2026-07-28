import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, type Component, type Focusable } from "@earendil-works/pi-tui";
import { fitLine, visibleWidth } from "../foundation/text.ts";
import { paint } from "../primitives/theme.ts";

export interface SearchFieldOptions {
	theme: Theme;
	placeholder?: string;
	prefix?: string;
	initialValue?: string;
	onChange?: (value: string) => void;
	onSubmit?: (value: string) => void;
	onCancel?: () => void;
}

export class SearchField implements Component, Focusable {
	private readonly options: SearchFieldOptions;
	private readonly input = new Input();
	private _focused = false;

	constructor(options: SearchFieldOptions) {
		this.options = options;
		this.input.setValue(options.initialValue ?? "");
		this.input.onSubmit = (value) => options.onSubmit?.(value);
		this.input.onEscape = () => options.onCancel?.();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }
	get value(): string { return this.input.getValue(); }
	setValue(value: string): void { this.input.setValue(value); this.options.onChange?.(value); }

	handleInput(data: string): void {
		const before = this.input.getValue();
		this.input.handleInput(data);
		const after = this.input.getValue();
		if (after !== before) this.options.onChange?.(after);
	}

	render(width: number): string[] {
		const prefix = paint(this.options.theme, this.options.prefix ?? "/ ", "accent", "strong");
		const prefixWidth = visibleWidth(prefix);
		const value = this.input.getValue();
		let rendered: string;
		if (!value && !this.focused && this.options.placeholder) rendered = paint(this.options.theme, this.options.placeholder, "subtle");
		else rendered = this.input.render(Math.max(0, width - prefixWidth))[0] ?? "";
		return [fitLine(`${prefix}${rendered}`, width)];
	}

	invalidate(): void { this.input.invalidate(); }
}
