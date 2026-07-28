import type { ModelChoice, WorkflowModelPolicy } from "./types.ts";
import { modelCatalogSummary } from "./models.ts";
import { PROFILE_NAMES } from "./profiles.ts";

export function buildWorkflowSystemInstructions(options: {
	models: ModelChoice[];
	ultracodeTriggered: boolean;
	ultracodeEffortMode: "one-prompt" | "session";
	budgetPolicy: string;
}): string {
	return [
		"# Dynamic JavaScript workflows",
		"Use workflow_run when the user explicitly requests a workflow or when fan-out, isolated context, branching, loops, or independent verification materially help. Small linear tasks should stay in the main context. Scripts run in QuickJS and may use agent, phase, parallel, pipeline, approve, models, args, workflowPrompt, cwd, platform, and return; they have no Node, filesystem, network, environment, require, or fetch access.",
		options.ultracodeTriggered
			? `An authenticated interactive prompt used the bounded \`ultracode\` trigger. Generate a workflow and use xhigh deliberation; effort mode is ${options.ultracodeEffortMode}.`
			: "Natural-language requests may still ask for a workflow directly; no trigger keyword is required.",
		"Interpret model preferences semantically in the user's original language and encode them in modelPolicy. User constraints outrank optimization. Workflows currently support the provider groups opencode-go, anthropic, openai, and modelhub (all modelhub-2…modelhub-8 key aliases collapse to modelhub). Use allowedProviders for the source/provider and allowedFamilies for the underlying model vendor; the constraints intersect. For example, direct OpenAI is allowedProviders:['openai'], any OpenAI-family model is allowedFamilies:['openai'], and OpenAI-family models through ModelHub use both allowedProviders:['modelhub'] and allowedFamilies:['openai']. The default is defaultRouting:'inherit' with omitted agent.model; auto is explicit only. Provider/family/model allowlists are hard and never fall back outside policy. Call workflow_models before choosing exact models or routing across providers or families.",
		`Catalog summary: ${modelCatalogSummary(options.models)}`,
		`Profiles: ${PROFILE_NAMES.join(", ")}. Structured profiles and agent({schema}) return runtime-validated JSON values; plain agents return scanned text. Give every worker a distinct objective, scope, evidence requirement, deliverable, and stop condition.`,
		`The user's persistent aggregate-budget mode is ${options.budgetPolicy}. It overrides budgets emitted by the orchestrator. In off mode omit budgets; in custom mode the runtime applies the user's limits. Aggregate token/cost limits stop new workers after reported exhaustion but already-running parallel workers may overrun them. maxTurns separately bounds one worker.`,
		"Declare size (small <5, medium <15, large <50, unrestricted). Avoid overlapping parallel edits. writePaths bounds direct edits, but unconfined shell/custom mutations require explicit user acknowledgement.",
		"Workflow launch approval, persistent trust, and worker tool permissions are separate. The workflow artifact is the source of truth for active modelPolicy, requested/resolved/reported identities, raw/scanned output, cache state, usage, errors, flags, and final handoff. Read it before reporting.",
	].join("\n\n");
}

export function workflowPolicyContext(policy: WorkflowModelPolicy): string {
	return `Active modelPolicy: ${JSON.stringify(policy)}`;
}
