import { Errors } from "typebox/value";
import type { JSONSchema, StepKind } from "./types.ts";

export const PROFILE_NAMES = ["researcher", "investigator", "planner", "implementer", "reviewer", "security-reviewer", "verifier", "quality-fixer", "synthesizer"] as const;
export type WorkflowProfileName = typeof PROFILE_NAMES[number];

export interface WorkflowProfile {
	name: WorkflowProfileName;
	kind: StepKind;
	tools: "read-only" | "all";
	structured: boolean;
	instruction: string;
	schema?: JSONSchema;
}

export interface StructuredOutputValidation {
	structured: boolean;
	value?: unknown;
	error?: string;
	/** A caller/schema defect is deterministic and must not consume worker retries. */
	schemaError?: boolean;
}

const COMMON = "Stay within the assigned scope. Distinguish observed facts from inference, cite paths and line ranges only after reading them, never fabricate evidence, and explicitly report limitations.";
const STRING_ARRAY = { type: "array", items: { type: "string" } };
const EVIDENCE_FINDING = {
	type: "object",
	properties: {
		claim: { type: "string" },
		evidence: STRING_ARRAY,
	},
	required: ["claim", "evidence"],
	additionalProperties: false,
};
const REVIEW_FINDING = {
	type: "object",
	properties: {
		severity: { enum: ["critical", "high", "medium", "low"] },
		claim: { type: "string" },
		evidence: STRING_ARRAY,
	},
	required: ["severity", "claim", "evidence"],
	additionalProperties: false,
};

function reportSchema(statuses: readonly string[], properties: Record<string, unknown>, required: string[]): JSONSchema {
	return {
		type: "object",
		properties: {
			status: { enum: [...statuses] },
			...properties,
			summary: { type: "string" },
		},
		required: ["status", ...required, "summary"],
		additionalProperties: false,
	};
}

const RESEARCHER_SCHEMA = reportSchema(["completed", "blocked"], {
	findings: { type: "array", items: EVIDENCE_FINDING },
	gaps: STRING_ARRAY,
}, ["findings", "gaps"]);

const INVESTIGATOR_SCHEMA = reportSchema(["completed", "blocked"], {
	paths: STRING_ARRAY,
	findings: { type: "array", items: EVIDENCE_FINDING },
	unexplored: STRING_ARRAY,
}, ["paths", "findings", "unexplored"]);

const PLANNER_SCHEMA = reportSchema(["completed", "blocked", "escalation_needed"], {
	requirements: STRING_ARRAY,
	targetFiles: STRING_ARRAY,
	steps: STRING_ARRAY,
	verification: STRING_ARRAY,
	risks: STRING_ARRAY,
}, ["requirements", "targetFiles", "steps", "verification", "risks"]);

const IMPLEMENTER_SCHEMA = reportSchema(["completed", "blocked", "escalation_needed"], {
	filesModified: STRING_ARRAY,
	tests: STRING_ARRAY,
	verification: STRING_ARRAY,
	remainingRisks: STRING_ARRAY,
}, ["filesModified", "tests", "verification", "remainingRisks"]);

const REVIEWER_SCHEMA = reportSchema(["approved", "approved_with_notes", "needs_revision", "blocked"], {
	findings: { type: "array", items: REVIEW_FINDING },
	strengths: STRING_ARRAY,
}, ["findings", "strengths"]);

const SECURITY_REVIEWER_SCHEMA = reportSchema(["approved", "approved_with_notes", "needs_revision", "blocked"], {
	findings: { type: "array", items: REVIEW_FINDING },
	unverifiedBoundaries: STRING_ARRAY,
}, ["findings", "unverifiedBoundaries"]);

const VERIFIER_SCHEMA = reportSchema(["approved", "approved_with_notes", "needs_revision", "blocked"], {
	checks: STRING_ARRAY,
	findings: { type: "array", items: REVIEW_FINDING },
	coverage: { enum: ["sufficient", "partial", "insufficient"] },
}, ["checks", "findings", "coverage"]);

const QUALITY_FIXER_SCHEMA = reportSchema(["approved", "needs_revision", "blocked"], {
	commands: STRING_ARRAY,
	fixes: STRING_ARRAY,
	failures: STRING_ARRAY,
}, ["commands", "fixes", "failures"]);

