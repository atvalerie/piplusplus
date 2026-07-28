# Pi++ UI foundation

## Direction

The UI follows the **Quiet Control Room** design: dense, calm, keyboard-first, and explicit about operational state. Hierarchy comes from spacing, alignment, and restrained rules rather than nested boxes.

## Invariants

1. Every rendered line fits its declared terminal width.
2. Width means terminal columns, never JavaScript string length.
3. ANSI styling and wide graphemes must survive wrapping, clipping, padding, and composition.
4. Components consume semantic tones; they do not hard-code RGB colors.
5. Layout adapts at compact (`<72`), regular (`72–119`), and wide (`>=120`) widths.
6. Unicode symbols always have conservative ASCII alternatives.
7. State changes invalidate cached output before requesting a render.
8. Color supplements state but never communicates it alone.
9. Labels must identify a real mode, state, object, or action; decorative labels are noise.
10. Each piece of metadata has one canonical surface—do not duplicate model, usage, or state merely to fill space.

## Rhythm

The spacing scale is intentionally small:

| Token | Columns/rows | Use |
| --- | ---: | --- |
| `none` | 0 | tightly related content |
| `xs` | 1 | list markers and compact gaps |
| `sm` | 2 | ordinary inset and column gap |
| `md` | 3 | section separation |
| `lg` | 4 | major surfaces |
| `xl` | 6 | sparse/empty states |

## Responsive behavior

- **Compact:** one pane, drill-down navigation, abbreviated metrics.
- **Regular:** list plus detail where useful, normal metrics.
- **Wide:** persistent navigation/list/inspector columns and expanded operational context.

Breakpoints are based on the width offered to the component, not the physical terminal width.

## Foundation modules

- `geometry.ts`: dimensions, insets, clamping, and allocation.
- `text.ts`: ANSI-safe fitting, wrapping, clipping, and validation.
- `layout.ts`: vertical stacking, insets, and horizontal composition.
- `responsive.ts`: width classes and responsive value selection.
- `cache.ts`: small width/key-aware render cache.
- `symbols.ts`: Unicode/ASCII symbol sets.

These modules contain no workflow concepts and are the base for later visual and interactive primitives.
