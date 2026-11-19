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

### Across languages

No language server sees both sides of a binding (Python and C++/CUDA, Python and Slang, TypeScript and Rust). The binding declarations name both sides, so gaffy links them ([src/core/bindings.ts](src/core/bindings.ts), [src/host/bridges.ts](src/host/bridges.ts); setting `gaffy.bridges`). Calls across languages draw dash-dot in vector mode; their tooltip names the binding (`via pybind11: ext.cpp:16`).

| Layer | Declarations read | Python call that links |
|---|---|---|
| pybind11, nanobind | `PYBIND11_MODULE(mod, m)` / `NB_MODULE(mod, m)`: `m.def("fn", &cpp_fn)`, `py::overload_cast<…>(&fn)`, `m.def_submodule("sub")`, `py::class_<T>(m, "T").def("meth", &T::meth)`, `def_static` | `mod.fn(…)`, `fn(…)` after `from mod import fn`, `mod.T.meth(…)`, through the file's imports |
| torch extensions | `PYBIND11_MODULE(TORCH_EXTENSION_NAME, m)`, its module named by `load(name=…, sources=[…])` or `CUDAExtension("pkg._C", […])` in setup.py | `_C.fn(…)` after `from . import _C` |
| torch operators | `TORCH_LIBRARY(ns, m)`, `TORCH_LIBRARY_IMPL(ns, CUDA, m)`: `m.impl("op", &op_cuda)` | `torch.ops.ns.op(…)` |
| slangpy, slangtorch | `spy.Module.load_from_file(device, "x.slang")`, `device.load_module("x")`, `slangtorch.loadModule("x.slang")` in the Python file | `….fn(…)` where x.slang defines `fn`; a function calling `getattr(h, …)` on a name that held the module (`module`, `self.module`) reaches each function of x.slang the file names in a string literal (marked "by name, getattr") |
| wasm-bindgen (Rust ↔ TypeScript, JavaScript) | `#[wasm_bindgen]` on `pub fn` (functions, `js_name`), on `impl T`: `#[wasm_bindgen(constructor)]`, methods, statics, `js_class`; `getter`/`setter` methods are property reads, not calls; the crate is the nearest `Cargo.toml` `[package]` | `f(…)` after `import { f } from '…/pkg'` (the crate's wasm-pack folder, `pkg/<crate>.js`, or the package name, which is the crate name), `ns.f(…)` after `import * as ns`, `new T(…)`, `T.s(…)`, dynamic `import(…)`, `require(…)`; the generated glue `pkg/*.js` counts as external code, so each call shows once, from the caller to the Rust function |

The C++/CUDA end is the definition go to definition finds at the binding's target (C/C++ extension or clangd), else a workspace symbol of that name; CUDA host functions in `.cu` files link the same way, and kernel launches `k<<<grid, block>>>(…)` count as calls in text calls. Not linked: calls on instances (`obj.meth(…)`: the type is unknown in the text), lambdas in bindings, constructors (`py::init`), registrations built in loops. Both sides must be in the workspace: for a package installed from a source repository, open the repository as a second workspace folder and install it editable (`pip install -e`), so Pylance resolves its Python code into that folder rather than `site-packages`.

## Create a view

Right click on a function name in the editor; the gaffy entries sit in the section of Find All References and Show Call Hierarchy (menu group `0_navigation`, after Show Type Hierarchy):

| entry | seeds | first side opened |
|---|---|---|
| gaffy: Call Hierarchy (up) | the function | its callers |
| gaffy: Call Hierarchy (dn) | the function | its calls |
| gaffy: Add to Call Graph | appended to the open view | as the view's direction |

`style.json` `view.traverse: "both"` starts every new view with callers and calls. With `gaffy.openCallHierarchy` (default on) VS Code's own Call Hierarchy opens in the References view as well. Explorer, right click on a file, **gaffy** > New View: Functions of File. The view file goes to `.gaffy/views/<symbol>_<short commit hash>.gaffy` (`<symbol>_<YYYYMMDD-HHMM>` outside git).

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
- Click an arrowhead (the arrowhead cell and the blank before the name; hovering highlights the calls it ends): closes the level it points into. Callers that the function's callers side shows: that side closes, the function keeps its place. A function that its caller's calls side shows: the caller's calls side closes, the caller keeps its place. A click on a line only selects (Shift adds); double click on a line isolates.
- Double click a function: close both sides, or open every side that has more.
- **Delete** (or Backspace) removes the selection: selected calls are cut (the branch below goes unless another call shows it), selected functions are hidden; click a box header to select its functions. The caller of a removed call, or the function that showed a removed function, keeps a `└─>>` or `>> ` marker; clicking it shows that side again, removed ones included. **Show all (n)** and Esc (with nothing selected) bring back everything removed.
- Layout: the tree layout (caller above callee, `A └─> B`, ordered by namespace box, left to right, top to bottom, callers to calls) runs again after every change. The name of the function last opened, closed, or removed keeps its position on screen (a `>> ` that appears or goes does not move it); dragging releases it. Closed sides stay recorded, so reopening restores the layers below.
- Drop repulsion: a dropped function or box whose labels would sit closer to another label on their row than `name() ─> next()` needs, or whose label, arrowhead or blank before the name would sit on a box border, or that leaves a call without a route, moves on one cell at a time in the drag direction (then sideways, then back) to the nearest clean spot, at most 12 cells. A call without any route is drawn dashed, with its arrowhead.
- Options > Arrange: **Reset layout** drops moves, locks, sibling order, and straightened calls; **Reset view** returns to the seeds and their first layer. Right click an arrow > **Straighten This Call** routes it before all others.
- Options > Layout: **Full** shows every function within the call depths of the toolbar, `all` `+` `−` *n* `call depth` *m* `−` `+` `all`: *n* caller levels on the left, *m* callee levels on the right, `all` every level the data holds. Options > Call depth by: **shortest call path** (a function's level is the fewest calls from a seed) or **longest call path** (the most calls, back edges of loops not counted). Full views keep the direction rule, the layout and the markers; markers and arrowheads do not open or close there. Switching layouts keeps the picture: Full takes the deepest caller and callee levels on screen as its depths; One layer at a time opens the sides that lead one level further within the depths. Closed sides and removed calls belong to one layer at a time only.

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

- Each caller sits above its callees; `└─>` points to the callee.
- Namespace boxes (optional, key `b`): packages and folders; a package holding one module merges with it (`render.harmonics`); labels are relative to their box. Callee boxes sit right of their caller boxes; the top-level functions of a box take the rows of their callers outside the box, so those calls draw level. A moved box or function leaves everything else where it was: later boxes take their columns and rows from where the moved item would sit unmoved.
- `>> name()`: callers off screen; `└─>>`, the first row under a function: calls off screen (closed, beyond the call depth, hidden, or removed).
- `├─>`, `└─>`: tree edge from the caller's stem. `──┐ ──┤ <──┘`: lane inside a box. `──> f()`: routed call arriving from the left, crossing box borders. Calls into one function share one line (a merge); calls from one function can leave on one line (a fork); a call joins a merge only where that line carries no other call; unrelated calls never share a line.
- Vector mode: where two calls cross, the horizontal one hops over the vertical one; where calls merge or fork, the branch curves in the direction of the call.
- `↻`: direct recursion; `↻ f()`: call back to `f` higher in the same chain.
- `[render.harmonics] (6)`: collapsed container with its member count.

Algorithms: [src/core/layout.ts](src/core/layout.ts) (rows and lanes in a block), [src/core/boxes.ts](src/core/boxes.ts), [src/core/place.ts](src/core/place.ts) (2D placement, moves, locks), [src/core/grid.ts](src/core/grid.ts) (routing); plan: [plan.md](plan.md).

## Interaction

| input | action |
|---|---|
| click a function | select it and open it beside the graph (`gaffy.openBeside`) |
| Shift+click a function | add to or remove from the selection |
| Shift+drag on the background | selection window: adds every function whose label it touches |
| `>> name()` / `└─>>` (one layer at a time) | open its callers / its calls, removed ones included |
| click an arrowhead (one layer at a time) | close the level it points into |
| double click a function (one layer at a time) | close both sides, or open every side that has more |
| double click a collapsed container; a box header | expand it; collapse the box |
| drag a function | move it with its tree children; calls re-route; the namespace box grows to enclose it; dragging one of several selected functions moves them all; the rest of the picture stays still |
| drag a box header | move the box with its content |
| hover an arrow | highlight every call through the cell under the pointer, each end to end |
| click an arrow | select every call through that cell: on a fork or merge, all of them; Shift+click adds or removes |
| double click an arrow | isolate: keep each selected call's caller and what lies below its callee, hide the rest |
| Enter | isolate the selected calls (or the selected functions); with a single focused function: open it |
| Esc | clear the selection; with nothing selected: show all again |
| right click a function | go to definition, editor context menu, peek references, VS Code call hierarchy; open or close callers and calls (one layer at a time); make or remove a seed (it keeps its place; the language server is asked for the side it lacks); select upstream, downstream, through, paths between two; hide; show hidden neighbors; collapse class, module, package; group its module; lock or unlock; move among siblings; tag; reveal; copy path or name |
| right click a box header | collapse, ungroup (dissolve the box), group the modules inside, lock or unlock, reveal, copy path |
| right click an arrow | isolate this call, isolate the path through it, go to call site, go to callee |
| ↑ ↓, Alt+↑ ↓ | move focus; move the focused function among its siblings |
| e, c or ←, → | open the focused function's sides that have more (one layer at a time); collapse innermost container; expand collapsed |
| Delete or Backspace, h, i, k | remove selection (calls cut, functions hidden; full: hide functions); hide selection; show only selection; lock or unlock the focused function |
| u, g, b, r, 0, x | unhide all; glyph or vector edges; group namespaces; refresh from language server; fit; export |

Toolbar: **Isolate** (when nothing is hidden: isolates the selection) or **Show all (n)** (when something is hidden), the call depths (full), fit, and **☰ Options**, a pulldown with checkmarks:

- Layout: one layer at a time, full; Call depth by (full): shortest or longest call path
- Namespaces: ✓ Group namespaces, reset per-box grouping
- Edges: glyphs (UTF box drawing) or vector; curve for vector: orthogonal, rounded, sigmoid, spline
- Tree parent: first caller found (dfs), nearest caller above, joint (shared functions: a caller right above joins the elbow `├───┴─>`; several callers in a box join one collector that enters from the left, `┌──┘` then `└─>`; calls between boxes arrive from the left whenever the cells are free)
- Arrange (key `a`, right click > Re-arrange Selection: the selected functions back to their computed place, moves and locks dropped): reset view (one layer at a time: the seeds and their first layer; full: the starting call depths), reset layout (moves, locks, sibling order, straightened calls), re-arrange (the selected functions, else every unlocked item), unlock all, expand collapsed, clear straightened calls
- Folders: per top-level folder, included or excluded. Filters apply when drawing: calls into an excluded folder are still fetched and kept, so including it again shows them at once, without the language server.
- File: Refresh from Language Server, export ASCII, edit style.json

The toolbar and the pulldown are plain HTML elements in the webview, built with d3-selection and styled with VS Code's theme variables (`--vscode-menu-*`); the graph itself is SVG drawn with D3.

Locks: a locked function or box keeps its absolute position; re-arrange and layouts place every unlocked item around it.

"Editor Context Menu…" opens the definition in an editor and shows VS Code's own editor context menu at its cursor, with every installed extension's entries. VS Code exposes no command that opens the explorer context menu for a given file; "Reveal in Explorer" selects the file there, where Shift+F10 opens it.

## Building, progress, cache

- While a view builds, a banner over the graph shows the phase, depth, definitions, language-server requests and cached answers; after 400 ms a notification with a cancel button shows the same.
- Every answer of the language server (callers or callees of one definition) is cached in `.gaffy/cache/calls.json`. Changing depth or direction, expanding, and opening a view use cached answers and ask the language server only for the rest.
- A saved, renamed, or externally changed source file drops the cached outgoing calls of its definitions and all cached incoming calls. Files whose extension no cached definition has (logs, bytecode, build output) drop nothing. `gaffy: Clear Call Cache` drops everything.
- No answer differs from an empty answer. A definition the language server does not resolve (still analyzing after a window reload, renamed, removed) keeps the calls the view holds; its answer is neither cached nor recorded as explored. The view retries after 2, 4, 8, 15, 30 and 60 s and shows `language server not ready` in the status line meanwhile; after the last retry a warning names the count.
- A language-server request without an answer after 30 s counts as no answer and is retried, so one stalled request does not hold the view's queue.
- Opening a stable view: every explored (definition, direction) pair takes its cached answer without the language server. Pairs without a cached answer are stale: on-screen ones are asked again in the background; the others keep their calls, lose the explored mark, and are asked when a side opens onto them. Nothing changed since the last save: no language-server request.
- **Refresh from Language Server** (Options > File, `r`, `gaffy: Refresh from Language Server`): asks every on-screen (definition, direction) pair from the language server and drops the cached answers of the others (asked when a side opens or a call depth reaches them).

## Change tracking

- Saving a source file updates open views that contain a definition from that file (`gaffy.refreshOnSave`: `touched`, `all`, `off`); stable views ask only the pairs the save made stale, as on opening.
- Renaming a file rewrites keys, paths and URIs in open views, then updates them the same way.
- Definitions keep their identity across line moves: keys are `<lang>:<path>#<qualified name>`.
- Views keep every definition the language server named; a closed side, a lower call depth, or a hide takes it off screen.

## Files

```
.gaffy/
  views/<symbol>_<commit>.gaffy  view: seeds, direction, depth, open sides, call depths, cut calls, collapsed, hidden, grouping,
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
  "view":   { "arrange": "grow", "traverse": "command" },
  "font":   { "family": "'JetBrains Mono', monospace", "size": 13, "lineHeight": 1.25 },
  "grid":   { "indent": 4, "laneGap": 2, "parentRule": "dfs" },
  "edges":  { "mode": "vector", "curve": "rounded", "lead": 3, "tension": 0.5, "arrow": true, "width": 1, "glyphs": "unicode", "cross": "│" },
  "labels": { "strip": [], "parens": true },
  "boxes":  { "enabled": true, "modules": false, "root": true, "fill": "hue", "alpha": 0.08, "line": "dashed" },
  "route":  { "bend": 3, "cross": 6, "border": 4, "adjacent": 2, "channel": 4 },
  "colors": { "selection": "#ff9e3b", "highlight": "#3794ff" }
}
```

- Defaults of the Options menu. Read when a view is created, then stored in the view file: `view.arrange` (Layout: `grow` one layer at a time, `auto` full), `view.traverse` (`command`: the editor command decides the side; `both`: callers and calls). Read on every render, for views without their own choice in Options: `edges.mode` (Edges: `vector`, `glyph`), `edges.curve` (Curve), `grid.parentRule` (Tree parent: `dfs`, `nearest`, `joint`), `boxes.enabled` (Group namespaces). The `gaffy.depth` setting sets the prefetch depth (one layer at a time) and the hop limit (automatic).
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
| `seed` | link foreground | seed functions |
| `twisty` | link foreground | `>>` and `└─>>` markers |
| `frame` | widget border | namespace box lines |
| `namespace` | description foreground | namespace box headers |
| `external` | disabled foreground | definitions outside the workspace |

A new UI element gets a color by a CSS rule in `media/webview.css` that reads `var(--g-<key>)`, and the key with its default in `DEFAULT_STYLE.colors` (and in the `:root` block of the CSS file, used before the style arrives).

## Settings

| setting | default | effect |
|---|---|---|
| `gaffy.depth` | 3 | one layer at a time: levels prefetched in the background; full: the starting call depths |
| `gaffy.maxNodes` | 400 | definitions fetched per build |
| `gaffy.openCallHierarchy` | true | also open VS Code's Call Hierarchy when creating a view |
| `gaffy.exclude` | none | globs of folders and files views leave off screen (for example `"**/tests/**"`); Options > Folders includes them again per view |
| `gaffy.includeExternal` | false | include site-packages, node_modules, stubs |
| `gaffy.autoSave` | true | save the view file after each graph change |
| `gaffy.refreshOnSave` | touched | update policy after a source save |
| `gaffy.openBeside` | true | open definitions beside the graph |

## Tests and preview

```bash
npm test                  # core: quotient, layout, boxes, placement, routing invariants, golden ASCII in test/golden/
UPDATE_GOLDEN=1 npm test  # rewrite goldens after an intended layout change
npm run preview           # dist/preview.html?doc=sh|exp4|star|grow|two[&edges=vector&curve=sigmoid&fill=hue&boxes=off&parentRule=joint]
```

The preview loads the webview bundle in a browser with a mocked VS Code API and fixture views: `sh` (..rrequest.md addendum 1a), `exp4` (giddy experiment 4), `star` (..rrequest.md example (*)).

[^lsp]: LSP, Language Server Protocol: JSON-RPC protocol between editors and language servers; call hierarchy requests `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls` since version 3.16.
