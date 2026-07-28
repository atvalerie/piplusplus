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

### `auto-update`

On startup and every 60 minutes, checks for and installs updates to unpinned Pi packages with `pi update --extensions`. Updated extension code takes effect after restarting Pi or running `/reload`.

Set a different interval in minutes at launch:

```bash
pi --extension-update-interval 30
```

Run `/extension-update` to update immediately. The updater invokes the current Pi entry point directly (including Windows paths with spaces) and only falls back to `cmd.exe` for npm's `pi.cmd` shim. Failures include captured stderr/stdout instead of reporting only an exit code. Git or npm packages installed with a pinned version/ref are intentionally skipped by Pi's package updater; install a newer pin explicitly to update them.

### `permissions`

Provides a global permission policy for the main agent and dependent extensions. Open the mode selector with `Ctrl+Alt+M` (or `/permissions`); it offers `manual`, `accept-edits`, `auto`, `read-only`, optional `plan`, and `dangerous`. `manual` confirms writes, edits, shell commands, and unknown tools. `accept-edits` automatically accepts every direct `write`/`edit` operation but still confirms shell commands, concurrent workflow mutations, and unknown tools. `auto` also permits deterministic low-risk inspection commands and pipelines. `read-only` blocks mutations. `plan` is registered by the separate plan-mode extension. `dangerous` bypasses every Pi++ tool confirmation, requires an explicit warning confirmation, is visibly marked in the footer, and deliberately resets to `manual` after restart rather than persisting. Confirmation-required operations fail closed without a TUI. Persistent modes are stored in `~/.pi/agent/piplusplus-permissions.json`.

### `plan-mode`

Provides a standalone Claude-style permission mode rather than a command-driven recipe. When enabled alongside `permissions`, **plan** appears as a peer of `manual`, `auto`, and `read-only` in the permission-mode selector and footer (`perm:plan`). Select it from `/permissions` or press `Ctrl+Alt+P`, then type requests normally. Plan mode removes mutating tools and workflows and limits shell access to Pi++'s deterministic inspection policy.

After the agent produces a scoped numbered plan, the approval dialog offers the Claude-style transitions: **compact context then accept all edits**, **execute and accept all edits**, **execute in conservative auto mode**, **execute with manual approvals**, **keep planning**, **refine**, or **cancel**. Compaction preserves planning decisions and injects the exact approved plan again afterward. Execution restores the previous tools, switches the global permission mode selected in the dialog, tracks `[DONE:n]` markers, and persists across resume. `/plan` commands remain optional automation/fallback controls; start directly with `pi --plan-mode` if desired.

### `workflows`

Runs Claude Code-style dynamic workflows as deterministic JavaScript orchestration scripts. Orchestration executes in a QuickJS WebAssembly capability sandbox with no real Node process, filesystem, network, module, or host-realm access; only the documented workflow primitives cross the boundary. The sandbox has a 64 MiB memory limit, 2 MiB stack limit, and a parent-enforced wall-clock deadline (`timeoutMs`, 30 minutes by default). The script uses `agent()`, `parallel()`, `pipeline()`, and `phase()` to manage up to 1,000 isolated subagents, with at most 16 running concurrently. Every `agent()` call has its own prompt and may select its own model, thinking level, and tool set. Intermediate results remain in script variables; only the returned result enters the main conversation.

Model choices come from Pi's live authenticated model catalog, available through `workflow_models` and `models()`. The orchestrating model may write its entire script and choose every worker model independently; recipes, profiles, and `auto` routing are optional. Explicit GPT/OpenAI or Claude/Anthropic requests become runtime family constraints, so unavailable requested families fail clearly instead of falling back to another family. Neutral `auto` routing no longer contains Opus/GPT brand preference; research favors cost-efficient capability while stronger phases use capability metadata.

While a workflow is active, pressing Down from the editor's last line moves focus into a bottom-docked workflow manager without losing the prompt buffer. Up from the first workflow row (or Escape) returns to editing. `/workflows` opens the same bottom dock explicitly; other inspectors remain centered.

Useful commands:

```text
/workflows                 interactive run list and detailed stats
/workflows status <id>     compact status
/workflows stop <id>       stop a run
```

Include the bounded word `ultracode` anywhere in a prompt to opt that prompt into xhigh reasoning and dynamic workflow generation. It is a one-prompt trigger, not a command or persistent session mode. `/workflows` drills down from workflow → phase → subagent → full prompt, tool calls, model, live usage, error, and result. Every workflow immediately creates a continuously updated JSON source of truth under `~/.pi/agent/workflows/artifacts/`, including workflows with verification. The returned artifact path is readable by the main agent at any time. It contains workflow metadata and script, raw bounded Pi JSON events, complete assistant/tool messages and reasoning when providers emit it, partial and final outputs, retries, usage, permission decisions, flags, errors, and lifecycle logs.

Standard workflow work can use audited `diagnose`, `design`, `review`, and foreground `implement` recipes instead of generated JavaScript. The recipe/profile direction was informed by the MIT-licensed [shinpr/claude-code-workflows](https://github.com/shinpr/claude-code-workflows); Pi++ independently implements the concepts on its permission-enforced, provider-neutral runtime rather than bundling their prompt tree. Reusable researcher, investigator, planner, implementer, reviewer, security-reviewer, verifier, quality-fixer, and synthesizer profiles add evidence-focused prompts; structured profile responses are runtime-validated and malformed responses retry. The implementation recipe pauses for semantic plan approval, applies declared direct write/edit scopes, runs repository quality checks, and finishes with independent code and security review.

Workflow orchestration receives safe copied `cwd` and `platform` values. A frozen compatibility facade provides `process.cwd()` and `process.platform` for generated scripts without exposing Node, environment variables, filesystem, or process control. Agent `tools` accepts arrays, comma-separated names, `read-only`, or `all`. Workflow token, turn, cache, and cost totals update on every completed child message rather than only when the process exits. Failed child attempts—including transient gateway errors—retry three times by default with exponential backoff; `maxRetries` and `retryBaseMs` can override this per run. Workflows discover and inherit the global permission service automatically; if it is unavailable, workers fall back to read-only behavior. Concurrent workflow writes require confirmation even in auto mode. Script approval and global tool permission are deliberately separate. Workflows also support pausing/resuming, stopping a run or selected agent, and restarting a running agent. Worker process trees receive graceful termination followed by forced escalation using Linux process groups or Windows `taskkill`. UTF-8 streams, output bytes, stderr, tool history, and event history are bounded during collection. Persisted runs and artifacts default to 30-day retention; set `PIPLUSPLUS_WORKFLOW_RETENTION_DAYS=1..365` to change it. Background completion is delivered back to the main agent automatically. See [`extensions/workflows/SECURITY.md`](./extensions/workflows/SECURITY.md) for the complete threat model, limits, and remaining OS-level caveats.

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
