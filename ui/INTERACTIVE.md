# Pi++ interactive primitives

Interactive primitives add keyboard navigation and focus management to the static kit while remaining independent of workflows or any other application domain.

## Components

| Component | Behavior |
| --- | --- |
| `Viewport` | Maintains a vertical offset, clamps scrolling, and keeps rows visible |
| `SelectionModel` | Selection movement with disabled-row skipping |
| `List` | Selectable, scrollable single-row items with status and description |
| `Tree` | Expand/collapse hierarchy with parent/child navigation |
| `Tabs` | Cyclic tab selection with active-content input routing |
| `SearchField` | IME-compatible Pi `Input` wrapper with semantic search chrome |
| `SplitPane` | Focusable responsive columns that collapse to the active pane |
| `Inspector` | Collapsible detail sections with selection and content scrolling |

## Keyboard conventions

- `↑`/`↓` or `j`/`k`: move through lists; inspectors reserve `j`/`k` for content scrolling.
- `home`/`end` or `g`/`G`: first/last item.
- `enter`: activate.
- `space`: expand or collapse.
- `←`/`→`: tree parent/child and inspector collapse/expand.
- `tab`/`shift+tab`: switch tabs or split-pane focus.
- `ctrl+d`/`ctrl+u`: half-page list movement.

Consumers should call `tui.requestRender()` after forwarding input. Domain actions stay in callbacks such as `onSelect`, `onToggle`, and `onFocusChange`.

## Responsive composition

`SplitPane` renders weighted columns when all pane minimums fit. Below that threshold, it renders only the active pane and preserves `tab` navigation. This gives application views one composition that works as a wide inspector and a compact drill-down UI.

## Focus and IME

`SearchField` implements Pi TUI's `Focusable` interface and propagates focus to its embedded `Input`. `SplitPane` likewise propagates focus only to its active focusable child. This keeps hardware cursor and IME candidate positioning correct.
