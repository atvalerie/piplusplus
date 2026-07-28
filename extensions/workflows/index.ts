import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, type Terminal } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { workflowApprovalSummary } from "./approval.ts";
import { writeWorkflowArtifact } from "./artifact.ts";
import { getPermissionService } from "../shared/permission-service.ts";
import { installWorkflowDockService, removeWorkflowDockService, type WorkflowDockService } from "../shared/workflow-dock-service.ts";
import { migrateWorkflowRun } from "./migration.ts";
import { filterSupportedWorkflowModels, modelCatalogText, serializeModels, SUPPORTED_WORKFLOW_PROVIDERS } from "./models.ts";
import { explainPermission, isPathWithinWriteScope, mutationOverlapsWriteScopes, scopedToolRequiresExplicitApproval } from "./permissions.ts";
import { PROFILE_NAMES } from "./profiles.ts";
import { compileWorkflowRecipe, WORKFLOW_RECIPE_NAMES } from "./recipes.ts";
import { createWorkflowController, validateWorkflowScript } from "./runtime.ts";
import { createSavedWorkflowSource, loadSavedWorkflows, normalizeWorkflowArgs, parseSavedWorkflowArgs, savedWorkflowDirectories, saveWorkflowSource, type SavedWorkflow } from "./saved.ts";
import {
	applyWorkflowSettings,
	DEFAULT_WORKFLOW_SETTINGS,
	describeWorkflowBudgetSettings,
	describeWorkflowMaxTurnsSettings,
	isInteractiveUltracodeTrigger,
	loadWorkflowSettings,
	normalizeCustomBudgets,
	normalizeCustomMaxTurns,
	saveWorkflowSettings,
	type WorkflowBudgetMode,
	type WorkflowMaxTurnsMode,
	type WorkflowSettings,
} from "./settings.ts";
import { buildWorkflowSystemInstructions, workflowPolicyContext } from "./system-prompt.ts";
import { Surface } from "../../ui/primitives/surface.ts";
import { WorkflowBrowser } from "./tui.ts";
import { headlessWorkflowLaunchAllowed, isWorkflowTrusted, trustWorkflowFromUserAction, workflowTrustIdentity } from "./trust.ts";
import { aggregateUsage, type AgentState, type PermissionRequest, type ThinkingLevel, type WorkflowController, type WorkflowRun, type WorkflowSpec, zeroUsage } from "./types.ts";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";
const WIDGET_ID = "piplusplus-workflows";
const MAX_RUN_LOG_EVENTS = 100_000;
const retentionDays = Math.max(1, Math.min(365, Number.parseInt(process.env.PIPLUSPLUS_WORKFLOW_RETENTION_DAYS ?? "30", 10) || 30));

export const WorkflowSchema = Type.Object({
	name: Type.String({ description: "Short workflow name" }),
	why: Type.String({ description: "Why code-mode orchestration is better than one main-agent context for this task" }),
	goal: Type.String({ description: "Concrete definition of done" }),
	prompt: Type.String({ description: "The original task or workflow-level objective. Individual agent() calls still receive their own distinct prompts." }),
	args: Type.Optional(Type.Unknown({ description: "Copied JSON data exposed to custom and saved workflow scripts as global args." })),
	script: Type.Optional(Type.String({ description: "Deterministic JavaScript body using agent(), parallel(), pipeline(), phase(), approve(), models(), workflowPrompt, and return. Omit when using recipe." })),
	recipe: Type.Optional(StringEnum(WORKFLOW_RECIPE_NAMES)),
	modelPolicy: Type.Object({
		defaultRouting: StringEnum(["inherit", "auto"] as const),
		allowedProviders: Type.Optional(Type.Array(StringEnum(SUPPORTED_WORKFLOW_PROVIDERS), {
			minItems: 1,
			uniqueItems: true,
			description: "Hard provider/source groups: opencode-go, anthropic, openai, or modelhub. ModelHub key aliases collapse to modelhub.",
		})),
		allowedFamilies: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true, description: "Exact lowercase family values from workflow_models, such as openai or anthropic." })),
		allowedModels: Type.Optional(Type.Array(Type.String(), { minItems: 1, uniqueItems: true })),
		rationale: Type.String({ description: "Why this routing policy follows the user's request. Interpret the request semantically in any language; do not rely on keywords." }),
	}, { description: "The orchestrating model's structured routing decision. Runtime-enforced allowlists are hard constraints." }),
	size: Type.Optional(StringEnum(["small", "medium", "large", "unrestricted"] as const, {
		description: "Generation guidance: small <5 agents, medium <15, large <50, unrestricted up to runtime caps.",
	})),
	budgets: Type.Optional(Type.Object({
		maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
		maxTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Hard cap on consumed input, output, cache-read, and cache-write tokens." })),
		maxCost: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Hard cap on reported workflow cost." })),
	}, { additionalProperties: false, description: "Aggregate scheduling budgets. User settings override these fields. Exhaustion prevents new workers from starting; already-running workers may finish and overrun token/cost thresholds." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
	background: Type.Optional(Type.Boolean({ description: "Run without blocking the conversation; default true" })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000, description: "Parent-enforced workflow wall-clock deadline" })),
	maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Retries per failed subagent; default 3" })),
	retryBaseMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000, description: "Initial exponential retry delay; default 1000ms" })),
});

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function elapsed(run: WorkflowRun): string {
	const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt)) / 1_000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function summary(run: WorkflowRun): string {
	return `${run.agents.length} agents · ${run.usage.turns} turns · ↑${formatTokens(run.usage.input)} ↓${formatTokens(run.usage.output)} · $${run.usage.cost.toFixed(4)} · ${elapsed(run)}`;
}

function icon(status: string): string {
	return ({ queued: "○", running: "⏳", paused: "Ⅱ", completed: "✓", completed_with_flags: "⚑", budget_exhausted: "⚠", failed: "✗", stopped: "■" } as Record<string, string>)[status] ?? "·";
}

