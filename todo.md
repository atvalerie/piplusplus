# Pi++ workflow parity implementation plan

## Goal and compatibility target

Bring the Pi++ dynamic workflow extension as close as practical to the public behavior contract of Claude Code `2.1.220`, while retaining ModelHub-specific multi-vendor routing, detailed artifacts, retries, profiles, and the QuickJS capability sandbox.

Target runtime:

- Pi `0.82.1`
- Claude Code behavior reference `2.1.220`
- Workflow models are limited to the authenticated provider groups `opencode-go`, `anthropic`, `openai`, and `modelhub`; `modelhub-2`, ... `modelhub-8` collapse to the `modelhub` group.
- Natural-language model preferences are interpreted by the main orchestrating model. Do not reintroduce keyword or language-specific regex parsing.
- Private Claude Code prompts and implementation details are not available. Match observable/documented behavior and explicitly document intentional Pi++ extensions.

## Preserve the current uncommitted baseline

The working tree already contains the first completed refactor. Do not reset or overwrite it.

Completed changes:

- Replaced `modelFamily` and `userModelInstruction` with required structured `modelPolicy`.
- Removed natural-language routing regexes.
- Omitted `agent.model` now inherits the session model.
- `auto` routing runs only when explicitly selected through `model: "auto"` or `defaultRouting: "auto"`.
- Added hard `allowedFamilies` and `allowedModels` intersections.
- ModelHub catalog `family` is preserved in a shared metadata registry for all aliases.
- The live catalog was verified with 24 usable models and the families `anthropic`, `china`, `openai`, and `xai`.
- Runtime checks the exact model reported by a child before accepting its output.
- Interactive workflow launch can no longer be bypassed with model-generated `approval: "skip"`.
- Approval UI displays the routing mode, allowlists, and rationale.
- `accept-edits` no longer auto-approves writes outside `cwd` or into `.git`, `.env`, and `.ssh`.
- Fixed ModelHub provider imports for the Pi `0.82.1` public API.
- Added required Pi core `peerDependencies`.
- Workflow artifact schema is now version 3 and stores `modelPolicy` and `reportedModel`.
- README and workflow security documentation describe the new contract.

Current verification baseline:

```text
57 tests
57 passed
0 failed

workflow import ok
modelhub import ok
workflow schema ok
live ModelHub metadata ok: 24 models
```

Known unrelated dependency warning:

- `npm audit` reports `brace-expansion@5.0.7` below `@earendil-works/pi-coding-agent@0.82.1`.
- `npm audit fix` cannot update the dependency because it is locked inside the upstream Pi package.
- Do not patch installed `node_modules`. Recheck after upgrading Pi.

## Execution order

Implement the remaining work in the phases below. Keep every phase independently testable. Do not combine state persistence, permission isolation, and schema transport in one large rewrite.

## Phase 1: real structured agent output

### Contract

- Add `schema?: JSONSchema` to `AgentOptions`.
- `agent(prompt, { schema })` returns the parsed structured value to QuickJS, not a JSON string.
- Without `schema`, preserve the current text-returning behavior.
- Replace prompt-only profile shapes with concrete schemas.
- Validate every required property, nested type, enum, array item, and `additionalProperties` decision.
- Invalid structured output remains retryable according to the existing retry policy.
- Validation errors must include an actionable JSON path.
- Preserve raw assistant text in artifacts even when validation fails.

### Implementation notes

- First inspect the JSON Schema validation APIs available in the pinned `typebox@1.1.38`.
- Prefer an existing standards-compliant validator already available through TypeBox. Add a runtime dependency only if the pinned API cannot validate arbitrary workflow schemas safely.
- Treat schemas as copied JSON data. Do not pass host-realm validator objects into QuickJS.
- Update the sandbox bridge so successful schema calls marshal JSON objects/arrays/primitives back into the guest.
- Update built-in recipes to consume objects directly where profiles use schemas; remove fragile repeated `JSON.parse(...)`.
- Decide and document whether `null` is a valid structured result.

### Tests

- Valid nested schema returns an object to a dependent workflow stage.
- Missing required property retries.
- Wrong nested type reports its path.
- Invalid JSON retries.
- A valid scalar/array schema works.
- Text agents remain backward compatible.
- Built-in recipes no longer depend on unchecked JSON strings.

## Phase 2: subagent output scanning

### Contract

