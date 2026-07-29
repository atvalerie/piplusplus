import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PermissionMode, PermissionRequest } from "./types.ts";

export type PathAccess = "allow" | "ask" | "deny";
export type PathOperation = "read" | "edit";
export interface PathPolicyDecision {
	access: PathAccess;
	requestedPath: string;
	resolvedPath: string;
	explanation: string;
}
export interface PermissionDecision { allow: boolean; automatic: boolean; explanation: string; risk: "safe" | "caution" | "danger"; hardDeny?: boolean }
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const DANGEROUS = /(?:\bsudo\b|\brm\s+(?:-[^\s]*r|--recursive)|\b(?:chmod|chown|mkfs|mount|umount|kill|pkill)\b|\b(?:del|erase|rmdir)\b[^\r\n]*(?:\/s|\/q)|\bremove-item\b[^\r\n]*-(?:recurse|force)|\b(?:format|shutdown|taskkill|diskpart)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)|(?:^|\s)(?:curl|wget|ssh|scp|nc|invoke-webrequest|start-bitstransfer)\b|>\s*[\\/]|\|\s*(?:sh|bash|powershell|pwsh)\b|powershell[^\r\n]*(?:-enc|-encodedcommand))/i;
const SAFE_PROGRAM = /^(?:pwd|cd|pushd|popd|ls|dir|find|where|which|type|rg|ripgrep|grep|findstr|cat|head|tail|wc|file|stat|tree|du|df|ps|date|uname|id|whoami|hostname|locale|printenv|printf|echo|true|false|test|exit|sed|jq|get-childitem|get-content|select-string|write-output|write-host)$/i;

/** Split shell chains while respecting quoted operators; undefined means shell execution syntax is unsafe. */
function inspectionSegments(command: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const flush = () => { const segment = current.trim(); if (!segment) return false; segments.push(segment); current = ""; return true; };
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (escaped) { current += char; escaped = false; continue; }
		if (char === "\\" && quote !== "'") { current += char; escaped = true; continue; }
		if (quote) {
			if (char === quote) quote = undefined;
			if (char === "`" || (quote === '"' && char === "$" && command[index + 1] === "(")) return undefined;
			current += char;
			continue;
		}
		if (char === "'" || char === '"') { quote = char; current += char; continue; }
		if (char === "`" || (char === "$" && command[index + 1] === "(") || char === "<" || char === ">") return undefined;
		if (char === "&") {
			if (command[index + 1] !== "&" || !flush()) return undefined;
			index++;
			continue;
		}
		if (char === "|" || char === ";" || char === "\n" || char === "\r") {
			if (!flush()) return undefined;
			if (char === "|" && command[index + 1] === "|") index++;
			continue;
		}
		current += char;
	}
	if (quote || escaped || !current.trim() || !flush()) return undefined;
	return segments;
}

export function isSafeInspectionCommand(command: string): boolean {
	const segments = inspectionSegments(command);
	if (!segments) return false;
	return segments.every((segment) => {
		const match = segment.match(/^\s*([^\s]+)([\s\S]*)$/);
		if (!match) return false;
		const program = match[1];
		const args = match[2];
		if (program.toLowerCase() === "git") return /^\s+(?:status|diff|log|show|grep|ls-files|rev-parse)(?:\s|$)/i.test(args) && !/(?:^|\s)--output(?:=|\s)/i.test(args);
		if (!SAFE_PROGRAM.test(program)) return false;
		if (/^(?:rg|ripgrep)$/i.test(program) && /(?:^|\s)--pre(?:=|\s)/i.test(args)) return false;
		if (/^find$/i.test(program) && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)(?:\s|$)/i.test(args)) return false;
		if (/^sed$/i.test(program) && /(?:^|\s)(?:--in-place(?:=|\s|$)|-[a-z]*i(?:[a-z]*|[.=][^\s]*))(?:\s|$)/i.test(args)) return false;
		return true;
	});
}

