import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
	buildChildAgentArgs,
	createPermissionResponseWriter,
	formatChildInvocationForLog,
	isClosedPermissionPipeError,
} from "../extensions/workflows/child.ts";
import { zeroUsage, type AgentState } from "../extensions/workflows/types.ts";

function failingPipe(code: string): Writable {
	return new Writable({
		write(_chunk, _encoding, callback) {
			callback(Object.assign(new Error(`write ${code}`), { code }));
		},
	});
}

test("permission response IPC absorbs a child-close EPIPE race", async () => {
	const unexpected: Error[] = [];
	const pipe = failingPipe("EPIPE");
	const write = createPermissionResponseWriter(pipe, (error) => unexpected.push(error));

	assert.equal(write({ id: "permission_1", allow: true }), true);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.deepEqual(unexpected, []);
	assert.equal(write({ id: "permission_2", allow: false }), false);
	assert.equal(isClosedPermissionPipeError(Object.assign(new Error("closed"), { code: "EPIPE" })), true);
	assert.equal(isClosedPermissionPipeError(Object.assign(new Error("bad"), { code: "EACCES" })), false);
});

test("permission response IPC reports unexpected stream failures without throwing", async () => {
	const unexpected: Error[] = [];
	const pipe = failingPipe("EACCES");
	const write = createPermissionResponseWriter(pipe, (error) => unexpected.push(error));

	assert.equal(write({ id: "permission_1", allow: false }), true);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(unexpected.length, 1);
	assert.equal((unexpected[0] as NodeJS.ErrnoException).code, "EACCES");
});

test("permission response IPC returns the auto-classifier denial reason to the worker", async () => {
	let output = "";
	const pipe = new Writable({
		write(chunk, _encoding, callback) {
			output += chunk.toString();
			callback();
		},
	});
	const write = createPermissionResponseWriter(pipe);
	assert.equal(write({ id: "permission_7", allow: false, reason: "User explicitly said not to push." }), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(JSON.parse(output), {
		id: "permission_7",
		allow: false,
		reason: "User explicitly said not to push.",
	});
});

test("structured contracts and profile instructions stay out of the visible worker prompt", () => {
	const agent: AgentState = {
		id: "review", label: "Review", phase: "Verification", prompt: "Review the actual diff.", kind: "review",
		profile: "reviewer", schema: { type: "object", properties: { status: { type: "string" } } },
		thinking: "max", effectiveThinking: "high", providerThinking: "high",
		status: "queued", createdAt: 1, scanFindings: [], flags: [], usage: zeroUsage(), toolCalls: [], messages: [], events: [], logs: [], attempt: 0,
	};
	const args = buildChildAgentArgs(agent, { provider: "modelhub", id: "gpt-test" });
	const systemIndex = args.indexOf("--append-system-prompt");

	assert.ok(systemIndex >= 0);
	assert.match(args[systemIndex + 1], /Workflow specialist profile: reviewer/);
	assert.match(args[systemIndex + 1], /Workflow structured output contract/);
	assert.match(args[systemIndex + 1], /"status"/);
	assert.equal(args.at(-1), "Review the actual diff.");
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "high"]);

	const logged = formatChildInvocationForLog("pi", args);
	assert.match(logged, /\[structured-output-contract\]/);
	assert.doesNotMatch(logged, /"status"|Review the actual diff/);
});
