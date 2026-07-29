import * as fs from "node:fs";
import * as readline from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const enabled = process.env.PIPLUSPLUS_PERMISSION_IPC === "1";
// When fd is supplied Node ignores this placeholder path; avoiding /dev/null keeps IPC portable.
const output = enabled ? fs.createWriteStream("permission-ipc-output", { fd: 3 }) : undefined;
const pending = new Map<string, (result: { allow: boolean; reason?: string }) => void>();
let sequence = 0;
let input: readline.Interface | undefined;
let inputStream: fs.ReadStream | undefined;

if (enabled) {
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
	if (!enabled || !output) return;
	const close = () => {
		input?.close();
		inputStream?.destroy();
		output.destroy();
		for (const resolve of pending.values()) resolve({ allow: false, reason: "Permission channel closed before a decision was returned." });
		pending.clear();
	};
	pi.on("agent_settled", close);
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
