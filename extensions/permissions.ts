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
	buildAutoClassifierInput,
	commandClassifierUserPrompt,
	parseCommandClassifierVerdict,
	rankPermissionClassifierModels,
} from "./permission-classifier.ts";
import { AutoPermissionSession, permissionRequestFingerprint } from "./auto-permission.ts";
import { acceptEditsAutoApproves, explainPermission, isCriticalFilesystemRemoval } from "./workflows/permissions.ts";
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
	auto: "execute without prompts using background safety checks",
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
	let classifierModel = AUTO_CLASSIFIER_MODEL;
	let classifierEffort: ClassifierEffort = CLASSIFIER_REASONING_LEVEL;
	let autoModeAcknowledged = false;
	const availableModes = new Set<GlobalPermissionMode>(BASE_MODES);
	let currentContext: ExtensionContext | undefined;
	let queue: Promise<void> = Promise.resolve();
	const listeners = new Set<() => void>();
	const autoSession = new AutoPermissionSession();
	const denialReasons = new Map<string, string>();
	let classifierCalls = 0;
	let classifierAllows = 0;
	let classifierDenies = 0;
	let classifierFailures = 0;
	let classifierUnavailable = 0;
	let classifierCost = 0;
	let lastClassifierModel: string | undefined;
	let lastClassifierOutcome: string | undefined;
	try {
		const value = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mode?: GlobalPermissionMode; classifierModel?: string; classifierEffort?: ClassifierEffort; autoModeAcknowledged?: boolean };
		if ([...BASE_MODES, "plan"].includes(value.mode as GlobalPermissionMode)) configuredMode = value.mode as GlobalPermissionMode;
		if (typeof value.classifierModel === "string" && value.classifierModel.trim()) classifierModel = value.classifierModel.trim();
		if (CLASSIFIER_EFFORTS.includes(value.classifierEffort as ClassifierEffort)) classifierEffort = value.classifierEffort as ClassifierEffort;
		if (typeof value.autoModeAcknowledged === "boolean") autoModeAcknowledged = value.autoModeAcknowledged;
		if (availableModes.has(configuredMode)) mode = configuredMode;
	} catch { /* defaults */ }

	const persist = async () => {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		const temp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await fs.promises.writeFile(temp, `${JSON.stringify({ mode: configuredMode, classifierModel, classifierEffort, autoModeAcknowledged }, null, 2)}\n`, { mode: 0o600 });
		await fs.promises.rename(temp, configPath);
	};

	const rememberDenialReason = (request: PermissionRequest, reason: string | undefined) => {
		const key = permissionRequestFingerprint(request);
		denialReasons.delete(key);
		if (reason) denialReasons.set(key, reason);
		while (denialReasons.size > 256) denialReasons.delete(denialReasons.keys().next().value!);
	};

	const classifierModelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	const availableClassifierModels = (ctx: ExtensionContext, inputTokens = CLASSIFIER_ESTIMATED_INPUT_TOKENS) =>
		rankPermissionClassifierModels(ctx.modelRegistry.getAvailable(), inputTokens);
	const classifierModelLabel = (candidate: ReturnType<typeof availableClassifierModels>[number]) =>
		`${classifierModelKey(candidate.model)} · estimated $${candidate.estimatedCostUsd.toFixed(6)}/call${candidate.explicitlyFree ? " · free-tagged" : ""}`;

	type ActionClassification = { allow: boolean; explanation: string };
	const classifyAction = async (request: PermissionRequest, ctx: ExtensionContext): Promise<ActionClassification> => {
		const classifierInput = buildAutoClassifierInput(request, ctx);
		const classifierPrompt = commandClassifierUserPrompt(classifierInput);
		const estimatedInputTokens = Math.max(CLASSIFIER_ESTIMATED_INPUT_TOKENS, Math.ceil(Buffer.byteLength(`${COMMAND_CLASSIFIER_SYSTEM_PROMPT}\n${classifierPrompt}`, "utf8") / 3));
		const ranked = availableClassifierModels(ctx, estimatedInputTokens);
		const candidates = classifierModel === AUTO_CLASSIFIER_MODEL
			? ranked.slice(0, 4)
			: ranked.filter((candidate) => classifierModelKey(candidate.model) === classifierModel).slice(0, 1);
		if (!candidates.length) {
			classifierUnavailable++;
			lastClassifierOutcome = classifierModel === AUTO_CLASSIFIER_MODEL
				? "no authenticated classifier model can fit the current auto-mode context"
				: `configured model unavailable or ineligible: ${classifierModel}`;
			return { allow: false, explanation: `Auto mode cannot determine the safety of this action: ${lastClassifierOutcome}.` };
		}
		let attempted = false;
		let lastFailure: string | undefined;
		for (const candidate of candidates) {
			const modelName = `${candidate.model.provider}/${candidate.model.id}`;
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
					messages: [{ role: "user", content: [{ type: "text", text: classifierPrompt }], timestamp: Date.now() }],
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
				const allow = verdict.decision === "ALLOW";
				if (allow) classifierAllows++;
				else classifierDenies++;
				lastClassifierOutcome = `${verdict.decision}: ${verdict.reason}`;
				return { allow, explanation: verdict.reason };
			} catch (error) {
				classifierFailures++;
				lastFailure = error instanceof Error ? error.message : String(error);
			}
		}
		if (!attempted) classifierUnavailable++;
		lastClassifierOutcome = attempted ? `failed: ${lastFailure ?? "unknown error"}` : `unavailable: ${lastFailure ?? "authentication failed"}`;
		return { allow: false, explanation: `Auto mode cannot determine the safety of this action${lastClassifierModel ? ` with ${lastClassifierModel}` : ""}: ${lastFailure ?? "classifier unavailable"}.` };
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
		getDenialReason(request) { return denialReasons.get(permissionRequestFingerprint(request)); },
		async authorize(request, suppliedContext, options) {
			const ctx = suppliedContext ?? currentContext;
			const cwd = ctx?.cwd ?? process.cwd();
			const policyMode = mode === "plan" || mode === "accept-edits" ? "auto" : mode === "dangerous" ? "manual" : mode;
			const decision = explainPermission(request, cwd, policyMode, { artifactRoots: [workflowArtifactRoot] });
			const criticalRemoval = isCriticalFilesystemRemoval(request, cwd);
			const forcePrompt = Boolean(options?.forcePrompt || criticalRemoval);
			rememberDenialReason(request, undefined);
			if (mode === "dangerous" && !forcePrompt) return true;
			if (decision.hardDeny) {
				rememberDenialReason(request, decision.explanation);
				return false;
			}
			if (mode === "plan") {
				const allow = decision.risk === "safe" && decision.allow;
				if (!allow) rememberDenialReason(request, decision.explanation);
				return allow;
			}

			let autoPromptSource: "fallback" | "retry" | undefined;
			if (mode === "auto" && !forcePrompt) {
				autoPromptSource = autoSession.promptReason(request);
				// Read-only operations remain automatic while fallback is paused,
				// matching Claude Code's normal read baseline.
				if (decision.risk === "safe" && decision.allow) {
					autoSession.recordAutomaticAllow();
					return true;
				}
				if (!autoPromptSource && decision.automatic) {
					if (decision.allow) autoSession.recordAutomaticAllow();
					else rememberDenialReason(request, decision.explanation);
					return decision.allow;
				}
				if (!autoPromptSource) {
					const classification = ctx
						? await classifyAction(request, ctx)
						: { allow: false, explanation: "Auto mode cannot determine the safety of this action without an active session context." };
					if (classification.allow) {
						autoSession.recordAutomaticAllow();
						return true;
					}
					rememberDenialReason(request, classification.explanation);
					const outcome = autoSession.recordClassifierDenial(request, classification.explanation);
					if (ctx?.hasUI) {
						const fallback = outcome.pauseTriggeredBy ? `\n${autoSession.getPauseReason()} The next non-read action will use manual approval.` : "";
						ctx.ui.notify(`Auto mode blocked ${request.toolName}: ${classification.explanation}${fallback}`, "warning");
					}
					return false;
				}
			}

			if (mode === "accept-edits") {
				if (acceptEditsAutoApproves(request, decision) && !forcePrompt) return true;
			} else if (mode !== "auto" && decision.automatic && !forcePrompt) return decision.allow;
			if (!ctx?.hasUI) {
				rememberDenialReason(request, decision.explanation);
				return false;
			}
			const input = request.toolName === "bash" ? String(request.input.command ?? "") : JSON.stringify(request.input, null, 2);
			let allowed = false;
			const prompt = async () => {
				const fallbackNote = autoPromptSource ? `\n${autoSession.getPauseReason() ?? "Retrying an auto-mode denial with manual approval."}` : "";
				const circuitBreaker = criticalRemoval ? "\nFilesystem root/home removal always requires an explicit decision." : "";
				const choice = await ctx.ui.select(`${request.agentLabel} requests ${request.toolName}\n\n${decision.explanation}${fallbackNote}${circuitBreaker}${options?.reason ? `\n${options.reason}` : ""}\n\n${input}`, ["Allow once", "Deny"]);
				allowed = choice === "Allow once";
			};
			queue = queue.then(prompt, prompt);
			await queue;
			if (autoPromptSource) autoSession.resolvePrompt(request, autoPromptSource, allowed);
			if (!allowed) rememberDenialReason(request, decision.explanation);
			return allowed;
		},
	};
	installPermissionService(service);

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "workflow_models" || event.toolName === "workflow_run") return;
		const request: PermissionRequest = {
			agentId: "main",
			agentLabel: "Main agent",
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
		};
		const allow = await service.authorize(request, ctx);
		return allow ? undefined : { block: true, reason: service.getDenialReason?.(request) ?? `Blocked by global ${mode} permission policy` };
	});

	const showRecentDenials = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			const recent = [...autoSession.getRecentDenials()].reverse();
			ctx.ui.notify(recent.length
				? recent.map((denial) => `${denial.toolName}: ${denial.reason}`).join("\n")
				: "No auto-mode denials in this session.", "info");
			return;
		}
		while (true) {
			const recent = [...autoSession.getRecentDenials()].reverse();
			if (!recent.length) { ctx.ui.notify("No auto-mode denials in this session.", "info"); return; }
			const labels = recent.map((denial) => {
				const input = denial.toolName === "bash" ? String(denial.input.command ?? "") : JSON.stringify(denial.input);
				const preview = input.length > 90 ? `${input.slice(0, 89)}…` : input;
				return `#${denial.id} · ${denial.toolName} · ${preview}${denial.retryQueued ? " · retry queued" : ""}`;
			});
			labels.push("Back");
			const selected = await ctx.ui.select("Recently denied by auto mode", labels);
			if (!selected || selected === "Back") return;
			const denial = recent[labels.indexOf(selected)];
			if (!denial) continue;
			const action = await ctx.ui.select(`${denial.agentLabel} · ${denial.toolName}\n\n${denial.reason}\n\n${JSON.stringify(denial.input, null, 2)}`, ["Retry with manual approval", "Back"]);
			if (action !== "Retry with manual approval") continue;
			const queued = autoSession.queueRetry(denial.id);
			if (!queued) continue;
			pi.sendMessage({
				customType: "piplusplus-auto-retry",
				content: `The user selected retry for the previously denied ${queued.toolName} action. Retry that same tool call once; it will be shown to the user for manual approval.`,
				display: true,
				details: { denialId: queued.id, toolName: queued.toolName },
			}, { triggerTurn: true, deliverAs: "followUp" });
			ctx.ui.notify(`Queued manual retry for denied ${queued.toolName} action.`, "info");
			return;
		}
	};

	const selectMode = async (requestedText: string, ctx: ExtensionContext) => {
		if (/^(?:denied|recent|recently-denied)$/i.test(requestedText.trim())) {
			await showRecentDenials(ctx);
			return;
		}
		const classifierCommand = requestedText.trim().match(/^classifier(?:\s+(.*))?$/i);
		if (classifierCommand) {
			const request = classifierCommand[1]?.trim() ?? "status";
			const [rawAction, ...rawRest] = request.split(/\s+/);
			const action = rawAction.toLowerCase();
			const argument = rawRest.join(" ").trim();
			if (action === "on") {
				ctx.ui.notify("The auto-mode classifier is always enabled while auto mode is active.", "info");
			} else if (action === "off") {
				ctx.ui.notify("Auto mode cannot run with its safety classifier disabled. Select a different permission mode instead.", "error");
				return;
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
					ctx.ui.notify(`Classifier model is unavailable or cannot fit the classifier context: ${selected}`, "error");
					return;
				}
				classifierModel = selected;
				await persist();
			} else if (action !== "status") {
				ctx.ui.notify("Usage: /permissions classifier [status|model [auto|PROVIDER/MODEL]|effort [LEVEL]]", "error");
				return;
			}

			const candidates = availableClassifierModels(ctx);
			const preferred = classifierModel === AUTO_CLASSIFIER_MODEL
				? candidates[0]
				: candidates.find((candidate) => classifierModelKey(candidate.model) === classifierModel);
			const selected = preferred ? classifierModelLabel(preferred) : classifierModel === AUTO_CLASSIFIER_MODEL ? "none available" : `${classifierModel} · unavailable`;
			ctx.ui.notify(`Auto safety classifier: always on in auto mode · model ${classifierModel === AUTO_CLASSIFIER_MODEL ? `auto → ${selected}` : selected} · effort ${classifierEffort}\nCalls: ${classifierCalls} · allowed ${classifierAllows} · denied ${classifierDenies} · failed ${classifierFailures} · unavailable ${classifierUnavailable} · cost $${classifierCost.toFixed(6)}\nSession denials: ${autoSession.getRecentDenials().length} · consecutive ${autoSession.getConsecutiveDenials()} · total ${autoSession.getTotalDenials()}${autoSession.isPaused() ? " · fallback paused" : ""}${lastClassifierModel ? `\nLast model: ${lastClassifierModel}` : ""}${lastClassifierOutcome ? `\nLast outcome: ${lastClassifierOutcome}` : ""}`, "info");
			return;
		}
		const modes = [...availableModes];
		const requested = requestedText.trim() as GlobalPermissionMode;
		let selected: GlobalPermissionMode | undefined = modes.includes(requested) ? requested : undefined;
		if (!selected && requestedText.trim()) { ctx.ui.notify(`Unknown permission mode: ${requestedText.trim()}`, "error"); return; }
		if (!selected) {
			const labels = modes.map((item) => `${item} · ${MODE_DESCRIPTIONS[item]}${item === mode ? " · current" : ""}`);
			if (autoSession.getRecentDenials().length) labels.push(`recently denied · ${autoSession.getRecentDenials().length}`);
			const choice = await ctx.ui.select(`Global permissions · ${mode}`, labels);
			if (choice?.startsWith("recently denied")) { await showRecentDenials(ctx); return; }
			selected = choice?.split(" · ")[0] as GlobalPermissionMode | undefined;
		}
		if (!selected) return;
		if (selected === "auto") {
			if (!availableClassifierModels(ctx).length) {
				ctx.ui.notify("Auto mode is unavailable because no authenticated text model can run the safety classifier.", "error");
				return;
			}
			if (!autoModeAcknowledged && ctx.hasUI) {
				const confirmation = await ctx.ui.select("Auto mode executes without permission prompts and uses a separate model to block actions outside your request. It reduces prompts but does not guarantee safety.", ["Cancel", "Enable auto mode"]);
				if (confirmation !== "Enable auto mode") return;
				autoModeAcknowledged = true;
			}
		}
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
			const classifierItem = `Auto safety classifier · ${classifierModel === AUTO_CLASSIFIER_MODEL ? "auto model" : classifierModel} · ${classifierEffort}`;
			const deniedItem = `Recently denied · ${autoSession.getRecentDenials().length}`;
			const selected = await ctx.ui.select("Pi++ permissions", [modeItem, classifierItem, deniedItem, "Back"]);
			if (!selected || selected === "Back") return;
			if (selected === modeItem) { await selectMode("", ctx); continue; }
			if (selected === deniedItem) { await showRecentDenials(ctx); continue; }
			while (ctx.hasUI) {
				const modelItem = `Model · ${classifierModel === AUTO_CLASSIFIER_MODEL ? "auto (cheapest)" : classifierModel}`;
				const effortItem = `Effort · ${classifierEffort}`;
				const classifierSetting = await ctx.ui.select("Pi++ auto safety classifier", [modelItem, effortItem, "Status", "Back"]);
				if (!classifierSetting || classifierSetting === "Back") break;
				if (classifierSetting === modelItem) await selectMode("classifier model", ctx);
				else if (classifierSetting === effortItem) await selectMode("classifier effort", ctx);
				else await selectMode("classifier status", ctx);
			}
		}
	};
	const unregisterSettings = registerPiPlusPlusSettingsSection({
		id: "permissions",
		label: "Permissions",
		description: "Global tool policy and auto-mode safety classifier",
		order: 10,
		summary: () => `${mode} · classifier ${classifierModel === AUTO_CLASSIFIER_MODEL ? "auto model" : classifierModel} · ${classifierEffort}${autoSession.isPaused() ? " · fallback paused" : ""}`,
		open: openPermissionSettings,
	});

	pi.registerCommand("permissions", { description: "View or change the global tool permission mode", handler: selectMode });
	pi.registerCommand("permission", { description: "Alias for /permissions", handler: selectMode });
	pi.registerShortcut(Key.ctrlAlt("m"), { description: "Open Pi++ permission mode selector", handler: async (ctx) => selectMode("", ctx) });

	pi.on("before_agent_start", (event) => mode === "auto" ? {
		systemPrompt: `${event.systemPrompt}\n\n## Auto permission mode\nExecute actions directly and minimize permission-related or avoidable clarification questions. A separate safety classifier checks non-read actions. If an action is denied, use the denial reason to choose a safer alternative; do not ask the user to bypass the classifier.`,
	} : undefined);
	pi.on("session_start", (_event, ctx) => { currentContext = ctx; autoSession.resetRuntime(); denialReasons.clear(); });
	pi.on("session_shutdown", () => { currentContext = undefined; listeners.clear(); unregisterSettings(); removePermissionService(service); });
}
