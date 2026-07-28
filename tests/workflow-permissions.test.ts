import assert from "node:assert/strict";
import test from "node:test";
import { getPermissionService, installPermissionService, removePermissionService, type PermissionService } from "../extensions/shared/permission-service.ts";
import { explainPermission } from "../extensions/workflows/permissions.ts";

const request = (toolName: string, input: Record<string, unknown>) => ({ agentId: "a", agentLabel: "Agent", toolName, input });

test("auto mode only approves deterministic low-risk operations", () => {
	assert.equal(explainPermission(request("read", { path: "README.md" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("read", { path: "/home/user/.pi/agent/workflows/artifacts/wf.json" }), "/repo", "read-only").allow, true);
	assert.equal(explainPermission(request("bash", { command: "git status" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("bash", { command: "dir" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("bash", { command: "Get-ChildItem src" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("bash", { command: "rg -n 'foo|bar' src || true" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("bash", { command: "ripgrep --files | head -20" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("bash", { command: "printf '%s\\n' \"$HOME\"" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("bash", { command: "git rev-parse --show-toplevel && git status" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("bash", { command: "npm test" }), "/repo", "auto").allow, false);
	assert.equal(explainPermission(request("bash", { command: "rm -rf build" }), "/repo", "auto").risk, "danger");
	assert.equal(explainPermission(request("bash", { command: "Remove-Item build -Recurse" }), "/repo", "auto").risk, "danger");
	assert.equal(explainPermission(request("bash", { command: "powershell -EncodedCommand AAAA" }), "/repo", "auto").risk, "danger");
	for (const command of [
		"printf x > output.txt",
		"rg foo $(touch owned)",
		"rg --pre 'node helper.js' foo",
		"find . -delete",
		"find . -exec touch {} ;",
		"sed -i 's/a/b/' file",
		"rg foo | node helper.js",
	]) assert.equal(explainPermission(request("bash", { command }), "/repo", "auto").allow, false, command);
	assert.equal(explainPermission(request("write", { path: "src/new.ts" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("write", { path: "../outside" }), "/repo", "auto").allow, false);
	assert.equal(explainPermission(request("write", { path: ".env" }), "/repo", "auto").allow, false);
	assert.equal(explainPermission(request("write", { path: "src\\.env\\secret" }), "/repo", "auto").allow, false);
});

test("manual and read-only modes fail closed for mutations", () => {
	assert.equal(explainPermission(request("edit", { path: "src/a.ts" }), "/repo", "manual").automatic, false);
	assert.equal(explainPermission(request("bash", { command: "npm test" }), "/repo", "manual").automatic, false);
	assert.equal(explainPermission(request("edit", { path: "src/a.ts" }), "/repo", "read-only").allow, false);
});

test("permission service is an optional global dependency", () => {
	const service: PermissionService = { getMode: () => "auto", setMode: async () => {}, authorize: async () => true };
	installPermissionService(service);
	assert.equal(getPermissionService(), service);
	removePermissionService(service);
	assert.equal(getPermissionService(), undefined);
});