- Scan every subagent result before another agent or the parent conversation receives it.
- Preserve the exact raw output separately in the sensitive artifact.
- Escape text that imitates harness roles/tags, including `Human:`, `Assistant:`, and system-reminder-like tags.
- Add an explicit marker when instruction-shaped or permission-bypass-shaped output is detected.
- Never silently delete or paraphrase content.
- Scanning must not invalidate structured output.

### Implementation notes

- Add `rawOutput`, safe `output`, and scan findings to `AgentState`.
- For structured values, recursively scan string values after JSON validation rather than prefixing arbitrary text to serialized JSON.
- For plain text, scan before returning the value through the QuickJS bridge.
- The final synthesizer and main-agent handoff must receive only the scanned representation.
- Artifacts must make the raw/scanned distinction obvious.

### Tests

- Role-prefix and fake system-tag payloads are escaped.
- Permission-bypass phrases receive a marker.
- Benign prose remains unchanged.
- Structured JSON stays valid and retains its shape.
- Raw output is present only in the artifact/state, not downstream prompts.

## Phase 3: permission and mutation isolation

### Direct file access

- Centralize protected path policy for `.git`, `.pi`, `.claude`, `.env`, `.ssh`, IDE configuration, hooks, and package-manager control paths.
- Check both the requested path and its resolved real path.
- Handle non-existent write targets by resolving the closest existing parent.
- Prevent symlinks inside an allowed directory from granting access outside it.
- Add explicit path-level `allow`, `ask`, and `deny` rules for read and edit operations.
- Preserve an explicit internal read allowance for workflow artifacts without granting arbitrary home-directory access.

### `writePaths`

- Keep direct `write` and `edit` enforcement.
- Close the shell mutation bypass. Do not pretend arbitrary shell strings can be proven path-confined with regex alone.
- Investigate Pi `0.82.1` sandbox/process hooks and choose one enforceable design:
  1. OS/process sandbox with write roots derived from `writePaths`; or
  2. isolated temporary git worktree per mutating agent plus strict parent permission checks; or
  3. deny mutation-capable Bash/PowerShell for scoped agents unless an explicit per-call user approval acknowledges that the shell is outside the declared scope.
- Prefer worktree isolation for parallel mutating agents and make merge behavior explicit.
- Never auto-approve concurrent writes to overlapping paths.

### Permission-mode parity

- Separate workflow launch approval from worker tool permissions.
- Document and test the deliberate Pi++ behavior if it differs from Claude's workflow-worker `acceptEdits` behavior.
- Headless confirmation-required actions must remain fail-closed.

### Tests

- Absolute and relative path escape attempts fail.
- Directory traversal and symlink escapes fail.
- Protected paths do not auto-approve.
- Artifact reads still work.
- Shell mutation cannot bypass `writePaths` without explicit acknowledgement.
- Parallel overlapping mutations trigger isolation or denial.

## Phase 4: resumable runs and agent-result cache

### Contract

- Pausing prevents new agents from starting; document that already-running agents continue until a stop operation is requested.
- Stopped workflows can resume within the same Pi session.
- Completed agents return cached results on resume.
- Agents that were queued, running, failed transiently, or stopped restart live.
- A new Pi session may start the workflow fresh unless cross-session resume is implemented and explicitly supported.
- Restarting one agent invalidates every downstream cached result that depends on it.

### Implementation notes

- Persist a stable script hash and per-agent invocation hash based on ID, prompt, normalized options, policy, and relevant upstream input.
- Re-run the QuickJS script on resume; `agent()` checks the cache and returns a completed matching result without spawning.
- Record dependencies as the script awaits agent results.
- Do not reuse cached results if the model policy, exact model, prompt, tools, schema, thinking level, or write scope changed.
- Add explicit run states for resumable stop versus terminal failure.

### Tests

- Stop/resume reuses completed agents.
- A previously running agent restarts.
- Changed script or prompt invalidates cache.
- Restarting an upstream agent invalidates dependent stages.
- Usage and cost do not double-count cached results.

## Phase 5: saved workflows, `meta`, and `args`

### Contract

- Support saved scripts with:

```js
export const meta = {
  name: "workflow-name",
  description: "..."
};
```

- Provide structured `args` to the QuickJS global.
- Add project and personal save locations appropriate for Pi:
  - project: `.pi/workflows/`
  - personal: `~/.pi/agent/workflows/`
- Saved workflows become slash commands and participate in autocomplete if Pi's extension API supports dynamic registration.
- Project workflows override personal workflows with the same name.
- Reject unsafe names, traversal, and symlinked save targets.
- Add save action to the workflow UI.

