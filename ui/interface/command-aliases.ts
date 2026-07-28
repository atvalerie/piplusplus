import * as fs from "node:fs";
import * as path from "node:path";

const NAME = /^[a-z0-9][a-z0-9:_-]*$/i;
const DEFAULTS: Readonly<Record<string, string>> = { exit: "/quit" };
type AliasConfig = Record<string, string | null>;

export interface CommandAlias { name: string; target: string; customized: boolean }

export class CommandAliasRegistry {
	private config: AliasConfig = {};
	private readonly configPath: string;
	constructor(configPath: string) { this.configPath = configPath; this.reload(); }

	reload(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
			this.config = parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? Object.fromEntries(Object.entries(parsed).filter(([name, target]) => NAME.test(name) && (typeof target === "string" || target === null)))
				: {};
		} catch { this.config = {}; }
	}

	list(): CommandAlias[] {
		const names = new Set([...Object.keys(DEFAULTS), ...Object.keys(this.config)]);
		return [...names].sort().flatMap((name) => {
			const target = this.effective(name);
			return target ? [{ name, target, customized: Object.prototype.hasOwnProperty.call(this.config, name) }] : [];
		});
	}

	resolve(input: string): string {
		let current = input;
		const visited = new Set<string>();
		for (let depth = 0; depth < 16; depth++) {
			const match = current.match(/^\/([^\s]+)([\s\S]*)$/);
			if (!match) return current;
			const name = match[1].toLowerCase();
			const target = this.effective(name);
			if (!target) return current;
			if (visited.has(name)) return input;
			visited.add(name);
			current = `${target}${match[2]}`;
		}
		return input;
	}

	set(name: string, target: string): void {
		const normalizedName = this.normalizeName(name);
		if (normalizedName === "alias" || normalizedName === "aliases") throw new Error(`/${normalizedName} is reserved`);
		const normalizedTarget = this.normalizeTarget(target);
		const previous = this.config[normalizedName];
		this.config[normalizedName] = normalizedTarget;
		if (this.resolve(`/${normalizedName}`) === `/${normalizedName}`) {
			if (previous === undefined) delete this.config[normalizedName]; else this.config[normalizedName] = previous;
			throw new Error("Alias creates a cycle");
		}
		this.persist();
	}

	remove(name: string): void {
		const normalized = this.normalizeName(name);
		if (Object.prototype.hasOwnProperty.call(DEFAULTS, normalized)) this.config[normalized] = null;
		else delete this.config[normalized];
		this.persist();
	}

	reset(name: string): void { delete this.config[this.normalizeName(name)]; this.persist(); }

	private effective(name: string): string | undefined {
		if (Object.prototype.hasOwnProperty.call(this.config, name)) return this.config[name] ?? undefined;
		return DEFAULTS[name];
	}
	private normalizeName(name: string): string {
		const normalized = name.trim().replace(/^\//, "").toLowerCase();
		if (!NAME.test(normalized)) throw new Error("Alias names may contain letters, numbers, colon, dash, and underscore");
		return normalized;
	}
	private normalizeTarget(target: string): string {
		const normalized = target.trim();
		if (!normalized) throw new Error("Alias target cannot be empty");
		const command = normalized.startsWith("/") ? normalized : `/${normalized}`;
		if (!/^\/[a-z0-9][a-z0-9:_-]*(?:[ \t]+[^\r\n]*)?$/i.test(command)) throw new Error("Alias target must be a slash command with optional arguments");
		return command;
	}
	private persist(): void {
		fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
		const temp = `${this.configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			fs.writeFileSync(temp, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
			fs.renameSync(temp, this.configPath);
			try { fs.chmodSync(this.configPath, 0o600); } catch { /* best effort */ }
		} finally { try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ } }
	}
}
