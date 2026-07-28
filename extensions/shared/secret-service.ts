import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SecretPromptOptions {
	title: string;
	description?: string;
	placeholder?: string;
	normalize?: (value: string) => string;
	validate?: (value: string, signal?: AbortSignal) => Promise<void>;
}

export interface SecretService {
	get(id: string): string | undefined;
	has(id: string): boolean;
	set(id: string, value: string): Promise<void>;
	delete(id: string): Promise<void>;
	list(): readonly string[];
	promptAndStore(id: string, options: SecretPromptOptions, ctx: ExtensionContext): Promise<boolean>;
}

interface SecretFile { version: 1; secrets: Record<string, { value: string; updatedAt: number }> }
const SERVICE_KEY = Symbol.for("piplusplus.secret-service");
type SecretGlobal = typeof globalThis & { [SERVICE_KEY]?: SecretService };
const globalState = globalThis as SecretGlobal;
const VALID_ID = /^[a-z0-9][a-z0-9._-]{1,127}$/i;

export class FileSecretStore {
	private data: SecretFile = { version: 1, secrets: {} };
	private queue: Promise<void> = Promise.resolve();
	private readonly filePath: string;
	constructor(filePath: string) { this.filePath = filePath; this.load(); }

	get(id: string): string | undefined { this.assertId(id); return this.data.secrets[id]?.value; }
	has(id: string): boolean { return this.get(id) !== undefined; }
	list(): readonly string[] { return Object.keys(this.data.secrets).sort(); }
	async set(id: string, value: string): Promise<void> {
		this.assertId(id);
		if (!value) throw new Error("Secret value cannot be empty");
		this.data.secrets[id] = { value, updatedAt: Date.now() };
		await this.persist();
	}
	async delete(id: string): Promise<void> { this.assertId(id); delete this.data.secrets[id]; await this.persist(); }

	private assertId(id: string): void { if (!VALID_ID.test(id)) throw new Error(`Invalid secret id: ${id}`); }
	private load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<SecretFile>;
			if (parsed.version === 1 && parsed.secrets && typeof parsed.secrets === "object") this.data = { version: 1, secrets: parsed.secrets };
			try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
		} catch { /* missing or invalid files start empty */ }
	}
	private async persist(): Promise<void> {
		const write = async () => {
			await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
			const temp = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			try {
				await fs.promises.writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
				await fs.promises.rename(temp, this.filePath);
				try { await fs.promises.chmod(this.filePath, 0o600); } catch { /* best effort */ }
			} finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
		};
		this.queue = this.queue.then(write, write);
		await this.queue;
	}
}

export function installSecretService(service: SecretService): void { globalState[SERVICE_KEY] = service; }
export function getSecretService(): SecretService | undefined { return globalState[SERVICE_KEY]; }
export function removeSecretService(service: SecretService): void { if (globalState[SERVICE_KEY] === service) delete globalState[SERVICE_KEY]; }
