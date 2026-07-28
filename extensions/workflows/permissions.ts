import * as path from "node:path";
import type { PermissionMode, PermissionRequest } from "./types.ts";

export interface PermissionDecision { allow: boolean; automatic: boolean; explanation: string; risk: "safe" | "caution" | "danger" }
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const DANGEROUS = /(?:\bsudo\b|\brm\s+(?:-[^\s]*r|--recursive)|\b(?:chmod|chown|mkfs|mount|umount|kill|pkill)\b|\b(?:del|erase|rmdir)\b[^\r\n]*(?:\/s|\/q)|\bremove-item\b[^\r\n]*-(?:recurse|force)|\b(?:format|shutdown|taskkill|diskpart)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)|(?:^|\s)(?:curl|wget|ssh|scp|nc|invoke-webrequest|start-bitstransfer)\b|>\s*[\\/]|\|\s*(?:sh|bash|powershell|pwsh)\b|powershell[^\r\n]*(?:-enc|-encodedcommand))/i;
const SAFE_COMMAND = /^\s*(?:pwd|ls(?:\s|$)|dir(?:\s|$)|find(?:\s|$)|where(?:\s|$)|rg(?:\s|$)|grep(?:\s|$)|findstr(?:\s|$)|(?:get-childitem|get-content|select-string)(?:\s|$)|git\s+(?:status|diff|log|show)(?:\s|$))[^;&|><`$]*$/i;

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
		const safe = SAFE_COMMAND.test(command);
		return { allow: mode === "auto" && safe, automatic: mode === "auto" && safe, risk: safe ? "safe" : "caution", explanation: safe ? "Read-only inspection command." : "Command can execute project code or has effects that cannot be proven safe automatically." };
	}
	return { allow: false, automatic: false, risk: "caution", explanation: `Custom tool “${request.toolName}” has no automatic safety policy.` };
}
