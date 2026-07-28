import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, type Terminal } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeWorkflowArtifact } from "./artifact.ts";
import { getPermissionService } from "../shared/permission-service.ts";
import { installWorkflowDockService, removeWorkflowDockService, type WorkflowDockService } from "../shared/workflow-dock-service.ts";
import { inferModelFamilyInstruction, modelCatalogText, serializeModels } from "./models.ts";
import { explainPermission, isPathWithinWriteScope } from "./permissions.ts";
import { PROFILE_NAMES } from "./profiles.ts";
import { compileWorkflowRecipe, WORKFLOW_RECIPE_NAMES } from "./recipes.ts";
import { createWorkflowController, validateWorkflowScript } from "./runtime.ts";
import { Surface } from "../../ui/primitives/surface.ts";
import { WorkflowBrowser } from "./tui.ts";
import { aggregateUsage, type AgentState, type PermissionRequest, type ThinkingLevel, type WorkflowController, type WorkflowRun, type WorkflowSpec, zeroUsage } from "./types.ts";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";
const WIDGET_ID = "piplusplus-workflows";
const MAX_RUN_LOG_EVENTS = 100_000;
const retentionDays = Math.max(1, Math.min(365, Number.parseInt(process.env.PIPLUSPLUS_WORKFLOW_RETENTION_DAYS ?? "30", 10) || 30));

