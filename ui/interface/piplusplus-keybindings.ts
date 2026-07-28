import * as fs from "node:fs";
import * as path from "node:path";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

export type PiPlusPlusKeybindingId = "piplusplus.keybindings.open" | "piplusplus.effort.open";

export interface PiPlusPlusKeybindingDefinition {
	id: PiPlusPlusKeybindingId;
	description: string;
	defaultKeys: readonly KeyId[];
}

export const piplusplusKeybindingDefinitions: readonly PiPlusPlusKeybindingDefinition[] = [
	{ id: "piplusplus.keybindings.open", description: "Open Pi++ keybinding browser", defaultKeys: ["f1"] },
	{ id: "piplusplus.effort.open", description: "Choose reasoning effort", defaultKeys: ["alt+e"] },
];

type Config = Partial<Record<PiPlusPlusKeybindingId, KeyId | KeyId[]>>;

export class PiPlusPlusKeybindingRegistry {
	private config: Config = {};
	private readonly configPath: string;

	constructor(configPath: string) {
		this.configPath = configPath;
		this.reload();
	}

	reload(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Config;
			this.config = parsed && typeof parsed === "object" ? parsed : {};
		} catch { this.config = {}; }
	}

	getDefinitions(): readonly PiPlusPlusKeybindingDefinition[] { return piplusplusKeybindingDefinitions; }

	getKeys(id: PiPlusPlusKeybindingId): KeyId[] {
		const definition = piplusplusKeybindingDefinitions.find((item) => item.id === id);
		if (!definition) return [];
		const configured = this.config[id];
		return [...(Array.isArray(configured) ? configured : configured ? [configured] : definition.defaultKeys)];
	}

	isCustomized(id: PiPlusPlusKeybindingId): boolean { return Object.prototype.hasOwnProperty.call(this.config, id); }

	matches(data: string, id: PiPlusPlusKeybindingId): boolean {
		return this.getKeys(id).some((key) => matchesKey(data, key));
	}

	set(id: PiPlusPlusKeybindingId, keys: KeyId[] | undefined): void {
		if (keys === undefined) delete this.config[id]; else this.config[id] = keys;
		fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
		const temp = `${this.configPath}.${process.pid}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temp, this.configPath);
	}
}
