/**
 * Keep installed Pi packages current.
 *
 * Pi has no separate package-update check command: `pi update --extensions`
 * checks for and installs updates for unpinned packages. The loaded extension
 * code is refreshed the next time Pi starts or after `/reload`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPiPlusPlusSettingsSection } from "./shared/settings-service.ts";

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;
const UPDATE_TIMEOUT_MS = 120_000;
const CHILD_ENV = "PIPLUSPLUS_WORKFLOW_CHILD";

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
	if (process.env[CHILD_ENV] === "1") return;
	const configPath = path.join(getAgentDir(), "piplusplus-auto-update.json");
	let configuredInterval: number | undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as { intervalMinutes?: unknown };
		if (typeof parsed.intervalMinutes === "number" && Number.isFinite(parsed.intervalMinutes) && parsed.intervalMinutes >= MIN_INTERVAL_MINUTES) configuredInterval = Math.floor(parsed.intervalMinutes);
	} catch { /* use flag/default */ }
	let intervalMinutes = configuredInterval ?? DEFAULT_INTERVAL_MINUTES;
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

	const schedule = (ctx: ExtensionContext) => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => { void updateExtensions(ctx, "scheduled"); }, intervalMinutes * 60_000);
	};
	const persistInterval = async () => {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
		const temp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			await fs.promises.writeFile(temp, `${JSON.stringify({ intervalMinutes }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			await fs.promises.rename(temp, configPath);
			try { await fs.promises.chmod(configPath, 0o600); } catch { /* best effort */ }
		} finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
	};

	pi.registerCommand("extension-update", {
		description: "Check for and install updates for unpinned Pi packages",
		handler: async (_args, ctx) => {
			await updateExtensions(ctx, "manual");
		},
	});

	const unregisterSettings = registerPiPlusPlusSettingsSection({
		id: "maintenance",
		label: "Maintenance",
		description: "Automatic update interval and immediate extension update checks",
		order: 50,
		summary: () => `updates every ${intervalMinutes} min`,
		open: async (ctx) => {
			while (ctx.hasUI) {
				const intervalItem = `Automatic update interval · ${intervalMinutes} minutes`;
				const selected = await ctx.ui.select("Pi++ maintenance", [intervalItem, "Check for extension updates now", "Back"]);
				if (!selected || selected === "Back") return;
				if (selected === "Check for extension updates now") { await updateExtensions(ctx, "manual"); continue; }
				const entered = await ctx.ui.input("Minutes between extension update checks", `Minimum ${MIN_INTERVAL_MINUTES}`);
				if (entered === undefined) continue;
				const parsed = Number(entered.trim());
				if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MINUTES) { ctx.ui.notify(`Update interval must be at least ${MIN_INTERVAL_MINUTES} minute.`, "error"); continue; }
				const previous = intervalMinutes;
				intervalMinutes = Math.floor(parsed);
				try { await persistInterval(); schedule(ctx); ctx.ui.notify(`Automatic update interval: ${intervalMinutes} minutes.`, "info"); }
				catch (error) { intervalMinutes = previous; ctx.ui.notify(`Could not save update interval: ${error instanceof Error ? error.message : String(error)}`, "error"); }
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (configuredInterval === undefined) intervalMinutes = intervalFrom(pi.getFlag("extension-update-interval"));

		// Long-lived resources must start from session_start, not the factory.
		await updateExtensions(ctx, "startup");
		schedule(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		unregisterSettings();
	});
}
