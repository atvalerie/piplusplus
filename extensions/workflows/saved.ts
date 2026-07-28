import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateSandboxedJSONExpression } from "./sandbox.ts";
import { validateWorkflowScript } from "./runtime.ts";
import type { WorkflowSpec } from "./types.ts";

export type SavedWorkflowScope = "project" | "personal";

export interface SavedWorkflowMeta {
	name: string;
	description: string;
	phases?: Array<{ title: string; detail?: string }>;
}

export interface SavedWorkflow {
	meta: SavedWorkflowMeta;
	script: string;
	source: string;
	path: string;
	scope: SavedWorkflowScope;
}

export interface SavedWorkflowLoadResult {
	workflows: Map<string, SavedWorkflow>;
	errors: string[];
}

const SAFE_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function validateSavedWorkflowName(value: unknown): string {
	if (typeof value !== "string" || !SAFE_NAME.test(value)) {
		throw new Error("Workflow name must be 1-64 lowercase letters, digits, hyphens, or underscores, without traversal.");
	}
	return value;
}

function findMetaObject(source: string): { expression: string; start: number; end: number } {
	const declarations = [...source.matchAll(/\bexport\s+const\s+meta\s*=/g)];
	if (declarations.length !== 1) throw new Error("Saved workflow must declare exactly one `export const meta = { ... };`.");
	const declaration = declarations[0];
	const start = declaration.index!;
	let cursor = start + declaration[0].length;
	while (/\s/.test(source[cursor] ?? "")) cursor++;
	if (source[cursor] !== "{") throw new Error("Saved workflow meta must be an object literal.");
	const objectStart = cursor;
	let depth = 0;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (; cursor < source.length; cursor++) {
		const char = source[cursor];
		const next = source[cursor + 1];
		if (lineComment) { if (char === "\n") lineComment = false; continue; }
		if (blockComment) { if (char === "*" && next === "/") { blockComment = false; cursor++; } continue; }
		if (escaped) { escaped = false; continue; }
		if (quote) {
			if (char === "\\") escaped = true;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "`") throw new Error("Saved workflow meta does not allow template literals.");
		if (char === "/" && next === "/") { lineComment = true; cursor++; continue; }
		if (char === "/" && next === "*") { blockComment = true; cursor++; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (char === "{") depth++;
		if (char === "}" && --depth === 0) {
			let end = cursor + 1;
			while (/\s/.test(source[end] ?? "")) end++;
			if (source[end] === ";") end++;
			return { expression: source.slice(objectStart, cursor + 1), start, end };
		}
	}
	throw new Error("Saved workflow meta object is not closed.");
}

export async function parseSavedWorkflowSource(source: string): Promise<{ meta: SavedWorkflowMeta; script: string }> {
	if (Buffer.byteLength(source, "utf8") > 1024 * 1024) throw new Error("Saved workflow source exceeds 1 MiB.");
	const declaration = findMetaObject(source);
	const value = await evaluateSandboxedJSONExpression(declaration.expression);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved workflow meta must evaluate to a JSON object.");
	const record = value as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => !["name", "description", "phases"].includes(key));
	if (extra.length) throw new Error(`Unknown saved workflow meta properties: ${extra.join(", ")}`);
	let phases: SavedWorkflowMeta["phases"];
	if (record.phases !== undefined) {
		if (!Array.isArray(record.phases) || record.phases.length > 100) throw new Error("Saved workflow meta.phases must be an array with at most 100 entries.");
		phases = record.phases.map((item, index) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Saved workflow meta.phases[${index}] must be an object.`);
			const phase = item as Record<string, unknown>;
			const phaseExtra = Object.keys(phase).filter((key) => !["title", "detail"].includes(key));
			if (phaseExtra.length) throw new Error(`Unknown saved workflow meta.phases[${index}] properties: ${phaseExtra.join(", ")}`);
			if (typeof phase.title !== "string" || !phase.title.trim() || phase.title.trim().length > 100) {
				throw new Error(`Saved workflow meta.phases[${index}].title must contain 1-100 characters.`);
			}
			if (phase.detail !== undefined && (typeof phase.detail !== "string" || !phase.detail.trim() || phase.detail.trim().length > 500)) {
				throw new Error(`Saved workflow meta.phases[${index}].detail must contain 1-500 characters when present.`);
			}
			return {
				title: phase.title.trim(),
				...(phase.detail === undefined ? {} : { detail: phase.detail.trim() }),
			};
		});
	}
	const meta = {
		name: validateSavedWorkflowName(record.name),
		description: typeof record.description === "string" ? record.description.trim() : "",
		...(phases === undefined ? {} : { phases }),
	};
	if (!meta.description || meta.description.length > 500) throw new Error("Saved workflow description must contain 1-500 characters.");
	const script = `${source.slice(0, declaration.start)}${source.slice(declaration.end)}`.trim();
	if (/^\s*(?:import|export)\b/m.test(script)) throw new Error("Saved workflow files may export only meta and cannot import modules.");
	if (!script) throw new Error("Saved workflow has no orchestration body.");
	const compileError = validateWorkflowScript(script);
	if (compileError) throw new Error(`Invalid saved workflow JavaScript: ${compileError}`);
	return { meta, script };
}

export function normalizeWorkflowArgs(value: unknown): unknown {
	if (value === undefined) return {};
	let json: string;
	try { json = JSON.stringify(value); }
	catch (error) { throw new Error(`Workflow args must be finite JSON data: ${error instanceof Error ? error.message : String(error)}`); }
	if (json === undefined) throw new Error("Workflow args must be a JSON value.");
	if (Buffer.byteLength(json, "utf8") > 256 * 1024) throw new Error("Workflow args exceed 256 KiB.");
	return JSON.parse(json);
}

export function parseSavedWorkflowArgs(value: string): unknown {
	if (!value.trim()) return {};
	try { return normalizeWorkflowArgs(JSON.parse(value)); }
	catch (error) { throw new Error(`Saved workflow arguments must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

export function createSavedWorkflowSource(
	spec: Pick<WorkflowSpec, "script">,
	name: string,
	description: string,
): string {
	const meta = {
		name: validateSavedWorkflowName(name),
		description: description.trim(),
	};
	if (!meta.description || meta.description.length > 500) throw new Error("Saved workflow description must contain 1-500 characters.");
	return `export const meta = ${JSON.stringify(meta, null, "\t")};\n\n${spec.script.trim()}\n`;
}

export function savedWorkflowDirectories(cwd: string, agentDir: string): Record<SavedWorkflowScope, string> {
	return {
		project: path.join(path.resolve(cwd), ".pi", "workflows"),
		personal: path.join(path.resolve(agentDir), "workflows"),
	};
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(base: string, target: string): void {
	const basePath = path.resolve(base);
	const targetPath = path.resolve(target);
	if (!inside(basePath, targetPath)) throw new Error("Saved workflow path escapes its configured root.");
	let current = basePath;
	for (const segment of path.relative(basePath, targetPath).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (!fs.existsSync(current)) continue;
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Saved workflow path uses a symlink or junction: ${current}`);
	}
}

async function loadDirectory(base: string, directory: string, scope: SavedWorkflowScope, errors: string[]): Promise<SavedWorkflow[]> {
	if (!fs.existsSync(directory)) return [];
	try { assertNoSymlinkComponents(base, directory); }
	catch (error) { errors.push(`${scope}: ${error instanceof Error ? error.message : String(error)}`); return []; }
	const workflows: SavedWorkflow[] = [];
	for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
		if (!entry.name.endsWith(".js") || entry.isSymbolicLink() || !entry.isFile()) continue;
		const filePath = path.join(directory, entry.name);
		try {
			assertNoSymlinkComponents(base, filePath);
			const source = await fs.promises.readFile(filePath, "utf8");
			const parsed = await parseSavedWorkflowSource(source);
			if (path.basename(entry.name, ".js") !== parsed.meta.name) throw new Error(`Filename must be ${parsed.meta.name}.js.`);
			workflows.push({ ...parsed, source, path: filePath, scope });
		} catch (error) {
			errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return workflows;
}

export async function loadSavedWorkflows(cwd: string, agentDir: string): Promise<SavedWorkflowLoadResult> {
	const directories = savedWorkflowDirectories(cwd, agentDir);
	const errors: string[] = [];
	const personal = await loadDirectory(path.resolve(agentDir), directories.personal, "personal", errors);
	const project = await loadDirectory(path.resolve(cwd), directories.project, "project", errors);
	const workflows = new Map<string, SavedWorkflow>();
	for (const workflow of personal) workflows.set(workflow.meta.name, workflow);
	for (const workflow of project) workflows.set(workflow.meta.name, workflow);
	return { workflows, errors };
}

export async function saveWorkflowSource(
	scope: SavedWorkflowScope,
	name: string,
	source: string,
	cwd: string,
	agentDir: string,
): Promise<SavedWorkflow> {
	validateSavedWorkflowName(name);
	const parsed = await parseSavedWorkflowSource(source);
	if (parsed.meta.name !== name) throw new Error(`Workflow meta.name must match the saved filename (${name}).`);
	const directories = savedWorkflowDirectories(cwd, agentDir);
	const base = scope === "project" ? path.resolve(cwd) : path.resolve(agentDir);
	const directory = directories[scope];
	assertNoSymlinkComponents(base, path.dirname(directory));
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	assertNoSymlinkComponents(base, directory);
	const target = path.join(directory, `${name}.js`);
	assertNoSymlinkComponents(base, target);
	if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Refusing to overwrite a symlinked saved workflow.");
	const temp = path.join(directory, `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		await fs.promises.writeFile(temp, source, { mode: 0o600, flag: "wx" });
		await fs.promises.rename(temp, target);
		try { await fs.promises.chmod(target, 0o600); } catch { /* best effort */ }
	} finally {
		await fs.promises.rm(temp, { force: true }).catch(() => {});
	}
	return { ...parsed, source, path: target, scope };
}
