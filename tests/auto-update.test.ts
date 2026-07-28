import assert from "node:assert/strict";
import test from "node:test";
import { resolvePiInvocation } from "../extensions/auto-update.ts";

test("auto-update invokes the running Pi JavaScript entry point on Windows", () => {
	assert.deepEqual(resolvePiInvocation({ platform: "win32", execPath: "C:\\Node\\node.exe", argv1: "C:\\Pi Agent\\dist\\cli.js", exists: () => true }), {
		command: "C:\\Node\\node.exe",
		args: ["C:\\Pi Agent\\dist\\cli.js", "update", "--extensions"],
	});
});

test("auto-update uses cmd only for the Windows npm-shim fallback", () => {
	const invocation = resolvePiInvocation({ platform: "win32", execPath: "C:\\Node\\node.exe", argv1: "C:\\bin\\pi.cmd", exists: () => true });
	assert.match(invocation.command, /(?:cmd\.exe|ComSpec)$/i);
	assert.deepEqual(invocation.args, ["/d", "/s", "/c", "pi update --extensions"]);
});

test("auto-update reuses packaged executables and has a POSIX fallback", () => {
	assert.deepEqual(resolvePiInvocation({ platform: "win32", execPath: "C:\\bin\\pi.exe", argv1: undefined, exists: () => false }), { command: "C:\\bin\\pi.exe", args: ["update", "--extensions"] });
	assert.deepEqual(resolvePiInvocation({ platform: "linux", execPath: "/usr/bin/node", argv1: undefined, exists: () => false }), { command: "pi", args: ["update", "--extensions"] });
});
