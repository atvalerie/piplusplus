# Workflow security model

## Trust boundaries

Workflow orchestration JavaScript is untrusted. It executes in a QuickJS WebAssembly runtime, not Node's `vm`. The guest has no Node globals, module loader, filesystem, network, environment, native addon, or host-realm object. It receives copied JSON `args`, `cwd`, and `platform` values plus a frozen, capability-free compatibility object exposing only `process.cwd()` and `process.platform`; this is not Node's process object. Only copied JSON values and these capabilities cross the boundary: `agent`, `approve`, `phase`, `models`, `log`, `args`, `workflowPrompt`, `cwd`, and `platform`. `parallel` and `pipeline` execute inside QuickJS.

Subagents are separate Pi processes. Their tool calls are not trusted merely because the workflow script was approved: they pass through the optional global Pi++ permission service. If that dependency is absent, workflow workers fail closed to read-only operations. Launch approval, persistent trust for an exact script/project identity, a script's semantic mid-run `approve()` gate, and individual worker tool permissions are four separate decisions. Only an explicit approval-UI action can write persistent workflow trust.

The main orchestrating model expresses its routing decision as a structured `modelPolicy`; the runtime does not parse natural-language keywords. Omitted worker models inherit the session model. Workflows accept only the supported provider groups `opencode-go`, `anthropic`, `openai`, and `modelhub`; Pi's `openai-codex` ChatGPT OAuth provider normalizes to the `openai` group, while numbered ModelHub key aliases collapse to `modelhub`. The exact provider ID is still preserved for child launch and identity verification. `allowedProviders`, `allowedFamilies`, and `allowedModels` are intersected before launch. ModelHub supplies authoritative underlying-family metadata for its aliases, while direct OpenAI, OpenAI Codex OAuth, and Anthropic providers map to their matching family. The configured model identity reported by the child is checked against the requested model before its result is accepted.

Worker output is untrusted input. Plain text is scanned before it enters another worker or the parent handoff: harness-like role prefixes and system tags are escaped, while instruction- and permission-bypass-shaped text receives an explicit marker. Structured output is first parsed and schema-validated, then every string value is scanned recursively without changing the JSON shape. The compact artifact keeps scanned previews and hashes; exact large final payloads are stored in owner-only content-addressed sidecars rather than being duplicated through raw events, messages, and output fields.

Direct file policy resolves both the requested path and real path. For non-existent targets it resolves the closest existing parent, preventing traversal and symlink/junction escapes. Credential files are denied. Repository automation/control paths such as `.git`, `.pi`, `.claude`, IDE settings, hooks, CI workflows, and package-manager control files require a decision. Workflow artifact indexes and their referenced `.data/*.txt` payloads have a narrow internal read exception without granting arbitrary access to the agent home directory. `writePaths` confines direct write/edit tools.

## Resource and lifecycle controls

- QuickJS memory: 64 MiB.
- QuickJS stack: 2 MiB.
- Wall-clock deadline: 30 minutes by default, configurable per run from 1 second to 24 hours.
- Workers: at most 1,000 total and 16 concurrent.
- Optional user-owned scheduling thresholds: agent count, consumed input/output/cache tokens, and reported cost. Exhaustion blocks new starts, but already-running workers may report an in-flight overrun. Worker `maxTurns` has a separate persistent off/custom/model policy and defaults to unlimited; a custom or model-enabled limit and the workflow deadline terminate active work.
- Size guidance: `small` <5 agents, `medium` <15, `large` <50, or `unrestricted`; warning thresholds are more than 25 scheduled agents or more than 1.5 million projected output tokens.
- Worker prompts travel over stdin rather than process arguments; generated profile/schema instructions use an owner-only temporary file consumed by Pi's file-aware system-prompt option. This avoids Windows command-line limits without exposing prompt contents in process listings.
- Worker results use plain print-mode stdout with a 16 MiB final-response ceiling. A dedicated IPC pipe carries only compact lifecycle/usage/tool metadata with a 64 KiB per-event ceiling; token-by-token `message_update` snapshots and full tool results are never forwarded to the parent.
- Worker stderr: 1 MiB retained.
- Tool-call summaries: 500 per worker, with arguments bounded to 8 KiB each; omitted counts remain explicit.
- Lifecycle log events: 2,000 per worker and 5,000 per run. Stream progress is not duplicated into lifecycle logs. Raw Pi JSON events and complete messages are processed transiently and are not retained by default.
- Failed worker attempts retry three times with bounded exponential backoff by default; cancellation wakes pending backoffs.
- Schema-validation failures are retryable; model-policy, model-identity, turn-limit, and hard-budget failures are deterministic and are not retried.
- UTF-8 is decoded with `StringDecoder`, preserving characters split across chunks.
- Cancellation terminates the worker process tree, then escalates after a grace period. Linux uses process groups; Windows uses `taskkill.exe /t /f`. QuickJS async host bridges are detached before sandbox disposal, so deadline/abort races cannot call into a freed runtime.
- Run, artifact, saved-workflow, settings, and trust files use atomic replacement and owner-only modes where supported. Runs/artifacts default to 30-day retention. Schema-v7 artifacts are compact indexes: prompt/result previews adapt to agent count and top out at 64 KiB, large final values live in immutable sidecars, and duplicate raw-event/message transcripts are omitted. Treat indexes and sidecars as sensitive session data.
- Same-session resume executes the sandbox script again and reuses only invocation-hash matches. Cache identity includes script, prompt, options, exact model, policy, args, and upstream result generations; explicit upstream restart invalidates dependent results.

## Limitations

Permission approval grants the requested subagent tool operation real access with the user's OS account. It is not an OS container. Pi 0.82.1 exposes no child-process write-root sandbox hook, so arbitrary Bash/PowerShell/custom tools cannot be proven confined to `writePaths`. Scoped workers therefore require explicit per-call acknowledgement for these tools; this is a warning and approval boundary, not process isolation. Concurrent overlapping writes are forced back through confirmation. In global `auto` mode, reads and ordinary in-project edits are deterministic fast paths; every other action is classified with current user intent, project instructions, the delegated task, and prior tool calls, but never tool results. Classifier denials and failures block without prompting and are returned to the worker with a reason. Repeated denials trigger the same 3-consecutive/20-total manual fallback used by Claude Code. Use manual mode for unfamiliar repositories and read-only mode for inspection-only workflows.

Pi++ does not yet create an isolated temporary git worktree for each mutating worker. Claude Code supports `isolation: worktree`; this remains a documented parity gap. Pi++ also resumes workflow results only within the same Pi session by deterministic script/cache replay, not by restoring a worker's full transcript across process restarts.
