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

Run `/extension-update` to update immediately. Git or npm packages installed with a pinned version/ref are intentionally skipped by Pi's package updater; install a newer pin explicitly to update them.

### `permissions`

Provides a global permission policy for the main agent and dependent extensions. Use `/permissions` or `/permissions manual|auto|read-only`. `manual` explains and confirms every write, edit, shell command, or unknown custom tool. `auto` immediately permits read-only tools, conservative inspection commands, and non-sensitive writes contained inside the project; uncertain, destructive, privileged, networked, and sensitive-path operations require confirmation. `read-only` blocks mutations. Confirmation-required operations fail closed without a TUI. The selected mode persists in `~/.pi/agent/piplusplus-permissions.json`.

### `workflows`

Runs Claude Code-style dynamic workflows as deterministic JavaScript orchestration scripts. Orchestration executes in a QuickJS WebAssembly capability sandbox with no Node, process, filesystem, network, module, or host-realm access; only the documented workflow primitives cross the boundary. The sandbox has a 64 MiB memory limit, 2 MiB stack limit, and a parent-enforced wall-clock deadline (`timeoutMs`, 30 minutes by default). The script uses `agent()`, `parallel()`, `pipeline()`, and `phase()` to manage up to 1,000 isolated subagents, with at most 16 running concurrently. Every `agent()` call has its own prompt and may select its own model, thinking level, and tool set. Intermediate results remain in script variables; only the returned result enters the main conversation.

Model choices come from Pi's live authenticated model catalog, available to the planning agent through `workflow_models` and to scripts through `models()`. Explicit user choices take precedence; otherwise the planning agent can select any model independently for every subagent, record its rationale, or delegate a choice to `auto`.

Useful commands:

```text
/workflows                 interactive run list and detailed stats
/workflows status <id>     compact status
/workflows stop <id>       stop a run
```

Include the bounded word `ultracode` anywhere in a prompt to opt that prompt into xhigh reasoning and dynamic workflow generation. It is a one-prompt trigger, not a command or persistent session mode. `/workflows` drills down from workflow → phase → subagent → full prompt, tool calls, model, usage, error, and result. If no verification worker actually executes, Pi++ also writes one consolidated handoff JSON under `~/.pi/agent/workflows/artifacts/`; the parent agent is explicitly instructed to read it before reporting. The artifact contains workflow metadata and script, every prompt and output, summary, agent counts and statuses, models, usage, tool calls, permission decisions, flags, errors, and lifecycle logs.

Workflows discover and inherit the global permission service automatically; if it is unavailable, workers fall back to read-only behavior. Concurrent workflow writes require confirmation even in auto mode. Script approval and global tool permission are deliberately separate. Workflows also support pausing/resuming, stopping a run or selected agent, and restarting a running agent. Worker process trees receive graceful termination followed by forced escalation using Linux process groups or Windows `taskkill`. UTF-8 streams, output bytes, stderr, tool history, and event history are bounded during collection. Persisted runs and artifacts default to 30-day retention; set `PIPLUSPLUS_WORKFLOW_RETENTION_DAYS=1..365` to change it. Background completion is delivered back to the main agent automatically. See [`extensions/workflows/SECURITY.md`](./extensions/workflows/SECURITY.md) for the complete threat model, limits, and remaining OS-level caveats.

### ModelHub provider and modular telemetry

`modelhub-provider` discovers ModelHub's live public catalog and registers its text/vision models with their current token prices. Run `/login`, choose **ModelHub**, and paste an `sk-mh-…` API key; Pi validates and stores it in its normal credential store. `/logout` removes it. `MODELHUB_API_KEY` remains available as a non-persisted environment fallback. Additional independently selectable keys can be exposed as `modelhub-2` through `modelhub-8` with `MODELHUB_API_KEY_2` … `MODELHUB_API_KEY_8`.

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

The `interface` extension applies the same design system to Pi's main editor and footer. The editor preserves Pi's native history, autocomplete, paste, IME, multiline editing, and application keybindings. Its border stays quiet unless it has useful context to communicate: a one-prompt `ULTRACODE` marker or a multiline count. The footer adapts project, branch, model, thinking, context, usage, cost, and extension status information to the available width. Streaming uses a restrained semantic pulse.

Reasoning effort can be changed with `alt+e` or `/effort [off|minimal|low|medium|high|xhigh|max]`. Open the searchable keybinding browser with `f1` or `/keybindings`. In the browser, use `enter`/`e` to replace a binding, `a` to add one, `r` to restore its default, `x` to unbind it, and `/` to search. Core Pi changes are applied immediately and persisted atomically to `~/.pi/agent/keybindings.json`. Pi++ launcher actions appear in the same browser and persist to `~/.pi/agent/piplusplus-keybindings.json`. They are resolved dynamically by the custom editor before normal Pi input handling, so changes apply immediately without `/reload` while still preserving other extension and core shortcuts.
