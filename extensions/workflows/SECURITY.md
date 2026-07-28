# Workflow security model

## Trust boundaries

Workflow orchestration JavaScript is untrusted. It executes in a QuickJS WebAssembly runtime, not Node's `vm`. The guest has no Node globals, module loader, filesystem, process, network, environment, native addon, or host-realm object. Only copied JSON values and these capabilities cross the boundary: `agent`, `phase`, `models`, `log`, and `workflowPrompt`. `parallel` and `pipeline` execute inside QuickJS.

Subagents are separate Pi processes. Their tool calls are not trusted merely because the workflow script was approved: they pass through the optional global Pi++ permission service. If that dependency is absent, workflow workers fail closed to read-only operations.

## Resource and lifecycle controls

- QuickJS memory: 64 MiB.
- QuickJS stack: 2 MiB.
- Wall-clock deadline: 30 minutes by default, configurable per run from 1 second to 24 hours.
- Workers: at most 1,000 total and 16 concurrent.
- Worker stdout/NDJSON: 32 MiB maximum.
- Worker stderr: 1 MiB retained.
- Tool calls: 10,000 retained per worker.
- Lifecycle log events: 100,000 per worker and per run; dropped counts remain explicit.
- UTF-8 is decoded with `StringDecoder`, preserving characters split across chunks.
- Cancellation terminates the worker process tree, then escalates after a grace period. Linux uses process groups; Windows uses `taskkill.exe /t /f`.
- Run and artifact files use atomic replacement and default to 30-day retention.

## Limitations

Permission approval grants the requested subagent tool operation real access with the user's OS account. It is not an OS container. Auto mode is deterministic and conservative, but cannot prove arbitrary commands safe. Concurrent writes are forced back through confirmation. Manual mode should be used for unfamiliar repositories, and read-only mode for inspection-only workflows.
