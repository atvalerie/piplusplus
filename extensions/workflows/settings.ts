import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowBudgets, WorkflowSpec } from "./types.ts";

export type WorkflowBudgetMode = "off" | "custom" | "model";

export interface WorkflowSettings {
	triggersEnabled: boolean;
	ultracodeEffortMode: "one-prompt" | "session";
	/**
	 * off: ignore model-proposed aggregate budgets (Claude-compatible default)
	 * custom: replace model-proposed budgets with user-owned values
	 * model: allow the orchestrator to choose per-run budgets
	 */
	budgetMode: WorkflowBudgetMode;
	customBudgets?: WorkflowBudgets;
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
	triggersEnabled: true,
	ultracodeEffortMode: "one-prompt",
	budgetMode: "off",
};

export function workflowSettingsPath(agentDir: string): string {
	return path.join(path.resolve(agentDir), "workflows", "settings.json");
}

export function normalizeCustomBudgets(value: unknown): WorkflowBudgets | undefined {
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Custom workflow budgets must be a JSON object.");
	const record = value as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => !["maxAgents", "maxTokens", "maxCost"].includes(key));
	if (extra.length) throw new Error(`Unknown custom workflow budget properties: ${extra.join(", ")}`);
	const budgets: WorkflowBudgets = {};
	if (record.maxAgents !== undefined) {
		if (!Number.isInteger(record.maxAgents) || Number(record.maxAgents) < 1 || Number(record.maxAgents) > 1_000) {
			throw new Error("customBudgets.maxAgents must be an integer from 1 to 1000.");
		}
		budgets.maxAgents = Number(record.maxAgents);
	}
	if (record.maxTokens !== undefined) {
		if (!Number.isInteger(record.maxTokens) || Number(record.maxTokens) < 1) {
			throw new Error("customBudgets.maxTokens must be a positive integer.");
		}
		budgets.maxTokens = Number(record.maxTokens);
	}
	if (record.maxCost !== undefined) {
		if (typeof record.maxCost !== "number" || !Number.isFinite(record.maxCost) || record.maxCost <= 0) {
			throw new Error("customBudgets.maxCost must be a positive finite number.");
		}
		budgets.maxCost = record.maxCost;
	}
	return Object.keys(budgets).length ? budgets : undefined;
}

function normalizedSettings(value: unknown): WorkflowSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_WORKFLOW_SETTINGS };
	const record = value as Record<string, unknown>;
	const budgetMode: WorkflowBudgetMode = record.budgetMode === "custom" || record.budgetMode === "model" || record.budgetMode === "off"
		? record.budgetMode
		: DEFAULT_WORKFLOW_SETTINGS.budgetMode;
	let customBudgets: WorkflowBudgets | undefined;
	try { customBudgets = normalizeCustomBudgets(record.customBudgets); }
	catch { customBudgets = undefined; }
	return {
		triggersEnabled: typeof record.triggersEnabled === "boolean" ? record.triggersEnabled : DEFAULT_WORKFLOW_SETTINGS.triggersEnabled,
		ultracodeEffortMode: record.ultracodeEffortMode === "session" || record.ultracodeEffortMode === "one-prompt"
			? record.ultracodeEffortMode
			: DEFAULT_WORKFLOW_SETTINGS.ultracodeEffortMode,
		budgetMode,
		...(customBudgets === undefined ? {} : { customBudgets }),
	};
}

export function applyWorkflowBudgetSettings(spec: WorkflowSpec, settings: WorkflowSettings): WorkflowSpec {
	if (settings.budgetMode === "model") return spec;
	return {
		...spec,
		budgets: settings.budgetMode === "custom" && settings.customBudgets
			? { ...settings.customBudgets }
			: undefined,
	};
}

export function describeWorkflowBudgetSettings(settings: WorkflowSettings): string {
	if (settings.budgetMode === "off") return "off (no aggregate agent/token/cost budget; runtime safety ceilings and deadline still apply)";
	if (settings.budgetMode === "model") return "model (the orchestrator may choose per-run limits)";
	return `custom ${JSON.stringify(settings.customBudgets ?? {})}`;
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
	if (settings.budgetMode === "custom" && !normalizeCustomBudgets(settings.customBudgets)) {
		throw new Error("Custom workflow budget mode requires at least one configured limit.");
	}
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
