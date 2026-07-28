import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { inspectWorkflowPlan, workflowApprovalSummary } from "../extensions/workflows/approval.ts";
import { createWorkflowController } from "../extensions/workflows/runtime.ts";
import { createSavedWorkflowSource } from "../extensions/workflows/saved.ts";
import { WorkflowBrowser } from "../extensions/workflows/tui.ts";
import {
	headlessWorkflowLaunchAllowed,
	isWorkflowTrusted,
	trustWorkflowFromUserAction,
	workflowTrustIdentity,
	workflowTrustPath,
} from "../extensions/workflows/trust.ts";
import { zeroUsage, type WorkflowController, type WorkflowRun, type WorkflowSpec } from "../extensions/workflows/types.ts";

function spec(script = `phase("Inspect"); const result = await agent("inspect"); phase("Verify"); return result;`): WorkflowSpec {
	return {
		name: "audit",
		why: "Independent inspection",
		goal: "Verified report",
		prompt: "Audit",
		script,
		size: "small",
		budgets: { maxAgents: 4, maxTokens: 100_000, maxCost: 2 },
		modelPolicy: { defaultRouting: "inherit", allowedProviders: ["modelhub"], allowedFamilies: ["openai"], rationale: "The user requested OpenAI only through ModelHub." },
	};
}

function run(name: string, status: WorkflowRun["status"]): WorkflowRun {
	return {
		id: name.toLowerCase(),
		cwd: process.cwd(),
		spec: { ...spec("return 'done';"), name },
		status,
		createdAt: Date.now(),
		currentPhase: "Workflow",
		phases: [],
		agents: [],
		flags: [],
		usage: zeroUsage(),
		paused: false,
		logs: [],
	};
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

test("approval preview shows phases, expected size, policy, and usage cautions", () => {
	const preview = inspectWorkflowPlan(spec());
	assert.deepEqual(preview.phases, ["Inspect", "Verify"]);
	assert.equal(preview.staticAgentSites, 1);
	const summary = workflowApprovalSummary(spec());
	assert.match(summary, /Workflow: audit/);
	assert.match(summary, /Inspect → Verify/);
	assert.match(summary, /Expected size: small/);
	assert.match(summary, /providers: modelhub/);
	assert.match(summary, /families: openai/);
	assert.match(summary, /Token scheduling threshold: 100,000/);
	assert.match(summary, /Cost scheduling threshold: \$2\.0000/);
});

test("persistent trust requires an explicit writer call and invalidates on script or project changes", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-trust-agent-"));
	const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-trust-project-a-"));
	const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-trust-project-b-"));
	try {
		const workflow = { ...spec(), args: { trust: true, approval: "skip" } };
		const identity = workflowTrustIdentity(workflow, projectA);
		assert.equal(fs.existsSync(workflowTrustPath(agentDir)), false);
		assert.equal(await isWorkflowTrusted(workflow, projectA, agentDir), false);
		assert.equal(fs.existsSync(workflowTrustPath(agentDir)), false);

		const trusted = await trustWorkflowFromUserAction(workflow, projectA, agentDir);
		assert.equal(trusted.key, identity.key);
		assert.equal(await isWorkflowTrusted(workflow, projectA, agentDir), true);
		assert.equal(await isWorkflowTrusted({ ...workflow, script: `${workflow.script}\n// changed` }, projectA, agentDir), false);
		assert.equal(await isWorkflowTrusted(workflow, projectB, agentDir), false);
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(projectA, { recursive: true, force: true });
		fs.rmSync(projectB, { recursive: true, force: true });
	}
});

test("headless launch policy is non-interactive and explicit", () => {
	assert.equal(headlessWorkflowLaunchAllowed(undefined), true);
	assert.equal(headlessWorkflowLaunchAllowed("allow"), true);
	assert.equal(headlessWorkflowLaunchAllowed("deny"), false);
	assert.throws(() => headlessWorkflowLaunchAllowed("prompt"), /allow.*deny/);
});

test("manager filters statuses and routes save, resume, resumable stop, and hard stop actions", () => {
	const runs = [run("Running", "running"), run("Done", "completed"), run("Failed", "failed")];
	let saved: string | undefined;
	let resumed: string | undefined;
	let softStops = 0;
	let hardStops = 0;
	const controller = {
		pause() {},
		resume() {},
		stop() { softStops++; },
		hardStop() { hardStops++; },
		stopAgent() {},
		restartAgent() {},
	} satisfies WorkflowController;
	const controllers = new Map(runs.map((item) => [item.id, controller]));
	const browser = new WorkflowBrowser(() => runs, controllers, theme, () => {}, 12, (id) => { resumed = id; }, (id) => { saved = id; });

	assert.match(browser.render(100).join("\n"), /Running/);
	browser.handleInput("f");
	const active = browser.render(100).join("\n");
	assert.match(active, /filter:active/);
	assert.match(active, /Running/);
	assert.doesNotMatch(active, /Done/);
	browser.handleInput("f");
	const completed = browser.render(100).join("\n");
	assert.match(completed, /Done/);
	assert.doesNotMatch(completed, /Failed/);
	browser.handleInput("f");
	const attention = browser.render(100).join("\n");
	assert.match(attention, /Failed/);
	browser.handleInput("s");
	assert.equal(saved, "failed");
	browser.handleInput("x");
	browser.handleInput("X");
	assert.equal(softStops, 1);
	assert.equal(hardStops, 1);

	const stopped = run("Stopped", "stopped");
	const stoppedBrowser = new WorkflowBrowser(() => [stopped], new Map([[stopped.id, controller]]), theme, () => {}, 12, (id) => { resumed = id; });
	stoppedBrowser.handleInput("p");
	assert.equal(resumed, "stopped");
});

test("saved-source builder emits validated meta for the manager save action", () => {
	const source = createSavedWorkflowSource(spec("return 1;"), "audit-run", "Reusable audit");
	assert.match(source, /^export const meta =/);
	assert.match(source, /"name": "audit-run"/);
	assert.match(source, /return 1;/);
	assert.throws(() => createSavedWorkflowSource(spec(), "../bad", "bad"), /lowercase/);
});

test("hard stop is terminal while normal stop remains resumable", async () => {
	const model = {
		provider: "modelhub", id: "gpt-test", name: "GPT", reasoning: true,
		contextWindow: 128_000, maxTokens: 16_000, cost: { input: 0, output: 0 },
	} as any;
	const workflow = run("Hard stop", "queued");
	workflow.spec.script = `await agent("wait", { id: "wait" }); return "done";`;
	workflow.spec.modelPolicy = { defaultRouting: "inherit", rationale: "test" };
	let release!: () => void;
	const child = new Promise<void>((resolve) => { release = resolve; });
	const runtime = createWorkflowController(workflow, [model], model, {
		changed: () => {},
		notify: () => {},
		requestPermission: async () => false,
		requestApproval: async () => true,
	}, {
		runChildAgent: (async () => {
			await child;
			return { exitCode: 1, output: "", stderr: "stopped", usage: zeroUsage(), model: "gpt-test", stopReason: "aborted" };
		}) as any,
	});
	const executing = runtime.execute();
	await new Promise((resolve) => setTimeout(resolve, 10));
	runtime.controller.hardStop();
	release();
	await executing;
	assert.equal(workflow.status, "failed");
	assert.match(workflow.error ?? "", /hard-stopped/);
});
