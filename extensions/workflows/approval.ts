import type { WorkflowSpec } from "./types.ts";

export interface WorkflowPlanPreview {
	phases: string[];
	staticAgentSites: number;
	cautions: string[];
}

export function inspectWorkflowPlan(spec: WorkflowSpec): WorkflowPlanPreview {
	const phases = [...spec.script.matchAll(/\bphase\s*\(\s*(["'])(.*?)\1\s*\)/g)]
		.map((match) => match[2].trim())
		.filter(Boolean)
		.filter((value, index, all) => all.indexOf(value) === index);
	const staticAgentSites = [...spec.script.matchAll(/\bagent\s*\(/g)].length;
	const cautions: string[] = [];
	if (staticAgentSites > 25) cautions.push(`Static script contains ${staticAgentSites} agent call sites; runs above 25 agents trigger a large-run warning.`);
	if (spec.budgets?.maxTokens !== undefined) cautions.push(`Hard token cap: ${spec.budgets.maxTokens.toLocaleString("en-US")}.`);
	else cautions.push("No hard token cap is configured.");
	if (spec.budgets?.maxCost !== undefined) cautions.push(`Hard cost cap: $${spec.budgets.maxCost.toFixed(4)}.`);
	else cautions.push("No hard cost cap is configured.");
	if (spec.budgets?.maxAgents !== undefined) cautions.push(`Hard agent cap: ${spec.budgets.maxAgents}.`);
	return { phases, staticAgentSites, cautions };
}

export function workflowApprovalSummary(spec: WorkflowSpec): string {
	const preview = inspectWorkflowPlan(spec);
	const allowed = [
		spec.modelPolicy.allowedProviders?.length ? `providers: ${spec.modelPolicy.allowedProviders.join(", ")}` : undefined,
		spec.modelPolicy.allowedFamilies?.length ? `families: ${spec.modelPolicy.allowedFamilies.join(", ")}` : undefined,
		spec.modelPolicy.allowedModels?.length ? `models: ${spec.modelPolicy.allowedModels.join(", ")}` : undefined,
	].filter(Boolean).join("; ") || "no model allowlist";
	return [
		`Workflow: ${spec.name}`,
		`Why: ${spec.why}`,
		`Goal: ${spec.goal}`,
		`Planned phases: ${preview.phases.length ? preview.phases.join(" → ") : "dynamic/not statically declared"}`,
		`Expected size: ${spec.size ?? "unspecified"}; ${preview.staticAgentSites} static agent call site${preview.staticAgentSites === 1 ? "" : "s"}`,
		`Routing: ${spec.modelPolicy.defaultRouting}; ${allowed}`,
		`Routing rationale: ${spec.modelPolicy.rationale}`,
		`Usage caution: ${preview.cautions.join(" ")}`,
	].join("\n");
}
