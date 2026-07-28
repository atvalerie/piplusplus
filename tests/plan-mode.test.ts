import assert from "node:assert/strict";
import test from "node:test";
import { extractPlan, formatPlanSteps, markPlanSteps } from "../extensions/shared/plan-mode.ts";

test("plan mode extracts a self-contained numbered plan", () => {
	const plan = extractPlan(`Analysis first.\n\n## Plan\nObjective: Fix it\n1. Inspect the failing boundary\n2. Add the focused regression test\n3. Implement and verify the correction\n\nVerification: run tests`);
	assert.ok(plan);
	assert.equal(plan.steps.length, 3);
	assert.match(plan.text, /^## Plan/);
	assert.equal(plan.steps[1].text, "Add the focused regression test");
});

test("plan progress markers are idempotent", () => {
	const steps = extractPlan("Plan:\n1. Inspect source\n2. Implement correction")!.steps;
	assert.equal(markPlanSteps("Done [DONE:1] and duplicate [DONE:1]", steps), 1);
	assert.equal(markPlanSteps("Now [DONE:2]", steps), 1);
	assert.match(formatPlanSteps(steps), /1\. ✓ Inspect source/);
	assert.equal(markPlanSteps("Again [DONE:2]", steps), 0);
});

test("text without a plan heading does not trigger execution UI", () => {
	assert.equal(extractPlan("I need one clarification before planning."), undefined);
});
