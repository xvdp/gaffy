# gaffy

VS Code extension: persistent, manipulable call graphs laid out on a character grid and rendered with D3. Each view is a `.gaffy` file under `<workspace>/.gaffy/views/` and opens as a tab. Call data comes from the language server's call hierarchy (LSP[^lsp]); shader languages whose servers have none get calls found in the text. See [Languages](#languages).

## Install

```bash
npm install
npm run package                              # typecheck, tests, bundles, gaffy-<version>.vsix
code --install-extension gaffy-0.5.0.vsix
```

Development: open `gaffy/` in VS Code and press F5 (Extension Development Host). `npm run watch` rebuilds on change.

## Test installed .vsix extension
`Ctrl+Shift+P > **Developer: Reload Window**`

## Languages

| Language | Server (VS Code extension) | Call hierarchy | gaffy |
|---|---|---|---|
| Python | Pylance | yes | language server |
| TypeScript, JavaScript | built in | yes (TypeScript 5.9 LanguageService, measured) | language server; a constructor's item carries its class name; object-literal methods are qualified by their variable (`obj.run`) |
| Rust | rust-analyzer | yes (not measured here) | language server; `impl Foo` → `Foo`, `impl Display for Foo` → `Foo[Display]`, so `fmt` of two trait impls stay apart |
| C, C++, CUDA, Objective-C | Microsoft C/C++ (registers a provider) or clangd | yes | language server; `ns::Foo::bar` → `ns` › `Foo` › `bar`; template arguments dropped; operators kept whole |
| Go, Java, C#, Kotlin, Swift, Dart | gopls, and the others' servers | per server (not measured here) | language server; Go `(*T).M` → `T` › `M` |
| GLSL | WebGL GLSL Editor (registers a provider) | yes | language server; without that extension: text |
| Slang | Slang (slangd 1.8): no call hierarchy, no references; definitions and document symbols (measured) | no | text: call sites resolved by go to definition; callers by a scan of the workspace's Slang files |
| HLSL, WGSL, Metal | depends on the extension | usually no | text: document symbols, else a C-like text outline; go to definition when offered, else by name |

Text calls ([src/core/textcalls.ts](src/core/textcalls.ts)): comments, strings and preprocessor lines are masked; functions and containers (`struct`, `class`, `namespace`, `interface`, `extension`, `cbuffer`) come from the server's document symbols, else from brace matching; a call site is a name followed by `(` (with optional `<…>`), minus control keywords. Calls through function pointers or macros are missed; a constructor call of a project type counts when a function of that name exists. Name rules per language: [src/core/langs.ts](src/core/langs.ts). External code (installed packages, `target/`, `_deps/`, `/usr/include`) stays out unless `gaffy.includeExternal` is on.

## Create a view

Right click on a function name in the editor; the gaffy entries sit below Go to Definition, references and Call Hierarchy:

| entry | seeds | traversal |
|---|---|---|
| gaffy: Upstream callers | the function | incoming calls, `gaffy.depth` hops |
| gaffy: Calls downstream | the function | outgoing calls |
| gaffy: Add to view | appended to the open view | view direction |

`gaffy: Upstream callers and calls downstream` is in the command palette. With `gaffy.openCallHierarchy` (default on) VS Code's own Call Hierarchy opens in the References view as well. Explorer, right click on a file, **gaffy** > New View: Functions of File. The view file goes to `.gaffy/views/<symbol>_<short commit hash>.gaffy` (`<symbol>_<YYYYMMDD-HHMM>` outside git).

