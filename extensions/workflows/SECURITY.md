# Workflow security model

## Trust boundaries

Workflow orchestration JavaScript is untrusted. It executes in a QuickJS WebAssembly runtime, not Node's `vm`. The guest has no Node globals, module loader, filesystem, network, environment, native addon, or host-realm object. It receives copied JSON `args`, `cwd`, and `platform` values plus a frozen, capability-free compatibility object exposing only `process.cwd()` and `process.platform`; this is not Node's process object. Only copied JSON values and these capabilities cross the boundary: `agent`, `approve`, `phase`, `models`, `log`, `args`, `workflowPrompt`, `cwd`, and `platform`. `parallel` and `pipeline` execute inside QuickJS.

Subagents are separate Pi processes. Their tool calls are not trusted merely because the workflow script was approved: they pass through the optional global Pi++ permission service. If that dependency is absent, workflow workers fail closed to read-only operations. Launch approval, persistent trust for an exact script/project identity, a script's semantic mid-run `approve()` gate, and individual worker tool permissions are four separate decisions. Only an explicit approval-UI action can write persistent workflow trust.

The main orchestrating model expresses its routing decision as a structured `modelPolicy`; the runtime does not parse natural-language keywords. Omitted worker models inherit the session model. Workflows accept only the supported provider groups `opencode-go`, `anthropic`, `openai`, and `modelhub`; numbered ModelHub key aliases collapse to the `modelhub` group. `allowedProviders`, `allowedFamilies`, and `allowedModels` are intersected before launch. ModelHub supplies authoritative underlying-family metadata for its aliases, while direct OpenAI and Anthropic providers map to their matching family. The configured model identity reported by the child is checked against the requested model before its result is accepted.

Worker output is untrusted input. Plain text is scanned before it enters another worker or the parent handoff: harness-like role prefixes and system tags are escaped, while instruction- and permission-bypass-shaped text receives an explicit marker. Structured output is first parsed and schema-validated, then every string value is scanned recursively without changing the JSON shape. Exact raw assistant text is retained only in sensitive run state and artifacts.

Direct file policy resolves both the requested path and real path. For non-existent targets it resolves the closest existing parent, preventing traversal and symlink/junction escapes. Credential files are denied. Repository automation/control paths such as `.git`, `.pi`, `.claude`, IDE settings, hooks, CI workflows, and package-manager control files require a decision. Workflow artifact JSON has a narrow internal read exception without granting arbitrary access to the agent home directory. `writePaths` confines direct write/edit tools.

## Resource and lifecycle controls

- QuickJS memory: 64 MiB.
- QuickJS stack: 2 MiB.
- Wall-clock deadline: 30 minutes by default, configurable per run from 1 second to 24 hours.
- Workers: at most 1,000 total and 16 concurrent.
- Optional user-owned scheduling thresholds: agent count, consumed input/output/cache tokens, and reported cost. Exhaustion blocks new starts, but already-running workers may report an in-flight overrun. Per-worker `maxTurns` and the workflow deadline terminate active work.
- Size guidance: `small` <5 agents, `medium` <15, `large` <50, or `unrestricted`; warning thresholds are more than 25 scheduled agents or more than 1.5 million projected output tokens.
- Worker stdout/NDJSON: 32 MiB maximum.
- Worker stderr: 1 MiB retained.
- Tool calls: 10,000 retained per worker.
- Lifecycle log events: 100,000 per worker and per run; raw JSON events: 50,000 per worker. Dropped counts remain explicit.
- Failed worker attempts retry three times with bounded exponential backoff by default; cancellation wakes pending backoffs.
- Schema-validation failures are retryable; model-policy, model-identity, turn-limit, and hard-budget failures are deterministic and are not retried.
- UTF-8 is decoded with `StringDecoder`, preserving characters split across chunks.
- Cancellation terminates the worker process tree, then escalates after a grace period. Linux uses process groups; Windows uses `taskkill.exe /t /f`.
- Run, artifact, saved-workflow, settings, and trust files use atomic replacement and owner-only modes where supported. Runs/artifacts default to 30-day retention. Artifacts are continuously updated and contain prompts, raw model responses, reasoning content when emitted, tool arguments/results, and errors; protect them as sensitive session data.
- Same-session resume executes the sandbox script again and reuses only invocation-hash matches. Cache identity includes script, prompt, options, exact model, policy, args, and upstream result generations; explicit upstream restart invalidates dependent results.

## Limitations

Permission approval grants the requested subagent tool operation real access with the user's OS account. It is not an OS container. Pi 0.82.1 exposes no child-process write-root sandbox hook, so arbitrary Bash/PowerShell/custom tools cannot be proven confined to `writePaths`. Scoped workers therefore require explicit per-call acknowledgement for these tools; this is a warning and approval boundary, not process isolation. Concurrent overlapping writes are forced back through confirmation. Use manual mode for unfamiliar repositories and read-only mode for inspection-only workflows.

Pi++ does not yet create an isolated temporary git worktree for each mutating worker. Claude Code supports `isolation: worktree`; this remains a documented parity gap. Pi++ also resumes workflow results only within the same Pi session by deterministic script/cache replay, not by restoring a worker's full transcript across process restarts.
