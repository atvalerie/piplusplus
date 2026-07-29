import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionRequest } from "./workflows/types.ts";

export const AUTO_CONSECUTIVE_DENIAL_LIMIT = 3;
export const AUTO_TOTAL_DENIAL_LIMIT = 20;
export const AUTO_RECENT_DENIAL_LIMIT = 50;

export interface AutoDeniedAction {
	id: number;
	at: number;
	agentLabel: string;
	toolName: string;
	input: Record<string, unknown>;
	reason: string;
	fingerprint: string;
	retryQueued: boolean;
}

export interface AutoDenialOutcome {
	paused: boolean;
	pauseTriggeredBy?: "consecutive" | "total";
}

function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value as object)) return "[circular]";
	seen.add(value as object);
	if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableValue(item, seen)]),
	);
}

export function permissionRequestFingerprint(request: Pick<PermissionRequest, "agentId" | "toolName" | "input">): string {
	return JSON.stringify(stableValue({
		agentId: request.agentId,
		toolName: request.toolName,
		input: request.input,
	}));
}

/**
 * Session-local state for Claude-compatible auto-mode denial handling.
 * Classifier denials do not prompt immediately. Three consecutive denials or
 * twenty total denials pause auto mode; a manually approved fallback resumes it.
 */
export class AutoPermissionSession {
	private consecutiveDenials = 0;
	private totalDenials = 0;
	private paused = false;
	private pauseReason: string | undefined;
	private sequence = 0;
	private readonly denials: AutoDeniedAction[] = [];
	private readonly retryFingerprints = new Set<string>();

	isPaused(): boolean { return this.paused; }
	getPauseReason(): string | undefined { return this.pauseReason; }
	getConsecutiveDenials(): number { return this.consecutiveDenials; }
	getTotalDenials(): number { return this.totalDenials; }
	getRecentDenials(): readonly AutoDeniedAction[] { return this.denials; }

	recordAutomaticAllow(): void {
		this.consecutiveDenials = 0;
	}

	recordClassifierDenial(request: PermissionRequest, reason: string): AutoDenialOutcome {
		this.consecutiveDenials++;
		this.totalDenials++;
		const denial: AutoDeniedAction = {
			id: ++this.sequence,
			at: Date.now(),
			agentLabel: request.agentLabel,
			toolName: request.toolName,
			input: request.input,
			reason,
			fingerprint: permissionRequestFingerprint(request),
			retryQueued: false,
		};
		this.denials.push(denial);
		while (this.denials.length > AUTO_RECENT_DENIAL_LIMIT) this.denials.shift();

		let pauseTriggeredBy: AutoDenialOutcome["pauseTriggeredBy"];
		if (this.totalDenials >= AUTO_TOTAL_DENIAL_LIMIT) {
			this.totalDenials = 0;
			this.paused = true;
			pauseTriggeredBy = "total";
			this.pauseReason = `Auto mode paused after ${AUTO_TOTAL_DENIAL_LIMIT} total classifier denials.`;
		} else if (this.consecutiveDenials >= AUTO_CONSECUTIVE_DENIAL_LIMIT) {
			this.paused = true;
			pauseTriggeredBy = "consecutive";
			this.pauseReason = `Auto mode paused after ${AUTO_CONSECUTIVE_DENIAL_LIMIT} consecutive classifier denials.`;
		}
		return { paused: this.paused, pauseTriggeredBy };
	}

	queueRetry(id: number): AutoDeniedAction | undefined {
		const denial = this.denials.find((candidate) => candidate.id === id);
		if (!denial) return undefined;
		denial.retryQueued = true;
		this.retryFingerprints.add(denial.fingerprint);
		return denial;
	}

	promptReason(request: PermissionRequest): "fallback" | "retry" | undefined {
		if (this.retryFingerprints.has(permissionRequestFingerprint(request))) return "retry";
		if (this.paused) return "fallback";
		return undefined;
	}

	resolvePrompt(request: PermissionRequest, source: "fallback" | "retry", allowed: boolean): void {
		if (source === "retry") {
			const fingerprint = permissionRequestFingerprint(request);
			this.retryFingerprints.delete(fingerprint);
			for (const denial of this.denials) {
				if (denial.fingerprint === fingerprint) denial.retryQueued = false;
			}
		}
		if (allowed && (source === "fallback" || this.paused)) {
			this.paused = false;
			this.pauseReason = undefined;
			this.consecutiveDenials = 0;
		}
	}

	resetRuntime(): void {
		this.consecutiveDenials = 0;
		this.totalDenials = 0;
		this.paused = false;
		this.pauseReason = undefined;
		this.retryFingerprints.clear();
	}
}

// Pi auto-discovers top-level extensions/*.ts files. Keep this helper loadable.
export default function autoPermissionHelperExtension(_pi: ExtensionAPI): void {}
