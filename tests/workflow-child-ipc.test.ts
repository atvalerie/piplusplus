import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
	buildChildAgentArgs,
	buildChildSystemInstructions,
	createPermissionResponseWriter,
	formatChildInvocationForLog,
	isClosedPermissionPipeError,
	prepareChildAgentLaunch,
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
	const systemPromptPath = "C:\\Temp\\piplusplus-worker\\system-prompt.md";
	const args = buildChildAgentArgs(agent, { provider: "modelhub", id: "gpt-test" }, systemPromptPath);
	const systemIndex = args.indexOf("--append-system-prompt");
	const instructions = buildChildSystemInstructions(agent);

	assert.ok(systemIndex >= 0);
	assert.equal(args[systemIndex + 1], systemPromptPath);
	assert.match(instructions ?? "", /Workflow specialist profile: reviewer/);
	assert.match(instructions ?? "", /Workflow structured output contract/);
	assert.match(instructions ?? "", /"status"/);
	assert.ok(!args.includes("Review the actual diff."));
	assert.deepEqual(args.slice(0, 4), ["--mode", "text", "-p", "--no-session"]);
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "high"]);

	const logged = formatChildInvocationForLog("pi", args);
	assert.match(logged, /\[workflow-system-prompt-file\]/);
	assert.doesNotMatch(logged, /system-prompt\.md|"status"|Review the actual diff/);
});

test("large worker prompts and schemas never enter Windows spawn arguments", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-launch-test-"));
	const prompt = `Inspect the repository.\n${"worker input ".repeat(100_000)}`;
	const schemaDescription = "structured contract ".repeat(100_000);
	const agent: AgentState = {
		id: "large", label: "Large", phase: "Execution", prompt, kind: "general",
		schema: { type: "object", description: schemaDescription, properties: { result: { type: "string" } } },
		status: "queued", createdAt: 1, scanFindings: [], flags: [], usage: zeroUsage(), toolCalls: [], messages: [], events: [], logs: [], attempt: 0,
	};
	let launch: ReturnType<typeof prepareChildAgentLaunch> | undefined;
	try {
		launch = prepareChildAgentLaunch(agent, { provider: "modelhub", id: "gpt-test" }, tempRoot);
		const argvBytes = launch.args.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8") + 1, 0);

		assert.equal(launch.stdin, prompt);
		assert.ok(argvBytes < 4_096, `expected short argv, got ${argvBytes} bytes`);
		assert.ok(!launch.args.some((value) => value.includes("worker input") || value.includes("structured contract")));
		assert.ok(launch.systemPromptFile);
		assert.match(fs.readFileSync(launch.systemPromptFile!, "utf8"), /structured contract/);
		launch.cleanup();
		assert.equal(fs.existsSync(launch.systemPromptFile!), false);
	} finally {
		launch?.cleanup();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});
