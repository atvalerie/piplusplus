# Claude Code 2.1.220 public-behavior parity report

Audit date: 2026-07-28  
Pi target: 0.82.1  
Claude Code reference: 2.1.220

## Scope and evidence boundary

The target is observable/public behavior, not private implementation. Claude Code's proprietary system prompts and internal orchestration code are not available, so Pi++ cannot honestly claim byte-for-byte or prompt-for-prompt equivalence.

Public references used for this audit:

- [Claude Code npm package, version 2.1.220](https://www.npmjs.com/package/@anthropic-ai/claude-code?activeTab=versions)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Claude Code CLI limits and structured output](https://code.claude.com/docs/en/cli-usage)
- [Claude Code common workflows](https://code.claude.com/docs/en/common-workflows)

## Behavior matrix

| Area | Public Claude Code behavior | Pi++ behavior | Assessment |
| --- | --- | --- | --- |
| Natural-language delegation | The main model decides when and how to delegate based on the task and agent descriptions. | The main Pi model semantically creates `modelPolicy` and JavaScript. No vendor/language keyword parser exists. | Compatible intent |
| Worker context | A normal subagent starts in a fresh isolated context and returns a summary/result. | Every `agent()` launches a separate no-session Pi process; intermediate context stays outside the parent. | Compatible |
| Omitted model | Omitted subagent model defaults to `inherit`. | Omitted `agent.model` with default routing `inherit` uses the session model. | Match |
| Explicit model | Claude accepts aliases/full IDs; per-invocation selection outranks defaults. | Pi++ accepts an exact authenticated `provider/id` or ID. | Compatible, provider-neutral extension |
| Automatic routing | Claude chooses a suitable subagent/model within its product model set. | `auto` exists but is never implicit; the main model must request it. | Deliberately stricter/explicit |
| Provider/vendor constraints | Claude Code is Anthropic-model based. | `allowedProviders`, `allowedFamilies`, and `allowedModels` intersect to hard-limit OpenCode Go, direct Anthropic, direct OpenAI, and ModelHub routing. | Pi++ extension |
| Exact identity | Public behavior exposes selected model configuration. | Runtime also rejects output when the child reports a different exact model. | Pi++ hardening |
| Tool restriction | Subagents can inherit or restrict tools. | Each worker can inherit all tools or receive an allowlist/read-only alias. | Match for allowlists |
| Permission inheritance | Subagents inherit parent permission context; background work auto-denies prompts that cannot be shown. | Workers use the global Pi++ mode. Confirmation remains possible with UI; without UI it fails closed. | Intentional divergence |
| Direct path security | Claude permission rules and protected paths gate tools. | Requested/real paths, closest existing parents, sensitive paths, symlink/junction escapes, and artifact exceptions are centralized. | Compatible goal, Pi++ policy differs |
| Shell isolation | Claude supports sandboxing and `isolation: worktree`. | Pi 0.82.1 has no worker write-root hook. Scoped shell/custom mutations require explicit acknowledgement but are not OS-confined. | Known gap |
| Parallel workers | Claude supports foreground/background subagents and parallel research. | `parallel()` and concurrent independent workers are first-class; maximum concurrency is 16. | Match in outcome |
| Nested delegation | Claude subagents cannot spawn subagents; the parent chains them. | Workflow child processes do not load the workflow extension; QuickJS parent orchestration chains workers. | Match |
| `maxTurns` | Subagents/print mode support a maximum agentic-turn count. | Parent NDJSON tracking terminates a tool-using worker exactly once at `maxTurns`. | Match in outcome |
| Cost/turn limits | Claude subagents expose `maxTurns`; SDK loops can expose a USD budget, but public Claude Code workflows have no aggregate token-budget field. | User-owned off/custom/model modes control optional aggregate agent/token/cost scheduling thresholds; deadline and `maxTurns` terminate active work. | Pi++ extension, off by default |
| Size guidance | The target contract uses small/medium/large/unrestricted advisory sizes. | Same thresholds shape generation; configured scheduling thresholds remain authoritative for new starts. | Match |
| Pause/stop | Claude supports stopping background tasks and managing running agents. | Pause blocks new scheduling; resumable stop terminates live workers; hard stop is terminal. | Compatible with explicit Pi labels |
| Resume | Claude subagent transcripts can persist and resume with full history in a resumed session. | Same-session workflow resume replays QuickJS and reuses hash-valid completed results; live/stopped workers restart. | Partial; cross-session transcript resume is absent |
| Cache invalidation | Not documented as a public subagent-result contract. | Script/options/model/policy/args/dependency hashes control reuse; upstream restart invalidates downstream generations. | Pi++ extension |
| Structured output | Claude print mode supports final JSON Schema output. | Any worker can return a validated object/array/scalar/null directly to QuickJS; invalid output retries. | Pi++ extension/different scope |
| Output injection defense | Claude documents prompt-injection defenses and isolated subagent summaries. | Raw output is retained separately; downstream text/structured strings are escaped or explicitly marked. | Pi++ hardening |
| Reusable definitions | Claude supports user/project subagent definitions and skills. | Project/personal saved JavaScript workflows with `meta`, JSON `args`, slash commands, and project precedence. | Analogous, not format-compatible |
| Approval | Claude permission and plan approvals are product-level UI decisions. | Launch approval is separate from worker permissions; exact-script/project trust requires explicit UI selection. | Compatible safety goal |
| Mid-run semantic gate | Claude's private workflow planner behavior is not a public API contract. | QuickJS exposes `approve(title, detail)` for semantic stage gates. | Intentional Pi++ divergence |
| Catalog prompt cost | Claude exposes only relevant model choices in its own prompt/tool surface. | Main prompt receives a bounded family/count summary; exact IDs require `workflow_models`. | Compatible efficiency goal |
| Literal `ultracode` | Not a documented Claude Code subagent API. | Optional Pi++ convenience, authenticated to `interactive` input only and independently disableable. | Pi++ extension |

## What Pi++ now does better for this use case

- Hard multi-vendor allowlists with exact reported-model verification.
- Per-stage runtime JSON Schema validation returning real guest values.
- Explicit raw-versus-scanned output audit trail.
- Deterministic result-cache identity and downstream invalidation.
- Continuously updated schema-v6 artifacts with model, permission, usage, retry, scan, cache, and budget evidence.
- Workflow-wide token/cost/agent budgets in interactive and background operation.

## What remains behind Claude Code

- No OS/process sandbox or temporary git worktree per mutating worker.
- No full worker transcript continuation across a restarted Pi process.
- Saved workflow JavaScript is Pi++-specific and does not load Claude `.claude/agents/*.md` definitions.
- Pi's global permission modes do not reproduce every Claude precedence rule (`dontAsk`, managed policy, background auto-denial, and `bypassPermissions`) one-for-one.
- The manager is a Pi extension UI, not Claude Code's native agent view.

## Acceptance audit

| Requirement | Evidence |
| --- | --- |
| Polish “only OpenAI” requests are handled semantically | System contract requires original-language semantic interpretation; `modelPolicy` is structured and no natural-language routing parser exists. |
| No Anthropic worker under OpenAI-only policy | Runtime filters eligible models before spawn and verifies child-reported identity. |
| Omitted model inherits; `auto` is explicit | `resolveModel` tests cover both branches. |
| Structured values cross QuickJS | Nested, scalar, array, null, and retry tests pass. |
| Worker output is scanned before downstream use | Plain and recursive structured scanner integration tests pass. |
| Direct/shell mutations cannot silently escape scope | Real-path/junction tests pass; unconfined shell/custom tools force acknowledgement. |
| Same-session cache/resume and dependency invalidation | Resume tests verify reuse, restart, hashes, downstream invalidation, and no double charge. |
| Saved `meta` and `args` | Parser, precedence, traversal, symlink, and QuickJS argument tests pass. |
| Budgets and large-run visibility | Agent/token/cost/turn/cache/threshold tests pass. |
| Model cannot persist trust | Trust writer is only called from an explicit UI branch; identity changes with script/project. |
| Literal trigger origin | Interactive/RPC/extension tests pass; disabled triggers do not affect direct tools or saved commands. |
| Prompt remains bounded | Tests cover a 2,000-model/2,000-family catalog and representative 24-model reduction. |

Conclusion: Pi++ matches the requested public behavior contract where Pi 0.82.1 exposes an enforceable equivalent, adds stronger ModelHub routing/audit features, and explicitly reports the remaining process-isolation, cross-session-resume, and permission-precedence gaps. It does **not** claim private implementation parity.
