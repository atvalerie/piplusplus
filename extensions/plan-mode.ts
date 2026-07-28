import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isSafeInspectionCommand } from "./workflows/permissions.ts";
import { extractPlan, formatPlanSteps, markPlanSteps, type PlanStep } from "./shared/plan-mode.ts";
import { getPermissionService, type GlobalPermissionMode } from "./shared/permission-service.ts";

const STATE_TYPE = "piplusplus-plan-mode";
const STATUS_ID = "piplusplus-plan";
const WIDGET_ID = "piplusplus-plan-steps";
const READ_TOOLS = new Set(["read", "bash", "grep", "find", "ls", "questionnaire", "workflow_models"]);

type Mode = "off" | "planning" | "executing" | "compacting";
interface PersistedState { mode: Mode; plan?: string; steps: PlanStep[]; toolsBefore?: string[]; permissionBefore?: GlobalPermissionMode }

function isAssistant(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}
function assistantText(message: AssistantMessage): string {
	return message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	if (process.env.PIPLUSPLUS_WORKFLOW_CHILD === "1") return;
	let mode: Mode = "off";
	let approvedPlan: string | undefined;
	let steps: PlanStep[] = [];
	let toolsBefore: string[] | undefined;
	let currentContext: ExtensionContext | undefined;
	let permissionBefore: GlobalPermissionMode = "manual";
	let unsubscribePermission: (() => void) | undefined;
	let unregisterPlanMode: (() => void) | undefined;
	let syncingPermission = false;

	const persist = () => pi.appendEntry(STATE_TYPE, { mode, plan: approvedPlan, steps, toolsBefore, permissionBefore } satisfies PersistedState);
	const updateUi = (ctx: ExtensionContext) => {
		const done = steps.filter((step) => step.completed).length;
		const label = mode === "planning" ? "plan:design" : mode === "compacting" ? "plan:compact" : mode === "executing" ? `plan:${done}/${steps.length}` : undefined;
		ctx.ui.setStatus(STATUS_ID, label);
		if (mode === "executing" && steps.length) {
			ctx.ui.setWidget(WIDGET_ID, steps.map((step) => step.completed ? `✓ ${step.text}` : `○ ${step.text}`));
		} else ctx.ui.setWidget(WIDGET_ID, undefined);
	};
	const enterReadOnly = () => {
		toolsBefore ??= pi.getActiveTools();
		pi.setActiveTools([...new Set([...toolsBefore.filter((tool) => READ_TOOLS.has(tool)), ...READ_TOOLS])]);
	};
	const restoreTools = () => {
		if (toolsBefore) pi.setActiveTools(toolsBefore);
		toolsBefore = undefined;
	};
	const setPlanState = (next: Mode, ctx: ExtensionContext) => {
		mode = next;
		if (next === "planning" || next === "compacting") enterReadOnly(); else restoreTools();
		updateUi(ctx); persist();
	};
	const setPermission = async (value: GlobalPermissionMode) => {
		const service = getPermissionService();
		if (!service || service.getMode() === value) return;
		syncingPermission = true;
		try { await service.setMode(value); } finally { syncingPermission = false; }
	};
	const beginPlanning = async (ctx: ExtensionContext, selectedExternally = false) => {
		const service = getPermissionService();
		if (service && service.getMode() !== "plan") permissionBefore = service.getMode();
		approvedPlan = undefined; steps = [];
		setPlanState("planning", ctx);
		if (!selectedExternally) await setPermission("plan");
		ctx.ui.notify("Mode: plan · exploration is read-only", "info");
	};
	const cancel = async (ctx: ExtensionContext) => {
		approvedPlan = undefined; steps = [];
		setPlanState("off", ctx);
		await setPermission(permissionBefore === "plan" ? "manual" : permissionBefore);
		ctx.ui.notify("Plan mode canceled", "info");
	};
	const executePlan = async (ctx: ExtensionContext, permission: "accept-edits" | "auto" | "manual" = "manual") => {
		if (!approvedPlan || !steps.length) { ctx.ui.notify("No approved plan to execute", "warning"); return; }
		await setPermission(permission);
		setPlanState("executing", ctx);
		pi.sendMessage({
			customType: "piplusplus-plan-execute",
			content: `Execute this user-approved plan exactly within the global permission policy. Re-inspect facts when repository state differs; stop and ask before changing scope, contracts, or architecture. Complete steps in order and include [DONE:n] only after step n is actually verified.\n\n${approvedPlan}`,
			display: true,
		}, { triggerTurn: true, deliverAs: "followUp" });
	};
	const compactThenExecute = (ctx: ExtensionContext, permission: "accept-edits" | "auto" | "manual" = "accept-edits") => {
		if (!approvedPlan) return;
		setPlanState("compacting", ctx);
		ctx.ui.notify("Compacting planning context before execution…", "info");
		ctx.compact({
			customInstructions: "Preserve the user's goal, constraints, approved planning decisions, relevant repository facts, files inspected, unresolved risks, and permission requirements. Execution will receive the exact approved plan again after compaction.",
			onComplete: () => { ctx.ui.notify("Planning context compacted", "info"); void executePlan(ctx, permission); },
			onError: (error) => { ctx.ui.notify(`Compaction unavailable (${error.message}); executing with current context`, "warning"); void executePlan(ctx, permission); },
		});
	};
	const showStatus = (ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const context = usage?.tokens !== null && usage?.tokens !== undefined && usage.percent !== null ? `\nContext: ${usage.tokens.toLocaleString()} tokens (${Math.round(usage.percent)}%)` : "";
		ctx.ui.notify(`Plan mode: ${mode}${steps.length ? `\n${formatPlanSteps(steps)}` : ""}${context}`, "info");
	};

	pi.registerFlag("plan-mode", { description: "Start in Pi++ plan mode", type: "boolean", default: false });
	pi.registerCommand("plan", {
		description: "Plan first, optionally compact context, then execute: /plan [TASK|status|execute|compact|cancel]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action || action === "on" || action === "start") { await beginPlanning(ctx); return; }
			if (action === "status") { showStatus(ctx); return; }
			if (action === "execute" || action === "run") { await executePlan(ctx, "manual"); return; }
			if (action === "compact") { compactThenExecute(ctx, "accept-edits"); return; }
			if (action === "cancel" || action === "off") { await cancel(ctx); return; }
			if (action.startsWith("done ")) {
				const step = steps.find((item) => item.number === Number(action.slice(5)));
				if (!step) { ctx.ui.notify("Unknown plan step", "error"); return; }
				step.completed = true; updateUi(ctx); persist(); return;
			}
			await beginPlanning(ctx);
			pi.sendUserMessage(args.trim(), { deliverAs: "followUp" });
		},
	});
	pi.registerShortcut(Key.ctrlAlt("p"), { description: "Select Pi++ plan permission mode", handler: async (ctx) => beginPlanning(ctx) });

	pi.on("tool_call", async (event) => {
		if (mode !== "planning" && mode !== "compacting") return;
		if (event.toolName === "bash") {
			const command = String((event.input as Record<string, unknown>).command ?? "");
			if (isSafeInspectionCommand(command)) return;
		}
		if (event.toolName !== "bash" && READ_TOOLS.has(event.toolName)) return;
		return { block: true, reason: `Plan mode is read-only; ${event.toolName} is unavailable until the plan is approved.` };
	});
	pi.on("before_agent_start", () => {
		if (mode === "planning") return {
			message: { customType: "piplusplus-plan-context", display: false, content: `[PI++ PLAN MODE · READ ONLY]\nExplore and ask necessary clarifying questions before proposing changes. Do not edit files, execute project code, install dependencies, invoke mutating workflows, or claim unobserved facts. Produce one self-contained plan with this structure:\n\n## Plan\nObjective: ...\nConstraints and assumptions: ...\nScope: concrete files/directories, with explicit exclusions\n1. First independently verifiable step\n2. Next step\n...\nVerification: commands/checks tied to requested behavior\nRisks and unresolved decisions: ...\n\nPrefer the smallest sufficient change. Preserve existing contracts unless evidence and the user require otherwise.` },
		};
		if (mode === "executing" && approvedPlan) return {
			message: { customType: "piplusplus-plan-progress", display: false, content: `[EXECUTING APPROVED PLAN]\nRemaining steps:\n${formatPlanSteps(steps.filter((step) => !step.completed))}\nFollow the approved scope. Mark [DONE:n] only after verification; stop for material plan deviations.` },
		};
	});
	pi.on("context", (event) => {
		if (mode === "planning") return;
		return { messages: event.messages.filter((message) => (message as AgentMessage & { customType?: string }).customType !== "piplusplus-plan-context") };
	});
	pi.on("turn_end", (event, ctx) => {
		if (mode !== "executing" || !isAssistant(event.message)) return;
		if (markPlanSteps(assistantText(event.message), steps)) { updateUi(ctx); persist(); }
	});
	pi.on("agent_end", async (event, ctx) => {
		if (mode === "executing" && steps.length && steps.every((step) => step.completed)) {
			pi.sendMessage({ customType: "piplusplus-plan-complete", content: `Plan complete ✓\n\n${formatPlanSteps(steps)}`, display: true }, { triggerTurn: false });
			mode = "off"; approvedPlan = undefined; steps = []; updateUi(ctx); persist(); return;
		}
		if (mode !== "planning" || !ctx.hasUI) return;
		const latest = [...event.messages].reverse().find(isAssistant);
		const extracted = latest ? extractPlan(assistantText(latest)) : undefined;
		if (!extracted) return;
		approvedPlan = extracted.text; steps = extracted.steps; persist();
		const usage = ctx.getContextUsage();
		const usageLabel = usage?.tokens !== null && usage?.tokens !== undefined && usage.percent !== null ? ` · ${Math.round(usage.percent)}% / ${usage.tokens.toLocaleString()} tokens` : "";
		const compactLabel = `Compact context${usageLabel}, then execute`;
		const choice = await ctx.ui.select(`Approve plan\n\n${formatPlanSteps(steps)}`, [
			`Yes · ${compactLabel} · accept all edits`,
			"Yes · execute and accept all edits",
			"Yes · execute in conservative auto mode",
			"Yes · execute with manual approvals",
			"No · keep planning",
			"Refine plan",
			"Cancel plan",
		]);
		if (choice?.startsWith("Yes · Compact")) compactThenExecute(ctx, "accept-edits");
		else if (choice === "Yes · execute and accept all edits") await executePlan(ctx, "accept-edits");
		else if (choice === "Yes · execute in conservative auto mode") await executePlan(ctx, "auto");
		else if (choice === "Yes · execute with manual approvals") await executePlan(ctx, "manual");
		else if (choice === "Refine plan") {
			const refinement = await ctx.ui.editor("Plan changes or missing constraints", "");
			if (refinement?.trim()) pi.sendUserMessage(`Refine the proposed plan with these requirements; remain read-only:\n${refinement.trim()}`, { deliverAs: "followUp" });
		} else if (choice === "Cancel plan") await cancel(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const service = getPermissionService();
		unregisterPlanMode = service?.registerMode?.("plan");
		unsubscribePermission = service?.subscribe?.(() => {
			if (syncingPermission || !currentContext) return;
			const selected = service.getMode();
			if (selected === "plan" && mode !== "planning" && mode !== "compacting") void beginPlanning(currentContext, true);
			else if (selected !== "plan" && (mode === "planning" || mode === "compacting")) {
				approvedPlan = undefined; steps = []; setPlanState("off", currentContext);
			}
		});
		const entry = ctx.sessionManager.getEntries().filter((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === STATE_TYPE).pop() as { data?: PersistedState } | undefined;
		if (entry?.data) {
			mode = entry.data.mode === "compacting" ? "planning" : entry.data.mode;
			approvedPlan = entry.data.plan; steps = entry.data.steps ?? []; permissionBefore = entry.data.permissionBefore ?? permissionBefore;
		}
		toolsBefore = undefined;
		if (pi.getFlag("plan-mode") === true || service?.getMode() === "plan") mode = "planning";
		if (mode === "planning") { enterReadOnly(); void setPermission("plan"); }
		updateUi(ctx);
	});
	pi.on("session_shutdown", () => {
		if (mode === "planning" || mode === "compacting") restoreTools();
		if (currentContext) currentContext.ui.setStatus(STATUS_ID, undefined);
		unsubscribePermission?.(); unregisterPlanMode?.();
		unsubscribePermission = undefined; unregisterPlanMode = undefined; currentContext = undefined;
	});
}
