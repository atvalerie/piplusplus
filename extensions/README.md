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

- `auto-update.ts` — periodically updates unpinned Pi packages.
- `permissions.ts` — global manual, conservative auto, and read-only permission policy with explanatory confirmation modals and a dependency service for other extensions.
- `shared/permission-service.ts` — shared dependency contract used by the permission extension and consumers such as workflows.
- `workflows.ts` / `workflows/` — JavaScript-orchestrated dynamic workflows with independently prompted and model-routed subagents, background execution, drill-down TUI state, usage statistics, flags, and error reporting.
- `modelhub-provider.ts` — live ModelHub catalog and OpenAI/Anthropic-compatible provider registration.
- `secrets.ts` / `shared/secret-service.ts` — reusable masked secret setup and owner-only atomic local storage dependency.
- `telemetry-core.ts` — provider-neutral telemetry registry and refresh lifecycle.
- `modelhub-telemetry.ts` — optional ModelHub wallet, limits, usage, keys, and savings adapter.
- `telemetry-ui.ts` — provider-neutral `/telemetry` side inspector and `setup`/`clear` flow for adapter-declared secrets.
- `ui-gallery.ts` — interactive gallery for validating Pi++ foundation, static, responsive, and navigation primitives.
- `interface.ts` — Quiet Control Room composer, responsive footer, streaming indicator, and optional shared telemetry summary for Pi's main TUI.
