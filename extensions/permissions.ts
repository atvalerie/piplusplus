import * as fs from "node:fs";
import * as path from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CLASSIFIER_ESTIMATED_INPUT_TOKENS,
	CLASSIFIER_MAX_OUTPUT_TOKENS,
	CLASSIFIER_REASONING_LEVEL,
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
const CLASSIFIER_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ClassifierEffort = typeof CLASSIFIER_EFFORTS[number];
const AUTO_CLASSIFIER_MODEL = "auto";
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
	let classifierModel = AUTO_CLASSIFIER_MODEL;
	let classifierEffort: ClassifierEffort = CLASSIFIER_REASONING_LEVEL;
	const availableModes = new Set<GlobalPermissionMode>(BASE_MODES);
	let currentContext: ExtensionContext | undefined;
	let queue: Promise<void> = Promise.resolve();
	const listeners = new Set<() => void>();
	let classifierCalls = 0;
	let classifierAllows = 0;
	let classifierAsks = 0;
	let classifierFailures = 0;
	let classifierSkipped = 0;
	let classifierUnavailable = 0;
	let classifierCost = 0;
	let lastClassifierModel: string | undefined;
	let lastClassifierOutcome: string | undefined;
	const classifierCache = new Map<string, boolean>();
	try {
		const value = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mode?: GlobalPermissionMode; aiClassifier?: boolean; classifierModel?: string; classifierEffort?: ClassifierEffort };
		if ([...BASE_MODES, "plan"].includes(value.mode as GlobalPermissionMode)) configuredMode = value.mode as GlobalPermissionMode;
		if (typeof value.aiClassifier === "boolean") aiClassifierEnabled = value.aiClassifier;
		if (typeof value.classifierModel === "string" && value.classifierModel.trim()) classifierModel = value.classifierModel.trim();
		if (CLASSIFIER_EFFORTS.includes(value.classifierEffort as ClassifierEffort)) classifierEffort = value.classifierEffort as ClassifierEffort;
		if (availableModes.has(configuredMode)) mode = configuredMode;
	} catch { /* defaults */ }

	const persist = async () => {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		const temp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await fs.promises.writeFile(temp, `${JSON.stringify({ mode: configuredMode, aiClassifier: aiClassifierEnabled, classifierModel, classifierEffort }, null, 2)}\n`, { mode: 0o600 });
		await fs.promises.rename(temp, configPath);
	};

	const rememberClassification = (key: string, allow: boolean) => {
		classifierCache.delete(key);
		classifierCache.set(key, allow);
		while (classifierCache.size > 256) classifierCache.delete(classifierCache.keys().next().value!);
	};

	const classifierModelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	const availableClassifierModels = (ctx: ExtensionContext, inputTokens = CLASSIFIER_ESTIMATED_INPUT_TOKENS) =>
		rankPermissionClassifierModels(ctx.modelRegistry.getAvailable(), inputTokens);
	const classifierModelLabel = (candidate: ReturnType<typeof availableClassifierModels>[number]) =>
		`${classifierModelKey(candidate.model)} · estimated $${candidate.estimatedCostUsd.toFixed(6)}/call${candidate.explicitlyFree ? " · free-tagged" : ""}`;

	type CommandClassification = { allow: boolean; explanation: string };
	const classifyCommand = async (command: string, ctx: ExtensionContext): Promise<CommandClassification> => {
		if (!aiClassifierEnabled) return { allow: false, explanation: "disabled" };
		if (!isAiCommandClassificationEligible(command)) {
			classifierSkipped++;
			lastClassifierOutcome = "skipped by deterministic safety barrier";
			return { allow: false, explanation: lastClassifierOutcome };
		}
		const estimatedInputTokens = CLASSIFIER_ESTIMATED_INPUT_TOKENS + Math.ceil(Buffer.byteLength(command, "utf8") / 3);
		const ranked = availableClassifierModels(ctx, estimatedInputTokens);
		const candidates = classifierModel === AUTO_CLASSIFIER_MODEL
			? ranked.slice(0, 2)
			: ranked.filter((candidate) => classifierModelKey(candidate.model) === classifierModel).slice(0, 1);
		if (!candidates.length) {
			classifierUnavailable++;
			lastClassifierOutcome = classifierModel === AUTO_CLASSIFIER_MODEL
				? "no authenticated free/sub-$0.001 model available"
				: `configured model unavailable or ineligible: ${classifierModel}`;
			return { allow: false, explanation: lastClassifierOutcome };
		}
		let attempted = false;
		let lastFailure: string | undefined;
		for (const candidate of candidates) {
			const modelName = `${candidate.model.provider}/${candidate.model.id}`;
			const cacheKey = `${modelName}\0${ctx.cwd}\0${command}`;
			const cached = classifierCache.get(cacheKey);
			if (cached !== undefined) {
				classifierCache.delete(cacheKey);
				classifierCache.set(cacheKey, cached);
				lastClassifierModel = modelName;
				lastClassifierOutcome = `cached ${cached ? "ALLOW" : "ASK"}`;
				return { allow: cached, explanation: `${lastClassifierOutcome} from ${modelName}` };
			}
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate.model);
				if (!auth.ok) { lastFailure = auth.error; continue; }
				attempted = true;
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
					reasoning: classifierEffort,
					cacheRetention: "none",
					maxRetries: 0,
					timeoutMs: CLASSIFIER_TIMEOUT_MS,
					sessionId: uuidv7(),
				});
				classifierCost += response.usage.cost.total;
				const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				const verdict = parseCommandClassifierVerdict(text);
				if (!verdict) {
					classifierFailures++;
					lastFailure = response.stopReason === "error"
						? response.errorMessage ?? "model request failed"
						: `invalid response (${response.stopReason})`;
					continue;
				}
				const allow = verdict === "ALLOW";
				if (allow) classifierAllows++;
				else classifierAsks++;
				rememberClassification(cacheKey, allow);
				lastClassifierOutcome = verdict;
				return { allow, explanation: `${verdict} from ${modelName}` };
			} catch (error) {
				classifierFailures++;
				lastFailure = error instanceof Error ? error.message : String(error);
			}
		}
		if (!attempted) classifierUnavailable++;
		lastClassifierOutcome = attempted ? `failed: ${lastFailure ?? "unknown error"}` : `unavailable: ${lastFailure ?? "authentication failed"}`;
		return { allow: false, explanation: lastClassifierOutcome };
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
			let classifierExplanation: string | undefined;
			if (mode === "dangerous" && !options?.forcePrompt) return true;
			if (decision.hardDeny) return false;
			if (mode === "plan") return decision.risk === "safe" && decision.allow;
			if (mode === "accept-edits") {
				if (acceptEditsAutoApproves(request, decision) && !options?.forcePrompt) return true;
			} else if (decision.automatic && !options?.forcePrompt) return decision.allow;
			if (mode === "auto" && ctx && !options?.forcePrompt && request.toolName === "bash" && decision.risk === "caution") {
				const classification = await classifyCommand(String(request.input.command ?? ""), ctx);
				if (classification.allow) return true;
				classifierExplanation = classification.explanation;
			}
			if (!ctx?.hasUI) return false;
			const input = request.toolName === "bash" ? String(request.input.command ?? "") : JSON.stringify(request.input, null, 2);
			let allowed = false;
			const prompt = async () => {
				const classifierNote = classifierExplanation ? `\nAuto classifier: ${classifierExplanation}` : "";
				const choice = await ctx.ui.select(`${request.agentLabel} requests ${request.toolName}\n\n${decision.explanation}${classifierNote}${options?.reason ? `\n${options.reason}` : ""}\n\n${input}`, ["Allow once", "Deny"]);
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
		const classifierCommand = requestedText.trim().match(/^classifier(?:\s+(.*))?$/i);
		if (classifierCommand) {
			const request = classifierCommand[1]?.trim() ?? "status";
			const [rawAction, ...rawRest] = request.split(/\s+/);
			const action = rawAction.toLowerCase();
			const argument = rawRest.join(" ").trim();
			if (action === "on" || action === "off") {
				aiClassifierEnabled = action === "on";
				classifierCache.clear();
				await persist();
			} else if (action === "effort") {
				let selected = argument.toLowerCase() as ClassifierEffort;
				if (!argument && ctx.hasUI) {
					const choice = await ctx.ui.select(`Classifier effort · ${classifierEffort}`, CLASSIFIER_EFFORTS.map((effort) => `${effort}${effort === classifierEffort ? " · current" : ""}`));
					if (!choice) return;
					selected = choice.split(" · ")[0] as ClassifierEffort;
				}
				if (!CLASSIFIER_EFFORTS.includes(selected)) {
					ctx.ui.notify(`Usage: /permissions classifier effort ${CLASSIFIER_EFFORTS.join("|")}`, "error");
					return;
				}
				classifierEffort = selected;
				classifierCache.clear();
				await persist();
			} else if (action === "model") {
				const candidates = availableClassifierModels(ctx);
				let selected = argument;
				if (!selected && ctx.hasUI) {
					const labels = [
						`auto · cheapest available${classifierModel === AUTO_CLASSIFIER_MODEL ? " · current" : ""}`,
						...candidates.map((candidate) => `${classifierModelLabel(candidate)}${classifierModelKey(candidate.model) === classifierModel ? " · current" : ""}`),
					];
					const choice = await ctx.ui.select("Classifier model", labels);
					if (!choice) return;
					const index = labels.indexOf(choice);
					if (index === 0) selected = AUTO_CLASSIFIER_MODEL;
					else {
						const candidate = candidates[index - 1];
						if (!candidate) return;
						selected = classifierModelKey(candidate.model);
					}
				}
				if (selected !== AUTO_CLASSIFIER_MODEL && !candidates.some((candidate) => classifierModelKey(candidate.model) === selected)) {
					ctx.ui.notify(`Classifier model is unavailable or above the safety cost limit: ${selected}`, "error");
					return;
				}
				classifierModel = selected;
				classifierCache.clear();
				await persist();
			} else if (action !== "status") {
				ctx.ui.notify("Usage: /permissions classifier [status|on|off|model [auto|PROVIDER/MODEL]|effort [LEVEL]]", "error");
				return;
			}

			const candidates = availableClassifierModels(ctx);
			const preferred = classifierModel === AUTO_CLASSIFIER_MODEL
				? candidates[0]
				: candidates.find((candidate) => classifierModelKey(candidate.model) === classifierModel);
			const selected = preferred ? classifierModelLabel(preferred) : classifierModel === AUTO_CLASSIFIER_MODEL ? "none available" : `${classifierModel} · unavailable`;
			ctx.ui.notify(`Auto command classifier: ${aiClassifierEnabled ? "on" : "off"} · model ${classifierModel === AUTO_CLASSIFIER_MODEL ? `auto → ${selected}` : selected} · effort ${classifierEffort}\nCalls: ${classifierCalls} · allowed ${classifierAllows} · asked ${classifierAsks} · failed ${classifierFailures} · safety-skipped ${classifierSkipped} · unavailable ${classifierUnavailable} · cost $${classifierCost.toFixed(6)}${lastClassifierModel ? `\nLast model: ${lastClassifierModel}` : ""}${lastClassifierOutcome ? `\nLast outcome: ${lastClassifierOutcome}` : ""}`, "info");
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
			const classifierItem = `AI command classifier · ${aiClassifierEnabled ? "on" : "off"} · ${classifierModel === AUTO_CLASSIFIER_MODEL ? "auto model" : classifierModel} · ${classifierEffort}`;
			const selected = await ctx.ui.select("Pi++ permissions", [modeItem, classifierItem, "Back"]);
			if (!selected || selected === "Back") return;
			if (selected === modeItem) { await selectMode("", ctx); continue; }
			while (ctx.hasUI) {
				const enabledItem = `Enabled · ${aiClassifierEnabled ? "on" : "off"}`;
				const modelItem = `Model · ${classifierModel === AUTO_CLASSIFIER_MODEL ? "auto (cheapest)" : classifierModel}`;
				const effortItem = `Effort · ${classifierEffort}`;
				const classifierSetting = await ctx.ui.select("Pi++ auto command classifier", [enabledItem, modelItem, effortItem, "Status", "Back"]);
				if (!classifierSetting || classifierSetting === "Back") break;
				if (classifierSetting === enabledItem) {
					const value = await ctx.ui.select("AI command classifier", [
						`On${aiClassifierEnabled ? " · current" : ""}`,
						`Off${!aiClassifierEnabled ? " · current" : ""}`,
						"Back",
					]);
					if (value?.startsWith("On")) await selectMode("classifier on", ctx);
					else if (value?.startsWith("Off")) await selectMode("classifier off", ctx);
				} else if (classifierSetting === modelItem) await selectMode("classifier model", ctx);
				else if (classifierSetting === effortItem) await selectMode("classifier effort", ctx);
				else await selectMode("classifier status", ctx);
			}
		}
	};
	const unregisterSettings = registerPiPlusPlusSettingsSection({
		id: "permissions",
		label: "Permissions",
		description: "Global tool policy and optional AI command classifier",
		order: 10,
		summary: () => `${mode} · classifier ${aiClassifierEnabled ? "on" : "off"} · ${classifierModel === AUTO_CLASSIFIER_MODEL ? "auto model" : classifierModel} · ${classifierEffort}`,
		open: openPermissionSettings,
	});

	pi.registerCommand("permissions", { description: "View or change the global tool permission mode", handler: selectMode });
	pi.registerShortcut(Key.ctrlAlt("m"), { description: "Open Pi++ permission mode selector", handler: async (ctx) => selectMode("", ctx) });

	pi.on("session_start", (_event, ctx) => { currentContext = ctx; });
	pi.on("session_shutdown", () => { currentContext = undefined; listeners.clear(); unregisterSettings(); removePermissionService(service); });
}
