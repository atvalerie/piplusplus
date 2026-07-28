import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkflowSettings {
	triggersEnabled: boolean;
	ultracodeEffortMode: "one-prompt" | "session";
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
	triggersEnabled: true,
	ultracodeEffortMode: "one-prompt",
};

export function workflowSettingsPath(agentDir: string): string {
	return path.join(path.resolve(agentDir), "workflows", "settings.json");
}

function normalizedSettings(value: unknown): WorkflowSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_WORKFLOW_SETTINGS };
	const record = value as Record<string, unknown>;
	return {
		triggersEnabled: typeof record.triggersEnabled === "boolean" ? record.triggersEnabled : DEFAULT_WORKFLOW_SETTINGS.triggersEnabled,
		ultracodeEffortMode: record.ultracodeEffortMode === "session" || record.ultracodeEffortMode === "one-prompt"
			? record.ultracodeEffortMode
			: DEFAULT_WORKFLOW_SETTINGS.ultracodeEffortMode,
	};
}

function assertSafeSettingsPath(agentDir: string, target: string): void {
	const base = path.resolve(agentDir);
	const relative = path.relative(base, path.resolve(target));
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Workflow settings path escapes the Pi agent directory.");
	let current = base;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Workflow settings path uses a symlink or junction: ${current}`);
	}
}

export async function loadWorkflowSettings(agentDir: string): Promise<WorkflowSettings> {
	const target = workflowSettingsPath(agentDir);
	assertSafeSettingsPath(agentDir, target);
	try {
		return normalizedSettings(JSON.parse(await fs.promises.readFile(target, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_WORKFLOW_SETTINGS };
		throw error;
	}
}

export async function saveWorkflowSettings(agentDir: string, settings: WorkflowSettings): Promise<void> {
	const normalized = normalizedSettings(settings);
	const target = workflowSettingsPath(agentDir);
	assertSafeSettingsPath(agentDir, target);
	await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	assertSafeSettingsPath(agentDir, target);
	const temp = path.join(path.dirname(target), `.settings.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		await fs.promises.writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await fs.promises.rename(temp, target);
		try { await fs.promises.chmod(target, 0o600); } catch { /* best effort */ }
	} finally {
		await fs.promises.rm(temp, { force: true }).catch(() => {});
	}
}

export function isInteractiveUltracodeTrigger(source: "interactive" | "rpc" | "extension", text: string, enabled: boolean): boolean {
	return enabled
		&& source === "interactive"
		&& /(?<![\p{L}\p{N}_])ultracode(?![\p{L}\p{N}_])/iu.test(text);
}
