# gaffy

VS Code extension: persistent, manipulable call graphs on a character grid, drawn with D3. View: a `.gaffy` file in `<workspace>/.gaffy/views/`, opened as a tab. Call data: the language server's call hierarchy (LSP[^lsp]); for shader languages without one, calls found in the text ([Languages](#languages)).

## Install from Source

```bash
npm install
npm run package                              # typecheck, tests, bundles, gaffy-<version>.vsix
npm run install:local                        # code --install-extension gaffy-<version>.vsix
```


![demo](images/demo.gif)


Development: `gaffy/` in VS Code, F5 (Extension Development Host); `npm run watch` rebuilds on change.

## Scripts

| command | effect |
|---|---|
| `npm install` | dependencies, after cloning or a `package.json` change |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | vitest: core, routing invariants, golden text pictures in `test/golden/` |
| `UPDATE_GOLDEN=1 npm test` | goldens rewritten after an intended layout change |
| `npm run build` | esbuild bundles: `dist/extension.js` (host), `dist/webview.js` (webview) |
| `npm run watch` | build on every save |
| `npm run package` | typecheck, test, build, `vsce package` → `gaffy-<version>.vsix` |
| `npm run install:local` | `code --install-extension gaffy-<version>.vsix`, version from `package.json` |
| `npm run preview` | `dist/preview.html`: the webview in a browser with fixture views; `GAFFY_PREVIEW_FILE=<view.gaffy> npm run preview` for any view |
| `npm run heuristics` | `docs/heuristics.md`, `docs/heuristics.gaffy`, `docs/ordering.md` regenerated from the code |
| `npm run docs:check` | `npm run heuristics`, then a failure when `docs/` differs from the commit |
| `node tools/gaffy-trace.mjs <trace.jsonl>` | view change log (setting `gaffy.trace`) as a list |

Release and publishing commands (`npm version`, `vsce publish`, `ovsx publish`): [docs/development.md](docs/development.md).

## Documentation

- [docs/development.md](docs/development.md): tooling, release, publishing, project parts, security measures.
- [docs/heuristics.md](docs/heuristics.md): layout rules with code links, as a pipeline graph; [docs/heuristics.gaffy](docs/heuristics.gaffy): the same graph as a gaffy view.
- [docs/ordering.md](docs/ordering.md): functions that change what a view shows and where (triggers, interpreters, layout), drawing of one call, what a drag moves.

## Test installed .vsix extension
`Ctrl+Shift+P > **Developer: Reload Window**`

## Languages

| Language | Server (VS Code extension) | Call hierarchy | gaffy |
|---|---|---|---|
| Python | Pylance | yes | language server |
| TypeScript, JavaScript | built in | yes (TypeScript 5.9 LanguageService, measured) | language server; constructors named by class; object-literal methods qualified by their variable (`obj.run`) |
| Rust | rust-analyzer (`rust-lang.rust-analyzer`); none under an inactive `#[cfg]` (module behind a disabled Cargo feature): set `"rust-analyzer.cargo.features"` | yes (not measured here) | language server; `impl Foo` → `Foo`, `impl Display for Foo` → `Foo[Display]`: `fmt` of two trait impls stays distinct |
| C, C++, CUDA, Objective-C | Microsoft C/C++ (registers a provider) or clangd | yes | language server; `ns::Foo::bar` → `ns` › `Foo` › `bar`; template arguments dropped; operators kept whole |
| Go, Java, C#, Kotlin, Swift, Dart | gopls, each language's server | per server (not measured here) | language server; Go `(*T).M` → `T` › `M` |
| GLSL | WebGL GLSL Editor (registers a provider) | yes | language server; without it: text |
| Slang | Slang (slangd 1.8): definitions and document symbols, no references (measured) | no | text: call sites by go to definition; callers by a scan of workspace Slang files |
| HLSL, WGSL, Metal | per extension | usually no | text: document symbols, else a C-like outline; go to definition when offered, else by name |

