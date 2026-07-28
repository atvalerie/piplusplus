export const WORKFLOW_RECIPE_NAMES = ["diagnose", "design", "review", "implement"] as const;
export type WorkflowRecipeName = typeof WORKFLOW_RECIPE_NAMES[number];

export interface WorkflowRecipe { name: WorkflowRecipeName; description: string; background: boolean; script: string }

const synthesis = (assignment: string) => `return await agent(${JSON.stringify(assignment)} + "\\n\\nEvidence:\\n" + evidence, { id: "synthesis", label: "Synthesis", profile: "synthesizer" });`;

export const WORKFLOW_RECIPES: Record<WorkflowRecipeName, WorkflowRecipe> = {
	diagnose: {
		name: "diagnose", description: "Investigate a failure, independently challenge it, then synthesize verified causes and options.", background: true,
		script: `phase("Investigation");
const investigation = await agent(workflowPrompt, { id: "investigator", label: "Investigator", profile: "investigator" });
phase("Independent verification");
const verification = await agent("Verify this investigation against the repository. Challenge its path coverage and conclusions.\\n\\n" + investigation, { id: "verifier", label: "Verifier", profile: "verifier" });
phase("Synthesis");
const evidence = JSON.stringify({ investigation, verification });
${synthesis("Explain the verified cause, evidence, uncertainty, recommended correction, alternatives, and post-fix checks.")}`,
	},
	design: {
		name: "design", description: "Research repository constraints, create a traceable minimal plan, independently verify it, and synthesize.", background: true,
		script: `phase("Repository research");
const research = await agent(workflowPrompt, { id: "researcher", label: "Repository researcher", profile: "researcher" });
phase("Planning");
const plan = await agent("Design the smallest sufficient change for the original objective. Map requirements to files and verification.\\n\\nResearch:\\n" + research, { id: "planner", label: "Planner", profile: "planner" });
phase("Plan verification");
const verification = await agent("Independently verify this plan against the repository and original objective.\\n\\n" + plan, { id: "plan-verifier", label: "Plan verifier", profile: "verifier" });
phase("Synthesis");
const evidence = JSON.stringify({ research, plan, verification });
${synthesis("Present the proposed design, requirement-to-task traceability, risks, unresolved decisions, and verification strategy. Do not implement.")}`,
	},
	review: {
		name: "review", description: "Run correctness and security reviews independently, then consolidate actionable findings.", background: true,
		script: `phase("Independent review");
const [codeReview, securityReview] = await parallel([
  () => agent(workflowPrompt, { id: "code-review", label: "Code reviewer", profile: "reviewer" }),
  () => agent(workflowPrompt, { id: "security-review", label: "Security reviewer", profile: "security-reviewer" })
]);
phase("Synthesis");
const evidence = JSON.stringify({ codeReview, securityReview });
const finalReport = await agent("Consolidate only evidence-backed findings ordered by severity, preserve disagreements, list strengths, and give an overall verdict.\\n\\nEvidence:\\n" + evidence, { id: "synthesis", label: "Synthesis", profile: "synthesizer" });
const reviewStatuses = [JSON.parse(codeReview).status, JSON.parse(securityReview).status];
return reviewStatuses.every(status => status === "approved" || status === "approved_with_notes") ? finalReport : "WORKFLOW_FLAG: Independent review requires revision or is blocked\\n" + finalReport;`,
	},
	implement: {
		name: "implement", description: "Plan, request semantic approval, implement within declared target files, then independently review and verify.", background: false,
		script: `phase("Planning");
const plan = await agent(workflowPrompt, { id: "planner", label: "Implementation planner", profile: "planner" });
if (!await approve("Implementation plan", plan)) return "Implementation canceled at the plan approval gate.";
const parsedPlan = JSON.parse(plan);
if (parsedPlan.status !== "completed") return "Planning did not produce an implementable plan: " + plan;
if (!Array.isArray(parsedPlan.targetFiles) || !parsedPlan.targetFiles.length || !parsedPlan.targetFiles.every(path => typeof path === "string" && path.trim())) return "Implementation stopped: approved plan has no concrete targetFiles write scope.";
phase("Implementation");
const implementation = await agent("Implement the approved plan for the original objective.\\n\\nApproved plan:\\n" + plan, { id: "implementer", label: "Implementer", profile: "implementer", writePaths: parsedPlan.targetFiles });
if (JSON.parse(implementation).status !== "completed") return "Implementation escalated or blocked: " + implementation;
phase("Quality checks");
const quality = await agent("Run repository-defined checks and correct only in-scope quality failures. Do not weaken tests.\\n\\nApproved plan:\\n" + plan + "\\n\\nImplementation report:\\n" + implementation, { id: "quality-fixer", label: "Quality fixer", profile: "quality-fixer", writePaths: parsedPlan.targetFiles });
phase("Independent verification");
const [codeReview, securityReview] = await parallel([
  () => agent("Review the implementation against the objective and approved plan.\\n\\nPlan:\\n" + plan + "\\n\\nImplementation report:\\n" + implementation, { id: "code-review", label: "Code reviewer", profile: "reviewer" }),
  () => agent("Security-review the implementation and changed boundaries.\\n\\nPlan:\\n" + plan + "\\n\\nImplementation report:\\n" + implementation, { id: "security-review", label: "Security reviewer", profile: "security-reviewer" })
]);
phase("Synthesis");
const evidence = JSON.stringify({ plan, implementation, quality, codeReview, securityReview });
const finalReport = await agent("Report implementation, verification evidence, review verdicts, unresolved findings, and exact next actions.\\n\\nEvidence:\\n" + evidence, { id: "synthesis", label: "Synthesis", profile: "synthesizer" });
const verificationStatuses = [JSON.parse(quality).status, JSON.parse(codeReview).status, JSON.parse(securityReview).status];
return verificationStatuses.every(status => status === "approved" || status === "approved_with_notes") ? finalReport : "WORKFLOW_FLAG: Quality or independent verification requires revision or is blocked\\n" + finalReport;`,
	},
};

export function compileWorkflowRecipe(value: unknown): WorkflowRecipe {
	if (typeof value !== "string" || !(value in WORKFLOW_RECIPES)) throw new Error(`Unknown workflow recipe: ${String(value)}`);
	return WORKFLOW_RECIPES[value as WorkflowRecipeName];
}
