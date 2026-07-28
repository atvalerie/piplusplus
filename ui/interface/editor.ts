import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { CommandAliasRegistry } from "./command-aliases.ts";
import { fitLine, visibleWidth } from "../foundation/text.ts";
import { paint } from "../primitives/theme.ts";

export class ControlRoomEditor extends CustomEditor {
	private readonly appTheme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly aliases?: CommandAliasRegistry;
	onPiPlusPlusShortcut?: (data: string) => boolean;

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, appTheme: Theme, aliases?: CommandAliasRegistry) {
		super(tui, editorTheme, keybindings, { paddingX: 1, autocompleteMaxVisible: 8 });
		this.appTheme = appTheme;
		this.keybindings = keybindings;
		this.aliases = aliases;
	}

	handleInput(data: string): void {
		if (this.onPiPlusPlusShortcut?.(data)) return;
		if (this.aliases && this.keybindings.matches(data, "tui.input.submit")) {
			const input = this.getExpandedText();
			const resolved = this.aliases.resolve(input);
			if (resolved !== input) {
				// Close the slash autocomplete before replacing the command; otherwise
				// its stale selection consumes Enter and overwrites the alias expansion.
				super.handleInput("\x1b");
				this.setText(resolved);
			}
		}
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length < 2 || width < 8) return lines;
		const text = this.getText();
		const ultracode = /(?<![\p{L}\p{N}_])ultracode(?![\p{L}\p{N}_])/iu.test(text);
		const lineCount = this.getLines().length;
		if (ultracode && !lines[0].includes("↑")) lines[0] = this.rule(width, " ULTRACODE ", "");
		const contentEnd = Math.min(lines.length - 1, this.getVisibleEditorBottom(lines));
		if (lineCount > 1 && !lines[contentEnd].includes("↓")) lines[contentEnd] = this.rule(width, "", ` ${lineCount} lines `);
		return lines.map((line) => fitLine(line, width));
	}

	private rule(width: number, left: string, right: string): string {
		const styledLeft = paint(this.appTheme, left, left.includes("ULTRACODE") ? "accent" : "muted", "strong");
		const styledRight = paint(this.appTheme, right, "subtle");
		const remaining = Math.max(0, width - visibleWidth(styledLeft) - visibleWidth(styledRight));
		return `${styledLeft}${this.borderColor("─").repeat(remaining)}${styledRight}`;
	}

	private getVisibleEditorBottom(lines: readonly string[]): number {
		// Autocomplete rows are appended after the editor's bottom border. Find the
		// last full-width horizontal rule instead of assuming the final row.
		for (let index = lines.length - 1; index > 0; index--) {
			const plain = lines[index].replace(/\x1b\[[0-9;]*m/g, "");
			if (/^[─↑↓\s\d]+$/u.test(plain) && visibleWidth(lines[index]) > 3) return index;
		}
		return lines.length - 1;
	}
}
