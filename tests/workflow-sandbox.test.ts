import assert from "node:assert/strict";
import test from "node:test";
import { executeSandboxedWorkflow, type SandboxBindings } from "../extensions/workflows/sandbox.ts";

function bindings(agent: SandboxBindings["agent"] = async (prompt) => String(prompt)): SandboxBindings {
	return { agent, phase: () => {}, log: () => {}, models: [{ id: "model" }], workflowPrompt: "original" };
}

test("workflow JavaScript has no Node or host-realm capabilities", async () => {
	const result = await executeSandboxedWorkflow(`
		let escaped;
		try { escaped = agent.constructor("return typeof process")(); } catch (error) { escaped = "blocked"; }
		return { process: typeof process, require: typeof require, fetch: typeof fetch, escaped };
	`, bindings(), { timeoutMs: 2_000 });
	assert.deepEqual(result, { process: "undefined", require: "undefined", fetch: "undefined", escaped: "undefined" });
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

test("sandbox interrupts synchronous infinite loops at the wall-clock deadline", async () => {
	let timedOut = 0;
	await assert.rejects(
		executeSandboxedWorkflow("while (true) {}", bindings(), { timeoutMs: 30, onTimeout: () => timedOut++ }),
		/deadline/,
	);
	assert.equal(timedOut, 1);
});