A new view asks the language server for one layer, shows it, then in the background asks every function on screen for its callers and calls (so the open markers know what lies beyond) and prefetches `gaffy.depth` layers along the traversal direction. Reopening a view shows the stored graph at once and asks the language server only for calls that changed files made stale (see [Building, progress, cache](#building-progress-cache)).

## One layer at a time

```
                 up_sym_3() ─────┐
    up_sym_2() ──┐               │
 >> up_sym_1() ─┴─> my_symbol() <┘
                    ├─> downsym_1()
                    └─> downsym_2()
                        └─>>
```

- `>> name()`: callers not on screen; click shows one layer of them. `└─>>` under a function (first row of its calls): calls not on screen; click shows one layer of them. A side with nothing more shows no marker and no count.
- Direction: a seed opens both sides. A function shown as a call opens only its calls; a function shown as a caller opens only its callers. The other callers of a callee belong to a view seeded at that callee (editor right click > gaffy: Upstream callers).
- Click an arrowhead into a function: closes its callers. Click a line leaving a function: closes its calls. Ctrl, Cmd or Shift+click selects calls instead; double click on an arrow isolates.
- Double click a function: close both sides, or open every side that has more.
- **Delete** (or Backspace) removes the selection: selected calls are cut (the branch below goes unless another call shows it), selected functions are hidden; click a box header to select its functions. The caller of a removed call, or the function that showed a removed function, keeps a `└─>>` or `>> ` marker; clicking it shows that side again, removed ones included. **Show all (n)** and Esc (with nothing selected) bring back everything removed.
- Layout: the tree layout of the automatic arrangement (caller above callee, `A └─> B`, ordered by namespace box, left to right, top to bottom, callers to calls) runs again after every change. The function last opened, closed, or removed keeps its position on screen; dragging releases it. Closed sides stay recorded, so reopening restores the layers below.
- Options > Arrange: **Reset layout** drops moves, locks, sibling order, and straightened calls; **Reset view** returns to the seeds and their first layer. Right click an arrow > **Straighten This Call** routes it before all others.
- Options > Layout: **Automatic** brings back every function to the depth limit, with folds (views made before 0.5.0 open in it).

The editor entries were a `gaffy` submenu; the submenu stays defined in `package.json` (`contributes.submenus`, `contributes.menus["gaffy.editor"]`). To return to it, replace the three `editor/context` entries by `{ "submenu": "gaffy.editor", "group": "z_gaffy@1" }`.

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
- `◂ name()`: its callers are closed (folded, or not yet asked); `name() ▸`: its calls are closed; `◂3`, `▸3`: folded count.
- `├─>`, `└─>`: tree edge from the caller's stem. `──┐ ──┤ <──┘`: lane inside a box. `──> f()`: routed call arriving from the left, crossing box borders. Calls into one function share one line (a merge); calls from one function can leave on one line (a fork); a call joins a merge only where that line carries no other call; unrelated calls never share a line.
- Vector mode: where two calls cross, the horizontal one hops over the vertical one; where calls merge or fork, the branch curves in the direction of the call.
- `↻`: direct recursion; `↻ f()`: call back to `f` higher in the same chain.
- `[render.harmonics] (6)`: collapsed container with its member count. ` ▸3`: three functions folded below (reached only through this one). ` +2`: two hidden callers or callees.

Algorithms: [src/core/layout.ts](src/core/layout.ts) (rows and lanes in a block), [src/core/boxes.ts](src/core/boxes.ts), [src/core/place.ts](src/core/place.ts) (2D placement, moves, locks), [src/core/grid.ts](src/core/grid.ts) (routing); plan: [plan.md](plan.md).

## Interaction

| input | action |
|---|---|
| click a function | select it and open it beside the graph (`gaffy.openBeside`) |
| Shift+click a function | add to or remove from the selection |
| `◂ name()` / `name() ▸` | closed side: click opens its callers / its calls (unfold, or ask the language server) |
| hover a function: `▴` / `▾` | close its callers / its calls (fold: hide what only it reaches on that side; `◂3`, `▸3` show the count) |
| double click a function | open or close it on the traversal side |
| double click a collapsed container; a box header | expand it; collapse the box |
| drag a function | move it with its tree children; calls re-route; the namespace box grows to enclose it |
| drag a box header | move the box with its content |
| `+n` badge | pick hidden neighbors to unhide |
| hover an arrow | highlight every call through the cell under the pointer, each end to end |
| click an arrow | select every call through that cell: on a fork or merge, all of them; Shift+click adds or removes |
| double click an arrow | isolate: keep each selected call's caller and what lies below its callee, hide the rest |
| Enter | isolate the selected calls (or the selected functions); with a single focused function: open it |
| Esc | show all again; with nothing hidden: clear the selection |
| right click a function | go to definition, editor context menu, peek references, VS Code call hierarchy; fold; expand callers or callees; seeds; select upstream, downstream, through, paths between two; hide; show hidden neighbors; collapse class, module, package; group its module; lock or unlock; move among siblings; tag; reveal; copy path or name |
| right click a box header | collapse, ungroup (dissolve the box), group the modules inside, lock or unlock, reveal, copy path |
| right click an arrow | isolate this call, isolate the path through it, go to call site, go to callee |
| ↑ ↓, Alt+↑ ↓ | move focus; move the focused function among its siblings |
| e, f, c or ←, → | expand through the language server; fold or unfold; collapse innermost container; expand collapsed |
| Delete or Backspace, h, i, k | remove selection (calls cut, functions hidden; automatic arrangement: hide); hide selection; show only selection; lock or unlock the focused function |
| u, o, g, b, r, 0, x | unhide all; toggle order; glyph or vector edges; group namespaces; refresh from language server; fit; export |

Toolbar: **Isolate** (when nothing is hidden: isolates the selection) or **Show all (n)** (when something is hidden), depth − n +, fit, and **☰ Options**, a pulldown with checkmarks:

- Traverse: ✓ Upstream callers, ✓ Calls downstream (both checked = both directions; unchecking a side removes its expansions and folds)
- Order: callers on top, callees on top (VS Code call hierarchy)
- Namespaces: ✓ Group namespaces, reset per-box grouping
- Edges: glyphs (UTF box drawing) or vector; curve for vector: orthogonal, rounded, sigmoid, spline
- Tree parent: first caller found (dfs), nearest caller above, joint (shared functions: a caller right above joins the elbow `├───┴─>`; several callers in a box join one collector that enters from the left, `┌──┘` then `└─>`; calls between boxes arrive from the left whenever the cells are free)
- Arrange: reset view (back to seeds, direction and depth), reset layout (moves, locks, sibling order), re-arrange (the selected functions, else every unlocked item), unlock all, expand collapsed, open folds
- Folders: per top-level folder, included or excluded
- File: Refresh from Language Server, export ASCII, edit style.json

The toolbar and the pulldown are plain HTML elements in the webview, built with d3-selection and styled with VS Code's theme variables (`--vscode-menu-*`); the graph itself is SVG drawn with D3.

Locks: a locked function or box keeps its absolute position; re-arrange and automatic layouts place every unlocked item around it.

"Editor Context Menu…" opens the definition in an editor and shows VS Code's own editor context menu at its cursor, with every installed extension's entries. VS Code exposes no command that opens the explorer context menu for a given file; "Reveal in Explorer" selects the file there, where Shift+F10 opens it.

## Building, progress, cache

- While a view builds, a banner over the graph shows the phase, depth, definitions, language-server requests and cached answers; after 400 ms a notification with a cancel button shows the same.
- Every answer of the language server (callers or callees of one definition) is cached in `.gaffy/cache/calls.json`. Changing depth or direction, expanding, and opening a view use cached answers and ask the language server only for the rest.
- A saved, renamed, or externally changed source file drops the cached outgoing calls of its definitions and all cached incoming calls. Files whose extension no cached definition has (logs, bytecode, build output) drop nothing. `gaffy: Clear Call Cache` drops everything.
- No answer differs from an empty answer. A definition the language server does not resolve (still analyzing after a window reload, renamed, removed) keeps the calls the view holds; its answer is neither cached nor recorded as explored. The view retries after 2, 4, 8, 15, 30 and 60 s and shows `language server not ready` in the status line meanwhile; after the last retry a warning names the count.
- Opening a stable view: every explored (definition, direction) pair takes its cached answer without the language server. Pairs without a cached answer are stale: on-screen ones are asked again in the background; the others keep their calls, lose the explored mark, and are asked when a side opens onto them. Nothing changed since the last save: no language-server request.
- **Refresh from Language Server** (Options > File, `r`, `gaffy: Refresh from Language Server`): stable views ask every on-screen pair from the language server and drop the cached answers of the others (asked when a side opens onto them); automatic views redraw from the cache, then ask every definition.

## Change tracking

- Saving a source file updates open views that contain a definition from that file (`gaffy.refreshOnSave`: `touched`, `all`, `off`); stable views ask only the pairs the save made stale, as on opening.
- Renaming a file rewrites keys, paths and URIs in open views, then updates them the same way.
- Definitions keep their identity across line moves: keys are `<lang>:<path>#<qualified name>`.
- Automatic views: a build replaces the graph; definitions outside the new reach set (lower depth, other direction, deleted code) disappear. Stable views keep every definition; a closed side hides it.

## Files

```
.gaffy/
  views/<symbol>_<commit>.gaffy  view: seeds, direction, depth, order, open sides, cut calls, collapsed, hidden, grouping,
                               folder include and exclude, tags, straightened calls, last graph and the
                               directions asked per definition (JSON)
  <symbol>_<commit>.md         ASCII export, <pre> with links to path#Lline; <commit> = short HEAD hash, or
  <symbol>_<commit>.txt        <YYYYMMDD-HHMM> outside git; later exports of the same symbol and commit: _2, _3, …
  cache/calls.json             cached language-server answers
  style.json                   style overrides (gaffy: Edit Style writes the defaults)
```

## Style

`.gaffy/style.json` overrides the `gaffy.style` setting, which overrides the defaults in [src/core/style.ts](src/core/style.ts) (`DEFAULT_STYLE`). Schema: [schemas/style.schema.json](schemas/style.schema.json).

```json
{
  "view":   { "arrange": "grow", "order": "callers", "traverse": "command" },
  "font":   { "family": "'JetBrains Mono', monospace", "size": 13, "lineHeight": 1.25 },
  "grid":   { "indent": 4, "laneGap": 2, "parentRule": "dfs" },
  "edges":  { "mode": "vector", "curve": "rounded", "lead": 3, "tension": 0.5, "arrow": true, "width": 1, "glyphs": "unicode", "cross": "│" },
  "labels": { "strip": [], "parens": true },
  "boxes":  { "enabled": true, "modules": false, "root": true, "fill": "hue", "alpha": 0.08, "line": "dashed" },
  "route":  { "bend": 3, "cross": 6, "border": 4, "adjacent": 2, "channel": 4 },
  "colors": { "selection": "#ff9e3b", "highlight": "#3794ff" }
}
```

- Defaults of the Options menu. Read when a view is created, then stored in the view file: `view.arrange` (Layout: `grow` one layer at a time, `auto` automatic), `view.order` (Order), `view.traverse` (`command`: the editor command decides the side; `both`: callers and calls). Read on every render, for views without their own choice in Options: `edges.mode` (Edges: `vector`, `glyph`), `edges.curve` (Curve), `grid.parentRule` (Tree parent: `dfs`, `nearest`, `joint`), `boxes.enabled` (Group namespaces). The `gaffy.depth` setting sets the prefetch depth (one layer at a time) and the hop limit (automatic).
- `edges.lead`: straight lead-out and lead-in of the sigmoid, in cells; `edges.tension`: how far the S-curve's control points reach (0 sharp, 1 wide).
- `route.adjacent`: cost of a vertical run in the column next to an unrelated vertical line; `route.cross`: cost of a crossing.

### Colors

Each key of `colors` becomes the CSS custom property `--g-<key>` on the webview (`applyColors` in [src/webview/main.ts](src/webview/main.ts)); the rules in [media/webview.css](media/webview.css) read those properties. Values are CSS colors or VS Code theme variables (`var(--vscode-…)`).

| key | default | element |
|---|---|---|
| `fg` | editor foreground | function names |
| `bg` | editor background | canvas, box header background |
| `edge` | line-number foreground | call lines, arrowheads, glyphs |
| `highlight` | focus border | hovered calls and the calls of the hovered function |
| `selection` | active link foreground | selected calls (click on an arrow), outline of selected functions |
| `selected` | selection background | background of selected functions |
| `seed` | link foreground | seed functions, `+n` badges |
| `twisty` | link foreground | `◂` `▸` `▴` `▾` disclosure markers |
| `frame` | widget border | namespace box lines |
| `namespace` | description foreground | namespace box headers |
| `external` | disabled foreground | definitions outside the workspace |

A new UI element gets a color by a CSS rule in `media/webview.css` that reads `var(--g-<key>)`, and the key with its default in `DEFAULT_STYLE.colors` (and in the `:root` block of the CSS file, used before the style arrives).

## Settings

| setting | default | effect |
|---|---|---|
| `gaffy.depth` | 3 | stable views: layers prefetched in the background; automatic views: hop limit |
| `gaffy.maxNodes` | 400 | definitions fetched per build |
| `gaffy.openCallHierarchy` | true | also open VS Code's Call Hierarchy when creating a view |
| `gaffy.exclude` | tests (`**/tests/**`, `**/test_*.py`, …) | globs left out of builds; the Folders section includes them per view |
| `gaffy.includeExternal` | false | include site-packages, node_modules, stubs |
| `gaffy.autoSave` | true | save the view file after each graph change |
| `gaffy.refreshOnSave` | touched | update policy after a source save |
| `gaffy.openBeside` | true | open definitions beside the graph |

## Tests and preview

```bash
npm test                  # core: quotient, layout, boxes, placement, routing invariants, golden ASCII in test/golden/
UPDATE_GOLDEN=1 npm test  # rewrite goldens after an intended layout change
npm run preview           # dist/preview.html?doc=sh|exp4|star[&edges=vector&curve=sigmoid&fill=hue&order=callees&boxes=off]
```

The preview loads the webview bundle in a browser with a mocked VS Code API and fixture views: `sh` (..rrequest.md addendum 1a), `exp4` (giddy experiment 4), `star` (..rrequest.md example (*)).

[^lsp]: LSP, Language Server Protocol: JSON-RPC protocol between editors and language servers; call hierarchy requests `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls` since version 3.16.
