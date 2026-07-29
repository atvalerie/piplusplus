import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
const MAX_FINAL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_WORKER_EVENT_LINE_BYTES = 64 * 1024;
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
): (response: { id: string; allow: boolean; reason?: string }) => boolean {
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

export function buildChildSystemInstructions(agent: AgentState): string | undefined {
	const instructions: string[] = [];
	const profile = getWorkflowProfile(agent.profile);
	if (profile) instructions.push(`[Workflow specialist profile: ${profile.name}]\n${profile.instruction}`);
	const structuredContract = structuredOutputInstruction(agent.schema);
	if (structuredContract) instructions.push(structuredContract);
	return instructions.length ? instructions.join("\n\n") : undefined;
}

export function buildChildAgentArgs(
	agent: AgentState,
	model: Pick<Model, "provider" | "id">,
	appendSystemPromptPath?: string,
): string[] {
	const args = ["--mode", "text", "-p", "--no-session", "-e", fileURLToPath(new URL("./permission-child.ts", import.meta.url)), "--model", `${model.provider}/${model.id}`];
	const thinking = agent.effectiveThinking ?? agent.thinking;
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	if (appendSystemPromptPath) args.push("--append-system-prompt", appendSystemPromptPath);
	return args;
}

export interface PreparedChildAgentLaunch {
	args: string[];
	stdin: string;
	systemPromptFile?: string;
	cleanup: () => void;
}

/**
 * Windows CreateProcess has a small command-line limit. Prompts therefore
 * travel over stdin, while Pi's file-aware --append-system-prompt receives
 * only a short temporary path.
 */
export function prepareChildAgentLaunch(
	agent: AgentState,
	model: Pick<Model, "provider" | "id">,
	tempRoot = os.tmpdir(),
): PreparedChildAgentLaunch {
	const systemInstructions = buildChildSystemInstructions(agent);
	let tempDir: string | undefined;
	let systemPromptFile: string | undefined;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (systemPromptFile) {
			try { fs.rmSync(systemPromptFile, { force: true }); } catch { /* best effort */ }
		}
		if (tempDir) {
			try { fs.rmdirSync(tempDir); } catch { /* best effort */ }
		}
	};
	try {
		if (systemInstructions) {
			tempDir = fs.mkdtempSync(path.join(tempRoot, "piplusplus-worker-"));
			systemPromptFile = path.join(tempDir, "system-prompt.md");
			fs.writeFileSync(systemPromptFile, systemInstructions, { encoding: "utf8", mode: 0o600 });
		}
		return {
			args: buildChildAgentArgs(agent, model, systemPromptFile),
			stdin: agent.prompt,
			systemPromptFile,
			cleanup,
		};
	} catch (error) {
		cleanup();
		throw error;
	}
}

