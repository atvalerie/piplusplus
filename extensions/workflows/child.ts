import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentState, ChildResult, PermissionRequest } from "./types.ts";
import { terminateProcessTree } from "./processes.ts";
import { getWorkflowProfile, structuredOutputInstruction } from "./profiles.ts";
import { zeroUsage } from "./types.ts";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_LOG_EVENTS = 2_000;
const MAX_TOOL_CALLS = 500;
const CLOSED_PERMISSION_PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

export function isClosedPermissionPipeError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && CLOSED_PERMISSION_PIPE_CODES.has(String((error as NodeJS.ErrnoException).code)));
}

/**
 * Child permission requests can outlive the child process by a few event-loop
 * turns while a user decision is pending. Keep that normal close/write race
 * local to the IPC channel instead of letting its EPIPE escape as an
 * uncaughtException in the parent Pi process.
 */
export function createPermissionResponseWriter(
	stream: Writable,
	onUnexpectedError: (error: Error) => void = () => {},
): (response: { id: string; allow: boolean }) => boolean {
	let closed = stream.destroyed || stream.writableEnded || !stream.writable;
	const handleError = (error: Error) => {
		closed = true;
		if (!isClosedPermissionPipeError(error)) onUnexpectedError(error);
	};
	stream.on("error", handleError);
	stream.on("close", () => { closed = true; });
	stream.on("finish", () => { closed = true; });
	return (response) => {
		if (closed || stream.destroyed || stream.writableEnded || !stream.writable) return false;
		try {
			stream.write(`${JSON.stringify(response)}\n`);
			return true;
		} catch (error) {
			handleError(error instanceof Error ? error : new Error(String(error)));
			return false;
		}
	};
}

function invocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const name = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(name)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
		if (text) return text;
	}
	return "";
}

export function buildChildAgentArgs(agent: AgentState, model: Pick<Model, "provider" | "id">): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "-e", fileURLToPath(new URL("./permission-child.ts", import.meta.url)), "--model", `${model.provider}/${model.id}`];
	const thinking = agent.effectiveThinking ?? agent.thinking;
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	const systemInstructions: string[] = [];
	const profile = getWorkflowProfile(agent.profile);
	if (profile) systemInstructions.push(`[Workflow specialist profile: ${profile.name}]\n${profile.instruction}`);
	const structuredContract = structuredOutputInstruction(agent.schema);
	if (structuredContract) systemInstructions.push(structuredContract);
	if (systemInstructions.length) args.push("--append-system-prompt", systemInstructions.join("\n\n"));
	args.push(agent.prompt);
	return args;
}

export function formatChildInvocationForLog(command: string, args: string[]): string {
	const visible: string[] = [];
	for (let index = 0; index < args.length - 1; index++) {
		const value = args[index];
		visible.push(value);
		if (value === "--append-system-prompt" && index + 1 < args.length - 1) {
			visible.push("[structured-output-contract]");
			index++;
		}
	}
	return `${command} ${visible.join(" ")}`;
}

export function shouldTerminateAtTurnLimit(message: Message, turns: number, maxTurns: number | undefined): boolean {
	if (!maxTurns || turns < maxTurns || message.role !== "assistant") return false;
	const hasToolCall = message.content.some((part) => part.type === "toolCall");
	return hasToolCall || message.stopReason === "toolUse" || message.stopReason === "tool_use";
}

export function createTurnLimitGuard(maxTurns: number | undefined, terminate: () => void): (message: Message, turns: number) => boolean {
	let terminated = false;
	return (message, turns) => {
		if (terminated || !shouldTerminateAtTurnLimit(message, turns, maxTurns)) return false;
		terminated = true;
		terminate();
		return true;
	};
}

function compactToolArgs(value: unknown): unknown {
	if (value === undefined) return undefined;
	let json: string;
	try { json = JSON.stringify(value); }
	catch { return { unavailable: true }; }
	if (Buffer.byteLength(json, "utf8") <= 8 * 1024) return value;
	return { truncated: true, bytes: Buffer.byteLength(json, "utf8"), preview: `${json.slice(0, 8 * 1024)}…` };
}

