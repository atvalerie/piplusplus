import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acceptEditsAutoApproves, explainPermission } from "./workflows/permissions.ts";
import { installPermissionService, removePermissionService, type GlobalPermissionMode, type PermissionService } from "./shared/permission-service.ts";
import type { PermissionRequest } from "./workflows/types.ts";
import { Key } from "@earendil-works/pi-tui";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";
const BASE_MODES: GlobalPermissionMode[] = ["manual", "accept-edits", "auto", "read-only", "dangerous"];
const MODE_DESCRIPTIONS: Record<GlobalPermissionMode, string> = {
	manual: "confirm edits and commands",
	"accept-edits": "accept direct edits; confirm commands",
	auto: "automatically allow proven low-risk operations",
	"read-only": "block mutations",
	plan: "read-only exploration followed by plan approval",
	dangerous: "bypass all Pi++ tool confirmation",
};

export default function permissionsExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;
	const configPath = path.join(getAgentDir(), "piplusplus-permissions.json");
	const workflowArtifactRoot = path.join(getAgentDir(), "workflows", "artifacts");
	let mode: GlobalPermissionMode = "manual";
	let configuredMode: GlobalPermissionMode = "manual";
	const availableModes = new Set<GlobalPermissionMode>(BASE_MODES);
	let currentContext: ExtensionContext | undefined;
	let queue: Promise<void> = Promise.resolve();
	const listeners = new Set<() => void>();
	try {
		const value = JSON.parse(fs.readFileSync(configPath, "utf8"))?.mode as GlobalPermissionMode;
		if ([...BASE_MODES, "plan"].includes(value)) configuredMode = value;
		if (availableModes.has(configuredMode)) mode = configuredMode;
	} catch { /* defaults */ }

	const persist = async () => {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		const temp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await fs.promises.writeFile(temp, `${JSON.stringify({ mode: configuredMode }, null, 2)}\n`, { mode: 0o600 });
		await fs.promises.rename(temp, configPath);
	};

	const service: PermissionService = {
		getMode: () => mode,
		getModes: () => [...availableModes],
		registerMode(value) {
			availableModes.add(value);
			if (configuredMode === value && mode !== value) { mode = value; for (const listener of listeners) listener(); }
			return () => {
				availableModes.delete(value);
				if (mode === value) { mode = "manual"; for (const listener of listeners) listener(); }
			};
		},
		async setMode(value) {
			if (!availableModes.has(value)) throw new Error(`Permission mode is unavailable: ${value}`);
			mode = value; configuredMode = value === "dangerous" ? "manual" : value; await persist(); for (const listener of listeners) listener();
		},
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		async authorize(request, suppliedContext, options) {
			const ctx = suppliedContext ?? currentContext;
			const cwd = ctx?.cwd ?? process.cwd();
			const policyMode = mode === "plan" || mode === "accept-edits" ? "auto" : mode === "dangerous" ? "manual" : mode;
			const decision = explainPermission(request, cwd, policyMode, { artifactRoots: [workflowArtifactRoot] });
			if (mode === "dangerous" && !options?.forcePrompt) return true;
			if (decision.hardDeny) return false;
			if (mode === "plan") return decision.risk === "safe" && decision.allow;
			if (mode === "accept-edits") {
				if (acceptEditsAutoApproves(request, decision) && !options?.forcePrompt) return true;
			} else if (decision.automatic && !options?.forcePrompt) return decision.allow;
			if (!ctx?.hasUI) return false;
			const input = request.toolName === "bash" ? String(request.input.command ?? "") : JSON.stringify(request.input, null, 2);
			let allowed = false;
			const prompt = async () => {
				const choice = await ctx.ui.select(`${request.agentLabel} requests ${request.toolName}\n\n${decision.explanation}${options?.reason ? `\n${options.reason}` : ""}\n\n${input}`, ["Allow once", "Deny"]);
				allowed = choice === "Allow once";
			};
			queue = queue.then(prompt, prompt);
			await queue;
			return allowed;
		},
	};
	installPermissionService(service);

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "workflow_models" || event.toolName === "workflow_run") return;
		const allow = await service.authorize({
			agentId: "main",
			agentLabel: "Main agent",
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
		}, ctx);
		return allow ? undefined : { block: true, reason: `Blocked by global ${mode} permission policy` };
	});

	const selectMode = async (requestedText: string, ctx: ExtensionContext) => {
		const modes = [...availableModes];
		const requested = requestedText.trim() as GlobalPermissionMode;
		let selected: GlobalPermissionMode | undefined = modes.includes(requested) ? requested : undefined;
		if (!selected && requestedText.trim()) { ctx.ui.notify(`Unknown permission mode: ${requestedText.trim()}`, "error"); return; }
		if (!selected) selected = await ctx.ui.select(`Global permissions · ${mode}`, modes.map((item) => `${item} · ${MODE_DESCRIPTIONS[item]}${item === mode ? " · current" : ""}`)) as GlobalPermissionMode | undefined;
		if (!selected) return;
		selected = selected.split(" · ")[0] as GlobalPermissionMode;
		if (selected === "dangerous" && ctx.hasUI) {
			const confirmation = await ctx.ui.select("Dangerous mode disables every Pi++ tool confirmation, including shell commands and writes outside the project.", ["Cancel", "Enable dangerous mode"]);
			if (confirmation !== "Enable dangerous mode") return;
		}
		await service.setMode(selected);
		ctx.ui.notify(`Permission mode: ${selected}`, "info");
	};

	pi.registerCommand("permissions", { description: "View or change the global tool permission mode", handler: selectMode });
	pi.registerShortcut(Key.ctrlAlt("m"), { description: "Open Pi++ permission mode selector", handler: async (ctx) => selectMode("", ctx) });

	pi.on("session_start", (_event, ctx) => { currentContext = ctx; });
	pi.on("session_shutdown", () => { currentContext = undefined; listeners.clear(); removePermissionService(service); });
}