export function formatChildInvocationForLog(command: string, args: string[]): string {
	const visible: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const value = args[index];
		visible.push(value);
		if (value === "--append-system-prompt" && index + 1 < args.length) {
			visible.push("[workflow-system-prompt-file]");
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
	const usage = zeroUsage();
	let launch: PreparedChildAgentLaunch;
	try {
		launch = prepareChildAgentLaunch(agent, model);
	} catch (error) {
		return {
			exitCode: 1,
			output: "",
			stderr: `Could not prepare workflow worker input: ${error instanceof Error ? error.message : String(error)}`,
			usage,
		};
	}
	const call = invocation(launch.args);
	let finalAssistantOutput = "";
	let stderr = "";
	let finalOutputBytes = 0;
	let stderrBytes = 0;
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let selectedModel: string | undefined;
	let stopReason: string | undefined;
	let settled = false;
	let turnLimitTerminated = false;
	let outputLimitExceeded = false;
	let errorMessage: string | undefined;

	const exitCode = await new Promise<number>((resolve) => {
		let resolved = false;
		const resolveOnce = (code: number) => {
			if (resolved) return;
			resolved = true;
			resolve(code);
		};
		const addLog = (entry: AgentState["logs"][number]) => {
			if (agent.logs.length < MAX_LOG_EVENTS) agent.logs.push(entry);
			else agent.droppedLogEvents = (agent.droppedLogEvents ?? 0) + 1;
		};
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(call.command, call.args, {
				cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
				env: { ...process.env, [CHILD_ENV]: "1", PIPLUSPLUS_PERMISSION_IPC: "1" },
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch (error) {
			launch.cleanup();
			stderr = error instanceof Error ? error.message : String(error);
			resolveOnce(1);
			return;
		}
		agent.process = proc;
		const turnLimitGuard = createTurnLimitGuard(agent.maxTurns, () => {
			turnLimitTerminated = true;
			stopReason = "max_turns";
			errorMessage = `Worker reached maxTurns (${agent.maxTurns}) before completing`;
			addLog({ at: Date.now(), type: "max_turns", message: errorMessage });
			terminateProcessTree(proc);
		});
		addLog({ at: Date.now(), type: "process_start", message: formatChildInvocationForLog(call.command, call.args) });
		proc.stdin?.on("error", (error) => {
			if (!isClosedPermissionPipeError(error)) addLog({ at: Date.now(), type: "stdin_error", message: error.message });
		});
		proc.stdin?.end(launch.stdin);

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
					let reason: string | undefined;
					try {
						const permissionRequest: PermissionRequest = { agentId: agent.id, agentLabel: agent.label, toolName: request.toolName, input: request.input };
						allow = await onPermission(permissionRequest);
						reason = permissionRequest.denialReason;
					} catch (error) {
						addLog({
							at: Date.now(),
							type: "permission_handler_error",
							message: error instanceof Error ? error.message : String(error),
						});
					}
					writePermissionResponse({ id: request.id, allow, reason });
				})();
			});
		}

		const toolCallIndexes = new Map<string, number>();
		const processWorkerEvent = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try { event = JSON.parse(line); } catch { addLog({ at: Date.now(), type: "unparsed_worker_event", message: line.slice(0, 8_192) }); return; }
			agent.observedEvents = (agent.observedEvents ?? 0) + 1;
			if (event.type === "agent_settled") {
				settled = true;
			}
			if (event.type === "tool_execution_start") {
				if (agent.toolCalls.length < MAX_TOOL_CALLS) {
					const index = agent.toolCalls.push({ name: event.toolName ?? "tool", args: compactToolArgs(event.args) }) - 1;
					if (typeof event.toolCallId === "string") toolCallIndexes.set(event.toolCallId, index);
				} else {
					agent.droppedToolCalls = (agent.droppedToolCalls ?? 0) + 1;
				}
				onUpdate();
			}
			if (event.type === "tool_execution_end" && event.isError) {
				const index = typeof event.toolCallId === "string" ? toolCallIndexes.get(event.toolCallId) : undefined;
				if (index !== undefined && agent.toolCalls[index]) agent.toolCalls[index].error = true;
				onUpdate();
			}
			if (event.type === "message_end") {
				agent.observedMessages = (agent.observedMessages ?? 0) + 1;
				if (event.role === "assistant") {
					usage.turns++;
					agent.usage.turns++;
					const current = event.usage;
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
					selectedModel ||= event.model;
					if (!turnLimitTerminated) {
						stopReason = event.stopReason;
						errorMessage = event.errorMessage;
					}
					const guardMessage = {
						role: "assistant",
						content: event.hasToolCall ? [{ type: "toolCall" }] : [],
						stopReason: event.stopReason,
					} as Message;
					turnLimitGuard(guardMessage, usage.turns);
				}
				onUpdate();
			}
		};

		const workerEvents = proc.stdio[5];
		if (workerEvents) {
			const events = readline.createInterface({ input: workerEvents });
			events.on("line", (line) => {
				if (outputLimitExceeded) return;
				if (Buffer.byteLength(line, "utf8") > MAX_WORKER_EVENT_LINE_BYTES) {
					outputLimitExceeded = true;
					stderr += `Workflow worker emitted an oversized IPC event (>${MAX_WORKER_EVENT_LINE_BYTES} bytes)`;
					terminateProcessTree(proc);
					return;
				}
				processWorkerEvent(line);
			});
			workerEvents.on("error", (error) => {
				if (!isClosedPermissionPipeError(error)) addLog({ at: Date.now(), type: "worker_ipc_error", message: error.message });
			});
		}

		proc.stdout?.on("data", (chunk: Buffer) => {
			if (outputLimitExceeded) return;
			finalOutputBytes += chunk.length;
			if (finalOutputBytes > MAX_FINAL_OUTPUT_BYTES) {
				outputLimitExceeded = true;
				stderr += `Workflow worker final response exceeded ${MAX_FINAL_OUTPUT_BYTES} bytes`;
				terminateProcessTree(proc);
				return;
			}
			finalAssistantOutput += stdoutDecoder.write(chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes <= MAX_STDERR_BYTES) stderr += stderrDecoder.write(chunk);
		});
		proc.on("error", (error) => {
			agent.process = undefined;
			launch.cleanup();
			stderr += error.message;
			resolveOnce(1);
		});
		proc.on("close", (code) => {
			agent.process = undefined;
			if (!outputLimitExceeded) finalAssistantOutput += stdoutDecoder.end();
			else stdoutDecoder.end();
			finalAssistantOutput = finalAssistantOutput.trim();
			stderr += stderrDecoder.end();
			if (stderrBytes > MAX_STDERR_BYTES) stderr += `\n[stderr truncated after ${MAX_STDERR_BYTES} bytes]`;
			if (stderr.trim()) addLog({ at: Date.now(), type: "stderr", message: stderr.trim() });
			addLog({ at: Date.now(), type: "process_exit", message: String(code ?? 1) });
			launch.cleanup();
			resolveOnce(outputLimitExceeded ? 1 : settled ? 0 : code ?? 1);
		});
	});

	return {
		exitCode,
		output: finalAssistantOutput,
		stderr,
		usage,
		model: selectedModel,
		stopReason,
		errorMessage,
	};
}
