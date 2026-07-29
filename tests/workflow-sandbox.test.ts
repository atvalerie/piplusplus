import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowTools } from "../extensions/workflows/runtime.ts";
import { executeSandboxedWorkflow, type SandboxBindings } from "../extensions/workflows/sandbox.ts";

function bindings(agent: SandboxBindings["agent"] = async (prompt) => String(prompt)): SandboxBindings {
	return { agent, phase: () => {}, approve: async () => true, log: () => {}, models: [{ id: "model" }], workflowPrompt: "original", cwd: "C:\\repo", platform: "win32" };
}

test("workflow tool aliases normalize generated read-only configurations", () => {
	assert.deepEqual(normalizeWorkflowTools("read-only"), ["read", "grep", "find", "ls"]);
	assert.deepEqual(normalizeWorkflowTools("read,grep"), ["read", "grep"]);
	assert.equal(normalizeWorkflowTools("all"), undefined);
});

test("workflow JavaScript has no Node or host-realm capabilities", async () => {
	const result = await executeSandboxedWorkflow(`
		let escaped;
		try { escaped = agent.constructor("return typeof process")(); } catch (error) { escaped = "blocked"; }
		return { process: typeof process, cwd, platform, processCwd: process.cwd(), processPlatform: process.platform, env: typeof process.env, require: typeof require, fetch: typeof fetch, escaped, frozen: Object.isFrozen(process) };
	`, bindings(), { timeoutMs: 2_000 });
	assert.deepEqual(result, { process: "object", cwd: "C:\\repo", platform: "win32", processCwd: "C:\\repo", processPlatform: "win32", env: "undefined", require: "undefined", fetch: "undefined", escaped: "object", frozen: true });
});

test("sandbox preserves dependent and parallel JavaScript orchestration", async () => {
	const calls: Array<[string, string]> = [];
	const result = await executeSandboxedWorkflow(`
		phase("Research");
		const values = await parallel([() => agent("alpha"), () => agent("beta")]);
		return { values, prompt: workflowPrompt, model: models()[0].id };
	`, bindings(async (prompt, _options, phase) => {
		calls.push([String(prompt), phase]);
		await new Promise((resolve) => setTimeout(resolve, prompt === "alpha" ? 15 : 2));
		return String(prompt).toUpperCase();
	}), { timeoutMs: 2_000 });
	assert.deepEqual(result, { values: ["ALPHA", "BETA"], prompt: "original", model: "model" });
	assert.deepEqual(calls, [["alpha", "Research"], ["beta", "Research"]]);
});

test("a later phase cannot consume parallel results until every prior worker settles", async () => {
	const events: string[] = [];
	const completed = new Set<string>();
	const result = await executeSandboxedWorkflow(`
		phase("Probe");
		const probes = await parallel([() => agent("patterns"), () => agent("surface")]);
		phase("Adversarial");
		const verdict = await agent("verify:" + probes.join("+"), { phase: "Adversarial", effort: "high" });
		return { probes, verdict };
	`, bindings(async (prompt, options, phase) => {
		const name = String(prompt);
		events.push(`start:${name}:${phase}`);
		if (name === "patterns" || name === "surface") {
			await new Promise((resolve) => setTimeout(resolve, name === "patterns" ? 12 : 2));
			completed.add(name);
			events.push(`done:${name}`);
			return name.toUpperCase();
		}
		assert.deepEqual([...completed].sort(), ["patterns", "surface"]);
		assert.equal((options as { effort?: string }).effort, "high");
		events.push(`done:${name}`);
		return "SAFE";
	}), { timeoutMs: 2_000 });

	assert.deepEqual(result, { probes: ["PATTERNS", "SURFACE"], verdict: "SAFE" });
	assert.equal(events.findIndex((event) => event.startsWith("start:verify:")), events.length - 2);
});

test("sandbox marshals structured agent objects, arrays, scalars, and null as guest values", async () => {
	const result = await executeSandboxedWorkflow(`
		const object = await agent("object");
		const array = await agent("array");
		const scalar = await agent("scalar");
		const nullable = await agent("null");
		return { nested: object.user.name, second: array[1], scalar, nullable, objectType: typeof object };
	`, bindings(async (prompt) => ({
		object: { user: { name: "Ada" } },
		array: ["first", 2],
		scalar: true,
		null: null,
	}[String(prompt)])), { timeoutMs: 2_000 });
	assert.deepEqual(result, { nested: "Ada", second: 2, scalar: true, nullable: null, objectType: "object" });
});

test("sandbox exposes structured workflow args as copied guest data", async () => {
	const supplied = { topic: "routing", nested: { count: 2 }, items: ["a", "b"] };
	const result = await executeSandboxedWorkflow(`
		args.nested.count += 1;
		return { topic: args.topic, count: args.nested.count, second: args.items[1] };
	`, { ...bindings(), args: supplied }, { timeoutMs: 2_000 });
	assert.deepEqual(result, { topic: "routing", count: 3, second: "b" });
	assert.deepEqual(supplied, { topic: "routing", nested: { count: 2 }, items: ["a", "b"] });
});

test("unreferenced host work cannot keep sandbox teardown past its deadline", async () => {
	const started = Date.now();
	await assert.rejects(
		() => executeSandboxedWorkflow(`void agent("detached"); return "done";`, {
			...bindings(),
			agent: async () => new Promise((_, reject) => setTimeout(() => reject(new Error("late detached failure")), 300)),
		}, { timeoutMs: 40 }),
		/wall-clock deadline/,
	);
	assert.ok(Date.now() - started < 1_000);
	await new Promise((resolve) => setTimeout(resolve, 330));
});

test("sandbox abandons late host settlements safely after its wall-clock deadline", async () => {
	let rejectWorker!: (error: Error) => void;
	const worker = new Promise<never>((_resolve, reject) => { rejectWorker = reject; });
	const started = Date.now();
	await assert.rejects(
		executeSandboxedWorkflow("return await agent('slow')", bindings(async () => worker), { timeoutMs: 30 }),
		/deadline/,
	);
	assert.ok(Date.now() - started < 500, "sandbox timeout must not wait for an uncooperative host promise");
	rejectWorker(new Error("late worker failure"));
	await new Promise((resolve) => setTimeout(resolve, 20));
});

test("sandbox interrupts synchronous infinite loops at the wall-clock deadline", async () => {
	let timedOut = 0;
	await assert.rejects(
		executeSandboxedWorkflow("while (true) {}", bindings(), { timeoutMs: 30, onTimeout: () => timedOut++ }),
		/deadline/,
	);
	assert.equal(timedOut, 1);
});
