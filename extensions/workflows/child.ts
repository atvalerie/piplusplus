import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentState, ChildResult } from "./types.ts";
import { zeroUsage } from "./types.ts";

const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";

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

export async function runChildAgent(
	cwd: string,
	agent: AgentState,
	model: Model,
	onUpdate: () => void,
): Promise<ChildResult> {
	const args = ["--mode", "json", "-p", "--no-session", "--model", `${model.provider}/${model.id}`];
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	args.push(agent.prompt);
	const call = invocation(args);
	const messages: Message[] = [];
	const usage = zeroUsage();
	let stderr = "";
	let buffer = "";
	let selectedModel: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(call.command, call.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, [CHILD_ENV]: "1" },
		});
		agent.process = proc;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try { event = JSON.parse(line); } catch { return; }
			if (event.type === "tool_execution_start" || event.type === "tool_call_start") {
				agent.toolCalls.push({ name: event.toolName ?? "tool", args: event.args });
				onUpdate();
			}
			if (event.type === "tool_execution_end" && event.isError && agent.toolCalls.length) {
				agent.toolCalls[agent.toolCalls.length - 1].error = true;
				onUpdate();
			}
			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				const message = event.message as Message;
				messages.push(message);
				if (message.role === "assistant") {
					usage.turns++;
					const current = message.usage;
					if (current) {
						usage.input += current.input || 0;
						usage.output += current.output || 0;
						usage.cacheRead += current.cacheRead || 0;
						usage.cacheWrite += current.cacheWrite || 0;
						usage.cost += current.cost?.total || 0;
					}
					selectedModel ||= message.model;
					stopReason = message.stopReason;
					errorMessage = message.errorMessage;
				}
				onUpdate();
			}
		};

		proc.stdout?.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
		proc.on("error", (error) => { stderr += error.message; resolve(1); });
		proc.on("close", (code) => {
			agent.process = undefined;
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 1);
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
