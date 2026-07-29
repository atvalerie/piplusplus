# Workflow state and artifact migration

Current artifact schema: **v7**.

Workflow artifacts are continuously replaced audit indexes, not executable configuration. Consumers should branch on `schemaVersion`, tolerate missing fields from older files, and ignore unknown fields from newer files. Pi++ does not rewrite historical artifacts in place.

## Version history

| Version | Main additions |
| --- | --- |
| v2 | Legacy workflow metadata, agents, messages/events, outputs, usage, and lifecycle logs. Routing could use `modelFamily` and free-text `userModelInstruction`. |
| v3 | Structured `modelPolicy`, exact requested/resolved/reported model identity, and hard family/model allowlists. |
| v4 | Separate sensitive `rawOutput`, scanned downstream `output`, structured values, and scan findings. |
| v5 | Script/invocation/result hashes, dependency generations, cache state, restart invalidations, and structured workflow `args`. |
| v6 | Workflow size, hard budgets/projections/warnings, `budget_exhausted` states, and per-agent `maxTurns`. |
| v7 | Compact artifact index: transient raw Pi events/messages are no longer duplicated, logs/tools are tightly bounded across the run, identical raw/scanned results share one representation, and values beyond their adaptive preview (up to 64 KiB) use hashed `.data/*.txt` sidecars. Reload state is minified and adaptively clips large cache values, forcing a safe live rerun instead of a partial cache hit. |

Current writers also add the user-owned workflow `turnPolicy` and requested/effective/provider-mapped effort fields. Older readers must ignore unknown fields, and files without `turnPolicy` load with the safe current default of `off` (unlimited workers, script-proposed `maxTurns` ignored).

## Persisted run-state loading

Same-session run files under `~/.pi/agent/workflows/runs/` are normalized on load:

- missing usage, logs, legacy messages/events, scan findings, cache markers, and invalidation lists receive safe defaults;
- an old `modelFamily` becomes a hard `allowedFamilies` entry;
- absent routing defaults to `modelPolicy.defaultRouting: "inherit"`;
- absent worker `turnPolicy` is interpreted as `off`, the current unlimited default;
- legacy free-text `userModelInstruction` is retained in the old JSON but is **not parsed** into new policy constraints;
- v7 reload state whose prompt/output/structured value exceeded the persistence bound has no `resultHash`, so resume reruns it rather than treating a preview as a complete cache result;
- an interrupted queued/running/paused run becomes `stopped` and may be resumed within the same Pi session.

Because pre-v5 state has no stable invocation/result hashes, its old completed agents are not cache hits. Resume safely runs them live.

## Compatibility guidance

- Readers that only need a final answer should use `summary`.
- Security/audit readers should distinguish `rawOutput` from scanned `output`; v2/v3 files have no such guarantee. In v7, `rawOutputStorage.sameAs: "output"` deliberately deduplicates identical values and `ref` points to an exact large payload.
- Routing auditors should require `workflow.modelPolicy` and `reportedModel` for v3+ files.
- Budget-aware tooling should treat absent v6 `execution.budget` as “not recorded,” not as an unlimited decision.
- Never infer a vendor constraint by parsing legacy prose. Re-run or explicitly edit the workflow with a structured policy.
