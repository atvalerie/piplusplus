import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionRequest } from "./workflows/types.ts";

export type GlobalPermissionMode = "manual" | "auto" | "read-only" | "plan";
export interface PermissionService {
	getMode(): GlobalPermissionMode;
	setMode(mode: GlobalPermissionMode): Promise<void>;
	getModes?(): GlobalPermissionMode[];
	registerMode?(mode: GlobalPermissionMode): () => void;
	subscribe?(listener: () => void): () => void;
	authorize(request: PermissionRequest, ctx?: ExtensionContext, options?: { forcePrompt?: boolean; reason?: string }): Promise<boolean>;
}

const KEY = Symbol.for("piplusplus.permission-service");
export function installPermissionService(service: PermissionService): void { (globalThis as any)[KEY] = service; }
export function getPermissionService(): PermissionService | undefined { return (globalThis as any)[KEY]; }
export function removePermissionService(service: PermissionService): void { if ((globalThis as any)[KEY] === service) delete (globalThis as any)[KEY]; }
