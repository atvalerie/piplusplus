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
- `workflows.ts` / `workflows/` — JavaScript-orchestrated dynamic workflows with independently prompted and model-routed subagents, background execution, drill-down TUI state, usage statistics, flags, and error reporting.
