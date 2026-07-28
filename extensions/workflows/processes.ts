import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const timers = new WeakMap<ChildProcess, ReturnType<typeof setTimeout>>();

/** Terminate the complete worker tree, escalating after a grace period on Linux and Windows. */
export function terminateProcessTree(child: ChildProcess, graceMs = 1_500): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		try { child.kill("SIGTERM"); } catch { /* already gone */ }
	} else {
		try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
	}
	const timer = setTimeout(() => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		if (process.platform === "win32" && child.pid) {
			const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
			killer.unref();
		} else {
			try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
		}
	}, graceMs);
	timer.unref();
	timers.set(child, timer);
	child.once("close", () => { const active = timers.get(child); if (active) clearTimeout(active); timers.delete(child); });
}