### Tests

- Parse and validate `meta`.
- Save and reload project/personal workflows.
- Project precedence works.
- Structured args reach the script unchanged.
- Symlink and traversal writes fail.

## Phase 6: budgets, turns, and large-run warnings

### Contract

- Add per-agent `maxTurns`.
- Add workflow budgets:
  - `maxAgents`
  - `maxTokens`
  - `maxCost`
  - existing wall-clock deadline
- Stop scheduling when a hard budget is exhausted.
- Surface partial results and an explicit budget-exhausted status.
- Warn when a run exceeds 25 scheduled agents or projects above 1.5 million tokens.
- Add size guidance:
  - `small`: fewer than 5 agents
  - `medium`: fewer than 15 agents
  - `large`: fewer than 50 agents
  - `unrestricted`
- Guidance shapes generation but runtime hard caps remain authoritative.

### Implementation notes

- If Pi has no child `--max-turns` flag, enforce turns from the parent JSON event stream and terminate the child process once the limit is reached.
- Persist budget decisions and projections in artifacts.
- Do not retry deterministic budget failures.

### Tests

- Agent turn limit terminates exactly once.
- Token/cost/agent budgets prevent further scheduling.
- Cached results do not consume a second budget.
- Large-run warning thresholds are correct.

## Phase 7: approval and workflow-management UI parity

### Launch approval

- Show workflow name, rationale, planned phases, expected agent count/size, model policy, and token/cost caution.
- Keep raw-script inspection and editing.
- Add persistent trust keyed by workflow identity/script hash and project path.
- Trust changes must be explicit user actions and stored outside model-controlled arguments.
- Headless launch remains non-interactive and follows configured policy.

### Manager controls

- Add status filtering.
- Add save action.
- Make pause, resumable stop, hard stop, restart, and resume labels unambiguous.
- Show requested, resolved, and reported model identities.
- Show cached/live status per agent.
- Preserve the editor buffer and focus behavior.

### Tests

- The model cannot create persistent trust.
- Script changes invalidate saved trust.
- Filter/navigation work in bounded terminals.
- Resume and save actions call the correct controller operations.

## Phase 8: trigger origin and ultracode behavior

- Restrict the literal `ultracode` trigger to interactive/human-origin input that Pi can authenticate.
- Do not trigger from extension-generated messages or untrusted RPC input.
- If Pi exposes only `interactive | rpc | extension`, treat only `interactive` as human by default.
- Continue allowing the main model to honor direct natural-language requests for a workflow without keyword parsing.
- Add optional session-persistent ultracode effort mode only if it can integrate cleanly with the existing effort selector.
- Add a setting to disable workflow triggering without disabling inspection of existing runs.

### Tests

- Interactive trigger works.
- RPC/extension input cannot trigger through the literal word.
- Direct tool invocation and saved workflow commands still work.
- Disabling triggers does not delete runs or artifacts.

## Phase 9: prompt and catalog efficiency

- Stop injecting the complete authenticated model catalog into every main-agent turn.
- Keep a compact workflow contract and a short summary of available families/counts.
- Require `workflow_models` when exact routing matters.
- Inject only the active `modelPolicy` into run-specific context.
- Measure prompt-size reduction with a representative live ModelHub catalog.
- Keep instructions explicit that user constraints outrank routing optimization.

### Tests

- Main system-prompt addition remains bounded as catalog size grows.
- Exact model routing still has an explicit catalog lookup path.
- No regression to keyword parsing.

## Phase 10: documentation, migration, and final parity audit

- Add a migration note from artifact schema v2 to v3 and any later schema introduced by resume/scanning.
- Document structured `modelPolicy`, schemas, saved workflows, budgets, permission isolation, and resume behavior.
- Clearly separate:
  - Claude-compatible default behavior
  - Pi++ extensions such as multi-vendor ModelHub routing, profiles, retries, rich artifacts, and optional auto routing
  - known intentional divergences such as semantic mid-run `approve()` if retained
- Re-run the public Claude Code `2.1.220` behavior matrix and update the report.

## Final acceptance criteria

