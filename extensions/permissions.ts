import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { explainPermission } from "./workflows/permissions.ts";
import { installPermissionService, removePermissionService, type GlobalPermissionMode, type PermissionService } from "./shared/permission-service.ts";
import type { PermissionRequest } from "./workflows/types.ts";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";
const MODES: GlobalPermissionMode[] = ["manual", "auto", "read-only"];

export default function permissionsExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;
	const configPath = path.join(getAgentDir(), "piplusplus-permissions.json");
	let mode: GlobalPermissionMode = "manual";
	let currentContext: ExtensionContext | undefined;
	let queue: Promise<void> = Promise.resolve();
	const listeners = new Set<() => void>();
	try {
		const value = JSON.parse(fs.readFileSync(configPath, "utf8"))?.mode;
		if (MODES.includes(value)) mode = value;
	} catch { /* defaults */ }

	const persist = async () => {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		const temp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await fs.promises.writeFile(temp, `${JSON.stringify({ mode }, null, 2)}\n`, { mode: 0o600 });
		await fs.promises.rename(temp, configPath);
	};

	const service: PermissionService = {
		getMode: () => mode,
		async setMode(value) { mode = value; await persist(); for (const listener of listeners) listener(); },
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		async authorize(request, suppliedContext, options) {
			const ctx = suppliedContext ?? currentContext;
			const cwd = ctx?.cwd ?? process.cwd();
			const decision = explainPermission(request, cwd, mode);
			if (decision.automatic && !options?.forcePrompt) return decision.allow;
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

	pi.registerCommand("permissions", {
		description: "View or change the global tool permission mode",
		handler: async (args, ctx) => {
			const requested = args.trim() as GlobalPermissionMode;
			let selected: GlobalPermissionMode | undefined = MODES.includes(requested) ? requested : undefined;
			if (!selected && args.trim()) { ctx.ui.notify(`Unknown permission mode: ${args.trim()}`, "error"); return; }
			if (!selected) selected = await ctx.ui.select(`Global permissions · ${mode}`, MODES.map((item) => `${item}${item === mode ? " · current" : ""}`)) as GlobalPermissionMode | undefined;
			if (!selected) return;
			selected = selected.split(" · ")[0] as GlobalPermissionMode;
			await service.setMode(selected);
			ctx.ui.notify(`Permission mode: ${selected}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => { currentContext = ctx; });
	pi.on("session_shutdown", () => { currentContext = undefined; listeners.clear(); removePermissionService(service); });
}