const WorkflowSchema = Type.Object({
	name: Type.String({ description: "Short workflow name" }),
	why: Type.String({ description: "Why code-mode orchestration is better than one main-agent context for this task" }),
	goal: Type.String({ description: "Concrete definition of done" }),
	prompt: Type.String({ description: "The original task or workflow-level objective. Individual agent() calls still receive their own distinct prompts." }),
	script: Type.Optional(Type.String({ description: "Deterministic JavaScript body using agent(), parallel(), pipeline(), phase(), approve(), models(), workflowPrompt, and return. Omit when using recipe." })),
	recipe: Type.Optional(StringEnum(WORKFLOW_RECIPE_NAMES)),
	modelFamily: Type.Optional(StringEnum(["gpt", "openai", "claude"] as const)),
	userModelInstruction: Type.Optional(Type.String({ description: "Verbatim model preference stated by the user, if any" })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
	background: Type.Optional(Type.Boolean({ description: "Run without blocking the conversation; default true" })),
	approval: Type.Optional(StringEnum(["prompt", "skip"] as const)),
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
	return ({ queued: "○", running: "⏳", paused: "Ⅱ", completed: "✓", completed_with_flags: "⚑", failed: "✗", stopped: "■" } as Record<string, string>)[status] ?? "·";
}

export default function workflowsExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_ENV] === "1") return;

	const runs = new Map<string, WorkflowRun>();
	const controllers = new Map<string, WorkflowController>();
	const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const artifactTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const artifactQueues = new Map<string, Promise<void>>();
	const stateDir = path.join(getAgentDir(), "workflows", "runs");
	const artifactDir = path.join(getAgentDir(), "workflows", "artifacts");
	let ctxNow: ExtensionContext | undefined;
	let restoreThinking: ThinkingLevel | undefined;
	let pendingUltracodeTriggers = 0;
	let counter = 0;

	const orderedRuns = () => [...runs.values()].sort((a, b) => b.createdAt - a.createdAt);

	const openWorkflowDock = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") { ctx.ui.notify(orderedRuns().map((run) => `${run.id} ${run.status} ${run.spec.name}`).join("\n") || "No workflows", "info"); return; }
		let mouseTerminal: Terminal | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				mouseTerminal = tui.terminal;
				mouseTerminal.write("\x1b[?1000h\x1b[?1006h");
				let timer: ReturnType<typeof setInterval>;
				const close = () => { clearInterval(timer); done(); };
				const height = Math.max(9, Math.floor(tui.terminal.rows * 0.45) - 2);
				const browser = new WorkflowBrowser(orderedRuns, controllers, theme, close, height);
				const panel = new Surface({ theme, body: browser, border: "frame", borderTone: "accent", padding: { top: 0, right: 1, bottom: 0, left: 1 }, background: "panel" });
				timer = setInterval(() => tui.requestRender(), 250);
				return { render: (width) => panel.render(width), invalidate: () => panel.invalidate(), handleInput: (data) => { browser.handleInput(data); tui.requestRender(); } };
			}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "48%", anchor: "bottom-center", margin: { top: 0, right: 0, bottom: 0, left: 0 } } });
		} finally { mouseTerminal?.write("\x1b[?1006l\x1b[?1000l"); }
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
		const terminal = ["completed", "completed_with_flags", "failed", "stopped"].includes(run.status);
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
		const decision = explainPermission(request, run.cwd, mode);
		const agent = run.agents.find((candidate) => candidate.id === request.agentId);
		if (agent?.writePaths && (request.toolName === "write" || request.toolName === "edit") && !isPathWithinWriteScope(run.cwd, request.input.path, agent.writePaths)) {
			agent.logs.push({ at: Date.now(), type: "permission_denied", tool: request.toolName, message: `Target is outside declared write scope: ${agent.writePaths.join(", ")}` });
			return false;
		}
		agent?.logs.push({ at: Date.now(), type: "permission_request", tool: request.toolName, message: `${mode}/${decision.risk}: ${decision.explanation}` });
		const concurrentMutation = (request.toolName === "write" || request.toolName === "edit") && run.agents.filter((candidate) => candidate.status === "running").length > 1;
		const allow = service ? await service.authorize(request, ctxNow, concurrentMutation ? { forcePrompt: true, reason: "Multiple workflow agents are active; concurrent writes can conflict." } : undefined) : decision.allow;
		agent?.logs.push({ at: Date.now(), type: allow ? "permission_allowed" : "permission_denied", tool: request.toolName, message: service ? `global ${mode} policy` : "global permission extension unavailable; read-only fallback" });
		return allow;
	}

	async function approve(spec: WorkflowSpec, ctx: ExtensionContext): Promise<WorkflowSpec | undefined> {
		if (spec.approval === "skip" || !ctx.hasUI) return spec;
		while (true) {
			const choice = await ctx.ui.select(`Workflow: ${spec.name}`, [
				`Run — ${spec.why}`,
				"View/edit JavaScript",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return undefined;
			if (choice.startsWith("Run")) return spec;
			const edited = await ctx.ui.editor(`JavaScript workflow: ${spec.name}`, spec.script);
			if (edited !== undefined) {
				const error = validateWorkflowScript(edited);
				if (error) ctx.ui.notify(`Invalid workflow script: ${error}`, "error");
				else spec = { ...spec, script: edited };
			}
		}
	}

	pi.registerTool({
		name: "workflow_models",
		label: "Workflow Models",
		description: "Return the current authenticated Pi model catalog with capability, context, output, and price metadata. Use before assigning workflow subagents when model choice matters.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			await ctx.modelRegistry.refresh();
			const models = serializeModels(ctx.modelRegistry.getAvailable());
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
			"Call workflow_models before workflow_run when selecting worker models. Explicit user model choices are binding; otherwise choose models at your own discretion from the returned authenticated catalog.",
			`Reusable profiles: ${PROFILE_NAMES.join(", ")}. Prefer profiles over ad-hoc role prose; their structured JSON contracts are validated and invalid output is retried.`,
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
			spec.modelFamily ??= inferModelFamilyInstruction(spec.userModelInstruction, spec.prompt, spec.goal);
			const compileError = validateWorkflowScript(spec.script);
			if (compileError) throw new Error(`Invalid workflow JavaScript: ${compileError}`);
			const approved = await approve(spec, ctx);
			if (!approved) return { content: [{ type: "text", text: "Workflow canceled" }], details: { canceled: true } };
			spec = approved;
			await ctx.modelRegistry.refresh();
			const models = ctx.modelRegistry.getAvailable() as Model[];
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
			});
			controllers.set(run.id, runtime.controller);
			changed(run, "created");
			const initialArtifactTimer = artifactTimers.get(run.id);
			if (initialArtifactTimer) clearTimeout(initialArtifactTimer);
			artifactTimers.delete(run.id);
			await writeArtifactNow(run);
			const background = spec.background ?? true;
			const promise = runtime.execute().then(async () => {
				controllers.delete(run.id);
				await writeArtifactNow(run);
				await persistNow(run);
				const level = run.status === "failed" ? "error" : run.status === "completed_with_flags" ? "warning" : "info";
				notify(`Workflow ${run.status.replaceAll("_", " ")}: ${run.spec.name} · ${summary(run)}`, level);
				if (background) {
					const handoff = run.artifactPath ? `\n\nRead the complete workflow JSON before reporting; it is the source of truth and remains available throughout execution:\n${run.artifactPath}` : "";
					pi.sendMessage({
						customType: "piplusplus-workflow-result",
						content: `Workflow ${run.id} (${run.spec.name}) ${run.status}.\n\n${run.result ?? run.error ?? "No result"}\n\n${summary(run)}${run.flags.length ? `\nFlags:\n- ${run.flags.join("\n- ")}` : ""}${handoff}`,
						display: true,
						details: { runId: run.id, status: run.status, artifactPath: run.artifactPath },
					}, { triggerTurn: true, deliverAs: "followUp" });
				}
			});
			if (background) {
				void promise;
				return { content: [{ type: "text", text: `Started JavaScript workflow ${run.id}: ${run.spec.name}. Use /workflows for live UI or read the continuously updated workflow JSON at any time:\n${run.artifactPath}` }], details: { runId: run.id, status: run.status, artifactPath: run.artifactPath } };
			}
			const abort = () => runtime.controller.stop();
			signal?.addEventListener("abort", abort, { once: true });
			await promise;
			signal?.removeEventListener("abort", abort);
			const handoff = run.artifactPath ? `\n\nRead the complete workflow JSON before reporting:\n${run.artifactPath}` : "";
			return { content: [{ type: "text", text: `${run.result ?? run.error ?? "No result"}\n\n${run.status} · ${summary(run)}${handoff}` }], details: { runId: run.id, status: run.status, artifactPath: run.artifactPath, run } };
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
			let text = `${theme.fg(run.status === "failed" ? "error" : run.status === "completed_with_flags" ? "warning" : run.status === "completed" ? "success" : "accent", icon(run.status))} ${theme.bold(run.spec.name)} ${theme.fg("dim", `· ${run.id} · ${summary(run)}`)}`;
			if (expanded) for (const agent of run.agents) text += `\n  ${icon(agent.status)} ${agent.label} ${theme.fg("dim", `· ${agent.resolvedModel ?? agent.requestedModel ?? "auto"}`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerMessageRenderer("piplusplus-workflow-result", (message, _options, theme) => new Text(
		theme.fg(message.content.includes(" failed") ? "error" : message.content.includes("completed_with_flags") ? "warning" : "success", message.content), 0, 0,
	));

	pi.registerCommand("workflows", {
		description: "Browse workflows, phases, subagent prompts, tools, models, errors, and results",
		handler: async (args, ctx) => {
			const [action, id] = args.trim().split(/\s+/, 2);
			if (action === "stop" && id) { controllers.get(id)?.stop(); return; }
			if (action === "status" && id) {
				const run = runs.get(id);
				ctx.ui.notify(run ? `${icon(run.status)} ${run.spec.name} · ${run.status} · ${summary(run)}` : `Unknown workflow: ${id}`, run?.status === "failed" ? "error" : "info");
				return;
			}
			await openWorkflowDock(ctx);
		},
	});

	pi.on("input", (event) => {
		if (event.source !== "extension" && /(?<![\p{L}\p{N}_])ultracode(?![\p{L}\p{N}_])/iu.test(event.text)) {
			pendingUltracodeTriggers++;
		}
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await ctx.modelRegistry.refresh();
		const catalog = modelCatalogText(serializeModels(ctx.modelRegistry.getAvailable()));
		const ultracodeTriggered = pendingUltracodeTriggers > 0 && /(?<![\p{L}\p{N}_])ultracode(?![\p{L}\p{N}_])/iu.test(event.prompt);
		if (ultracodeTriggered) pendingUltracodeTriggers--;
		if (ultracodeTriggered && restoreThinking === undefined) {
			restoreThinking = pi.getThinkingLevel() as ThinkingLevel;
			pi.setThinkingLevel("xhigh");
		}
		const instructions = [
			"# Dynamic JavaScript workflows",
			"workflow_run runs either an optional named recipe or a fully custom JavaScript orchestration body outside the main context. Each agent(prompt, options) starts an isolated Pi subagent with a distinct assignment. You are free to write the entire script, choose every model independently, mix profiles with ad-hoc prompts, or omit profiles; recipes and profiles are never compulsory.",
			ultracodeTriggered ? "The user's prompt contains the bounded trigger word `ultracode`. This is a one-prompt opt-in: use xhigh-level deliberation and generate a dynamic workflow for this task." : "Use workflows only when explicitly requested or materially useful; avoid them for small linear tasks.",
			"Before model assignment, inspect workflow_models or this authenticated catalog and choose from models actually available. User choices win. If the user requests GPT, OpenAI, Claude, or Anthropic workers, set modelFamily; the runtime enforces that explicit constraint and never falls back across families. Without an explicit family constraint, choose any model per worker and set modelRationale; model:'auto' is only an optional neutral fallback, not a requirement.",
			"Every workflow immediately creates a continuously updated JSON artifact whose path is returned by workflow_run. Use the read tool to inspect it at any time and always read it before reporting; read access is permitted by the global policy even though the artifact is outside the project. It is the source of truth for the script, live status, retries, prompts, outputs, tools, logs, usage, errors, verification, flags, and summary.",
			"Workflow tool permissions are separate from script approval and inherit the global /permissions mode. Manual explains and confirms writes, edits, commands, and unknown custom tools; auto only permits operations proven low-risk; read-only blocks mutations. Confirmation-required operations fail closed without a UI.",
			`Specialist profiles are ${PROFILE_NAMES.join(", ")}. Profiles add evidence-focused instructions and, except synthesizer, runtime-validated JSON status contracts; malformed output retries automatically. Use writePaths on mutating workers to enforce direct write/edit scope.`,
			"Available custom-script primitives: phase(name); await agent(uniquePrompt, {id,label,profile,kind,model,modelRationale,thinking,tools,writePaths}); await approve(title, detail); parallel(...); pipeline(...); models(); workflowPrompt; cwd; platform; return. Use cwd/platform directly, never assume Node globals, filesystem APIs, require, fetch, or environment access. Maximum 16 concurrent and 1000 total agents.",
			"Prompt workers with objective, scope, constraints, required evidence, expected deliverable, and explicit stop/escalation conditions. Do not prescribe commands they can discover from repository configuration. Keep factual investigation separate from planning, implementation, and independent verification. Never ask a synthesizer to invent evidence missing from upstream workers.",
			"For custom correctness-sensitive work, use this shape: evidence collection → independent verification or counter-evidence → synthesis. For mutations: inspect/plan → approve(plan) → scoped implementation → independent code and security review → synthesis. Do not mark a workflow successful merely because tools ran or tests exited zero; require evidence tied to the requested behavior.",
			"Authenticated models:",
			catalog || "(none)",
		].join("\n\n");
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
		pendingUltracodeTriggers = 0;
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
					const run = JSON.parse(await fs.promises.readFile(path.join(stateDir, file), "utf8")) as WorkflowRun;
					if (run.sessionId !== ctx.sessionManager.getSessionId()) continue;
					if (["queued", "running", "paused"].includes(run.status)) { run.status = "stopped"; run.finishedAt = Date.now(); run.error = "Interrupted by session restart or reload"; }
					run.logs ??= [];
					for (const agent of run.agents) { agent.logs ??= []; agent.messages ??= []; agent.events ??= []; }
					runs.set(run.id, run);
				} catch { /* ignore malformed old state */ }
			}
		} catch { /* best effort */ }
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