- A Polish request such as “puść workflow tylko na modelach OpenAI” is interpreted by the main model into an OpenAI allowlist without a language-specific parser.
- No Anthropic worker can launch or have its output accepted under that policy.
- Omitted worker models inherit the session model.
- `auto` never occurs implicitly.
- Exact child model identity is verified.
- `agent({ schema })` returns validated structured data.
- Instruction-shaped subagent output is scanned before downstream use.
- Direct and shell-based mutations cannot silently escape the declared boundary.
- Completed agents are cached across same-session stop/resume.
- Saved workflows support safe `meta` and structured `args`.
- Large and over-budget runs are visible and bounded.
- Interactive approval/trust cannot be controlled by the model.
- Literal trigger origin is restricted to human input.
- Full test suite, entrypoint imports, schema smoke test, and live ModelHub metadata smoke test pass.
- `git diff --check` is clean.

## Commands to run after compaction

Start by confirming the preserved baseline:

```powershell
git status --short
npm ci --ignore-scripts
npm test
node -e "import('./extensions/workflows/index.ts').then(()=>console.log('workflow import ok')); import('./extensions/modelhub-provider.ts').then(()=>console.log('modelhub import ok'))"
```

Then begin with Phase 1. Before editing, inspect:

```text
extensions/workflows/types.ts
extensions/workflows/index.ts
extensions/workflows/runtime.ts
extensions/workflows/sandbox.ts
extensions/workflows/profiles.ts
extensions/workflows/recipes.ts
extensions/workflows/artifact.ts
tests/workflow-recipes.test.ts
tests/workflow-sandbox.test.ts
```

After every phase:

```powershell
npm test
git diff --check
git status --short
```

Do not commit unless the user asks. Do not reset the existing dirty working tree.

## Implementation status — 2026-07-28

All ten phases are implemented. Final verification passed 102/102 tests after the warning-deduplication cleanup. Workflow/modelhub imports, the exported workflow schema, and live ModelHub metadata (24 usable models across `anthropic`, `china`, `openai`, and `xai`) passed. `git diff --check` reported no whitespace errors; Git emitted only Windows LF→CRLF conversion warnings. The known upstream `brace-expansion@5.0.7` audit finding remains nested under Pi `0.82.1` and was not patched in `node_modules`.

## Post-implementation audit — 2026-07-29

Provider scope was clarified and implemented as a separate hard policy dimension:

- supported workflow provider groups: `opencode-go`, `anthropic`, `openai`, and `modelhub`;
- `modelhub-2` through `modelhub-8` normalize to the `modelhub` provider group;
- `allowedProviders` restricts the source/provider;
- `allowedFamilies` continues to restrict the underlying model vendor;
- provider, family, and exact-model restrictions intersect;
- unsupported Pi providers are omitted from `workflow_models`, the main prompt summary, QuickJS `models()`, and runtime scheduling.

The audit also found follow-up defects that mean the earlier “all acceptance criteria complete” statement is too strong:

- shell commands classified as safe inspection can read protected or out-of-project paths without applying the path policy;
- child identity verification checks only `message.model`, not the full `message.provider/model` pair or `responseModel`;
- the parent handoff tells the main agent to read the complete artifact even though it contains unscanned `rawOutput`, messages, and raw events;
- saving a workflow persists the script but drops its `modelPolicy`, so an OpenAI-only saved run can later revert to unrestricted session-model inheritance;
- recursively scanning structured strings can make the returned value fail the schema that was validated before scanning;
- JSON Schema normalization silently converts non-finite numbers to `null`;
- the suite has no real Pi child-process/permission-IPC integration test and the package has no TypeScript typecheck command.

These findings still need fixes and regression tests before the full final acceptance list can be considered closed.

Provider-scope verification after the audit passed 105/105 tests. Workflow/modelhub imports, the exported schema with `allowedProviders`, the four-provider registry mapping, and `git diff --check` all passed. The live catalog still exposes only ModelHub on this machine because only ModelHub credentials are currently configured; direct OpenCode Go, Anthropic, and OpenAI execution therefore still needs provider login/API-key configuration.

## Runtime-loader hotfix — 2026-07-29

The global Pi 0.82.1 extension loader aliases only its documented extension entrypoints. Two unsupported subpath imports caused `pi -e ./` to fail even though native Node imports and unit tests passed:

- `typebox/schema` was replaced with the loader-supported `typebox/value` API;
- individual `@earendil-works/pi-ai/api/*.lazy` imports were replaced with the exact `@earendil-works/pi-ai/compat` entrypoint.

Verification passed 105/105 tests, native entrypoint imports, `git diff --check`, and an actual global-loader smoke test using `pi -e ./ --no-extensions --no-skills --no-prompt-templates --offline --list-models` with exit code 0 and 24 loaded ModelHub models.
