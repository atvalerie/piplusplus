# Pi++ static primitives

Static primitives turn the foundation's terminal-safe lines into the **Quiet Control Room** visual language. They implement Pi TUI's `Component` interface and remain domain-independent.

## Semantic styling

Use `Tone` rather than Pi color names:

- `neutral`: primary content
- `accent` / `active` / `info`: focus and live activity
- `muted` / `subtle`: secondary and tertiary context
- `success`: completed normally
- `warning`: waiting, paused, or attention required
- `danger`: failed or destructive

The adapter in `primitives/theme.ts` maps these tones onto the active Pi theme. Color must accompany a glyph or text label when it communicates state.

## Components

| Component | Purpose |
| --- | --- |
| `Label` | Styled ANSI-safe text with wrapping, alignment, and line limits |
| `Badge` | Compact state/category marker; solid, outline, or plain |
| `Rule` | Restrained labeled or unlabeled separator |
| `ProgressBar` | Determinate or animated indeterminate progress |
| `Metric` | Label/value/detail pair that stacks when narrow |
| `Breadcrumb` | Width-aware navigation context with middle collapse |
| `KeyHints` | Consistent keyboard affordances |
| `Surface` | Optional heading, separator, or frame around any component |
| `StateMessage` | Generic non-color-only state presentation |
| `EmptyState` | Quiet absence/first-use state |
| `ErrorState` | Explicit failure state |

Inline helpers (`badgeText`, `metricText`, `statusText`, `spinnerText`, and `keyHintText`) allow the same visual atoms inside composed lines.

## Example

```ts
const progress = new ProgressBar({
  theme,
  label: "Agents",
  value: 7,
  total: 10,
  tone: "active",
});

const panel = new Surface({
  theme,
  title: "Repository audit",
  subtitle: "Verification",
  border: "line",
  body: progress,
});
```

All primitives constrain their output to the width passed to `render()`. Components that cache styled output clear it through `invalidate()` so theme changes are safe.
