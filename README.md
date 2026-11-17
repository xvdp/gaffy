# gaffy

VS Code extension: persistent, manipulable call graphs laid out on a character grid and rendered with D3. Each view is a `.gaffy` file under `<workspace>/.gaffy/views/` and opens as a tab. Call data comes from the language server's call hierarchy (LSP[^lsp]), so every language with a call-hierarchy server works: TypeScript and JavaScript (built into VS Code), Python (Pylance), C/C++, Rust, Go.

## Install

```bash
npm install
npm run package                              # typecheck, tests, bundles, gaffy-<version>.vsix
code --install-extension gaffy-0.3.0.vsix
```

Development: open `gaffy/` in VS Code and press F5 (Extension Development Host). `npm run watch` rebuilds on change.

## Test installed .vsix extension
`Ctrl+Shift+P > **Developer: Reload Window**`

## Create a view

Right click on a function name in the editor, then the **gaffy** submenu:

| entry | seeds | traversal |
|---|---|---|
| New View: Callers of Symbol | the function | incoming calls, `gaffy.depth` hops |
| New View: Callees of Symbol | the function | outgoing calls |
| New View: Callers and Callees of Symbol | the function | both |
| Add Symbol to Active View | appended to the open view | view direction |

Explorer, right click on a file, **gaffy** > New View: Functions of File: seeds are the file's functions and methods, outgoing calls, one hop. The view file goes to `.gaffy/views/<name>.<callers|callees|calls>.gaffy` and opens.

## Layout

```
┌─ gutai ─────────────────────────────────────────────────────────────────┐
│  ┌─ render.harmonics ────────────┐         ┌─ runtime ────────────────┐ │
│  │  sh_eval() ───────────────────┼──┬─────┬┼> interop.to_drjit() ↻    │ │
│  │  ├─> resolve_backend() ──┐    │  │     ││  ├─> interop._shape()    │ │
│  │  ├─> _in_type() <────────┘    │  │     ││                          │ │
│  │  ├─> _from_tensor() ──────────┼──┘     ││                          │ │
│  │  ├─> _from_columns() ────┐    │        ││                          │ │
│  │  │   └─> _stacked() ─────│────┼────────┴┼> interop.to_torch()      │ │
```

- Order `callers on top` (default): each caller sits above its callees, `└─>` points to the callee. Order `callees on top`: each callee sits above its callers with `└──`, as in the VS Code call hierarchy view. Calls always go from caller to callee; the order only changes which end sits on top.
- Namespace boxes (optional, key `b`): packages and folders; a package holding one module merges with it (`render.harmonics`); labels are relative to their box. Callee boxes sit right of their caller boxes; the top-level functions of a box take the rows of their callers outside the box, so those calls draw level.
- `├─>`, `└─>`: tree edge from the caller's stem. `──┐ ──┤ <──┘`: lane inside a box. `──> f()`: routed call arriving from the left, crossing box borders. Calls into one function share one line (a merge); calls from one function can leave on one line (a fork); unrelated calls never share a line.
- Vector mode: where two calls cross, the horizontal one hops over the vertical one; where calls merge or fork, the branch curves in the direction of the call.
- `↻`: direct recursion; `↻ f()`: call back to `f` higher in the same chain.
- `[render.harmonics] (6)`: collapsed container with its member count. ` ▸3`: three functions folded below (reached only through this one). ` +2`: two hidden callers or callees.

Algorithms: [src/core/layout.ts](src/core/layout.ts) (rows and lanes in a block), [src/core/boxes.ts](src/core/boxes.ts), [src/core/place.ts](src/core/place.ts) (2D placement, moves, locks), [src/core/grid.ts](src/core/grid.ts) (routing); plan: [plan.md](plan.md).

## Interaction

| input | action |
|---|---|
| click a function | select it and open it beside the graph (`gaffy.openBeside`) |
| Shift+click | add to or remove from the selection |
| double click a function | fold what lies below it (` ▸n` marks the folded count); again to unfold; a function with nothing below expands through the language server; Shift: expand both directions |
| double click a collapsed container; a box header | expand it; collapse the box |
| drag a function | move it with its tree children; calls re-route; the namespace box grows to enclose it; a callee moved above its caller gets `┌─>` from over the caller |
| drag a box header | move the box with its content |
| `+n` badge | pick hidden neighbors to unhide |
| hover an arrow; click; double click | highlight that call end to end, through the lines it shares with other calls; select it; show only its caller and what lies below it |
| right click an arrow | show only what lies below this call; show only the path through this call; go to call site; go to callee |
| hover | highlight its calls, callers and callees |
| right click a function | go to definition, editor context menu, peek references, VS Code call hierarchy; fold or unfold; expand callers or callees; make or remove seed; select all callers, all callees, through, paths between two; hide selection, show only selection; hide, show hidden neighbors; collapse class, module, package; lock or unlock position; move among siblings; tag; reveal in explorer; copy path or qualified name |
| right click a box header | collapse, lock or unlock, reveal, copy path |
| ↑ ↓, Alt+↑ ↓ | move focus; move the focused function among its siblings |
| Enter, e, f, c or ←, → | open; expand through the language server; fold or unfold; collapse innermost container; expand collapsed |
| h or Delete, i, Esc | hide selection; show only selection; clear selection |
| k | lock or unlock the focused function |
| u, o, g, b | unhide all; toggle order; glyph or vector edges; namespace boxes |
| r, 0, x | rebuild; fit; export |

