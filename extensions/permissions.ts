import * as fs from "node:fs";
import * as path from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CLASSIFIER_ESTIMATED_INPUT_TOKENS,
	CLASSIFIER_MAX_OUTPUT_TOKENS,
	CLASSIFIER_TIMEOUT_MS,
	COMMAND_CLASSIFIER_SYSTEM_PROMPT,
	commandClassifierUserPrompt,
	isAiCommandClassificationEligible,
	parseCommandClassifierVerdict,
	rankPermissionClassifierModels,
} from "./permission-classifier.ts";
import { acceptEditsAutoApproves, explainPermission } from "./workflows/permissions.ts";
import { installPermissionService, removePermissionService, type GlobalPermissionMode, type PermissionService } from "./shared/permission-service.ts";
import { registerPiPlusPlusSettingsSection } from "./shared/settings-service.ts";
import type { PermissionRequest } from "./workflows/types.ts";
import { Key } from "@earendil-works/pi-tui";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";
const BASE_MODES: GlobalPermissionMode[] = ["manual", "accept-edits", "auto", "read-only", "dangerous"];
const MODE_DESCRIPTIONS: Record<GlobalPermissionMode, string> = {
	manual: "confirm edits and commands",
	"accept-edits": "accept direct edits; confirm commands",
	auto: "deterministic checks plus a free/very-cheap AI command classifier",
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
	let aiClassifierEnabled = true;
	const availableModes = new Set<GlobalPermissionMode>(BASE_MODES);
	let currentContext: ExtensionContext | undefined;
	let queue: Promise<void> = Promise.resolve();
	const listeners = new Set<() => void>();
	let classifierCalls = 0;
	let classifierAllows = 0;
	let classifierFailures = 0;
	let classifierCost = 0;
	let lastClassifierModel: string | undefined;
	const classifierCache = new Map<string, boolean>();
	try {
		const value = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mode?: GlobalPermissionMode; aiClassifier?: boolean };
		if ([...BASE_MODES, "plan"].includes(value.mode as GlobalPermissionMode)) configuredMode = value.mode as GlobalPermissionMode;
		if (typeof value.aiClassifier === "boolean") aiClassifierEnabled = value.aiClassifier;
		if (availableModes.has(configuredMode)) mode = configuredMode;
	} catch { /* defaults */ }

	const persist = async () => {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		const temp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await fs.promises.writeFile(temp, `${JSON.stringify({ mode: configuredMode, aiClassifier: aiClassifierEnabled }, null, 2)}\n`, { mode: 0o600 });
		await fs.promises.rename(temp, configPath);
	};

	const rememberClassification = (key: string, allow: boolean) => {
		classifierCache.delete(key);
		classifierCache.set(key, allow);
		while (classifierCache.size > 256) classifierCache.delete(classifierCache.keys().next().value!);
	};

	const classifyCommand = async (command: string, ctx: ExtensionContext): Promise<boolean> => {
		if (!aiClassifierEnabled || !isAiCommandClassificationEligible(command)) return false;
		const estimatedInputTokens = CLASSIFIER_ESTIMATED_INPUT_TOKENS + Math.ceil(Buffer.byteLength(command, "utf8") / 3);
		const candidates = rankPermissionClassifierModels(ctx.modelRegistry.getAvailable(), estimatedInputTokens).slice(0, 2);
		for (const candidate of candidates) {
			const modelName = `${candidate.model.provider}/${candidate.model.id}`;
			const cacheKey = `${modelName}\0${ctx.cwd}\0${command}`;
			const cached = classifierCache.get(cacheKey);
			if (cached !== undefined) {
				classifierCache.delete(cacheKey);
				classifierCache.set(cacheKey, cached);
				return cached;
			}
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate.model);
				if (!auth.ok) continue;
				const timeout = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
				const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
				classifierCalls++;
				lastClassifierModel = modelName;
				const response = await completeSimple(candidate.model, {
					systemPrompt: COMMAND_CLASSIFIER_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: commandClassifierUserPrompt(command) }], timestamp: Date.now() }],
				}, {
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal,
					maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
					reasoning: candidate.model.reasoning ? "minimal" : undefined,
					cacheRetention: "none",
					maxRetries: 0,
					timeoutMs: CLASSIFIER_TIMEOUT_MS,
					sessionId: uuidv7(),
				});
				classifierCost += response.usage.cost.total;
				const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				const verdict = parseCommandClassifierVerdict(text);
				if (!verdict) { classifierFailures++; continue; }
				const allow = verdict === "ALLOW";
				if (allow) classifierAllows++;
				rememberClassification(cacheKey, allow);
				return allow;
			} catch {
				classifierFailures++;
			}
		}
		return false;
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
			if (mode === "auto" && ctx && !options?.forcePrompt && request.toolName === "bash" && decision.risk === "caution") {
				if (await classifyCommand(String(request.input.command ?? ""), ctx)) return true;
			}
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
		const classifierCommand = requestedText.trim().match(/^classifier(?:\s+(on|off|status))?$/i);
		if (classifierCommand) {
			const action = classifierCommand[1]?.toLowerCase() ?? "status";
			if (action === "on" || action === "off") {
				aiClassifierEnabled = action === "on";
				classifierCache.clear();
				await persist();
			}
			const candidate = rankPermissionClassifierModels(ctx.modelRegistry.getAvailable())[0];
			const selected = candidate ? `${candidate.model.provider}/${candidate.model.id}${candidate.explicitlyFree ? " · free" : ` · estimated $${candidate.estimatedCostUsd.toFixed(6)}/call`}` : "none available";
			ctx.ui.notify(`Auto command classifier: ${aiClassifierEnabled ? "on" : "off"} · model ${selected} · ${classifierAllows}/${classifierCalls} allowed · $${classifierCost.toFixed(6)}${classifierFailures ? ` · ${classifierFailures} failure(s)` : ""}${lastClassifierModel ? ` · last ${lastClassifierModel}` : ""}`, "info");
			return;
		}
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

	const openPermissionSettings = async (ctx: ExtensionContext) => {
		while (ctx.hasUI) {
			const modeItem = `Permission mode · ${mode}`;
			const classifierItem = `AI command classifier · ${aiClassifierEnabled ? "on" : "off"}`;
			const selected = await ctx.ui.select("Pi++ permissions", [modeItem, classifierItem, "Back"]);
			if (!selected || selected === "Back") return;
			if (selected === modeItem) await selectMode("", ctx);
			else {
				const value = await ctx.ui.select("AI command classifier", [
					`On${aiClassifierEnabled ? " · current" : ""}`,
					`Off${!aiClassifierEnabled ? " · current" : ""}`,
					"Back",
				]);
				if (value?.startsWith("On")) await selectMode("classifier on", ctx);
				else if (value?.startsWith("Off")) await selectMode("classifier off", ctx);
			}
		}
	};
	const unregisterSettings = registerPiPlusPlusSettingsSection({
		id: "permissions",
		label: "Permissions",
		description: "Global tool policy and optional AI command classifier",
		order: 10,
		summary: () => `${mode} · classifier ${aiClassifierEnabled ? "on" : "off"}`,
		open: openPermissionSettings,
	});

	pi.registerCommand("permissions", { description: "View or change the global tool permission mode", handler: selectMode });
	pi.registerShortcut(Key.ctrlAlt("m"), { description: "Open Pi++ permission mode selector", handler: async (ctx) => selectMode("", ctx) });

	pi.on("session_start", (_event, ctx) => { currentContext = ctx; });
	pi.on("session_shutdown", () => { currentContext = undefined; listeners.clear(); unregisterSettings(); removePermissionService(service); });
}