/** Claude Code keeps a final prompt circuit-breaker for deleting filesystem roots or the user's home directory. */
export function isCriticalFilesystemRemoval(request: PermissionRequest, cwd = process.cwd()): boolean {
	if (request.toolName !== "bash") return false;
	const command = String(request.input.command ?? "");
	if (!/\b(?:rm|rmdir|del|erase|remove-item)\b/i.test(command)) return false;
	const root = path.parse(path.resolve(cwd)).root;
	const home = path.resolve(os.homedir());
	const tokens = command.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) ?? [];
	return tokens.some((raw) => {
		const token = raw.replace(/^(['"])(.*)\1$/, "$2").replace(/[),]+$/, "");
		if (["/", "~", "~/*", "$HOME", "$HOME/*", "${HOME}", "${HOME}/*"].includes(token)) return true;
		if (!path.isAbsolute(token)) return false;
		const withoutTrailingGlob = token.replace(/[\\/]\*$/, "");
		const resolved = path.resolve(withoutTrailingGlob);
		return resolved === root || resolved === home;
	});
}

export function scopedToolRequiresExplicitApproval(request: PermissionRequest, writePaths: string[] | undefined): boolean {
	if (!writePaths) return false;
	if (request.toolName === "bash") return !isSafeInspectionCommand(String(request.input.command ?? ""));
	return !["read", "grep", "find", "ls", "write", "edit"].includes(request.toolName);
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function realPathForTarget(target: string): string {
	let existing = target;
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	if (!fs.existsSync(existing)) return target;
	let realExisting: string;
	try { realExisting = fs.realpathSync.native(existing); } catch { return target; }
	return path.resolve(realExisting, path.relative(existing, target));
}

function resolvedPair(cwd: string, value: string): { cwdRequested: string; cwdResolved: string; requested: string; resolved: string } {
	const cwdRequested = path.resolve(cwd);
	const cwdResolved = realPathForTarget(cwdRequested);
	const requested = path.resolve(cwdRequested, value);
	const resolved = realPathForTarget(requested);
	return { cwdRequested, cwdResolved, requested, resolved };
}

function relativeSegments(root: string, target: string): string[] {
	return path.relative(root, target).split(/[\\/]+/).filter(Boolean).map((segment) => segment.toLowerCase());
}

const PROTECTED_DIRECTORIES = new Set([".git", ".pi", ".vscode", ".idea", ".husky"]);
const PROTECTED_FILES = new Set([
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".zshrc",
	".zprofile",
	".profile",
	".ripgreprc",
	".mcp.json",
	".claude.json",
]);
const CLAUDE_WRITABLE_DIRECTORIES = new Set(["commands", "agents", "skills", "worktrees"]);

/**
 * Match Claude Code's protected-write boundary. Sensitive reads are controlled
 * by explicit permission rules in Claude Code rather than an implicit .env/.ssh
 * deny, so this baseline intentionally protects writes only.
 */
function protectedWriteAccess(segments: string[]): { access: PathAccess; explanation: string } | undefined {
	if (segments.some((segment) => PROTECTED_DIRECTORIES.has(segment))) {
		return { access: "ask", explanation: "The path is repository metadata, Pi configuration, IDE configuration, or a hook location." };
	}
	const claudeIndex = segments.indexOf(".claude");
	if (claudeIndex >= 0) {
		const child = segments[claudeIndex + 1];
		if (!child || !CLAUDE_WRITABLE_DIRECTORIES.has(child)) {
			return { access: "ask", explanation: "The path is protected Claude configuration." };
		}
	}
	if (PROTECTED_FILES.has(segments.at(-1) ?? "")) {
		return { access: "ask", explanation: "The file is protected shell, repository, MCP, or Claude configuration." };
	}
	return undefined;
}

export function classifyPathAccess(
	cwd: string,
	value: unknown,
	operation: PathOperation,
	options: { artifactRoots?: string[] } = {},
): PathPolicyDecision {
	if (typeof value !== "string" || !value.trim()) {
		return { access: "deny", requestedPath: String(value), resolvedPath: String(value), explanation: "A concrete path is required." };
	}
	const pair = resolvedPair(cwd, value);
	if (operation === "read") {
		for (const root of options.artifactRoots ?? []) {
			const artifact = resolvedPair(root, ".");
			const requestedInside = inside(artifact.cwdRequested, pair.requested);
			const resolvedInside = inside(artifact.cwdResolved, pair.resolved);
			const relative = path.relative(artifact.cwdRequested, pair.requested);
			const [payloadDirectory] = relativeSegments(artifact.cwdRequested, pair.requested);
			const extension = path.extname(pair.requested).toLowerCase();
			const isArtifactIndex = extension === ".json" && !relative.includes(path.sep);
			const isArtifactPayload = extension === ".txt" && Boolean(payloadDirectory?.endsWith(".data"));
			if (requestedInside && resolvedInside && (isArtifactIndex || isArtifactPayload)) {
				return { access: "allow", requestedPath: pair.requested, resolvedPath: pair.resolved, explanation: isArtifactIndex ? "Read the workflow's JSON artifact." : "Read a large payload referenced by a workflow artifact." };
			}
		}
	}
	if (!inside(pair.cwdRequested, pair.requested)) {
		return {
			access: operation === "edit" ? "ask" : "allow",
			requestedPath: pair.requested,
			resolvedPath: pair.resolved,
			explanation: operation === "edit"
				? "The requested write path is outside the working directory."
				: "Read-only access outside the working directory.",
		};
	}
	if (!inside(pair.cwdResolved, pair.resolved)) {
		return {
			access: operation === "edit" ? "ask" : "allow",
			requestedPath: pair.requested,
			resolvedPath: pair.resolved,
			explanation: operation === "edit"
				? "The write path resolves through a symlink or junction outside the working directory."
				: "Read-only access through a symlink or junction outside the working directory.",
		};
	}
	if (operation === "edit") {
		const protectedPath = protectedWriteAccess(relativeSegments(pair.cwdRequested, pair.requested))
			?? protectedWriteAccess(relativeSegments(pair.cwdResolved, pair.resolved));
		if (protectedPath) return { ...protectedPath, requestedPath: pair.requested, resolvedPath: pair.resolved };
	}
	return { access: "allow", requestedPath: pair.requested, resolvedPath: pair.resolved, explanation: `The path is inside the workflow directory.` };
}

export function isPathWithinWriteScope(cwd: string, value: unknown, writePaths: string[] | undefined): boolean {
	if (!writePaths) return true;
	if (typeof value !== "string" || !writePaths.length) return false;
	const policy = classifyPathAccess(cwd, value, "edit");
	if (policy.access === "deny") return false;
	const target = resolvedPair(cwd, value);
	return writePaths.some((allowed) => {
		if (typeof allowed !== "string" || !allowed.trim()) return false;
		const root = resolvedPair(cwd, allowed);
		return inside(root.requested, target.requested) && inside(root.resolved, target.resolved)
			&& inside(target.cwdRequested, root.requested) && inside(target.cwdResolved, root.resolved);
	});
}

export function mutationOverlapsWriteScopes(cwd: string, target: unknown, otherScopes: Array<string[] | undefined>): boolean {
	return otherScopes.some((scope) => scope === undefined || isPathWithinWriteScope(cwd, target, scope));
}

export function explainPermission(
	request: PermissionRequest,
	cwd: string,
	mode: PermissionMode,
	options: { artifactRoots?: string[] } = {},
): PermissionDecision {
	if (READ_TOOLS.has(request.toolName)) {
		const pathPolicy = classifyPathAccess(cwd, request.input.path ?? ".", "read", options);
		if (pathPolicy.access === "deny") return { allow: false, automatic: true, hardDeny: true, risk: "danger", explanation: pathPolicy.explanation };
		if (pathPolicy.access === "ask") return { allow: false, automatic: false, risk: "caution", explanation: pathPolicy.explanation };
		return { allow: true, automatic: true, risk: "safe", explanation: `${pathPolicy.explanation} Read-only ${request.toolName} operation.` };
	}
	if (mode === "read-only") return { allow: false, automatic: true, risk: "caution", explanation: `${request.toolName} is blocked in read-only mode.` };
	if (request.toolName === "write" || request.toolName === "edit") {
		const target = request.input.path;
		const pathPolicy = classifyPathAccess(cwd, target, "edit", options);
		if (pathPolicy.access === "deny") return { allow: false, automatic: true, hardDeny: true, risk: "danger", explanation: pathPolicy.explanation };
		if (pathPolicy.access === "ask") return { allow: false, automatic: false, risk: "caution", explanation: pathPolicy.explanation };
		return { allow: mode === "auto", automatic: mode === "auto", risk: "caution", explanation: `Modify ${String(target)}. ${pathPolicy.explanation}` };
	}
	if (request.toolName === "bash") {
		const command = String(request.input.command ?? "");
		if (DANGEROUS.test(command)) return { allow: false, automatic: false, risk: "danger", explanation: "Command is destructive, privileged, networked, or pipes downloaded/generated data to a shell." };
		const safe = isSafeInspectionCommand(command);
		return { allow: mode === "auto" && safe, automatic: mode === "auto" && safe, risk: safe ? "safe" : "caution", explanation: safe ? "Read-only inspection command." : "Command can execute project code or has effects that cannot be proven safe automatically." };
	}
	return { allow: false, automatic: false, risk: "caution", explanation: `Custom tool “${request.toolName}” has no automatic safety policy.` };
}

export function acceptEditsAutoApproves(request: PermissionRequest, decision: PermissionDecision): boolean {
	if (READ_TOOLS.has(request.toolName)) return true;
	return (request.toolName === "write" || request.toolName === "edit") && decision.automatic && decision.allow;
}
