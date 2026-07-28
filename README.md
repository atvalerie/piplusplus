# piplusplus

A collection of independently configurable [Pi](https://pi.dev) extensions.

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

### `workflows`

Runs Claude Code-style dynamic workflows as deterministic JavaScript orchestration scripts. The script uses `agent()`, `parallel()`, `pipeline()`, and `phase()` to manage up to 1,000 isolated subagents, with at most 16 running concurrently. Every `agent()` call has its own prompt and may select its own model, thinking level, and tool set. Intermediate results remain in script variables; only the returned result enters the main conversation.

Model choices come from Pi's live authenticated model catalog, available to the planning agent through `workflow_models` and to scripts through `models()`. Explicit user choices take precedence; otherwise the planning agent can select any model independently for every subagent, record its rationale, or delegate a choice to `auto`.

Useful commands:

```text
/workflows                 interactive run list and detailed stats
/workflows status <id>     compact status
/workflows stop <id>       stop a run
```

Include the bounded word `ultracode` anywhere in a prompt to opt that prompt into xhigh reasoning and dynamic workflow generation. It is a one-prompt trigger, not a command or persistent session mode. `/workflows` drills down from workflow → phase → subagent → full prompt, tool calls, model, usage, error, and result. It also supports pausing/resuming, stopping a run or selected agent, and restarting a running agent. Background completion is delivered back to the main agent automatically.
