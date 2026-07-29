# Extensions

Each Pi extension in this directory is a standalone TypeScript entry point. Keeping one feature per `*.ts` file lets Pi discover it as a separate package resource, so users can enable or disable individual extensions with `pi config` after installing this package.

Add extensions directly to this directory, for example:

```text
extensions/
├── git-helpers.ts
└── safe-bash.ts
```

Each file must default-export an extension factory:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, or event handlers here.
}
```

## Included resources

- `piplusplus.ts` / `shared/settings-service.ts` — extensible interactive control center available as `/pi++`, `/piplusplus`, and `/pipp`; owner extensions provide live summaries and retain responsibility for validation, persistence, and runtime synchronization.
- `auto-update.ts` — periodically updates unpinned Pi packages, with a persistent interval editor in the Pi++ control center.
- `permissions.ts` / `permission-classifier.ts` / `auto-permission.ts` — global manual, accept-edits, Claude-compatible auto, read-only, optional plan, and session-only dangerous modes with a dependency service for other extensions. Auto mode immediately allows reads and ordinary in-project edits, routes every other action through an isolated intent-aware classifier without tool results, blocks denials without prompting, records retryable recent denials, and implements Claude's 3-consecutive/20-total manual-fallback thresholds.
- `plan-mode.ts` / `shared/plan-mode.ts` — standalone Claude-style `plan` permission mode, read-only planning, auto/manual execution acceptance, optional native compaction, exact plan handoff, and persistent progress.
- `shared/permission-service.ts` — shared dependency contract used by the permission extension and consumers such as workflows.
- `workflows.ts` / `workflows/` — audited diagnose/design/review/implement recipes plus sandboxed custom JavaScript workflows, reusable specialist profiles, structured-output validation, semantic approval gates, scoped direct writes, independently model-routed workers, retries, live usage, compact JSON artifact indexes with large-payload sidecars, explicit model-family enforcement, neutral optional auto-routing, and a keyboard-focusable bottom workflow dock.
- `modelhub-provider.ts` — live ModelHub catalog and OpenAI/Anthropic-compatible provider registration.
- `secrets.ts` / `shared/secret-service.ts` — reusable masked secret setup and owner-only atomic local storage dependency.
- `telemetry-core.ts` — provider-neutral telemetry registry and refresh lifecycle.
- `modelhub-telemetry.ts` — optional ModelHub wallet, limits, usage, keys, and savings adapter.
- `telemetry-ui.ts` — provider-neutral `/telemetry` side inspector and `setup`/`clear` flow for adapter-declared secrets.
- `ui-gallery.ts` — interactive gallery for validating Pi++ foundation, static, responsive, and navigation primitives.
- `interface.ts` — Quiet Control Room composer, responsive footer, streaming indicator, editable command aliases, and optional shared telemetry summary for Pi's main TUI.
