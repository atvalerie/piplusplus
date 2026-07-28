import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
	createPermissionResponseWriter,
	isClosedPermissionPipeError,
} from "../extensions/workflows/child.ts";

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