export const WORKFLOW_PROFILES: Record<WorkflowProfileName, WorkflowProfile> = {
	researcher: { name: "researcher", kind: "research", tools: "read-only", structured: true, schema: RESEARCHER_SCHEMA, instruction: `${COMMON} Collect relevant evidence without modifying files.` },
	investigator: { name: "investigator", kind: "discovery", tools: "read-only", structured: true, schema: INVESTIGATOR_SCHEMA, instruction: `${COMMON} Trace all plausible execution paths, test competing explanations, identify supporting and contradicting evidence, and stop at the demonstrated cause rather than the first suspicious line.` },
	planner: { name: "planner", kind: "planning", tools: "read-only", structured: true, schema: PLANNER_SCHEMA, instruction: `${COMMON} Prefer the smallest sufficient change. Preserve existing contracts unless evidence requires changing them. Map every requirement to concrete target file or directory paths (never globs), implementation steps, and verification.` },
	implementer: { name: "implementer", kind: "implementation", tools: "all", structured: true, schema: IMPLEMENTER_SCHEMA, instruction: `${COMMON} Inspect before editing, follow the approved plan and declared write scope, add focused tests for changed behavior, and escalate instead of silently changing a contract or scope.` },
	reviewer: { name: "reviewer", kind: "review", tools: "read-only", structured: true, schema: REVIEWER_SCHEMA, instruction: `${COMMON} Review the actual diff and governing requirements. Report only actionable correctness, regression, scope, and maintainability findings; include severity and evidence.` },
	"security-reviewer": { name: "security-reviewer", kind: "review", tools: "read-only", structured: true, schema: SECURITY_REVIEWER_SCHEMA, instruction: `${COMMON} Trace trust boundaries, inputs, authorization, secrets, command/file access, failure defaults, and mutation routes. Avoid generic checklist findings without a reachable path.` },
	verifier: { name: "verifier", kind: "verification", tools: "read-only", structured: true, schema: VERIFIER_SCHEMA, instruction: `${COMMON} Independently challenge prior conclusions, inspect omitted paths and counter-evidence, and verify each requirement against repository state.` },
	"quality-fixer": { name: "quality-fixer", kind: "verification", tools: "all", structured: true, schema: QUALITY_FIXER_SCHEMA, instruction: `${COMMON} Run repository-defined quality checks, make only in-scope corrective edits, and report exact commands and outcomes. Never weaken tests to obtain a pass.` },
	synthesizer: { name: "synthesizer", kind: "synthesis", tools: "read-only", structured: false, instruction: `${COMMON} Reconcile the supplied worker results, preserve uncertainty and disagreements, prioritize actionable conclusions, and produce a concise final handoff.` },
};

export function getWorkflowProfile(value: unknown): WorkflowProfile | undefined {
	return typeof value === "string" && value in WORKFLOW_PROFILES ? WORKFLOW_PROFILES[value as WorkflowProfileName] : undefined;
}

export function normalizeJSONSchema(value: unknown): JSONSchema | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean" && (!value || typeof value !== "object" || Array.isArray(value))) {
		throw new Error("agent schema must be a JSON Schema object or boolean");
	}
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new Error(`agent schema must be finite JSON data: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!json || json.length > 128 * 1024) throw new Error("agent schema exceeds the 128 KiB limit");
	let schema: unknown;
	try { schema = JSON.parse(json); } catch { throw new Error("agent schema must be valid JSON data"); }
	if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
		throw new Error("agent schema must be a JSON Schema object or boolean");
	}
	return schema as JSONSchema;
}

export function withStructuredOutputInstruction(prompt: string, schema: JSONSchema | undefined): string {
	if (schema === undefined) return prompt;
	return `${prompt}\n\n[Structured output]\nReturn only one valid JSON value with no markdown fence or surrounding prose. The value must validate against this JSON Schema:\n${JSON.stringify(schema)}`;
}

function jsonPath(pointer: string): string {
	if (!pointer) return "$";
	return `$${pointer.split("/").slice(1).map((part) => {
		const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
		if (/^(?:0|[1-9]\d*)$/.test(decoded)) return `[${decoded}]`;
		if (/^[A-Za-z_$][\w$]*$/.test(decoded)) return `.${decoded}`;
		return `[${JSON.stringify(decoded)}]`;
	}).join("")}`;
}

export function validateStructuredOutput(schema: JSONSchema | undefined, output: string): StructuredOutputValidation {
	if (schema === undefined) return { structured: false };
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { structured: true, error: `Structured output at $ is not valid JSON: ${detail}` };
	}
	try {
		const errors = Errors(schema as never, value);
		if (errors.length === 0) return { structured: true, value };
		const detail = errors.slice(0, 3).map((error) => `${jsonPath(error.instancePath)}: ${error.message}`).join("; ");
		return { structured: true, error: `Structured output failed JSON Schema validation: ${detail || "$: value is not allowed"}` };
	} catch (error) {
		return {
			structured: true,
			schemaError: true,
			error: `Invalid agent JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function applyWorkflowProfile(prompt: string, value: unknown): { prompt: string; profile?: WorkflowProfile } {
	if (value === undefined) return { prompt };
	const profile = getWorkflowProfile(value);
	if (!profile) throw new Error(`Unknown workflow profile: ${String(value)}`);
	return { profile, prompt: `[Specialist profile: ${profile.name}]\n${profile.instruction}\n\nAssignment:\n${prompt}` };
}

/** @deprecated Prefer validateStructuredOutput with the effective agent schema. */
export function validateProfileOutput(profile: WorkflowProfile | undefined, output: string): StructuredOutputValidation {
	return validateStructuredOutput(profile?.schema, output);
}
