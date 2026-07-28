import * as path from "node:path";
import type { PermissionMode, PermissionRequest } from "./types.ts";

export interface PermissionDecision { allow: boolean; automatic: boolean; explanation: string; risk: "safe" | "caution" | "danger" }
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

function inside(cwd: string, value: unknown): boolean {
	if (typeof value !== "string") return false;
	const target = path.resolve(cwd, value);
	const relative = path.relative(cwd, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function explainPermission(request: PermissionRequest, cwd: string, mode: PermissionMode): PermissionDecision {
	if (READ_TOOLS.has(request.toolName)) return { allow: true, automatic: true, risk: "safe", explanation: `Read-only ${request.toolName} operation.` };
	if (mode === "read-only") return { allow: false, automatic: true, risk: "caution", explanation: `${request.toolName} is blocked in read-only mode.` };
	if (request.toolName === "write" || request.toolName === "edit") {
		const target = request.input.path;
		const safeTarget = inside(cwd, target) && typeof target === "string" && !/(?:^|[\\/])(?:\.git|\.env|\.ssh)(?:[\\/]|$)/i.test(target);
		return { allow: mode === "auto" && safeTarget, automatic: mode === "auto" && safeTarget, risk: safeTarget ? "caution" : "danger", explanation: safeTarget ? `Modify ${String(target)} inside the workflow directory.` : `Target ${String(target)} is outside the workflow directory or sensitive.` };
	}
	if (request.toolName === "bash") {
		const command = String(request.input.command ?? "");
		if (DANGEROUS.test(command)) return { allow: false, automatic: false, risk: "danger", explanation: "Command is destructive, privileged, networked, or pipes downloaded/generated data to a shell." };
		const safe = isSafeInspectionCommand(command);
		return { allow: mode === "auto" && safe, automatic: mode === "auto" && safe, risk: safe ? "safe" : "caution", explanation: safe ? "Read-only inspection command." : "Command can execute project code or has effects that cannot be proven safe automatically." };
	}
	return { allow: false, automatic: false, risk: "caution", explanation: `Custom tool “${request.toolName}” has no automatic safety policy.` };
}