export async function runChildAgent(
	cwd: string,
	agent: AgentState,
	model: Model,
	onUpdate: () => void,
	onPermission: (request: PermissionRequest) => Promise<boolean>,
): Promise<ChildResult> {
	const args = buildChildAgentArgs(agent, model);
	const call = invocation(args);
	const messages: Message[] = [];
	const usage = zeroUsage();
	let stderr = "";
	let buffer = "";
	let stdoutBytes = 0;
	let stderrBytes = 0;
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let selectedModel: string | undefined;
	let stopReason: string | undefined;
	let settled = false;
	let turnLimitTerminated = false;
	let errorMessage: string | undefined;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(call.command, call.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
			env: { ...process.env, [CHILD_ENV]: "1", PIPLUSPLUS_PERMISSION_IPC: "1" },
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		agent.process = proc;
		const addLog = (entry: AgentState["logs"][number]) => {
			if (agent.logs.length < MAX_LOG_EVENTS) agent.logs.push(entry);
			else agent.droppedLogEvents = (agent.droppedLogEvents ?? 0) + 1;
		};
		const turnLimitGuard = createTurnLimitGuard(agent.maxTurns, () => {
			turnLimitTerminated = true;
			stopReason = "max_turns";
			errorMessage = `Worker reached maxTurns (${agent.maxTurns}) before completing`;
			addLog({ at: Date.now(), type: "max_turns", message: errorMessage });
			terminateProcessTree(proc);
		});
		addLog({ at: Date.now(), type: "process_start", message: formatChildInvocationForLog(call.command, call.args) });
		const permissionOutput = proc.stdio[3];
		const permissionInput = proc.stdio[4];
		if (permissionOutput && permissionInput) {
			const requests = readline.createInterface({ input: permissionOutput });
			const writePermissionResponse = createPermissionResponseWriter(permissionInput, (error) => {
				addLog({ at: Date.now(), type: "permission_ipc_error", message: error.message });
			});
			requests.on("line", (line) => {
				void (async () => {
					let request: { id: string; toolName: string; input: Record<string, unknown> };
					try { request = JSON.parse(line); } catch { return; }
					let allow = false;
					try {
						allow = await onPermission({ agentId: agent.id, agentLabel: agent.label, toolName: request.toolName, input: request.input });
					} catch (error) {
						addLog({
							at: Date.now(),
							type: "permission_handler_error",
							message: error instanceof Error ? error.message : String(error),
						});
					}
					writePermissionResponse({ id: request.id, allow });
				})();
			});
		}

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try { event = JSON.parse(line); } catch { addLog({ at: Date.now(), type: "unparsed_output", message: line.slice(0, 8_192) }); return; }
			agent.observedEvents = (agent.observedEvents ?? 0) + 1;
			if (event.type === "agent_settled") {
				settled = true;
				setTimeout(() => { if (agent.process === proc) terminateProcessTree(proc); }, 100).unref();
			}
			if (event.type === "tool_execution_start" || event.type === "tool_call_start") {
				if (agent.toolCalls.length < MAX_TOOL_CALLS) agent.toolCalls.push({ name: event.toolName ?? "tool", args: compactToolArgs(event.args) });
				else agent.droppedToolCalls = (agent.droppedToolCalls ?? 0) + 1;
				onUpdate();
			}
			if (event.type === "tool_execution_end" && event.isError && agent.toolCalls.length) {
				agent.toolCalls[agent.toolCalls.length - 1].error = true;
				onUpdate();
			}
			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				const message = event.message as Message;
				messages.push(message);
				agent.observedMessages = (agent.observedMessages ?? 0) + 1;
				if (message.role === "assistant") {
					usage.turns++;
					agent.usage.turns++;
					const current = message.usage;
					if (current) {
						const input = current.input || 0;
						const output = current.output || 0;
						const cacheRead = current.cacheRead || 0;
						const cacheWrite = current.cacheWrite || 0;
						const cost = current.cost?.total || 0;
						usage.input += input; agent.usage.input += input;
						usage.output += output; agent.usage.output += output;
						usage.cacheRead += cacheRead; agent.usage.cacheRead += cacheRead;
						usage.cacheWrite += cacheWrite; agent.usage.cacheWrite += cacheWrite;
						usage.cost += cost; agent.usage.cost += cost;
					}
					selectedModel ||= message.model;
					if (!turnLimitTerminated) {
						stopReason = message.stopReason;
						errorMessage = message.errorMessage;
					}
					turnLimitGuard(message, usage.turns);
				}
				onUpdate();
			}
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_STREAM_BYTES) { stderr += `Workflow worker output exceeded ${MAX_STREAM_BYTES} bytes`; terminateProcessTree(proc); return; }
			buffer += stdoutDecoder.write(chunk);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			if (Buffer.byteLength(buffer) > MAX_STREAM_BYTES) { stderr += "Workflow worker emitted an oversized NDJSON line"; terminateProcessTree(proc); return; }
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes <= MAX_STDERR_BYTES) stderr += stderrDecoder.write(chunk);
		});
		proc.on("error", (error) => { stderr += error.message; resolve(1); });
		proc.on("close", (code) => {
			agent.process = undefined;
			buffer += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			if (stderrBytes > MAX_STDERR_BYTES) stderr += `\n[stderr truncated after ${MAX_STDERR_BYTES} bytes]`;
			if (buffer.trim()) processLine(buffer);
			if (stderr.trim()) addLog({ at: Date.now(), type: "stderr", message: stderr.trim() });
			addLog({ at: Date.now(), type: "process_exit", message: String(code ?? 1) });
			resolve(settled ? 0 : code ?? 1);
		});
	});

	return {
		exitCode,
		output: finalText(messages),
		stderr,
		usage,
		model: selectedModel,
		stopReason,
		errorMessage,
	};
}
