import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WorkflowDockService {
	hasRuns(): boolean;
	open(ctx: ExtensionContext): Promise<void>;
}

const KEY = Symbol.for("piplusplus.workflow-dock-service");
export function installWorkflowDockService(service: WorkflowDockService): void { (globalThis as any)[KEY] = service; }
export function getWorkflowDockService(): WorkflowDockService | undefined { return (globalThis as any)[KEY]; }
export function removeWorkflowDockService(service: WorkflowDockService): void { if ((globalThis as any)[KEY] === service) delete (globalThis as any)[KEY]; }