Toolbar: traverse (callers, callees, both), depth, order, namespace boxes, edges (glyph, vector, and in vector mode the curve: orthogonal, rounded, sigmoid, spline), tree parent rule, fit, reset layout (drop every move, lock and sibling order), re-arrange (drop the moves of unlocked items), unlock all, show all (unhide, unfold, expand collapsed), folders (per top-level folder: included or excluded), export, style.

Locks: a locked function or box keeps its absolute position; re-arrange and rebuilds place every unlocked item around it.

"Editor Context Menu…" opens the definition in an editor and shows VS Code's own editor context menu at its cursor, with every installed extension's entries. VS Code exposes no command that opens the explorer context menu for a given file; "Reveal in Explorer" selects the file there, where Shift+F10 opens it.

## Building, progress, cache

- While a view builds, a banner over the graph shows the phase, depth, definitions, language-server requests and cached answers; after 400 ms a notification with a cancel button shows the same.
- Every answer of the language server (callers or callees of one definition) is cached in `.gaffy/cache/calls.json`. Changing depth or direction, expanding, and opening a view use cached answers and ask the language server only for the rest.
- **⟳ rebuild** first redraws from the cache and the calls already in the view (instant), then asks the language server for every definition and redraws again.
- A saved, renamed, or externally changed file drops the cached outgoing calls of its definitions and all cached incoming calls. `gaffy: Clear Call Cache` drops everything.

## Change tracking

- Saving a source file rebuilds open views that contain a definition from that file (`gaffy.refreshOnSave`: `touched`, `all`, `off`).
- Renaming a file rewrites keys, paths and URIs in open views, then rebuilds them.
- Definitions keep their identity across line moves: keys are `<lang>:<path>#<qualified name>`.
- A rebuild replaces the graph: definitions outside the new reach set (lower depth, other direction, deleted code) disappear.

## Files

```
.gaffy/
  views/<name>.gaffy     view: seeds, direction, depth, order, collapsed, hidden, sibling order, moves (offset),
                         locks, folder include and exclude, tags, last built graph (JSON)
  export/<name>.md       ASCII export, <pre> with links to path#Lline
  export/<name>.txt      ASCII export, plain
  style.json             style overrides (gaffy: Edit Style writes the defaults)
```

## Style

`.gaffy/style.json` overrides the `gaffy.style` setting, which overrides the defaults in [src/core/style.ts](src/core/style.ts). Schema: [schemas/style.schema.json](schemas/style.schema.json).

```json
{
  "font":   { "family": "'JetBrains Mono', monospace", "size": 13, "lineHeight": 1.25 },
  "grid":   { "indent": 4, "laneGap": 2, "parentRule": "dfs" },
  "edges":  { "mode": "glyph", "glyphs": "unicode", "arrow": true, "cross": "│", "width": 1, "curve": "orthogonal" },
  "labels": { "strip": [], "parens": true },
  "boxes":  { "enabled": true, "modules": false, "root": true, "fill": "hue", "alpha": 0.08, "line": "dashed" },
  "route":  { "bend": 3, "cross": 6, "border": 4, "channel": 4 },
  "colors": { "edge": "#6e7681", "seed": "#4daafc" }
}
```

## Settings

| setting | default | effect |
|---|---|---|
| `gaffy.depth` | 4 | hop limit for new views |
| `gaffy.maxNodes` | 400 | definitions fetched per build |
| `gaffy.exclude` | tests (`**/tests/**`, `**/test_*.py`, …) | globs left out of builds; the folders toolbar includes them per view |
| `gaffy.includeExternal` | false | include site-packages, node_modules, stubs |
| `gaffy.autoSave` | true | save the view file after each graph change |
| `gaffy.refreshOnSave` | touched | rebuild policy after a source save |
| `gaffy.openBeside` | true | open definitions beside the graph |

## Tests and preview

```bash
npm test                  # core: quotient, layout, boxes, placement, routing invariants, golden ASCII in test/golden/
UPDATE_GOLDEN=1 npm test  # rewrite goldens after an intended layout change
npm run preview           # dist/preview.html?doc=sh|exp4|star[&edges=vector&curve=sigmoid&fill=hue&order=callees&boxes=off]
```

The preview loads the webview bundle in a browser with a mocked VS Code API and fixture views: `sh` (..rrequest.md addendum 1a), `exp4` (giddy experiment 4), `star` (..rrequest.md example (*)).

[^lsp]: LSP, Language Server Protocol: JSON-RPC protocol between editors and language servers; call hierarchy requests `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls` since version 3.16.
