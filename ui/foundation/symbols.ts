export interface Symbols {
	selected: string;
	pending: string;
	running: string;
	paused: string;
	success: string;
	warning: string;
	error: string;
	stopped: string;
	branch: string;
	lastBranch: string;
	vertical: string;
	horizontal: string;
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	arrow: string;
	collapsed: string;
	expanded: string;
}

export const unicodeSymbols: Readonly<Symbols> = Object.freeze({
	selected: "›",
	pending: "○",
	running: "◉",
	paused: "Ⅱ",
	success: "✓",
	warning: "⚑",
	error: "×",
	stopped: "■",
	branch: "├",
	lastBranch: "└",
	vertical: "│",
	horizontal: "─",
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	arrow: "→",
	collapsed: "▸",
	expanded: "▾",
});

export const asciiSymbols: Readonly<Symbols> = Object.freeze({
	selected: ">",
	pending: "o",
	running: "*",
	paused: "=",
	success: "+",
	warning: "!",
	error: "x",
	stopped: "#",
	branch: "+",
	lastBranch: "`",
	vertical: "|",
	horizontal: "-",
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	arrow: ">",
	collapsed: ">",
	expanded: "v",
});

export interface SymbolOptions {
	ascii?: boolean;
	environment?: Readonly<Record<string, string | undefined>>;
}

export function symbols(options: SymbolOptions = {}): Readonly<Symbols> {
	const environment = options.environment ?? process.env;
	const forceAscii = options.ascii ?? (environment.PIPLUSPLUS_ASCII === "1" || environment.TERM === "dumb");
	return forceAscii ? asciiSymbols : unicodeSymbols;
}
