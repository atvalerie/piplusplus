import { getQuickJS, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";

export interface SandboxBindings {
	agent(prompt: unknown, options: unknown, phase: string): Promise<unknown>;
	phase(name: unknown): void;
	approve(title: unknown, detail: unknown): Promise<boolean>;
	log(value: unknown): void;
	models: unknown;
	args?: unknown;
	workflowPrompt: string;
	/** Copied metadata only; grants no host capabilities. */
	cwd?: string;
	platform?: string;
}

export interface SandboxOptions {
	timeoutMs: number;
	memoryBytes?: number;
	signal?: AbortSignal;
	isAborted?: () => boolean;
	onTimeout?: () => void;
}

function guestValue(vm: QuickJSContext, value: unknown, ancestors = new Set<object>()): QuickJSHandle {
	if (value === undefined) return vm.undefined;
	if (value === null) return vm.null;
	if (typeof value === "string") return vm.newString(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Cannot marshal a non-finite number into the workflow sandbox");
		return vm.newNumber(value);
	}
	if (typeof value === "boolean") return value ? vm.true : vm.false;
	if (typeof value !== "object") throw new Error(`Cannot marshal ${typeof value} into the workflow sandbox`);
	if (ancestors.has(value)) throw new Error("Cannot marshal cyclic data into the workflow sandbox");
	ancestors.add(value);
	const handle = Array.isArray(value) ? vm.newArray() : vm.newObject();
	try {
		for (const [key, item] of Object.entries(value)) {
			const child = guestValue(vm, item, ancestors);
			vm.setProp(handle, Array.isArray(value) ? Number(key) : key, child);
			if (child !== vm.undefined && child !== vm.null && child !== vm.true && child !== vm.false) child.dispose();
		}
		return handle;
	} catch (error) {
		handle.dispose();
		throw error;
	} finally {
		ancestors.delete(value);
	}
}

/** Evaluate a data-only JavaScript literal in QuickJS and copy it out as JSON. */
export async function evaluateSandboxedJSONExpression(expression: string, timeoutMs = 100): Promise<unknown> {
	const QuickJS = await getQuickJS();
	const runtime = QuickJS.newRuntime();
	const deadline = Date.now() + timeoutMs;
	runtime.setMemoryLimit(8 * 1024 * 1024);
	runtime.setMaxStackSize(512 * 1024);
	runtime.setInterruptHandler(() => Date.now() > deadline);
	const vm = runtime.newContext();
	try {
		const result = vm.evalCode(`(() => {
			const value = (${expression});
			const json = JSON.stringify(value, (_key, item) => {
				if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" || item === undefined) {
					throw new Error("metadata must contain only finite JSON data");
				}
				if (typeof item === "number" && !Number.isFinite(item)) throw new Error("metadata numbers must be finite");
				return item;
			});
			if (json === undefined) throw new Error("metadata must be a JSON value");
			return json;
		})()`, "workflow-meta.js");
		if (result.error) {
			const detail = vm.dump(result.error);
			result.error.dispose();
			const message = typeof detail === "object" && detail && "message" in detail ? String((detail as any).message) : String(detail);
			throw new Error(message);
		}
		const json = vm.getString(result.value);
		result.value.dispose();
		return JSON.parse(json);
	} finally {
		vm.dispose();
		runtime.dispose();
	}
}

/** Execute orchestration in QuickJS/WASM. Guest code has no Node, filesystem, network, module, or real process capability. */
export async function executeSandboxedWorkflow(source: string, bindings: SandboxBindings, options: SandboxOptions): Promise<unknown> {
	const QuickJS = await getQuickJS();
	const runtime = QuickJS.newRuntime();
	const deadline = Date.now() + options.timeoutMs;
	let deadlineReached = false;
	let timeoutNotified = false;
	const notifyTimeout = () => { if (!timeoutNotified) { timeoutNotified = true; options.onTimeout?.(); } };
	runtime.setMemoryLimit(options.memoryBytes ?? 64 * 1024 * 1024);
	runtime.setMaxStackSize(2 * 1024 * 1024);
	runtime.setInterruptHandler(() => {
		deadlineReached ||= Date.now() > deadline;
		return deadlineReached || options.signal?.aborted === true || options.isAborted?.() === true;
	});
	const vm = runtime.newContext();
	let phase = "Workflow";
	let acceptingSettlements = true;
	const pending = new Set<Promise<unknown>>();
	const deferreds = new Set<ReturnType<QuickJSContext["newPromise"]>>();
	const interrupted = () => deadlineReached || options.signal?.aborted === true || options.isAborted?.() === true;
	const trackSettlement = (promise: Promise<unknown>) => {
		pending.add(promise);
		void promise.finally(() => pending.delete(promise)).catch(() => {});
	};
	const rejectDeferred = (deferred: ReturnType<QuickJSContext["newPromise"]>, error: unknown) => {
		if (!acceptingSettlements || interrupted()) return;
		const handle = vm.newError(error instanceof Error ? error.message : String(error));
		deferred.reject(handle);
		handle.dispose();
	};

	const install = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle) => {
		const handle = vm.newFunction(name, fn);
		handle.consume((value) => vm.setProp(vm.global, name, value));
	};

	install("__agent", (promptHandle, optionsHandle, phaseHandle) => {
		const deferred = vm.newPromise();
		deferreds.add(deferred);
		const task = bindings.agent(vm.dump(promptHandle), vm.dump(optionsHandle), vm.getString(phaseHandle));
		const settlement = task.then((value) => {
			if (!acceptingSettlements || interrupted()) return;
			try {
				const handle = guestValue(vm, value);
				deferred.resolve(handle);
				if (handle !== vm.undefined && handle !== vm.null && handle !== vm.true && handle !== vm.false) handle.dispose();
			} catch (error) {
				rejectDeferred(deferred, error);
			}
		}, (error) => rejectDeferred(deferred, error)).catch(() => {});
		trackSettlement(settlement);
		trackSettlement(deferred.settled.then(() => {
			if (acceptingSettlements && !interrupted()) runtime.executePendingJobs();
		}).catch(() => {}).finally(() => {
			if (deferreds.delete(deferred)) deferred.dispose();
		}));
		return deferred.handle;
	});
	install("__approve", (titleHandle, detailHandle) => {
		const deferred = vm.newPromise();
		deferreds.add(deferred);
		const task = bindings.approve(vm.dump(titleHandle), vm.dump(detailHandle));
		const settlement = task.then((value) => {
			if (acceptingSettlements && !interrupted()) deferred.resolve(value ? vm.true : vm.false);
		}, (error) => rejectDeferred(deferred, error)).catch(() => {});
		trackSettlement(settlement);
		trackSettlement(deferred.settled.then(() => {
			if (acceptingSettlements && !interrupted()) runtime.executePendingJobs();
		}).catch(() => {}).finally(() => {
			if (deferreds.delete(deferred)) deferred.dispose();
		}));
		return deferred.handle;
	});
	install("__phase", (nameHandle) => {
		const name = vm.dump(nameHandle);
		bindings.phase(name);
		phase = String(name);
		return vm.undefined;
	});
	install("__log", (valueHandle) => { bindings.log(vm.dump(valueHandle)); return vm.undefined; });
	install("__models", () => vm.newString(JSON.stringify(bindings.models)));
	install("__args", () => guestValue(vm, bindings.args ?? {}));
	vm.setProp(vm.global, "workflowPrompt", vm.newString(bindings.workflowPrompt));
	vm.setProp(vm.global, "__workflowCwd", vm.newString(bindings.cwd ?? ""));
	vm.setProp(vm.global, "__workflowPlatform", vm.newString(bindings.platform ?? "unknown"));

	const prelude = `
const cwd = __workflowCwd;
const platform = __workflowPlatform;
const process = Object.freeze({ platform, cwd: () => cwd });
let __workflowPhase = "Workflow";
const phase = (name) => { __workflowPhase = String(name); return __phase(name); };
const agent = (prompt, options = {}) => __agent(prompt, options, __workflowPhase);
const approve = (title, detail = "") => __approve(String(title), String(detail));
const models = () => JSON.parse(__models());
const args = __args();
const log = (value) => __log(value);
const parallel = async (tasks) => {
  if (!Array.isArray(tasks)) throw new Error("parallel() requires an array");
  return Promise.all(tasks.map(task => typeof task === "function" ? task() : task));
};
const pipeline = async (items, ...stages) => {
  if (!Array.isArray(items)) throw new Error("pipeline() requires an array as its first argument");
  let current = items;
  for (const stage of stages) current = await Promise.all(current.map((item, index) => stage(item, index)));
  return current;
};
(async () => { ${source}\n})()`;

	let promiseHandle: QuickJSHandle | undefined;
	try {
		const evaluation = vm.evalCode(prelude, "workflow.js");
		if (evaluation.error) {
			const detail = vm.dump(evaluation.error);
			evaluation.error.dispose();
			const message = typeof detail === "object" && detail && "message" in detail ? String((detail as any).message) : String(detail);
			if (deadlineReached || Date.now() >= deadline || (/interrupted/i.test(message) && options.isAborted?.() !== true && options.signal?.aborted !== true)) {
				deadlineReached = true;
				notifyTimeout();
				throw new Error(`Workflow exceeded wall-clock deadline (${options.timeoutMs}ms)`);
			}
			throw new Error(message);
		}
		promiseHandle = evaluation.value;
		const waitForResolution = async (): Promise<ReturnType<QuickJSContext["getPromiseState"]>> => {
			while (true) {
				runtime.executePendingJobs();
				const state = vm.getPromiseState(promiseHandle!);
				if (state.type !== "pending") return state;
				if (Date.now() >= deadline) {
					acceptingSettlements = false;
					deadlineReached = true;
					notifyTimeout();
					throw new Error(`Workflow exceeded wall-clock deadline (${options.timeoutMs}ms)`);
				}
				if (options.signal?.aborted === true || options.isAborted?.() === true) {
					acceptingSettlements = false;
					throw new Error("Workflow sandbox aborted");
				}
				await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
			}
		};
		const resolved = await waitForResolution();
		if (resolved.error) {
			const detail = vm.dump(resolved.error);
			resolved.error.dispose();
			const message = typeof detail === "object" && detail && "message" in detail ? String((detail as any).message) : String(detail);
			if (/interrupted/i.test(message) && options.isAborted?.() !== true && options.signal?.aborted !== true) {
				deadlineReached = true;
				notifyTimeout();
				throw new Error(`Workflow exceeded wall-clock deadline (${options.timeoutMs}ms)`);
			}
			throw new Error(message);
		}
		const valueHandle = resolved.value;
		const value = vm.dump(valueHandle);
		valueHandle.dispose();
		// A script may start host work without awaiting its guest promise. Keep the run alive
		// for that work, but never let such work bypass the parent wall-clock deadline.
		while (pending.size > 0) {
			if (Date.now() >= deadline) {
				acceptingSettlements = false;
				deadlineReached = true;
				notifyTimeout();
				throw new Error(`Workflow exceeded wall-clock deadline (${options.timeoutMs}ms)`);
			}
			if (options.signal?.aborted === true || options.isAborted?.() === true) {
				acceptingSettlements = false;
				throw new Error("Workflow sandbox aborted");
			}
			await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
		}
		return value;
	} finally {
		acceptingSettlements = false;
		for (const deferred of deferreds) deferred.dispose();
		deferreds.clear();
		promiseHandle?.dispose();
		vm.dispose();
		runtime.dispose();
	}
}
