import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getPermissionService, installPermissionService, removePermissionService, type PermissionService } from "../extensions/shared/permission-service.ts";
import { acceptEditsAutoApproves, classifyPathAccess, explainPermission, isCriticalFilesystemRemoval, isPathWithinWriteScope, mutationOverlapsWriteScopes, scopedToolRequiresExplicitApproval } from "../extensions/workflows/permissions.ts";

const request = (toolName: string, input: Record<string, unknown>) => ({ agentId: "a", agentLabel: "Agent", toolName, input });

test("auto mode only approves deterministic low-risk operations", () => {
	assert.equal(explainPermission(request("read", { path: "README.md" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("read", { path: "../outside.txt" }), "/repo", "read-only").allow, true);
	assert.equal(explainPermission(request("read", { path: "/agent/workflows/artifacts/wf.json" }), "/repo", "read-only", { artifactRoots: ["/agent/workflows/artifacts"] }).allow, true);
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
	assert.equal(explainPermission(request("write", { path: ".env" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("write", { path: "src\\.env\\secret" }), "/repo", "auto").allow, true);
	assert.equal(explainPermission(request("write", { path: "package.json" }), "/repo", "auto").automatic, true);
	assert.equal(explainPermission(request("read", { path: ".git/config" }), "/repo", "auto").automatic, true);
	assert.equal(explainPermission(request("write", { path: ".git/config" }), "/repo", "auto").automatic, false);
});

test("manual and read-only modes fail closed for mutations", () => {
	assert.equal(explainPermission(request("edit", { path: "src/a.ts" }), "/repo", "manual").automatic, false);
	assert.equal(explainPermission(request("bash", { command: "npm test" }), "/repo", "manual").automatic, false);
	assert.equal(explainPermission(request("edit", { path: "src/a.ts" }), "/repo", "read-only").allow, false);
});

test("filesystem root and home removals retain the final explicit-approval circuit breaker", () => {
	assert.equal(isCriticalFilesystemRemoval(request("bash", { command: "rm -rf /" }), "/repo"), true);
	assert.equal(isCriticalFilesystemRemoval(request("bash", { command: "Remove-Item -Recurse $HOME" }), "/repo"), true);
	assert.equal(isCriticalFilesystemRemoval(request("bash", { command: "rm -rf ./build" }), "/repo"), false);
	assert.equal(isCriticalFilesystemRemoval(request("write", { path: "/" }), "/repo"), false);
});

test("accept-edits auto-approval stays inside the workflow directory and prompts for protected writes", () => {
	const inside = request("edit", { path: "src/a.ts" });
	const outside = request("edit", { path: "../outside.ts" });
	const protectedPath = request("write", { path: ".git/config" });
	assert.equal(acceptEditsAutoApproves(inside, explainPermission(inside, "/repo", "auto")), true);
	assert.equal(acceptEditsAutoApproves(outside, explainPermission(outside, "/repo", "auto")), false);
	assert.equal(acceptEditsAutoApproves(protectedPath, explainPermission(protectedPath, "/repo", "auto")), false);
});

test("path policy resolves traversal, protected paths, artifact exceptions, and non-existent targets", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-path-policy-"));
	const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-artifacts-"));
	try {
		fs.mkdirSync(path.join(repo, "src"));
		assert.equal(classifyPathAccess(repo, "src/new/deep.ts", "edit").access, "allow");
		assert.equal(classifyPathAccess(repo, "../escape.ts", "edit").access, "ask");
		assert.equal(classifyPathAccess(repo, "../outside.txt", "read").access, "allow");
		assert.equal(classifyPathAccess(repo, ".env.local", "read").access, "allow");
		assert.equal(classifyPathAccess(repo, ".ssh/config", "edit").access, "allow");
		assert.equal(classifyPathAccess(repo, ".pi/settings.json", "edit").access, "ask");
		assert.equal(classifyPathAccess(repo, ".claude/hooks/pre-tool.js", "edit").access, "ask");
		assert.equal(classifyPathAccess(repo, ".claude/skills/example/SKILL.md", "edit").access, "allow");
		assert.equal(classifyPathAccess(repo, ".vscode/settings.json", "edit").access, "ask");
		assert.equal(classifyPathAccess(repo, ".github/workflows/ci.yml", "edit").access, "allow");
		assert.equal(classifyPathAccess(repo, "package-lock.json", "edit").access, "allow");
		const artifact = path.join(artifacts, "wf.json");
		const other = path.join(artifacts, "notes.txt");
		const payloadDirectory = path.join(artifacts, "wf.data");
		fs.mkdirSync(payloadDirectory);
		const payload = path.join(payloadDirectory, "hash.txt");
		const nestedJson = path.join(payloadDirectory, "unrelated.json");
		assert.equal(classifyPathAccess(repo, artifact, "read", { artifactRoots: [artifacts] }).access, "allow");
		assert.equal(classifyPathAccess(repo, payload, "read", { artifactRoots: [artifacts] }).access, "allow");
		assert.equal(classifyPathAccess(repo, nestedJson, "read", { artifactRoots: [artifacts] }).access, "allow");
		assert.equal(classifyPathAccess(repo, other, "read", { artifactRoots: [artifacts] }).access, "allow");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(artifacts, { recursive: true, force: true });
	}
});

test("real-path checks block symlink and junction escapes from write scopes", (t) => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-symlink-repo-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piplusplus-symlink-outside-"));
	try {
		const link = path.join(repo, "linked");
		try { fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
		catch (error) { t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`); return; }
		assert.equal(classifyPathAccess(repo, path.join("linked", "new.ts"), "edit").access, "ask");
		assert.equal(classifyPathAccess(repo, path.join("linked", "readme.txt"), "read").access, "allow");
		assert.equal(isPathWithinWriteScope(repo, path.join("linked", "new.ts"), ["linked"]), false);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("scoped agents require an explicit acknowledgement for unconfined shell and custom tools", () => {
	assert.equal(scopedToolRequiresExplicitApproval(request("bash", { command: "git status" }), ["src"]), false);
	assert.equal(scopedToolRequiresExplicitApproval(request("bash", { command: "npm test" }), ["src"]), true);
	assert.equal(scopedToolRequiresExplicitApproval(request("bash", { command: "printf x > src/file" }), ["src"]), true);
	assert.equal(scopedToolRequiresExplicitApproval(request("custom_mutator", {}), ["src"]), true);
	assert.equal(scopedToolRequiresExplicitApproval(request("bash", { command: "npm test" }), undefined), false);
});

test("parallel writes are considered overlapping only when another live scope can cover the target", () => {
	assert.equal(mutationOverlapsWriteScopes("/repo", "src/api/a.ts", [["src/api"]]), true);
	assert.equal(mutationOverlapsWriteScopes("/repo", "src/api/a.ts", [["src/ui"]]), false);
	assert.equal(mutationOverlapsWriteScopes("/repo", "src/api/a.ts", [undefined]), true);
});

test("permission service is an optional global dependency", () => {
	const service: PermissionService = { getMode: () => "auto", setMode: async () => {}, authorize: async () => true };
	installPermissionService(service);
	assert.equal(getPermissionService(), service);
	removePermissionService(service);
	assert.equal(getPermissionService(), undefined);
});
