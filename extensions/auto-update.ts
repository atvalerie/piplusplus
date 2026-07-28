/**
 * Keep installed Pi packages current.
 *
 * Pi has no separate package-update check command: `pi update --extensions`
 * checks for and installs updates for unpinned packages. The loaded extension
 * code is refreshed the next time Pi starts or after `/reload`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;
const UPDATE_TIMEOUT_MS = 120_000;

export interface PiInvocation { command: string; args: string[] }

/** Invoke the running Pi entry point directly; Windows cannot spawn npm's pi.cmd without cmd.exe. */
export function resolvePiInvocation(options: { platform?: NodeJS.Platform; execPath?: string; argv1?: string; exists?: (file: string) => boolean } = {}): PiInvocation {
	const platform = options.platform ?? process.platform;
	const execPath = options.execPath ?? process.execPath;
	const argv1 = Object.prototype.hasOwnProperty.call(options, "argv1") ? options.argv1 : process.argv[1];
	const exists = options.exists ?? fs.existsSync;
	const executable = (platform === "win32" ? path.win32.basename(execPath) : path.basename(execPath)).toLowerCase();
	const nodeRuntime = /^(?:node|bun)(?:\.exe)?$/.test(executable);
	if (nodeRuntime && argv1 && !argv1.startsWith("/$bunfs/root/") && !/\.(?:cmd|bat|exe)$/i.test(argv1) && exists(argv1)) {
		return { command: execPath, args: [argv1, "update", "--extensions"] };
	}
	if (!nodeRuntime) return { command: execPath, args: ["update", "--extensions"] };
	if (platform === "win32") return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "pi update --extensions"] };
	return { command: "pi", args: ["update", "--extensions"] };
}

function intervalFrom(value: boolean | string | undefined): number {
	if (typeof value !== "string") return DEFAULT_INTERVAL_MINUTES;

	const minutes = Number(value);
	if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) {
		return DEFAULT_INTERVAL_MINUTES;
	}

	return Math.floor(minutes);
}

export default function autoUpdateExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let updateInProgress = false;

	pi.registerFlag("extension-update-interval", {
		description: "Minutes between automatic Pi package updates (default: 60)",
		type: "string",
		default: String(DEFAULT_INTERVAL_MINUTES),
	});

	async function updateExtensions(ctx: ExtensionContext, source: "startup" | "scheduled" | "manual") {
		if (updateInProgress) return;
		updateInProgress = true;

		try {
			const invocation = resolvePiInvocation();
			const result = await pi.exec(invocation.command, invocation.args, {
				timeout: UPDATE_TIMEOUT_MS,
			});

			if (result.code === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						source === "scheduled"
							? "Pi extension update check completed."
							: "Pi extension update check completed. Restart or use /reload to load updated code.",
						"info",
					);
				}
				return;
			}

			if (ctx.hasUI) {
				const detail = (result.stderr || result.stdout).trim().replace(/\x1b\[[0-9;]*m/g, "").slice(-1_200);
				ctx.ui.notify(`Pi extension update failed (exit code ${result.code ?? "unknown"})${result.killed ? " · timed out" : ""}.${detail ? `\n${detail}` : ""}`, "warning");
			}
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Pi extension update failed: ${message}`, "warning");
			}
		} finally {
			updateInProgress = false;
		}
	}

	pi.registerCommand("extension-update", {
		description: "Check for and install updates for unpinned Pi packages",
		handler: async (_args, ctx) => {
			await updateExtensions(ctx, "manual");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const intervalMinutes = intervalFrom(pi.getFlag("extension-update-interval"));

		// Long-lived resources must start from session_start, not the factory.
		await updateExtensions(ctx, "startup");
		timer = setInterval(() => {
			void updateExtensions(ctx, "scheduled");
		}, intervalMinutes * 60_000);
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
