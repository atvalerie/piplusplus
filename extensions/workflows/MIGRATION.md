# Workflow state and artifact migration

Current artifact schema: **v6**.

Workflow artifacts are append-only audit snapshots, not executable configuration. Consumers should branch on `schemaVersion`, tolerate missing fields from older files, and ignore unknown fields from newer files. Pi++ does not rewrite historical artifacts in place.

## Version history

| Version | Main additions |
| --- | --- |
| v2 | Legacy workflow metadata, agents, messages/events, outputs, usage, and lifecycle logs. Routing could use `modelFamily` and free-text `userModelInstruction`. |
| v3 | Structured `modelPolicy`, exact requested/resolved/reported model identity, and hard family/model allowlists. |
| v4 | Separate sensitive `rawOutput`, scanned downstream `output`, structured values, and scan findings. |
| v5 | Script/invocation/result hashes, dependency generations, cache state, restart invalidations, and structured workflow `args`. |
| v6 | Workflow size, hard budgets/projections/warnings, `budget_exhausted` states, and per-agent `maxTurns`. |

## Persisted run-state loading

Same-session run files under `~/.pi/agent/workflows/runs/` are normalized on load:

- missing usage, logs, messages, events, scan findings, cache markers, and invalidation lists receive safe defaults;
- an old `modelFamily` becomes a hard `allowedFamilies` entry;
- absent routing defaults to `modelPolicy.defaultRouting: "inherit"`;
- legacy free-text `userModelInstruction` is retained in the old JSON but is **not parsed** into new policy constraints;
- an interrupted queued/running/paused run becomes `stopped` and may be resumed within the same Pi session.

Because pre-v5 state has no stable invocation/result hashes, its old completed agents are not cache hits. Resume safely runs them live.

## Compatibility guidance

- Readers that only need a final answer should use `summary`.
- Security/audit readers should distinguish `rawOutput` from scanned `output`; v2/v3 files have no such guarantee.
- Routing auditors should require `workflow.modelPolicy` and `reportedModel` for v3+ files.
- Budget-aware tooling should treat absent v6 `execution.budget` as “not recorded,” not as an unlimited decision.
- Never infer a vendor constraint by parsing legacy prose. Re-run or explicitly edit the workflow with a structured policy.
