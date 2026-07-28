import type { StepKind } from "./types.ts";

export const PROFILE_NAMES = ["researcher", "investigator", "planner", "implementer", "reviewer", "security-reviewer", "verifier", "quality-fixer", "synthesizer"] as const;
export type WorkflowProfileName = typeof PROFILE_NAMES[number];

export interface WorkflowProfile {
	name: WorkflowProfileName;
	kind: StepKind;
	tools: "read-only" | "all";
	structured: boolean;
	instruction: string;
	statuses: readonly string[];
}

const COMMON = "Stay within the assigned scope. Distinguish observed facts from inference, cite paths and line ranges only after reading them, never fabricate evidence, and explicitly report limitations.";
const JSON_RULE = "Return only one valid JSON object, with no markdown fence or surrounding prose.";

export const WORKFLOW_PROFILES: Record<WorkflowProfileName, WorkflowProfile> = {
	researcher: { name: "researcher", kind: "research", tools: "read-only", structured: true, statuses: ["completed", "blocked"], instruction: `${COMMON} Collect relevant evidence without modifying files. ${JSON_RULE} Shape: {"status":"completed|blocked","findings":[{"claim":"...","evidence":["path:line"]}],"gaps":[],"summary":"..."}.` },
	investigator: { name: "investigator", kind: "discovery", tools: "read-only", structured: true, statuses: ["completed", "blocked"], instruction: `${COMMON} Trace all plausible execution paths, test competing explanations, identify supporting and contradicting evidence, and stop at the demonstrated cause rather than the first suspicious line. ${JSON_RULE} Shape: {"status":"completed|blocked","paths":[],"findings":[],"unexplored":[],"summary":"..."}.` },
	planner: { name: "planner", kind: "planning", tools: "read-only", structured: true, statuses: ["completed", "blocked", "escalation_needed"], instruction: `${COMMON} Prefer the smallest sufficient change. Preserve existing contracts unless evidence requires changing them. Map every requirement to concrete target file or directory paths (never globs), implementation steps, and verification. ${JSON_RULE} Shape: {"status":"completed|blocked|escalation_needed","requirements":[],"targetFiles":[],"steps":[],"verification":[],"risks":[],"summary":"..."}.` },
	implementer: { name: "implementer", kind: "implementation", tools: "all", structured: true, statuses: ["completed", "blocked", "escalation_needed"], instruction: `${COMMON} Inspect before editing, follow the approved plan and declared write scope, add focused tests for changed behavior, and escalate instead of silently changing a contract or scope. ${JSON_RULE} Shape: {"status":"completed|blocked|escalation_needed","summary":"...","filesModified":[],"tests":[],"verification":[],"remainingRisks":[]}.` },
	reviewer: { name: "reviewer", kind: "review", tools: "read-only", structured: true, statuses: ["approved", "approved_with_notes", "needs_revision", "blocked"], instruction: `${COMMON} Review the actual diff and governing requirements. Report only actionable correctness, regression, scope, and maintainability findings; include severity and evidence. ${JSON_RULE} Shape: {"status":"approved|approved_with_notes|needs_revision|blocked","findings":[],"strengths":[],"summary":"..."}.` },
	"security-reviewer": { name: "security-reviewer", kind: "review", tools: "read-only", structured: true, statuses: ["approved", "approved_with_notes", "needs_revision", "blocked"], instruction: `${COMMON} Trace trust boundaries, inputs, authorization, secrets, command/file access, failure defaults, and mutation routes. Avoid generic checklist findings without a reachable path. ${JSON_RULE} Shape: {"status":"approved|approved_with_notes|needs_revision|blocked","findings":[],"unverifiedBoundaries":[],"summary":"..."}.` },
	verifier: { name: "verifier", kind: "verification", tools: "read-only", structured: true, statuses: ["approved", "approved_with_notes", "needs_revision", "blocked"], instruction: `${COMMON} Independently challenge prior conclusions, inspect omitted paths and counter-evidence, and verify each requirement against repository state. ${JSON_RULE} Shape: {"status":"approved|approved_with_notes|needs_revision|blocked","checks":[],"findings":[],"coverage":"sufficient|partial|insufficient","summary":"..."}.` },
	"quality-fixer": { name: "quality-fixer", kind: "verification", tools: "all", structured: true, statuses: ["approved", "needs_revision", "blocked"], instruction: `${COMMON} Run repository-defined quality checks, make only in-scope corrective edits, and report exact commands and outcomes. Never weaken tests to obtain a pass. ${JSON_RULE} Shape: {"status":"approved|needs_revision|blocked","commands":[],"fixes":[],"failures":[],"summary":"..."}.` },
	synthesizer: { name: "synthesizer", kind: "synthesis", tools: "read-only", structured: false, statuses: [], instruction: `${COMMON} Reconcile the supplied worker results, preserve uncertainty and disagreements, prioritize actionable conclusions, and produce a concise final handoff.` },
};

export function getWorkflowProfile(value: unknown): WorkflowProfile | undefined {
	return typeof value === "string" && value in WORKFLOW_PROFILES ? WORKFLOW_PROFILES[value as WorkflowProfileName] : undefined;
}

export function applyWorkflowProfile(prompt: string, value: unknown): { prompt: string; profile?: WorkflowProfile } {
	if (value === undefined) return { prompt };
	const profile = getWorkflowProfile(value);
	if (!profile) throw new Error(`Unknown workflow profile: ${String(value)}`);
	return { profile, prompt: `[Specialist profile: ${profile.name}]\n${profile.instruction}\n\nAssignment:\n${prompt}` };
}

export function validateProfileOutput(profile: WorkflowProfile | undefined, output: string): { value?: unknown; error?: string } {
	if (!profile?.structured) return {};
	let value: unknown;
	try { value = JSON.parse(output); } catch { return { error: `${profile.name} must return one valid JSON object` }; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${profile.name} returned JSON that is not an object` };
	const status = (value as Record<string, unknown>).status;
	if (typeof status !== "string" || !profile.statuses.includes(status)) return { error: `${profile.name} returned invalid status ${String(status)}` };
	return { value };
}