export default function workflowsExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;

	const runs = new Map<string, WorkflowRun>();
	const controllers = new Map<string, WorkflowController>();
	const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const artifactTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const artifactQueues = new Map<string, Promise<void>>();
	const savedWorkflows = new Map<string, SavedWorkflow>();
	const registeredSavedCommands = new Set<string>();
	const stateDir = path.join(getAgentDir(), "workflows", "runs");
	const artifactDir = path.join(getAgentDir(), "workflows", "artifacts");
	let ctxNow: ExtensionContext | undefined;
	let restoreThinking: ThinkingLevel | undefined;
	const pendingUltracodeTriggers: boolean[] = [];
	let workflowSettings: WorkflowSettings = { ...DEFAULT_WORKFLOW_SETTINGS };
	let counter = 0;

	const orderedRuns = () => [...runs.values()].sort((a, b) => b.createdAt - a.createdAt);

	async function saveWorkflowRun(runId: string, ctx: ExtensionContext): Promise<void> {
		const run = runs.get(runId);
		if (!run) { ctx.ui.notify(`Unknown workflow: ${runId}`, "error"); return; }
		const suggested = run.spec.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "workflow";
		const enteredName = await ctx.ui.input(`Save workflow name (default: ${suggested})`, "lowercase-name");
		if (enteredName === undefined) return;
		const name = enteredName.trim() || suggested;
		const enteredDescription = await ctx.ui.input(`Description (default: ${run.spec.goal.slice(0, 120)})`, "what this workflow does");
		if (enteredDescription === undefined) return;
		const description = enteredDescription.trim() || run.spec.goal.slice(0, 500);
		const selectedScope = await ctx.ui.select("Save workflow scope", [
			"Project — .pi/workflows",
			"Personal — ~/.pi/agent/workflows",
			"Cancel",
		]);
		if (!selectedScope || selectedScope === "Cancel") return;
		const scope = selectedScope.startsWith("Project") ? "project" : "personal";
		try {
			const source = createSavedWorkflowSource(run.spec, name, description);
			const directories = savedWorkflowDirectories(ctx.cwd, getAgentDir());
			const target = path.join(directories[scope], `${name}.js`);
			if (fs.existsSync(target) && !await ctx.ui.confirm("Replace saved workflow?", `${target}\n\nThis overwrites the existing saved workflow source.`)) return;
			const saved = await saveWorkflowSource(scope, name, source, ctx.cwd, getAgentDir());
			await refreshSavedWorkflowCommands(ctx);
			ctx.ui.notify(`Saved /${saved.meta.name} as a ${scope} workflow.`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not save workflow: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	const openWorkflowDock = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") { ctx.ui.notify(orderedRuns().map((run) => `${run.id} ${run.status} ${run.spec.name}`).join("\n") || "No workflows", "info"); return; }
		const editorBuffer = ctx.ui.getEditorText();
		let mouseTerminal: Terminal | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				mouseTerminal = tui.terminal;
				mouseTerminal.write("\x1b[?1000h\x1b[?1006h");
				let timer: ReturnType<typeof setInterval>;
				const close = () => { clearInterval(timer); done(); };
				const height = Math.max(9, Math.floor(tui.terminal.rows * 0.45) - 2);
				const browser = new WorkflowBrowser(
					orderedRuns,
					controllers,
					theme,
					close,
					height,
					(runId, restartAgentId) => { void resumeWorkflow(runId, restartAgentId); },
					(runId) => { close(); void saveWorkflowRun(runId, ctx); },
				);
				const panel = new Surface({ theme, body: browser, border: "frame", borderTone: "accent", padding: { top: 0, right: 1, bottom: 0, left: 1 }, background: "panel" });
				timer = setInterval(() => tui.requestRender(), 250);
				return { render: (width) => panel.render(width), invalidate: () => panel.invalidate(), handleInput: (data) => { browser.handleInput(data); tui.requestRender(); } };
			}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "48%", anchor: "bottom-center", margin: { top: 0, right: 0, bottom: 0, left: 0 } } });
		} finally {
			mouseTerminal?.write("\x1b[?1006l\x1b[?1000l");
			ctx.ui.setEditorText(editorBuffer);
		}
	};
	const dockService: WorkflowDockService = { hasRuns: () => [...runs.values()].some((run) => ["queued", "running", "paused"].includes(run.status)), open: openWorkflowDock };
	installWorkflowDockService(dockService);

	const persistNow = async (run: WorkflowRun) => {
		try {
			await fs.promises.mkdir(stateDir, { recursive: true });
			const clean = JSON.parse(JSON.stringify(run, (key, value) => key === "process" ? undefined : value));
			const target = path.join(stateDir, `${run.id}.json`);
			const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			await fs.promises.writeFile(temp, JSON.stringify(clean, null, 2), { mode: 0o600 });
			await fs.promises.rename(temp, target);
		} catch { /* UI state persistence is best effort */ }
	};

	const schedulePersist = (run: WorkflowRun, immediate = false) => {
		const previous = persistTimers.get(run.id);
		if (previous) clearTimeout(previous);
		if (immediate) { persistTimers.delete(run.id); void persistNow(run); return; }
		persistTimers.set(run.id, setTimeout(() => { persistTimers.delete(run.id); void persistNow(run); }, 150));
	};

	const writeArtifactNow = async (run: WorkflowRun) => {
		const previous = artifactQueues.get(run.id) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(async () => { await writeWorkflowArtifact(run, artifactDir); });
		artifactQueues.set(run.id, next);
		try { await next; }
		catch (error) {
			run.logs.push({ at: Date.now(), event: `artifact_error:${error instanceof Error ? error.message : String(error)}`, phase: run.currentPhase, status: run.status });
			notify(`Could not update workflow JSON for ${run.spec.name}`, "warning");
		} finally { if (artifactQueues.get(run.id) === next) artifactQueues.delete(run.id); }
	};

	const scheduleArtifact = (run: WorkflowRun, immediate = false) => {
		const previous = artifactTimers.get(run.id);
		if (previous) clearTimeout(previous);
		if (immediate) { artifactTimers.delete(run.id); void writeArtifactNow(run); return; }
		artifactTimers.set(run.id, setTimeout(() => { artifactTimers.delete(run.id); void writeArtifactNow(run); }, 150));
	};

	const refreshUi = () => {
		const ctx = ctxNow;
		if (!ctx?.hasUI) return;
		const active = orderedRuns().filter((run) => ["queued", "running", "paused"].includes(run.status));
		ctx.ui.setStatus(WIDGET_ID, active.length ? `${active.length} workflow${active.length === 1 ? "" : "s"}` : undefined);
		if (!active.length) { ctx.ui.setWidget(WIDGET_ID, undefined); return; }
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => new Text(active.map((run) => {
			const done = run.agents.filter((agent) => !["queued", "running"].includes(agent.status)).length;
			return `${theme.fg(run.status === "paused" ? "warning" : "accent", `${icon(run.status)} `)}${run.spec.name}${theme.fg("dim", ` · ${run.currentPhase} · ${done}/${run.agents.length} · ${summary(run)}`)}`;
		}).join("\n"), 0, 0), { placement: "belowEditor" });
	};

	const changed = (run: WorkflowRun, event: string, agent?: AgentState) => {
		if (run.logs.length < MAX_RUN_LOG_EVENTS) run.logs.push({ at: Date.now(), event, phase: run.currentPhase, status: run.status, agentId: agent?.id, agentStatus: agent?.status });
		else run.droppedLogEvents = (run.droppedLogEvents ?? 0) + 1;
		run.usage = aggregateUsage(run.agents);
		const terminal = ["completed", "completed_with_flags", "budget_exhausted", "failed", "stopped"].includes(run.status);
		schedulePersist(run, terminal);
		scheduleArtifact(run, terminal);
		refreshUi();
		pi.events.emit("piplusplus:workflow", { runId: run.id, event, status: run.status });
	};

	const notify = (message: string, level: "info" | "warning" | "error") => {
		if (ctxNow?.hasUI) ctxNow.ui.notify(message, level);
	};

	async function requestPermission(run: WorkflowRun, request: PermissionRequest): Promise<boolean> {
		const service = getPermissionService();
		const mode = service?.getMode() ?? "read-only";
		const policyMode = mode === "plan" || mode === "accept-edits" ? "auto" : mode === "dangerous" ? "manual" : mode;
		const decision = explainPermission(request, run.cwd, policyMode, { artifactRoots: [artifactDir] });
		const agent = run.agents.find((candidate) => candidate.id === request.agentId);
		if (decision.hardDeny) {
			agent?.logs.push({ at: Date.now(), type: "permission_denied", tool: request.toolName, message: decision.explanation });
			return false;
		}
		if (agent?.writePaths && (request.toolName === "write" || request.toolName === "edit") && !isPathWithinWriteScope(run.cwd, request.input.path, agent.writePaths)) {
			agent.logs.push({ at: Date.now(), type: "permission_denied", tool: request.toolName, message: `Target is outside declared write scope: ${agent.writePaths.join(", ")}` });
			return false;
		}
		agent?.logs.push({ at: Date.now(), type: "permission_request", tool: request.toolName, message: `${mode}/${decision.risk}: ${decision.explanation}` });
		const otherRunningAgents = run.agents.filter((candidate) => candidate.id !== request.agentId && candidate.status === "running");
		const overlappingMutation = (request.toolName === "write" || request.toolName === "edit")
			&& mutationOverlapsWriteScopes(run.cwd, request.input.path, otherRunningAgents.map((candidate) => candidate.writePaths));
		const scopedUnconfinedTool = scopedToolRequiresExplicitApproval(request, agent?.writePaths);
		const reasons = [
			overlappingMutation ? "Another running workflow agent may mutate the same declared path; concurrent overlapping writes require an explicit decision." : undefined,
			scopedUnconfinedTool && request.toolName === "bash" ? "This shell command executes with the user's OS account and cannot be confined to writePaths; approval explicitly acknowledges that the declared path scope is not an OS sandbox." : undefined,
			scopedUnconfinedTool && request.toolName !== "bash" ? "This custom tool has no enforceable writePaths boundary; approval explicitly acknowledges its effects may escape the declared scope." : undefined,
		].filter((reason): reason is string => Boolean(reason));
		const allow = service
			? await service.authorize(request, ctxNow, reasons.length ? { forcePrompt: true, reason: reasons.join("\n") } : undefined)
			: decision.allow;
		agent?.logs.push({ at: Date.now(), type: allow ? "permission_allowed" : "permission_denied", tool: request.toolName, message: service ? `global ${mode} policy` : "global permission extension unavailable; read-only fallback" });
		return allow;
	}

	const resumeWorkflow = async (runId: string, restartAgentId?: string): Promise<void> => {
		const run = runs.get(runId);
		if (!run) { notify(`Unknown workflow: ${runId}`, "error"); return; }
		if (restartAgentId) run.cacheInvalidations = [...new Set([...(run.cacheInvalidations ?? []), restartAgentId])];
		const resumable = run.status === "stopped"
			|| (["completed", "completed_with_flags", "budget_exhausted", "failed"].includes(run.status) && Boolean(run.cacheInvalidations?.length));
		if (!resumable) { notify(`Workflow ${runId} is ${run.status}; only stopped runs or explicitly restarted agents can resume.`, "warning"); return; }
		const ctx = ctxNow;
		if (!ctx) { notify(`Workflow ${runId} cannot resume without an active Pi session.`, "error"); return; }
		await ctx.modelRegistry.refresh();
		const models = filterSupportedWorkflowModels(ctx.modelRegistry.getAvailable() as Model[]);
		const runtime = createWorkflowController(run, models, ctx.model, {
			changed: (event, agent) => changed(run, event, agent),
			notify,
			requestPermission: (request) => requestPermission(run, request),
			requestApproval: async (title, detail) => {
				if (!ctx.hasUI) return false;
				const shown = detail.length > 12_000 ? `${detail.slice(0, 12_000)}\n…` : detail;
				const choice = await ctx.ui.select(`${title}\n\n${shown}`, ["Approve and continue", "Reject and stop"]);
				return choice === "Approve and continue";
			},
		}, { sessionThinking: pi.getThinkingLevel() as ThinkingLevel });
		controllers.set(run.id, runtime.controller);
		changed(run, "resume_requested");
		void runtime.execute().then(async () => {
			await writeArtifactNow(run);
			await persistNow(run);
			const level = run.status === "failed" ? "error" : run.status === "completed_with_flags" || run.status === "budget_exhausted" ? "warning" : "info";
			notify(`Workflow ${run.status.replaceAll("_", " ")} after resume: ${run.spec.name} · ${summary(run)}`, level);
			if (["completed", "completed_with_flags", "budget_exhausted", "failed"].includes(run.status)) {
				const handoff = run.artifactPath ? `\n\nRead the complete workflow JSON before reporting:\n${run.artifactPath}` : "";
				pi.sendMessage({
					customType: "piplusplus-workflow-result",
					content: `Workflow ${run.id} (${run.spec.name}) ${run.status} after resume.\n${workflowPolicyContext(run.spec.modelPolicy)}\n\n${run.result ?? run.error ?? "No result"}\n\n${summary(run)}${run.flags.length ? `\nFlags:\n- ${run.flags.join("\n- ")}` : ""}${handoff}`,
					display: true,
					details: { runId: run.id, status: run.status, artifactPath: run.artifactPath },
				}, { triggerTurn: true, deliverAs: "followUp" });
			}
		});
	};

	async function approve(spec: WorkflowSpec, ctx: ExtensionContext): Promise<WorkflowSpec | undefined> {
		if (!ctx.hasUI) return headlessWorkflowLaunchAllowed() ? spec : undefined;
		while (true) {
			try {
				if (await isWorkflowTrusted(spec, ctx.cwd, getAgentDir())) return spec;
			} catch (error) {
				ctx.ui.notify(`Could not read workflow trust store: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			const identity = workflowTrustIdentity(spec, ctx.cwd);
			const choice = await ctx.ui.select(`${workflowApprovalSummary(spec)}\nTrust identity: ${identity.scriptHash.slice(0, 12)} · ${identity.projectPath}`, [
				"Run once",
				"Run and trust this exact script in this project",
				"View/edit raw JavaScript",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return undefined;
			if (choice === "Run once") return spec;
			if (choice.startsWith("Run and trust")) {
				try {
					await trustWorkflowFromUserAction(spec, ctx.cwd, getAgentDir());
					ctx.ui.notify(`Trusted exact workflow script ${identity.scriptHash.slice(0, 12)} for this project.`, "info");
				} catch (error) {
					ctx.ui.notify(`Workflow will run once, but trust could not be saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
				return spec;
			}
			const edited = await ctx.ui.editor(`JavaScript workflow: ${spec.name}`, spec.script);
			if (edited !== undefined) {
				const error = validateWorkflowScript(edited);
				if (error) ctx.ui.notify(`Invalid workflow script: ${error}`, "error");
				else spec = { ...spec, script: edited };
			}
		}
	}

	const launchApprovedWorkflow = async (
		spec: WorkflowSpec,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: (update: any) => void,
	) => {
		spec.args = normalizeWorkflowArgs(spec.args);
		await ctx.modelRegistry.refresh();
		const models = filterSupportedWorkflowModels(ctx.modelRegistry.getAvailable() as Model[]);
		const runId = `wf_${Date.now().toString(36)}_${(++counter).toString(36)}`;
		const run: WorkflowRun = {
			id: runId,
			sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, spec, status: "queued", createdAt: Date.now(),
			currentPhase: "Starting", phases: [], agents: [], flags: [], usage: zeroUsage(), paused: false, logs: [],
			artifactPath: path.join(artifactDir, `${runId}.json`),
		};
		runs.set(run.id, run);
		const runtime = createWorkflowController(run, models, ctx.model, {
			changed: (event, agent) => {
				changed(run, event, agent);
				onUpdate?.({ content: [{ type: "text", text: `${icon(run.status)} ${run.spec.name} · ${run.currentPhase} · ${run.agents.length} agents` }], details: { runId: run.id, status: run.status } });
			},
			notify,
			requestPermission: (request) => requestPermission(run, request),
			requestApproval: async (title, detail) => {
				if (!ctx.hasUI) return false;
				const shown = detail.length > 12_000 ? `${detail.slice(0, 12_000)}\n…` : detail;
				const choice = await ctx.ui.select(`${title}\n\n${shown}`, ["Approve and continue", "Reject and stop"]);
				return choice === "Approve and continue";
			},
		}, { sessionThinking: pi.getThinkingLevel() as ThinkingLevel });
		controllers.set(run.id, runtime.controller);
		changed(run, "created");
		const initialArtifactTimer = artifactTimers.get(run.id);
		if (initialArtifactTimer) clearTimeout(initialArtifactTimer);
		artifactTimers.delete(run.id);
		await writeArtifactNow(run);
		const background = spec.background ?? true;
		const promise = runtime.execute().then(async () => {
			await writeArtifactNow(run);
			await persistNow(run);
			const level = run.status === "failed" ? "error" : run.status === "completed_with_flags" || run.status === "budget_exhausted" ? "warning" : "info";
			notify(`Workflow ${run.status.replaceAll("_", " ")}: ${run.spec.name} · ${summary(run)}`, level);
			if (background) {
				const handoff = run.artifactPath ? `\n\nRead the complete workflow JSON before reporting; it is the source of truth and remains available throughout execution:\n${run.artifactPath}` : "";
				pi.sendMessage({
					customType: "piplusplus-workflow-result",
					content: `Workflow ${run.id} (${run.spec.name}) ${run.status}.\n${workflowPolicyContext(run.spec.modelPolicy)}\n\n${run.result ?? run.error ?? "No result"}\n\n${summary(run)}${run.flags.length ? `\nFlags:\n- ${run.flags.join("\n- ")}` : ""}${handoff}`,
					display: true,
					details: { runId: run.id, status: run.status, artifactPath: run.artifactPath },
				}, { triggerTurn: true, deliverAs: "followUp" });
			}
		});
		if (background) {
			void promise;
			return { content: [{ type: "text" as const, text: `Started JavaScript workflow ${run.id}: ${run.spec.name}.\n${workflowPolicyContext(run.spec.modelPolicy)}\nUse /workflows for live UI or read the continuously updated workflow JSON at any time:\n${run.artifactPath}` }], details: { runId: run.id, status: run.status, artifactPath: run.artifactPath } };
		}
		const abort = () => runtime.controller.stop();
		signal?.addEventListener("abort", abort, { once: true });
		await promise;
		signal?.removeEventListener("abort", abort);
		const handoff = run.artifactPath ? `\n\nRead the complete workflow JSON before reporting:\n${run.artifactPath}` : "";
		return { content: [{ type: "text" as const, text: `${run.result ?? run.error ?? "No result"}\n\n${run.status} · ${summary(run)}\n${workflowPolicyContext(run.spec.modelPolicy)}${handoff}` }], details: { runId: run.id, status: run.status, artifactPath: run.artifactPath, run } };
	};

	const refreshSavedWorkflowCommands = async (ctx: ExtensionContext): Promise<void> => {
		const loaded = await loadSavedWorkflows(ctx.cwd, getAgentDir());
		savedWorkflows.clear();
		for (const [name, workflow] of loaded.workflows) savedWorkflows.set(name, workflow);
		for (const error of loaded.errors) notify(`Saved workflow skipped: ${error}`, "warning");
		const occupied = new Set(pi.getCommands().map((command) => command.name));
		for (const workflow of savedWorkflows.values()) {
			const name = workflow.meta.name;
			if (occupied.has(name) && !registeredSavedCommands.has(name)) {
				notify(`Saved workflow /${name} was not registered because that command name is already in use.`, "warning");
				continue;
			}
			pi.registerCommand(name, {
				description: `${workflow.meta.description} [saved ${workflow.scope} workflow; args: JSON]`,
				handler: async (rawArgs, commandContext) => {
					const current = savedWorkflows.get(name);
					if (!current) { commandContext.ui.notify(`Saved workflow /${name} is no longer available.`, "error"); return; }
					let args: unknown;
					try { args = parseSavedWorkflowArgs(rawArgs); }
					catch (error) { commandContext.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
					const prompt = args && typeof args === "object" && !Array.isArray(args) && typeof (args as Record<string, unknown>).prompt === "string"
						? String((args as Record<string, unknown>).prompt)
						: `Run saved workflow /${name} with args:\n${JSON.stringify(args, null, 2)}`;
					const spec: WorkflowSpec = {
						name: current.meta.name,
						why: `The user invoked saved ${current.scope} workflow /${name}.`,
						goal: current.meta.description,
						prompt,
						args,
						script: current.script,
						background: true,
						modelPolicy: { defaultRouting: "inherit", rationale: "Saved workflows use Claude-compatible session-model inheritance unless their script routes an agent explicitly." },
					};
					const approved = await approve(applyWorkflowSettings(spec, workflowSettings), commandContext);
					if (!approved) { commandContext.ui.notify(`Saved workflow /${name} canceled.`, "info"); return; }
					const result = await launchApprovedWorkflow(approved, commandContext);
					commandContext.ui.notify(result.content[0]?.text ?? `Started /${name}.`, "info");
				},
			});
			registeredSavedCommands.add(name);
		}
	};

	pi.registerTool({
		name: "workflow_models",
		label: "Workflow Models",
		description: "Return authenticated workflow models from OpenCode Go, Anthropic, OpenAI, and ModelHub with provider group, family, capability, context, output, and price metadata. Use before assigning workflow subagents when model choice matters.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			await ctx.modelRegistry.refresh();
			const models = serializeModels(filterSupportedWorkflowModels(ctx.modelRegistry.getAvailable() as Model[]));
			return { content: [{ type: "text", text: modelCatalogText(models) || "No authenticated models available" }], details: { models } };
		},
		renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("workflow models")), 0, 0); },
		renderResult(result, { expanded }, theme) {
			const models = (result.details as { models?: ReturnType<typeof serializeModels> } | undefined)?.models ?? [];
			const shown = expanded ? models : models.slice(0, 8);
			let text = theme.fg("success", `${models.length} authenticated models`);
			for (const model of shown) text += `\n${theme.fg("accent", `${model.provider}/${model.id}`)} ${theme.fg("dim", `${model.reasoning ? "reasoning" : "fast"} · ctx ${formatTokens(model.contextWindow)} · $${model.inputCost}/$${model.outputCost}`)}`;
			if (!expanded && models.length > shown.length) text += `\n${theme.fg("dim", `… ${models.length - shown.length} more`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "workflow_run",
		label: "Dynamic Workflow",
		description: "Compile and run a deterministic JavaScript orchestration script in the background. The script can create up to 1000 isolated subagents with manual, conservative auto, or read-only tool permissions, and manage up to 16 concurrently. Intermediate results stay in script variables; only the returned value is delivered to the main conversation.",
		promptSnippet: "Run JavaScript-orchestrated background workflows with many independently prompted and model-routed subagents",
		promptGuidelines: [
			"Recipes (diagnose, design, review, implement) are optional conveniences, not mandatory templates. Freely write a custom JavaScript workflow whenever it better matches the task, routing, or model strategy.",
			"Use workflow_run only when fan-out, context isolation, loops, branching, or independent verification materially improves the task.",
			"Interpret the user's model preferences semantically in whatever language they used and encode the decision in modelPolicy. Never infer policy from fixed keywords. Explicit user constraints are binding runtime allowlists. Workflows support provider groups opencode-go, anthropic, openai, and modelhub; use allowedProviders for the source and allowedFamilies for the underlying model vendor, intersecting them when both matter.",
			"Claude-compatible routing is the default: use modelPolicy.defaultRouting='inherit' and omit agent.model so workers inherit the current session model. Use agent.model for deliberate per-stage routing. Use 'auto' only when you intentionally delegate selection to Pi++'s capability/cost router.",
			"Call workflow_models before choosing exact worker models or restricting a workflow to a family different from the session model. Under an allowlist, route exact eligible models or deliberately set defaultRouting='auto'; an ineligible inherited model fails closed.",
			`Reusable profiles: ${PROFILE_NAMES.join(", ")}. Prefer profiles over ad-hoc role prose; their structured JSON contracts are validated and invalid output is retried.`,
			"For ad-hoc structured workers, pass a JSON Schema as agent(..., { schema }). The runtime returns the parsed JSON value directly to JavaScript, validates nested values and additional properties, and retries invalid worker output. Without schema, agent() returns text.",
			"Declare size as small (<5 agents), medium (<15), large (<50), or unrestricted. User-owned budget settings override budgets emitted here. Aggregate maxAgents/maxTokens/maxCost values stop new workers after exhaustion; already-running workers may finish and overrun token/cost thresholds. Use lower concurrency when a tighter aggregate bound is required. Runs above 25 scheduled agents or 1.5M projected output tokens warn explicitly.",
			"Worker maxTurns is controlled by the user's persistent off/custom/model policy: off is the unlimited default and ignores script values, custom applies one user limit to every worker, and only model mode accepts agent(..., { maxTurns }). A limited worker that requests another tool after reaching its limit is terminated once and is not retried. Agent options accept thinking or the Claude Workflow-compatible effort alias; omitted effort inherits the live session level and is clamped to the resolved model. Agent options also accept a per-agent phase override.",
			"Every custom workflow_run script must give each subagent a task-specific prompt through agent(prompt, options). Do not use one generic shared worker prompt.",
			"Use phase(name) for visible stages, parallel([() => agent(...), ...]) for fan-out, pipeline(items, stage...) for maps, ordinary JavaScript loops/branches for loop-until-done and classify-and-act, and a final agent critic/synthesizer before return when correctness matters.",
			"Workflow workers inherit the global Pi++ permission service. Never treat workflow approval as permission to bypass global tool policy; if the permission extension is unavailable, workers fail closed to read-only behavior.",
			"Avoid parallel agents editing overlapping files unless the workflow provides explicit isolation and merge handling.",
		],
		parameters: WorkflowSchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			const requested = params as Partial<WorkflowSpec>;
			let spec: WorkflowSpec;
			if (requested.recipe) {
				const recipe = compileWorkflowRecipe(requested.recipe);
				spec = { ...requested, recipe: recipe.name, script: recipe.script, background: requested.background ?? recipe.background } as WorkflowSpec;
			} else {
				if (!requested.script?.trim()) throw new Error("workflow_run requires either recipe or script");
				spec = requested as WorkflowSpec;
			}
			// Compatibility for callers saved before the structured policy existed.
			spec.modelPolicy ??= {
				defaultRouting: "inherit",
				rationale: "No explicit model policy was supplied; use Claude-compatible session-model inheritance.",
			};
			spec = applyWorkflowSettings(spec, workflowSettings);
			const compileError = validateWorkflowScript(spec.script);
			if (compileError) throw new Error(`Invalid workflow JavaScript: ${compileError}`);
			const approved = await approve(spec, ctx);
			if (!approved) return { content: [{ type: "text", text: "Workflow canceled" }], details: { canceled: true } };
			return launchApprovedWorkflow(approved, ctx, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = `${theme.fg("toolTitle", theme.bold("workflow "))}${theme.fg("accent", args.name ?? "…")}`;
			if (args.why) text += `\n${theme.fg("muted", "why: ")}${args.why}`;
			text += `\n${theme.fg("dim", `${String(args.script ?? "").split("\n").length} lines JavaScript · concurrency ${args.concurrency ?? 4}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { runId?: string; canceled?: boolean } | undefined;
			if (details?.canceled) return new Text(theme.fg("warning", "Workflow canceled"), 0, 0);
			const run = details?.runId ? runs.get(details.runId) : undefined;
			if (!run) return new Text("Workflow", 0, 0);
			let text = `${theme.fg(run.status === "failed" ? "error" : run.status === "completed_with_flags" || run.status === "budget_exhausted" ? "warning" : run.status === "completed" ? "success" : "accent", icon(run.status))} ${theme.bold(run.spec.name)} ${theme.fg("dim", `· ${run.id} · ${summary(run)}`)}`;
			if (expanded) for (const agent of run.agents) text += `\n  ${icon(agent.status)} ${agent.label} ${theme.fg("dim", `· ${agent.resolvedModel ?? agent.requestedModel ?? "auto"}`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerMessageRenderer("piplusplus-workflow-result", (message, _options, theme) => new Text(
		theme.fg(message.content.includes(" failed") ? "error" : message.content.includes("completed_with_flags") || message.content.includes("budget_exhausted") ? "warning" : "success", message.content), 0, 0,
	));

	pi.registerCommand("workflows", {
		description: "Browse workflows, phases, subagent prompts, tools, models, errors, and results",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const [action, id, agentId] = parts;
			if (action === "triggers") {
				if (id !== "on" && id !== "off" && id !== "status") {
					ctx.ui.notify("Usage: /workflows triggers on|off|status", "warning");
					return;
				}
				if (id !== "status") {
					workflowSettings = { ...workflowSettings, triggersEnabled: id === "on" };
					if (!workflowSettings.triggersEnabled) pendingUltracodeTriggers.length = 0;
					try { await saveWorkflowSettings(getAgentDir(), workflowSettings); }
					catch (error) { ctx.ui.notify(`Could not save workflow trigger setting: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
				}
				ctx.ui.notify(`Literal interactive workflow triggers are ${workflowSettings.triggersEnabled ? "enabled" : "disabled"}. Direct workflow_run, saved commands, and /workflows inspection remain available.`, "info");
				return;
			}
			if (action === "ultracode-effort") {
				if (id !== "one-prompt" && id !== "session" && id !== "status") {
					ctx.ui.notify("Usage: /workflows ultracode-effort one-prompt|session|status", "warning");
					return;
				}
				if (id !== "status") {
					workflowSettings = { ...workflowSettings, ultracodeEffortMode: id };
					try { await saveWorkflowSettings(getAgentDir(), workflowSettings); }
					catch (error) { ctx.ui.notify(`Could not save ultracode effort setting: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
				}
				ctx.ui.notify(`Ultracode effort mode: ${workflowSettings.ultracodeEffortMode}.`, "info");
				return;
			}
			if (action === "budget") {
				let mode = id as WorkflowBudgetMode | "status" | "unlimited" | undefined;
				if (!mode) {
					const selected = await ctx.ui.select(`Workflow aggregate budgets: ${describeWorkflowBudgetSettings(workflowSettings)}`, [
						"Off - no aggregate budget (Claude-compatible)",
						"Custom - user-owned limits",
						"Model - orchestrator chooses per run",
						"Cancel",
					]);
					if (!selected || selected === "Cancel") return;
					mode = selected.startsWith("Off") ? "off" : selected.startsWith("Custom") ? "custom" : "model";
				}
				if (mode === "status") {
					ctx.ui.notify(`Workflow aggregate budgets: ${describeWorkflowBudgetSettings(workflowSettings)}.`, "info");
					return;
				}
				if (mode === "unlimited") mode = "off";
				if (mode !== "off" && mode !== "model" && mode !== "custom") {
					ctx.ui.notify('Usage: /workflows budget off|model|custom [maxTokens or JSON]|status', "warning");
					return;
				}
				let customBudgets = workflowSettings.customBudgets;
				if (mode === "custom") {
					const raw = parts.slice(2).join(" ").trim();
					try {
						if (raw) {
							customBudgets = normalizeCustomBudgets(/^\d+$/.test(raw) ? { maxTokens: Number(raw) } : JSON.parse(raw));
						} else {
							const maxTokens = await ctx.ui.input("Workflow token scheduling threshold", "e.g. 200000; empty = no token threshold");
							if (maxTokens === undefined) return;
							const maxAgents = await ctx.ui.input("Maximum agents", "e.g. 3; empty = runtime ceiling");
							if (maxAgents === undefined) return;
							const maxCost = await ctx.ui.input("Cost scheduling threshold (USD)", "e.g. 5; empty = no cost threshold");
							if (maxCost === undefined) return;
							customBudgets = normalizeCustomBudgets({
								...(maxTokens.trim() ? { maxTokens: Number(maxTokens) } : {}),
								...(maxAgents.trim() ? { maxAgents: Number(maxAgents) } : {}),
								...(maxCost.trim() ? { maxCost: Number(maxCost) } : {}),
							});
						}
						if (!customBudgets) throw new Error("At least one custom limit is required; use budget off for no aggregate limits.");
					} catch (error) {
						ctx.ui.notify(`Invalid workflow budget: ${error instanceof Error ? error.message : String(error)}`, "error");
						return;
					}
				}
				workflowSettings = {
					...workflowSettings,
					budgetMode: mode,
					...(mode === "custom" ? { customBudgets } : {}),
				};
				try { await saveWorkflowSettings(getAgentDir(), workflowSettings); }
				catch (error) { ctx.ui.notify(`Could not save workflow budget setting: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
				ctx.ui.notify(`Workflow aggregate budgets: ${describeWorkflowBudgetSettings(workflowSettings)}. Already-running parallel workers can overrun token/cost scheduling thresholds.`, "info");
				return;
			}
			if (action === "max-turns" || action === "maxturns") {
				let mode = id as WorkflowMaxTurnsMode | "status" | "unlimited" | undefined;
				if (!mode) {
					const selected = await ctx.ui.select(`Workflow worker maxTurns: ${describeWorkflowMaxTurnsSettings(workflowSettings)}`, [
						"Off - unlimited worker turns (default)",
						"Custom - same user-owned limit for every worker",
						"Model - orchestrator chooses per worker",
						"Cancel",
					]);
					if (!selected || selected === "Cancel") return;
					mode = selected.startsWith("Off") ? "off" : selected.startsWith("Custom") ? "custom" : "model";
				}
				if (mode === "status") {
					ctx.ui.notify(`Workflow worker maxTurns: ${describeWorkflowMaxTurnsSettings(workflowSettings)}.`, "info");
					return;
				}
				if (mode === "unlimited") mode = "off";
				if (mode !== "off" && mode !== "model" && mode !== "custom") {
					ctx.ui.notify("Usage: /workflows max-turns off|model|custom <1-1000>|status", "warning");
					return;
				}
				let customMaxTurns = workflowSettings.customMaxTurns;
				if (mode === "custom") {
					const raw = parts.slice(2).join(" ").trim();
					const entered = raw || await ctx.ui.input("Maximum turns per workflow worker", "1-1000");
					if (entered === undefined) return;
					try { customMaxTurns = normalizeCustomMaxTurns(entered); }
					catch (error) {
						ctx.ui.notify(`Invalid workflow maxTurns: ${error instanceof Error ? error.message : String(error)}`, "error");
						return;
					}
				}
				workflowSettings = {
					...workflowSettings,
					maxTurnsMode: mode,
					...(mode === "custom" ? { customMaxTurns } : {}),
				};
				try { await saveWorkflowSettings(getAgentDir(), workflowSettings); }
				catch (error) { ctx.ui.notify(`Could not save workflow maxTurns setting: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
				ctx.ui.notify(`Workflow worker maxTurns: ${describeWorkflowMaxTurnsSettings(workflowSettings)}.`, "info");
				return;
			}
			if (action === "stop" && id) { controllers.get(id)?.stop(); return; }
			if (action === "hard-stop" && id) { controllers.get(id)?.hardStop(); return; }
			if (action === "resume" && id) { await resumeWorkflow(id); return; }
			if (action === "restart" && id && agentId) {
				const run = runs.get(id);
				if (!run) { ctx.ui.notify(`Unknown workflow: ${id}`, "error"); return; }
				if (["queued", "running", "paused"].includes(run.status)) controllers.get(id)?.restartAgent(agentId);
				else await resumeWorkflow(id, agentId);
				return;
			}
			if (action === "status" && id) {
				const run = runs.get(id);
				ctx.ui.notify(
					run ? `${icon(run.status)} ${run.spec.name} · ${run.status} · ${summary(run)}` : `Unknown workflow: ${id}`,
					run?.status === "failed" ? "error" : run?.status === "budget_exhausted" || run?.status === "completed_with_flags" ? "warning" : "info",
				);
				return;
			}
			await openWorkflowDock(ctx);
		},
	});

	pi.on("input", (event) => {
		// Slash commands are handled without an agent turn and must not leave a
		// stale origin decision for the next prompt.
		if (/^\s*\//.test(event.text)) return { action: "continue" as const };
		pendingUltracodeTriggers.push(isInteractiveUltracodeTrigger(event.source, event.text, workflowSettings.triggersEnabled));
		if (pendingUltracodeTriggers.length > 100) pendingUltracodeTriggers.splice(0, pendingUltracodeTriggers.length - 100);
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", (event, ctx) => {
		const models = serializeModels(filterSupportedWorkflowModels(ctx.modelRegistry.getAvailable() as Model[]));
		const ultracodeTriggered = pendingUltracodeTriggers.shift() === true
			&& /(?<![\p{L}\p{N}_])ultracode(?![\p{L}\p{N}_])/iu.test(event.prompt);
		if (ultracodeTriggered && workflowSettings.ultracodeEffortMode === "one-prompt" && restoreThinking === undefined) {
			restoreThinking = pi.getThinkingLevel() as ThinkingLevel;
			pi.setThinkingLevel("xhigh");
		} else if (ultracodeTriggered && workflowSettings.ultracodeEffortMode === "session") {
			restoreThinking = undefined;
			pi.setThinkingLevel("xhigh");
		}
		const instructions = buildWorkflowSystemInstructions({
			models,
			ultracodeTriggered,
			ultracodeEffortMode: workflowSettings.ultracodeEffortMode,
			budgetPolicy: describeWorkflowBudgetSettings(workflowSettings),
			maxTurnsPolicy: describeWorkflowMaxTurnsSettings(workflowSettings),
		});
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
	});

	pi.on("agent_settled", () => {
		if (restoreThinking !== undefined) {
			pi.setThinkingLevel(restoreThinking);
			restoreThinking = undefined;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		ctxNow = ctx;
		restoreThinking = undefined;
		pendingUltracodeTriggers.length = 0;
		try { workflowSettings = await loadWorkflowSettings(getAgentDir()); }
		catch (error) {
			workflowSettings = { ...DEFAULT_WORKFLOW_SETTINGS };
			notify(`Could not load workflow settings; defaults are active: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		try {
			const cutoff = Date.now() - retentionDays * 86_400_000;
			for (const directory of [stateDir, artifactDir]) {
				await fs.promises.mkdir(directory, { recursive: true });
				for (const file of await fs.promises.readdir(directory)) {
					if (!file.endsWith(".json")) continue;
					try { const stat = await fs.promises.stat(path.join(directory, file)); if (stat.mtimeMs < cutoff) await fs.promises.unlink(path.join(directory, file)); } catch {}
				}
			}
			for (const file of await fs.promises.readdir(stateDir)) {
				if (!file.endsWith(".json")) continue;
				try {
					const run = migrateWorkflowRun(JSON.parse(await fs.promises.readFile(path.join(stateDir, file), "utf8")));
					if (run.sessionId !== ctx.sessionManager.getSessionId()) continue;
					if (["queued", "running", "paused"].includes(run.status)) {
						run.status = "stopped";
						run.finishedAt = Date.now();
						run.error = "Interrupted by session restart or reload; this same-session run can be resumed.";
					}
					run.logs ??= [];
					for (const agent of run.agents) {
						if (agent.status === "queued" || agent.status === "running") agent.status = "stopped";
						agent.logs ??= [];
						agent.messages ??= [];
						agent.events ??= [];
						agent.scanFindings ??= [];
					}
					runs.set(run.id, run);
				} catch { /* ignore malformed old state */ }
			}
		} catch { /* best effort */ }
		await refreshSavedWorkflowCommands(ctx);
		for (const run of runs.values()) scheduleArtifact(run, true);
		refreshUi();
	});

	pi.on("session_shutdown", async () => {
		for (const controller of controllers.values()) controller.stop();
		for (const timer of persistTimers.values()) clearTimeout(timer);
		for (const timer of artifactTimers.values()) clearTimeout(timer);
		persistTimers.clear();
		artifactTimers.clear();
		await Promise.all([...runs.values()].map(async (run) => { await Promise.all([persistNow(run), writeArtifactNow(run)]); }));
		ctxNow = undefined;
		removeWorkflowDockService(dockService);
	});
}
