import * as fs from "node:fs";
import * as readline from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const enabled = process.env.PIPLUSPLUS_PERMISSION_IPC === "1";
// When fd is supplied Node ignores this placeholder path; avoiding /dev/null keeps IPC portable.
const output = enabled ? fs.createWriteStream("permission-ipc-output", { fd: 3 }) : undefined;
const eventOutput = enabled ? fs.createWriteStream("workflow-event-output", { fd: 5 }) : undefined;
const pending = new Map<string, (result: { allow: boolean; reason?: string }) => void>();
let sequence = 0;
let input: readline.Interface | undefined;
let inputStream: fs.ReadStream | undefined;
let closing: Promise<void> | undefined;

function compactIpcValue(value: unknown): unknown {
	let json: string;
	try { json = JSON.stringify(value); }
	catch { return { unavailable: true }; }
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes <= 8 * 1024) return value;
	return { truncated: true, bytes, preview: `${json.slice(0, 8 * 1024)}…` };
}

function writeWorkerEvent(event: Record<string, unknown>): void {
	if (!eventOutput || eventOutput.destroyed || eventOutput.writableEnded) return;
	try { eventOutput.write(`${JSON.stringify(event)}\n`); } catch { /* parent will detect a missing/failed worker */ }
}

function endStream(stream: fs.WriteStream | undefined): Promise<void> {
	if (!stream || stream.destroyed || stream.writableEnded) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => resolve();
		stream.once("error", done);
		stream.end(done);
	});
}

if (enabled) {
	output?.on("error", () => { /* parent close/error is handled as a denied request */ });
	eventOutput?.on("error", () => { /* parent owns workflow failure reporting */ });
	inputStream = fs.createReadStream("permission-ipc-input", { fd: 4 });
	input = readline.createInterface({ input: inputStream });
	input.on("line", (line) => {
		try {
			const message = JSON.parse(line) as { id: string; allow: boolean; reason?: string };
			pending.get(message.id)?.({ allow: message.allow, reason: message.reason });
			pending.delete(message.id);
		} catch { /* fail closed through child exit/abort */ }
	});
}

export default function permissionChild(pi: ExtensionAPI) {
	if (!enabled || !output || !eventOutput) return;
	const close = (): Promise<void> => {
		if (closing) return closing;
		input?.close();
		inputStream?.destroy();
		for (const resolve of pending.values()) resolve({ allow: false, reason: "Permission channel closed before a decision was returned." });
		pending.clear();
		closing = Promise.all([endStream(output), endStream(eventOutput)]).then(() => undefined);
		return closing;
	};
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") {
			writeWorkerEvent({ type: "message_end", role: message.role });
			return;
		}
		writeWorkerEvent({
			type: "message_end",
			role: "assistant",
			hasToolCall: message.content.some((part) => part.type === "toolCall"),
			usage: message.usage,
			model: message.model,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
		});
	});
	pi.on("tool_execution_start", (event) => {
		writeWorkerEvent({
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: compactIpcValue(event.args),
		});
	});
	pi.on("tool_execution_end", (event) => {
		writeWorkerEvent({
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			isError: event.isError,
		});
	});
	pi.on("agent_settled", async () => {
		writeWorkerEvent({ type: "agent_settled" });
		await close();
	});
	pi.on("session_shutdown", close);
	pi.on("tool_call", async (event) => {
		const id = `permission_${++sequence}`;
		const result = await new Promise<{ allow: boolean; reason?: string }>((resolve) => {
			pending.set(id, resolve);
			output.write(`${JSON.stringify({ id, toolName: event.toolName, input: event.input })}\n`);
		});
		return result.allow ? undefined : { block: true, reason: result.reason ?? "Workflow tool call denied by permission policy or user" };
	});
}
