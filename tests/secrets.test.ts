import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { FileSecretStore, getSecretService, installSecretService, removeSecretService, type SecretService } from "../extensions/shared/secret-service.ts";

test("secret store persists atomically without exposing values through list", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-secrets-"));
	const file = path.join(directory, "secrets.json");
	const store = new FileSecretStore(file);
	await Promise.all([store.set("modelhub.dashboard-cookie", "cookie-value"), store.set("other.token", "token-value")]);
	assert.equal(store.get("modelhub.dashboard-cookie"), "cookie-value");
	assert.deepEqual(store.list(), ["modelhub.dashboard-cookie", "other.token"]);
	assert.equal(new FileSecretStore(file).get("other.token"), "token-value");
	assert.doesNotMatch(JSON.stringify(store.list()), /cookie-value|token-value/);
	if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	await store.delete("other.token");
	assert.equal(new FileSecretStore(file).has("other.token"), false);
	fs.rmSync(directory, { recursive: true, force: true });
});

test("secret service is an optional shared dependency", () => {
	const service = { get: () => undefined, has: () => false, set: async () => {}, delete: async () => {}, list: () => [], promptAndStore: async () => false } as SecretService;
	assert.equal(getSecretService(), undefined);
	installSecretService(service);
	assert.equal(getSecretService(), service);
	removeSecretService(service);
	assert.equal(getSecretService(), undefined);
});
