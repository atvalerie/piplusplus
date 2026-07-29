# piplusplus

A collection of independently configurable [Pi](https://pi.dev) extensions targeting Linux and Windows. Core behavior uses platform-neutral Node APIs; platform-specific hardening must provide equivalent adapters rather than assuming Unix utilities.

## Install

```bash
pi install git:github.com/atvalerie/piplusplus
```

Use `pi config` to enable or disable individual extensions supplied by this package. Project-local installation is also supported:

```bash
pi install -l git:github.com/atvalerie/piplusplus
```

Extensions live in [`extensions/`](./extensions/). Each `*.ts` file is a separate Pi extension resource.

## Included extensions

### Pi++ control center

Run `/pi++`, `/piplusplus`, or `/pipp` to open one interactive control center for every registered Pi++ settings page. The root menu shows live summaries and delegates changes back to the owning extension, so validation, persistence, and active runtime state stay synchronized. It currently covers global permissions and the AI classifier; all workflow trigger, effort, budget, turn, retention, and headless-launch settings; reasoning effort, Pi/Pi++ keybindings, and command aliases; telemetry credentials; and extension-update scheduling. A page can also be opened directly, for example `/pi++ workflows`.

The control center is extensible through `extensions/shared/settings-service.ts`; independently installed Pi++ modules can register additional owner-controlled pages without creating a central monolithic settings file.

### `auto-update`

On startup and every 60 minutes, checks for and installs updates to unpinned Pi packages with `pi update --extensions`. Updated extension code takes effect after restarting Pi or running `/reload`.

Set a different interval in minutes at launch:

```bash
pi --extension-update-interval 30
```

Run `/extension-update` to update immediately. The update interval can also be changed persistently from `/pi++` → **Maintenance** and is stored in `~/.pi/agent/piplusplus-auto-update.json`; the launch flag remains the fallback when no persistent override exists. The updater invokes the current Pi entry point directly (including Windows paths with spaces) and only falls back to `cmd.exe` for npm's `pi.cmd` shim. Failures include captured stderr/stdout instead of reporting only an exit code. Git or npm packages installed with a pinned version/ref are intentionally skipped by Pi's package updater; install a newer pin explicitly to update them.

### `permissions`

Provides a global permission policy for the main agent and dependent extensions. Open it with `Ctrl+Alt+M`, `/permissions`, or `/permission`; it offers `manual`, `accept-edits`, `auto`, `read-only`, optional `plan`, and `dangerous`. `manual` confirms writes, edits, shell commands, and unknown tools. `accept-edits` automatically accepts direct `write`/`edit` operations inside the working directory, except Claude/Pi/repository/IDE protected paths; it still confirms out-of-scope edits, shell commands, concurrent workflow mutations, and unknown tools.

`auto` follows Claude Code's public auto-mode decision flow. Read-only actions and ordinary file edits in the working directory run immediately, except protected writes. Every other action—including mutation, installation, network, custom-tool, and protected-path requests—goes to an isolated safety classifier instead of being rejected by regex before the user's intent can be considered. The classifier sees current user messages, prior tool calls, project/session instructions, the pending action, the delegated workflow task where applicable, and repository branch/remotes; tool results and assistant prose are deliberately stripped. It returns only `ALLOW` or `DENY` plus a short reason. A denial blocks without opening a permission prompt, reports the reason to the agent so it can try a safer alternative, shows a warning, and appears under `/permissions denied` and **Recently denied** in the permissions UI. A denied action can be retried once through manual approval.

As in Claude Code, auto mode pauses after 3 consecutive or 20 total classifier denials and resumes prompting for non-read actions; approving the fallback prompt resumes auto mode. Any automatically allowed action resets the consecutive counter, while the total counter resets only when its own threshold triggers. Classifier failure or unavailability denies safely and participates in the same fallback instead of silently turning every action into a prompt. Auto mode also adds proactive execution guidance to the active turn. The classifier cannot be disabled while auto mode is active; inspect it with `/permissions classifier status`, choose a model with `/permissions classifier model [auto|PROVIDER/MODEL]`, and set effort with `/permissions classifier effort [off|minimal|low|medium|high|xhigh|max]`. The `auto` model setting uses the cheapest authenticated text model that fits the bounded classifier context, with authenticated fallbacks rather than the former hard $0.001 eligibility cutoff.

`read-only` blocks mutations. `plan` is registered by the separate plan-mode extension. `dangerous` bypasses Pi++ confirmations, requires an explicit warning confirmation, is visibly marked in the footer, and deliberately resets to `manual` after restart. Filesystem-root and home-directory removals retain a final explicit-approval circuit breaker in every mutable mode. Confirmation-required operations fail closed without a TUI. Persistent mode and classifier settings are stored in `~/.pi/agent/piplusplus-permissions.json`; denial counters and recent denials are session-local.

### `plan-mode`

Provides a standalone Claude-style permission mode rather than a command-driven recipe. When enabled alongside `permissions`, **plan** appears as a peer of `manual`, `auto`, and `read-only` in the permission-mode selector and footer (`perm:plan`). Select it from `/permissions` or press `Ctrl+Alt+P`, then type requests normally. Plan mode removes mutating tools and workflows and limits shell access to Pi++'s deterministic inspection policy.

After the agent produces a scoped numbered plan, the approval dialog offers the Claude-style transitions: **compact context then accept all edits**, **execute and accept all edits**, **execute in auto mode**, **execute with manual approvals**, **keep planning**, **refine**, or **cancel**. Compaction preserves planning decisions and injects the exact approved plan again afterward. Execution restores the previous tools, switches the global permission mode selected in the dialog, tracks `[DONE:n]` markers, and persists across resume. `/plan` commands remain optional automation/fallback controls; start directly with `pi --plan-mode` if desired.

### `workflows`

Runs Claude Code-style dynamic workflows as deterministic JavaScript orchestration scripts. Orchestration executes in a QuickJS WebAssembly capability sandbox with no real Node process, filesystem, network, module, or host-realm access; only the documented workflow primitives cross the boundary. The sandbox has a 64 MiB memory limit, 2 MiB stack limit, and a parent-enforced wall-clock deadline (`timeoutMs`, 30 minutes by default). Scripts use `agent()`, `parallel()`, `pipeline()`, `phase()`, and semantic `approve()` gates to manage up to 1,000 isolated subagents, with at most 16 running concurrently. Copied JSON `args`, `workflowPrompt`, `cwd`, and `platform` are available to the script. Every `agent()` call has its own prompt and may select its own model, thinking level (`thinking`, with Claude Workflow-compatible alias `effort`), phase override, tools, direct-write scope, and JSON Schema. Scripts may propose per-agent `maxTurns`, but the persistent user turn policy decides whether it is ignored, overridden, or accepted. Intermediate results remain in script variables; only the returned result enters the main conversation. Saved workflow metadata accepts `name`, `description`, and optional display-only `phases: [{ title, detail }]`.

Model choices come from Pi's live authenticated catalog, but workflows currently expose and run only the supported provider groups `opencode-go`, `anthropic`, `openai`, and `modelhub`. The `openai` group includes both Pi's `openai` API-key provider and its `openai-codex` ChatGPT Plus/Pro OAuth provider; `modelhub-2` through `modelhub-8` key aliases collapse to `modelhub`. Exact provider IDs remain visible through `workflow_models` and inside a script through `models()`, and are preserved when launching workers. The main system prompt receives only bounded provider/family counts, not every model ID and price. The orchestrating model understands the user's request in its original language, writes the script, and supplies a structured `modelPolicy`; the runtime never parses natural-language model keywords. `allowedProviders` restricts the source, while `allowedFamilies` restricts the underlying model vendor and intersects with the provider restriction. Thus direct OpenAI or Codex OAuth uses `allowedProviders: ["openai"]`, any OpenAI-family model uses `allowedFamilies: ["openai"]`, and OpenAI-family models served only through ModelHub use both restrictions. Like Claude Code, an `agent()` call with no model inherits the current session model. The orchestrator may route any stage explicitly with `model: "provider/id"`, while `model: "auto"` and policy-wide auto routing remain deliberate Pi++ extensions. Provider, family, and exact-model allowlists are hard runtime constraints; ModelHub contributes authoritative family metadata for its aliases. The configured model reported by each child is checked before output is accepted, so an unavailable or contradictory choice fails instead of silently falling back outside the policy.

While a workflow is active, pressing Down from the editor's last line moves focus into a bottom-docked workflow manager without losing the prompt buffer. Up from the first workflow row (or Escape) returns to editing. `/workflows` opens the same bottom dock explicitly; other inspectors remain centered.

Useful commands:

```text
/workflows                 interactive run list and detailed stats
/workflows status <id>     compact status
/workflows stop <id>       stop a run, retaining same-session resume state
/workflows hard-stop <id>  terminate a run without the normal resume path
/workflows resume <id>     resume a stopped run and reuse valid cached agents
/workflows restart <id> <agent-id>
/workflows triggers on|off|status
/workflows ultracode-effort one-prompt|session|status
/workflows budget off|model|custom [maxTokens or JSON]|status
/workflows max-turns off|model|custom <1-1000>|status
```

Only authenticated interactive input can activate the bounded literal word `ultracode`; RPC and extension-generated input cannot. The default is one-prompt xhigh effort, while the optional `session` effort mode keeps xhigh for the Pi session. `/workflows triggers off` disables this literal trigger without disabling natural-language workflow requests, direct `workflow_run`, saved workflow commands, or run inspection. Aggregate workflow budgets are user-owned and default to `off`, matching Claude Code's lack of a workflow-wide token budget. Use `/workflows budget off`, `/workflows budget model`, `/workflows budget custom 200000`, or `/workflows budget custom {"maxTokens":200000,"maxAgents":3,"maxCost":5}`; `/workflows budget` opens an interactive editor and `/workflows budget status` shows the active mode.

Worker `maxTurns` is independently user-owned and also defaults to `off`, meaning unlimited turns: any `maxTurns` generated in the workflow script is ignored. `/workflows max-turns custom 20` applies 20 turns to every worker, while `/workflows max-turns model` permits the orchestrator's per-agent values again. `/workflows max-turns` opens the selector and `/workflows max-turns status` reports the active mode. The `/pi++` workflow page also controls artifact retention (1–365 days) and the headless launch policy. Workflow settings persist in `~/.pi/agent/workflows/settings.json`; `PIPLUSPLUS_WORKFLOW_RETENTION_DAYS` and `PIPLUSPLUS_WORKFLOW_HEADLESS_POLICY` remain authoritative environment overrides when set.

`/workflows` drills down from workflow → phase → subagent → the user-visible assignment, tool calls, requested/resolved/reported models, requested/effective/provider-mapped reasoning effort, cache state, live usage, errors, and results. Structured-output contracts and specialist-profile control text are delivered through the child system prompt and do not flood the visible assignment. Child NDJSON is processed incrementally: only the latest final assistant text is retained for handoff, individual lines are capped at 16 MiB, and the complete stream has a 256 MiB safety ceiling. Omitted effort inherits the current Pi session level, then clamps to the selected model's supported levels before launch. Use `f` to cycle status filters, `s` to save, `p` to pause/resume scheduling, `x` for a resumable stop, `X` for a hard stop, and `r` to restart the selected agent. The dock preserves the main editor buffer. Launch approval shows rationale, statically visible phases and agent sites, size, model policy, and budget cautions. “Run and trust” is a separate explicit action keyed to the exact script hash and project path; model-controlled arguments cannot create trust. Trust is stored in `~/.pi/agent/workflows/trust.json`. Headless launch never opens a dialog and defaults to allow for compatibility; set `PIPLUSPLUS_WORKFLOW_HEADLESS_POLICY=deny` to fail closed.

Every workflow immediately creates a continuously updated schema-v7 JSON index under `~/.pi/agent/workflows/artifacts/`. It keeps the active `modelPolicy`, worker assignments/models, usage, bounded tool summaries and lifecycle diagnostics, cache hashes/dependencies, budgets/projections, retries, scan findings, errors, and the final handoff. It does **not** duplicate the complete Pi NDJSON stream, assistant/tool messages, and final text several times, and `workflow_run` returns only compact run metadata rather than embedding the in-memory run again. Results have previews of up to 64 KiB (automatically smaller for large agent sets) and exact larger values are stored once in immutable content-addressed `.data/*.txt` sidecars; identical raw/scanned output shares one payload. Instruction-shaped worker text is escaped or marked before another worker or the parent receives it.

Standard workflow work can use audited `diagnose`, `design`, `review`, and foreground `implement` recipes instead of generated JavaScript. The recipe/profile direction was informed by the MIT-licensed [shinpr/claude-code-workflows](https://github.com/shinpr/claude-code-workflows); Pi++ independently implements the concepts on its permission-enforced, provider-neutral runtime rather than bundling their prompt tree. Reusable researcher, investigator, planner, implementer, reviewer, security-reviewer, verifier, quality-fixer, and synthesizer profiles add evidence-focused prompts. Structured profiles use concrete JSON Schemas, return parsed values to the workflow script, and retry malformed or schema-invalid responses with actionable JSON paths. Ad-hoc workers can use `agent(prompt, { schema })` for the same behavior; calls without a schema remain text-returning, and `null` is accepted only when the schema permits it.

Saved workflows live in project `.pi/workflows/` or personal `~/.pi/agent/workflows/`; project definitions win on name collisions and register as slash commands with JSON arguments:

```js
export const meta = {
  name: "audit",
  description: "Run the reusable audit workflow"
};

const result = await agent(String(args.prompt ?? workflowPrompt), { id: "audit", profile: "reviewer" });
return result;
```

Workflow `size` is advisory (`small` <5, `medium` <15, `large` <50, or `unrestricted`). Optional `budgets.maxAgents`, `maxTokens`, and `maxCost` are aggregate scheduling thresholds, while `timeoutMs` terminates the run. User budget mode overrides limits proposed by the orchestrating model. Runs warn above 25 scheduled agents or 1.5 million projected output tokens. Exhaustion prevents new agents from starting, permits already-running agents to finish, retains partial results, and never retries deterministic budget failures; parallel in-flight workers can therefore report token or cost usage above the threshold. Use lower `concurrency` or enable a user-owned custom `maxTurns` policy for a tighter bound. Same-session resume re-runs the QuickJS script and reuses completed agents only when script, prompt, options, exact model, policy, args, and upstream dependency hashes still match; restarting an upstream agent invalidates dependent cache entries.

Workflows inherit the global permission service automatically; if it is unavailable, workers fall back to read-only behavior. Direct file access checks requested and real paths, traversal, non-existent parents, sensitive control files, and symlink/junction escapes. `writePaths` is enforced for direct edits. Arbitrary shell/custom tools are not falsely claimed to be OS-confined: scoped mutation requires a per-call acknowledgement, and concurrent overlapping writes always return to confirmation. Worker process trees receive graceful termination followed by forced escalation using Linux process groups or Windows `taskkill`. Persisted runs and artifacts default to 30-day retention; change it from `/pi++` → **Workflows**, with `PIPLUSPLUS_WORKFLOW_RETENTION_DAYS=1..365` available as an environment override.

See the [workflow security model](./extensions/workflows/SECURITY.md), [artifact/state migration notes](./extensions/workflows/MIGRATION.md), and [Claude Code 2.1.220 public-behavior parity report](./extensions/workflows/PARITY.md) for guarantees, deliberate extensions, and remaining differences.

### ModelHub provider and modular telemetry

`modelhub-provider` discovers ModelHub's live public catalog and registers its text/vision models with their current token prices. Run `/login`, choose **ModelHub**, and paste an `sk-mh-…` API key; Pi validates and stores it in its normal credential store. `/logout` removes it. `MODELHUB_API_KEY` remains available as a non-persisted environment fallback. Additional independently selectable keys can be exposed as `modelhub-2` through `modelhub-8` with `MODELHUB_API_KEY_2` … `MODELHUB_API_KEY_8`. Reasoning-capable GPT models expose ModelHub's documented `minimal` through `xhigh` `reasoning_effort` values; Pi's `max` level maps to ModelHub's maximum GPT wire value, `xhigh`. Native Anthropic Messages models use Claude thinking controls instead: adaptive-thinking models expose Anthropic `max`, while native `xhigh` is enabled only for Claude Opus 4.7/4.8/5+, Sonnet 5+, and Fable 5+; older Claude models retain budget-based thinking through `high`.

Provider telemetry is split into cooperating extensions:

- `secrets` — reusable masked-input and local secret-storage dependency for extensions.
- `telemetry-core` — provider-neutral source registry, snapshots, refresh, and subscriptions.
- `modelhub-telemetry` — ModelHub catalog, limits, API-key quota, wallet, usage, cache savings, and key metadata adapter.
- `telemetry-ui` — `/telemetry` responsive right-side inspector; it has no ModelHub-specific networking.
- `interface` — optionally adds the active ModelHub balance and estimated recent savings to its wide footer when telemetry is available.

The modules degrade independently: the provider does not require telemetry, telemetry works without the custom interface, and the interface works without either. For account dashboard analytics, enable `secrets`, `telemetry-core`, `modelhub-telemetry`, and `telemetry-ui`, then run:

```text
/telemetry setup modelhub
```

Paste the `__Host-fas_session` cookie from a signed-in browser into the masked prompt. It never enters chat history and is stored in `~/.pi/agent/piplusplus-secrets.json`, written atomically with owner-only permissions where supported. The file is not encrypted, so protect it like Pi's other local credential files. Remove the stored cookie with `/telemetry clear modelhub`.

Environment configuration remains available:

```bash
# Optional alternative to /login:
export MODELHUB_API_KEY='sk-mh-…'
# Optional alternative to /telemetry setup:
export MODELHUB_SESSION_COOKIE='__Host-fas_session=…'
```

Environment values take precedence over stored telemetry setup. `MODELHUB_API_KEYS` may contain a comma-separated telemetry-only list; numbered variables are preferable when those keys should also appear as selectable providers.

### UI kit and gallery

Pi++ includes a terminal-safe UI foundation, semantic visual primitives, and interactive navigation components under `ui/`. Open the live component gallery with:

```text
/ui-gallery
```

Use `tab`/`shift+tab` to switch examples, `w` to simulate auto/50/80/120-column layouts, arrow keys or `j`/`k` to interact with examples, and `q` or `escape` to close.

The `interface` extension applies the same design system to Pi's main editor and footer. The editor preserves Pi's native history, autocomplete, paste, IME, multiline editing, application keybindings, extension shortcuts, widgets, and dialogs. Its border stays quiet unless it has useful context to communicate: a one-prompt `ULTRACODE` marker or a multiline count. The footer adapts project, branch, permission mode (`auto`, `manual`, or `read-only`), model, thinking, context, usage, cost, and live extension activity to the available width. Permission-mode changes repaint immediately. Streaming uses a restrained semantic pulse. The workflow browser now uses the same framed overlay system, follows selection in bounded terminals, updates live, and supports keyboard, page, and mouse-wheel detail scrolling.

Reasoning effort can be changed with `alt+e` or `/effort [off|minimal|low|medium|high|xhigh|max]`. Open the searchable keybinding browser with `f1` or `/keybindings`. In the browser, use `enter`/`e` to replace a binding, `a` to add one, `r` to restore its default, `x` to unbind it, and `/` to search. Core Pi changes are applied immediately and persisted atomically to `~/.pi/agent/keybindings.json`. Pi++ launcher actions appear in the same browser and persist to `~/.pi/agent/piplusplus-keybindings.json`. They are resolved dynamically by the custom editor before normal Pi input handling, so changes apply immediately without `/reload` while still preserving other extension and core shortcuts.

Command aliases are also resolved by the editor before Pi processes slash commands, allowing aliases for native commands. `/exit` maps to `/quit` by default. Use `/aliases` to list aliases, `/alias NAME TARGET` to set one, `/alias remove NAME` to disable/remove one, and `/alias reset NAME` to restore its default. Aliases and fixed target arguments persist in `~/.pi/agent/piplusplus-aliases.json` and apply immediately.