Text calls ([src/core/textcalls.ts](src/core/textcalls.ts)): comments, strings, preprocessor lines masked; functions and containers (`struct`, `class`, `namespace`, `interface`, `extension`, `cbuffer`) from document symbols, else brace matching; call site: name + `(` (optional `<…>`), control keywords excluded; constructor of a project type counted when a function of that name exists; calls through function pointers or macros missed. Name rules per language: [src/core/langs.ts](src/core/langs.ts). External code (installed packages, `target/`, `_deps/`, `/usr/include`): hidden unless `gaffy.includeExternal`.

### Across languages

Binding declarations link calls no language server sees across (Python ↔ C++/CUDA, Python ↔ Slang, TypeScript ↔ Rust): [src/core/bindings.ts](src/core/bindings.ts), [src/host/bridges.ts](src/host/bridges.ts); setting `gaffy.bridges`. Tooltip: the binding (`via pybind11: ext.cpp:16`).

| Layer | Declarations read | Python call that links |
|---|---|---|
| pybind11, nanobind | `PYBIND11_MODULE(mod, m)` / `NB_MODULE(mod, m)`: `m.def("fn", &cpp_fn)`, `py::overload_cast<…>(&fn)`, `m.def_submodule("sub")`, `py::class_<T>(m, "T").def("meth", &T::meth)`, `def_static` | `mod.fn(…)`, `fn(…)` after `from mod import fn`, `mod.T.meth(…)`, through the file's imports |
| torch extensions | `PYBIND11_MODULE(TORCH_EXTENSION_NAME, m)`; module name from `load(name=…, sources=[…])` or `CUDAExtension("pkg._C", […])` in setup.py | `_C.fn(…)` after `from . import _C` |
| torch operators | `TORCH_LIBRARY(ns, m)`, `TORCH_LIBRARY_IMPL(ns, CUDA, m)`: `m.impl("op", &op_cuda)` | `torch.ops.ns.op(…)` |
| slangpy, slangtorch | `spy.Module.load_from_file(device, "x.slang")`, `device.load_module("x")`, `slangtorch.loadModule("x.slang")` in the Python file | `….fn(…)` for `fn` defined in x.slang; a function calling `getattr(h, …)` on a name that held the module (`module`, `self.module`) links to each x.slang function named in a string literal of the file (marked "by name, getattr") |
| wasm-bindgen (Rust ↔ TypeScript, JavaScript) | `#[wasm_bindgen]` on `pub fn` (`js_name`) and on `impl T` (`#[wasm_bindgen(constructor)]`, methods, statics, `js_class`); `getter`/`setter` methods: property reads, not calls; crate: nearest `Cargo.toml` `[package]` | `f(…)` after `import { f } from '…/pkg'` (crate's wasm-pack folder, `pkg/<crate>.js`, or package name = crate name), `ns.f(…)` after `import * as ns`, `new T(…)`, `T.s(…)`, dynamic `import(…)`, `require(…)`; generated glue `pkg/*.js` is external code, so each call shows once, caller → Rust function |

C++/CUDA end: go to definition at the binding's target (C/C++ extension or clangd), else a workspace symbol of that name; CUDA host functions in `.cu` files alike; kernel launches `k<<<grid, block>>>(…)`: text calls. torch.autograd: `X.apply(…)` on a `torch.autograd.Function` subclass → `X.forward` (dispatched at run time; the language server stops at `Function.apply`). Not linked: calls on instances (`obj.meth(…)`, type unknown in the text), lambdas in bindings, constructors (`py::init`), registrations built in loops. A binding match replaces the language server's edge from that call site, which matches by name while the compiled module is unresolved (`_C.rasterize_gaussians(…)` taken for the Python wrapper `rasterize_gaussians`; measured with Pyright).

Search scope for bindings and callers: the file's project (nearest folder with `setup.py`, `pyproject.toml`, `setup.cfg`, `CMakeLists.txt`, `Cargo.toml` or `package.json`), then the workspace.

Requirement: both sides in the workspace. An installed package's `site-packages` holds the Python wrapper and the compiled module, no C++/CUDA source: add the source repository as a second workspace folder (File > Add Folder to Workspace), resolved by Pylance through `pip install -e <repo>` or `"python.analysis.extraPaths": ["<repo>"]` (Pyright resolves extra paths before `site-packages`). Otherwise the call ends at the installed copy: external code, shown only with `gaffy.includeExternal` (VS Code setting, not style.json).

Direction: binding calls are outgoing calls; a function shown as a caller opens only its callers. Path `forward → _C.rasterize_gaussians → RasterizeGaussiansCUDA`: the calls of `forward` (a seed, or a view from gaffy> Call Hierarchy (dn)).

### Implicit calls (classes)

Runtime method calls without a call expression naming the method, absent from language-server answers; added by [src/host/implicit.ts](src/host/implicit.ts), with a tooltip:

- Construction: a class calls `__new__`, `__init__` (nearest base class defining one) and `__post_init__` (Python), or `constructor` (TypeScript, JavaScript): `Foo(…)` → `caller → Foo → Foo.__init__`; callers of `Foo.__init__` start with `Foo`.
- Instance call (Python): `obj(…)` calls `type(obj).__call__`, or `forward` for a torch `nn.Module` (no `__call__` below `Module`). Type of `obj`: the language server's type definition at the call site (`criterion(x, y)`, `self.net(x)`); call sites with an answer skipped.

Not followed (a call trace would see them): backprop, hooks, `with` blocks, iteration, operators, properties, decorators.

## Create a view

Editor right click on a function name, section of Find All References (group `0_navigation`, after Show Type Hierarchy):

| entry | seeds | first side opened |
|---|---|---|
| gaffy> Call Hierarchy (up) | the function | its callers |
| gaffy> Call Hierarchy (dn) | the function | its calls |
| gaffy> Add to Call Graph | appended to the open view | as the view's direction |

`style.json` `view.traverse: "both"`: new views start with callers and calls. Explorer right click on a file > **gaffy** > Call Hierarchies (all, up): each function of the file with one caller level, full layout. `gaffy: Check Language Servers`: workspace languages, extension providing each call hierarchy, missing installs; a notification once per version when a required extension is missing (Install, Show Report, Don't Show Again).

New view: unsaved, bound to `.gaffy/views/<symbol>_<short commit hash>.gaffy` (`<symbol>_<YYYYMMDD-HHMM>` outside git); right click > Save (.gaffy) writes it; Autosave Graphs (`gaffy.saveViews`) saves new views at once. Save as Text (key `x`): `.gaffy/<symbol>_<commit>.md` and `.txt`, named in a notification.

Build: one layer, drawn at once; in the background, callers and calls of each function on screen (for the markers) and `gaffy.depth` layers prefetched along the traversal direction. Reopened view: the stored graph at once ([Building, progress, cache](#building-progress-cache)).

## One layer at a time

```
                 up_sym_3() ─────┐
    up_sym_2() ──┐               │
 >> up_sym_1() ─┴─> my_symbol() <┘
                    ├─> downsym_1()
                    └─> downsym_2()
                        └─>>
```

- Markers: `>> name()` (callers off screen), `└─>>` (calls off screen); a click shows one more layer; no marker on a side with nothing more.
- Direction: a seed opens both sides; a callee only its calls; a caller only its callers. Other callers of a callee: a view seeded at that callee (editor right click > gaffy> Call Hierarchy (up)).
- Arrowhead click (arrowhead cell, blank before the name; hover highlights its calls): closes the level it points into (a function's callers, or the calls of the caller showing it); the owner of the closed side keeps its place.
- **Delete** (or Backspace): selected calls cut (with the branch below unless another call shows it), selected functions hidden; a box header click selects its functions. Hidden or removed neighbors keep a `└─>>` or `>> ` marker, both layouts, either side; where the marker opens no side (full layout, or a side the direction rule keeps closed), a click restores those neighbors and the hidden functions on their path from the seeds. **Show all (n)** and Esc (nothing selected): everything removed back, every collapsed container expanded.
- Layout: tree (caller above callee, `A └─> B`; by namespace box, left to right, top to bottom, callers to calls), rerun after each change. Anchor: the function last opened, closed or removed keeps its screen position. Closed sides stay recorded; reopening restores the layers below.
- Moves: kept while sides open and data arrives; content grown onto a moved unit moves it to the nearest clear spot (12 cells around, else straight up to 80; [src/core/settle.ts](src/core/settle.ts)), saved in the view. Opening the callers of a moved function hands its move to the new tree parent right above it (`prev()`, then `└─> fun()`). Details: [docs/ordering.md](docs/ordering.md), section 5.
- Label end: receives or sends, never both; a function sending from its end receives from the left, one receiving at its end sends from under or over its name, else dashed.
- Drop repulsion: a drop closer to a label than `name() ─> next()` needs, onto a box border, or cutting a route steps along the drag (then sideways, then back) to the nearest clean spot, at most 12 cells. A call with no route: dashed, with its arrowhead.
- Options > Call Expansion > Global Toolbar (**Full**): every function within the toolbar call depths `all` `+` `−` *n* `call depth` *m* `−` `+` `all` (*n* caller levels left, *m* callee levels right, `all`: every level in the data). Call depth by: **shortest call path** (fewest calls from a seed) or **longest call path** (most calls, loop back edges excluded). Switching keeps the picture: Full adopts the deepest levels on screen; one layer at a time opens the sides within those depths. Closed sides and removed calls: one layer at a time only.

Editor submenu `gaffy` (defined, unused: `contributes.submenus`, `contributes.menus["gaffy.editor"]`): replace the three `editor/context` entries by `{ "submenu": "gaffy.editor", "group": "z_gaffy@1" }`.

## Layout

```
┌─ kazoo ─────────────────────────────────────────────────────────────────┐
│  ┌─ moomoo.boogaloos ────────────┐         ┌─ noodles ────────────────┐ │
│  │  scoobie() ───────────────────┼──┬─────┬┼> wibbles.to_magoo() ↻    │ │
│  │  ├─> resolve_patatas() ──┐    │  │     ││  ├─> wibbles._zoink()    │ │
│  │  ├─> _in_shoo() <────────┘    │  │     ││                          │ │
│  │  ├─> _from_jinkie() ──────────┼──┘     ││                          │ │
│  │  ├─> _from_noodles() ────┐    │        ││                          │ │
│  │  │   └─> _stacked() ─────│────┼────────┴┼> wibbles.to_mooch()      │ │
```

- Callers above their callees; `└─>` points to the callee.
- Namespace boxes (optional, key `b`): packages and folders; a package with one module merges with it (`moomoo.boogaloos`); labels relative to their box. Callee boxes right of caller boxes; top-level functions of a box take the rows of their outside callers (level calls). A moved box or function displaces nothing: later boxes take columns and rows from its unmoved position.
- `>> name()`, `└─>>`: callers, calls off screen (closed, beyond the call depth, hidden, or removed).
- `├─>`, `└─>`: tree edge from the caller's stem. `──┐ ──┤ <──┘`: lane inside a box. `──> f()`: routed call from the left, across box borders. Merge, fork: calls into, or from, one function on one line; unrelated calls never share a line.
- Vector mode: horizontal call hops over a crossed vertical one (orthogonal, rounded); branches of a merge or fork curve in the call direction.
- `↻`: direct recursion; `↻ f()`: call back to `f` higher in the same chain.
- `[moomoo.boogaloos] (6)`: collapsed container, member count; its move or lock applies only while collapsed (unit `collapsed:<key>`); expanding restores the layout from before the collapse.

Algorithms: [src/core/layout.ts](src/core/layout.ts) (rows and lanes in a block), [src/core/boxes.ts](src/core/boxes.ts), [src/core/place.ts](src/core/place.ts) (2D placement, moves, locks), [src/core/grid.ts](src/core/grid.ts) (routing). Rules with code links: [docs/heuristics.md](docs/heuristics.md) (layout heuristics; the same graph as a gaffy view: [docs/heuristics.gaffy](docs/heuristics.gaffy)), [docs/ordering.md](docs/ordering.md) (triggers, interpreters, layout functions, drawing of one call, what a drag moves).

## Interaction

| input | action |
|---|---|
| click a function | select; definition opened next to the graph (`gaffy.openDefinitions`) |
| Shift+click a function | selection toggle |
| Shift+drag on the background | selection window: every label touched |
| `>> name()` / `└─>>` (one layer at a time) | open callers / calls, removed ones included |
| click an arrowhead (one layer at a time) | close the level it points into |
| double click a function (one layer at a time) | close both sides, or open every side with more |
| double click a collapsed container; a box header | expand it; collapse the box |
| drag a function | move with its tree children, or all selected; calls re-route; its namespace box grows around it |
| drag a box header | move the box and its content |
| hover an arrow | highlight every call through the cell, end to end |
| click an arrow | select every call through the cell (whole fork or merge); Shift toggles |
| double click an arrow | isolate: selected calls' callers and everything below their callees |
| Enter | isolate selected calls or functions; one focused function: open it |
| Esc | clear the selection; nothing selected: show all |
| right click a function | VS Code: editor context menu, peek references, call hierarchy, reveal in explorer, copy path or name, go to definition (`gaffy.openDefinitions` off); open or close callers, calls (one layer at a time); make or remove a seed (place kept; missing side asked); select upstream, downstream, through, between two or more, clear; isolate selection, hide selection (else the function clicked; seeds stay), show hidden neighbors; collapse class, module, package; group its module; re-arrange selected, lock, unlock, move among siblings, tag |
| right click the canvas | Options > File entries except Edit style.json and Settings; Isolate Selection, Clear Selection; ✓ Group namespaces, ✓ Tight groups; Options > Arrange entries |
| right click a box header | collapse, ungroup (box dissolved, inner moves dropped, content at computed places in the enclosing box), group the modules inside, lock, unlock, reveal, copy path |
| right click an arrow | **Straighten This Call (route it first)**, isolate this call, isolate the path through it, go to call site, go to callee |
| ↑ ↓, Alt+↑ ↓ | move focus; move the focused function among its siblings |
| e, c or ←, → | open the focused function's sides that have more (one layer at a time); collapse innermost container; expand collapsed |
| Delete or Backspace, h, i, k | remove selection (calls cut, functions hidden; full: hide functions); hide selection; isolate selection; lock or unlock the focused function |
| u, g, b, r, 0, x | unhide all; glyph or vector edges; group namespaces; refresh from language server; zoom fit; export |

Toolbar: **Isolate** (nothing hidden) or **Show all (n)** (something hidden), call depths (full), **zoom fit**, **Expand mode >>** / **Expand mode -+** (switch to that call expansion), **☰ Options** (pulldown, checkmarks):

- Call Expansion: Individual On Graph (one layer at a time), Global Toolbar (full); Call depth by (full): shortest or longest call path
- Namespaces: ✓ Group namespaces, ✓ Tight groups (default on, style `boxes.tight`: frames fit their content on all sides), reset per-box grouping (moves inside changed boxes dropped)
- Edges: glyphs (UTF box drawing) or vector; vector curve: orthogonal, rounded, sigmoid, spline. Cross-language calls dash-dot, implicit calls dotted, every style and the text export (`┈ ┊`, `─·─·`)
- Tree parent: first caller found (dfs), nearest caller above, left merge (joint: a caller right above joins the elbow `├───┴─>`; several callers in a box join one collector from the left, `┌──┘` then `└─>`; calls between boxes arrive from the left where cells are free)
- Arrange, also on canvas right click (key `a`: re-arrange): **Reset graph**: seeds, depth, direction (one layer at a time: seeds and first layer; full: starting call depths), **Reset Layout**: moves, locks, order (sibling order, straightened calls), Re-arrange (selected functions to their computed place; no selection: every unlocked move dropped), Unlock all, Expand collapsed
- Folders: ✓ Include external code (`gaffy.includeExternal`, workspace setting; on: language server asked again; off: hidden at once), ✓ Include standard library (`gaffy.includeStandardLibrary`), then each top-level folder, included or excluded (external and standard library folders listed only while included). Draw-time filters: calls into an excluded folder stay stored, so including it shows them without the language server.
- File: Save (.gaffy) (Autosave Graphs off), ✓ Freeze at commit (no language-server updates; commit and time recorded in the view and shown in the toolbar: Frozen at commit … ; also `gaffy: Freeze or Unfreeze View at Commit`), ✓ Autosave Graphs (`gaffy.saveViews`), Save as Text (.txt, .md), Refresh Language Server, Edit style.json, Settings (filtered to gaffy)

Toolbar, pulldown: HTML built with d3-selection, VS Code theme variables (`--vscode-menu-*`). Graph: SVG drawn with D3.

Locks: a locked function or box keeps its absolute position; unlocked items placed around it.

"Editor Context Menu…": the definition in an editor, with VS Code's editor context menu at its cursor (entries of every installed extension). Explorer context menu of a file: no VS Code command; "Reveal in Explorer" selects the file, Shift+F10 opens its menu.

## Views from scripts

A script writes a view file with seeds by name and opens it; gaffy resolves each seed (document symbols, call hierarchy) and asks the language server within the view's depths. Seeds: `<path>#<qualified name>` or `<path>:<line>` (1-based, inside the definition), path relative to the folder holding `.gaffy/` (the repository), else to the workspace folder; a seed not found is reported in a warning. `"save": true`: the file is saved after every change, whatever `gaffy.autoSave` says.

```python
import json, pathlib, subprocess

view = {"gaffy": 1, "name": "batch", "view": {
    "seeds": ["src/pkg/mod.py#Scoobie.do", "src/pkg/other.py#magoo", "src/pkg/other.py:120"],
    "arrange": "auto", "direction": "both", "depthUp": 2, "depthDown": 3, "save": True}}
p = pathlib.Path(".gaffy/views/batch.gaffy")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(view))
subprocess.run(["code", str(p)])
```

`depthUp`: caller levels, `depthDown`: callee levels (`"all"`: every level); `"arrange": "grow"` instead starts one layer at a time. The resolved view replaces the names with gaffy keys and stores the graph.

## Building, progress, cache

- Progress: banner with phase, depth, definitions, language-server requests, cached answers; after 400 ms also a notification with cancel.
- Cache: each language-server answer (callers or callees of one definition), in `.gaffy/cache/calls.json`. Depth or direction changes, expansion and view opening ask the language server only for uncached answers.
- Invalidation: a saved, renamed or externally changed source file drops its definitions' cached outgoing calls and all cached incoming calls; files of an extension no cached definition has (logs, bytecode, build output): none. `gaffy: Clear Call Cache`: everything.
- No answer ≠ empty answer: a definition the language server does not resolve (analyzing after a reload, renamed, removed) keeps its stored calls, uncached, unexplored; retries after 2, 4, 8, 15, 30, 60 s (`language server not ready` in the status line), then a warning with the count.
- Timeout: 30 s without an answer counts as no answer (retried); one stalled request never holds the queue.
- Opening a view: explored (definition, direction) pairs take cached answers; stale pairs on screen asked again in the background, off screen kept and asked when a side opens onto them. Nothing changed since the last save: no request.
- **Refresh Language Server** (Options > File, `r`, `gaffy: Refresh Language Server`): every on-screen (definition, direction) pair asked again; cached answers of the others dropped (asked when a side or a call depth reaches them).

## Change tracking

- Source save: open views with a definition from that file updated (`gaffy.refreshOnSave`: `touched`, `all`, `off`), asking only the pairs made stale.
- File rename: keys, paths, URIs rewritten in open views, then updated alike.
- Definition identity across line moves: keys `<lang>:<path>#<qualified name>`.
- Views keep every definition the language server named; closed sides, lower call depths, hides only take them off screen.

## Files

```
.gaffy/
  views/<symbol>_<commit>.gaffy  view: seeds, direction, depth, open sides, call depths, cut calls, collapsed, hidden, grouping,
                               folder include and exclude, tags, straightened calls, last graph and the
                               directions asked per definition (JSON)
  <symbol>_<commit>.md         text export, <pre> with links to path#Lline, seeds in bold; <commit> = short HEAD hash, or
  <symbol>_<commit>.txt        <YYYYMMDD-HHMM> outside git; later exports of the same symbol and commit: _2, _3, …
  cache/calls.json             cached language-server answers
  style.json                   style overrides (gaffy: Edit Style writes the defaults)
```

## Style

Precedence: `.gaffy/style.json` over the `gaffy.style` setting over `DEFAULT_STYLE` ([src/core/style.ts](src/core/style.ts)); numbers clamped to the ranges of [schemas/style.schema.json](schemas/style.schema.json).

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

- Options defaults. At view creation, stored in the view: `view.arrange` (`grow` one layer at a time, `auto` full), `view.traverse` (`command`: the editor command determines the side; `both`). Every render, unless the view has its own choice: `edges.mode` (`vector`, `glyph`), `edges.curve`, `grid.parentRule` (`dfs`, `nearest`, `joint`), `boxes.enabled`.
- `edges.lead`: straight lead-out and lead-in of the sigmoid (cells); `edges.tension`: reach of the S-curve control points (0 sharp, 1 wide).
- `route.adjacent`: cost of a vertical run in the column next to an unrelated vertical line; `route.cross`: cost of a crossing.

### Colors

`colors` key → CSS custom property `--g-<key>` (`applyColors`, [src/webview/main.ts](src/webview/main.ts)), read by [media/webview.css](media/webview.css). Values: CSS colors or VS Code theme variables (`var(--vscode-…)`).

| key | default | element |
|---|---|---|
| `fg` | editor foreground | function names |
| `bg` | editor background | canvas, box header background |
| `edge` | line-number foreground | call lines, arrowheads, glyphs |
| `highlight` | focus border | hovered calls, calls of the hovered function |
| `selection` | active link foreground | selected calls (click on an arrow), outline of selected functions |
| `selected` | selection background | background of selected functions |
| `seed` | link foreground | seed functions |
| `twisty` | link foreground | `>>` and `└─>>` markers |
| `frame` | widget border | namespace box lines |
| `namespace` | description foreground | namespace box headers |
| `external` | disabled foreground | definitions outside the workspace |

New UI color: a rule in `media/webview.css` reading `var(--g-<key>)`; the key with its default in `DEFAULT_STYLE.colors` and in the CSS `:root` block (used before the style arrives).

## Settings

| setting | default | effect |
|---|---|---|
| `gaffy.depth` | 3 | one layer at a time: levels prefetched in the background; full: the starting call depths |
| `gaffy.maxNodes` | 400 | definitions fetched per build |
| `gaffy.openCallHierarchy` | true | also open VS Code's Call Hierarchy, in the References view, when creating a view |
| `gaffy.saveViews` | false | Autosave Graphs: new views written to `.gaffy/views/`, saved after each change. Off: closing an unsaved view discards it (hot exit keeps it across window reloads) |
| `gaffy.trace` | false | view change log, undo and redo included, in `.gaffy/trace/<view>.jsonl`: event, target, grid cell, acting functions, changed fields, moved labels and boxes; trusted workspaces only. Reader: `node tools/gaffy-trace.mjs <file>` (this repository) |
| `gaffy.exclude` | none | globs of folders and files kept off screen (for example `"**/tests/**"`); Options > Folders includes them again per view |
| `gaffy.includeExternal` | false | show external code: installed packages (site-packages, node_modules), stubs, system headers, build output, wasm-pack glue |
| `gaffy.includeStandardLibrary` | false | with external code: builtins and standard library (Python typeshed `stdlib`, `pythonX.Y`; Rust core, alloc, std; C++ standard headers; TypeScript `lib.*.d.ts`); off: installed packages only; drawn without the language server |
| `gaffy.autoSave` | true | save the view file after each graph change |
| `gaffy.refreshOnSave` | touched | update policy after a source save |
| `gaffy.openDefinitions` | true | Open Definitions: a view from the editor opens beside it; a click opens the definition next to the graph. Off: active column; a click only selects |

## Tests and preview

Commands: [Scripts](#scripts). Preview page parameters: `dist/preview.html?doc=sh|exp4|star|grow|two[&edges=vector&curve=sigmoid&fill=hue&boxes=off&parentRule=joint]`.

Preview: the webview bundle in a browser, mocked VS Code API, fixture views (`sh`, `exp4`, `star`, `grow`, `two`) over made-up packages; `GAFFY_PREVIEW_FILE=<view.gaffy>` previews any view.

## License

Apache License 2.0 ([LICENSE](LICENSE)). Copies and derived works keep the attribution in [NOTICE](NOTICE): name, copyright, repository. Third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[^lsp]: LSP, Language Server Protocol: JSON-RPC protocol between editors and language servers; call hierarchy requests `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls` since version 3.16.
