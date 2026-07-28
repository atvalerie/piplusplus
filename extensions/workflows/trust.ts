import * as fs from "node:fs";
import * as path from "node:path";
import { stableWorkflowHash } from "./cache.ts";
import type { WorkflowSpec } from "./types.ts";

interface WorkflowTrustRecord {
	key: string;
	name: string;
	scriptHash: string;
	projectPath: string;
	trustedAt: number;
}

interface WorkflowTrustFile {
	version: 1;
	records: WorkflowTrustRecord[];
}

export interface WorkflowTrustIdentity {
	key: string;
	name: string;
	scriptHash: string;
	projectPath: string;
}

function canonicalProjectPath(cwd: string): string {
	const resolved = path.resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function workflowTrustIdentity(spec: Pick<WorkflowSpec, "name" | "script">, cwd: string): WorkflowTrustIdentity {
	const scriptHash = stableWorkflowHash(spec.script);
	const projectPath = canonicalProjectPath(cwd);
	return {
		key: stableWorkflowHash({ name: spec.name, scriptHash, projectPath }),
		name: spec.name,
		scriptHash,
		projectPath,
	};
}

export function workflowTrustPath(agentDir: string): string {
	return path.join(path.resolve(agentDir), "workflows", "trust.json");
}

function assertSafeTrustTarget(agentDir: string, target: string): void {
	const base = path.resolve(agentDir);
	const resolved = path.resolve(target);
	const relative = path.relative(base, resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Workflow trust path escapes the Pi agent directory.");
	}
	let current = base;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
			throw new Error(`Workflow trust path uses a symlink or junction: ${current}`);
		}
	}
}

async function readTrustFile(agentDir: string): Promise<WorkflowTrustFile> {
	const target = workflowTrustPath(agentDir);
	assertSafeTrustTarget(agentDir, target);
	try {
		const parsed = JSON.parse(await fs.promises.readFile(target, "utf8")) as Partial<WorkflowTrustFile>;
		if (parsed.version !== 1 || !Array.isArray(parsed.records)) return { version: 1, records: [] };
		return {
			version: 1,
			records: parsed.records.filter((record): record is WorkflowTrustRecord => Boolean(
				record
				&& typeof record.key === "string"
				&& typeof record.name === "string"
				&& typeof record.scriptHash === "string"
				&& typeof record.projectPath === "string"
				&& typeof record.trustedAt === "number",
			)),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
		throw error;
	}
}

export async function isWorkflowTrusted(spec: Pick<WorkflowSpec, "name" | "script">, cwd: string, agentDir: string): Promise<boolean> {
	const identity = workflowTrustIdentity(spec, cwd);
	const trust = await readTrustFile(agentDir);
	return trust.records.some((record) =>
		record.key === identity.key
		&& record.name === identity.name
		&& record.scriptHash === identity.scriptHash
		&& record.projectPath === identity.projectPath);
}

/**
 * Call only from an explicit user-action branch in approval UI. No workflow
 * argument or script capability is accepted here as an authorization signal.
 */
export async function trustWorkflowFromUserAction(
	spec: Pick<WorkflowSpec, "name" | "script">,
	cwd: string,
	agentDir: string,
): Promise<WorkflowTrustIdentity> {
	const identity = workflowTrustIdentity(spec, cwd);
	const trust = await readTrustFile(agentDir);
	const records = trust.records.filter((record) => record.key !== identity.key);
	records.push({ ...identity, trustedAt: Date.now() });
	const target = workflowTrustPath(agentDir);
	assertSafeTrustTarget(agentDir, target);
	await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	assertSafeTrustTarget(agentDir, target);
	const temp = path.join(path.dirname(target), `.trust.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		await fs.promises.writeFile(temp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await fs.promises.rename(temp, target);
		try { await fs.promises.chmod(target, 0o600); } catch { /* best effort */ }
	} finally {
		await fs.promises.rm(temp, { force: true }).catch(() => {});
	}
	return identity;
}

export function headlessWorkflowLaunchAllowed(value = process.env.PIPLUSPLUS_WORKFLOW_HEADLESS_POLICY): boolean {
	if (value === undefined || value.trim() === "") return true;
	if (value === "allow") return true;
	if (value === "deny") return false;
	throw new Error("PIPLUSPLUS_WORKFLOW_HEADLESS_POLICY must be 'allow' or 'deny'");
}
