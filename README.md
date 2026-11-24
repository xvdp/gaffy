# gaffy
*VS Code extension* that generates persistent, editable call graphs, leveraging D3 and can be exported to ASCII (UTF) style.

This sketch uses the character grid logic of ASCII, the clean looks of D3, to extend VS Code call graphs.

Supports Python, TypeScript, JavaScript, Rust, C++, CUDA, Objective-C, Go, Java, C#, Kotlin, Swift, Dart, relying on their language servers, partial support for Slang. Some cross language support across pybind11, nanobind, wasm-bindgen. More info in [docs/development.md](docs/development.md).


Graphs are .json (.gaffy) files saved as  `<vscode-root>/.baggy/gaffy/<symbol>_<commit>.gaffy`; views written by [giddy](https://github.com/xvdp/giddy) live in their repository, `<repo>/.baggy/gaffy/`, beside giddy's reports in `<repo>/.baggy/giddy/`.

## Install from vscode marketplace
Stupid MS locked my account so not yet published. I suppose if i were an agent i would have the patience to go thru with their byzantine mating rituals to unlock an account.


## Install from Source

```bash
npm install
npm run package         # typecheck, tests, bundles, gaffy-<version>.vsix
npm run install:local   # also:  code --install-extension gaffy-<version>.vsix
```
### Test installed .vsix extension
`Ctrl+Shift+P > **Developer: Reload Window**`

### Access points:
Function context and file explorer file content.

`gaffy> Call hierarchy (up)` is similar to VS Code `Show Call Hierarchy` with several differences beyond the gaffy view:
* partial cross language support [`src/host/bridges.ts`](src/host/bridges.ts) 
* call hierarchy can be exapanded to called functions as well.

<p align="center">
  <img src="images/gaffy_func_ctxt.png" alt="Editor right click on a function: gaffy> Call Hierarchy (up)" width="48%" align="middle">
  &nbsp;<b> --> </b>&nbsp;
  <img src="images/gaffy_cross_lang.png" alt="The gaffy view it opens: Python callers reaching the CUDA function coord2Morton" width="48%" align="middle">
</p>


```
╭┄ scene ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮
┆  >> __init__.Scene()                                    ┆
┆  └┈> __init__.Scene.__init__()                          ┆
┆      └─> gaussian_model.GaussianModel.create_from_pcd() ·┐
┆  >> gaussian_model.GaussianModel.reinitial_pts() ─┐     ┆│
╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄·┄┄┄┄┄╯·
                                    ┌─·─·─·─·─·─·─·─┴─·─·─·┘
                                    ·╭┄ submodules/simple-knn ┄╮
                                    └─> spatial.distCUDA2()    ┆
                                     ┆  └─> simple_knn.knn()   ┆
                                     ┆      └─>>               ┆
                                     ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯
```


![demo](images/demo.gif)


Development: `gaffy/` in VS Code, F5 (Extension Development Host); `npm run watch` rebuilds on change.

## Docs

- [docs/development.md](docs/development.md): tooling, release, publishing, project parts, security measures.
- [docs/heuristics.md](docs/heuristics.md): layout rules with code links, as a pipeline graph; [docs/heuristics.gaffy](docs/heuristics.gaffy): the same graph as a gaffy view.
- [docs/ordering.md](docs/ordering.md): functions that change what a view shows and where (triggers, interpreters, layout), drawing of one call, what a drag moves.



`style.json` `view.traverse: "both"`: new views start with callers and calls. Explorer right click on a file > **gaffy** > Call Hierarchies (all, up): each function of the file with one caller level, full layout. `gaffy: Check Language Servers`: workspace languages, extension providing each call hierarchy, missing installs; a notification once per version when a required extension is missing (Install, Show Report, Don't Show Again).

New view: unsaved, bound to `.baggy/gaffy/<symbol>_<short commit hash>.gaffy` (`<symbol>_<YYYYMMDD-HHMM>` outside git); right click > Save (.gaffy) writes it; Autosave Graphs (`gaffy.saveViews`) saves new views at once. Save as Text (key `x`): `.baggy/gaffy/<symbol>_<commit>.md` and `.txt` in the view's project, named in a notification.

Options values belong to the view: edge style, curve, tree parent, grouping, tight groups, external code and standard library are stored in it when it is created (or unfrozen); `style.json` and the settings are defaults for new views only.

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
| hover a function name | card (not over the `>> ` of callers off screen, which keeps its own title): the language server's signature (as VS Code's hover, return types included where the server infers them), one parameter per line, VS Code hover colors; then qualified name, `path:line`, levels |
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

- Call Expansion: Individual On Graph (one layer at a time), Global Toolbar (full); ✓ Paths between seeds only (`view.between`; full: paths within the call depths; one layer at a time: every path in the graph data, any number of calls, and a marker click says the side leads to no other seed; turned off one layer at a time: the paths stay, nothing else opens); Call depth by (full): shortest or longest call path
- Grouping: ✓ by Namespace, ✓ Tight (default on, style `boxes.tight`: frames fit their content on all sides), reset per-box grouping (moves inside changed boxes dropped)
- Parenting: first caller found (dfs), nearest caller above, left merge (joint: a caller right above joins the elbow `├───┴─>`; several callers in a box join one collector from the left, `┌──┘` then `└─>`; calls between boxes arrive from the left where cells are free)
- Edge Style: ASCII (UTF) (box drawing glyphs) or D3 Vector; Vector Style: orthogonal, rounded, sigmoid, spline. Cross-language calls dash-dot, implicit calls dotted, every style and the text export (`┈ ┊`, `─·─·`)
- Arrange, also on canvas right click (key `a`: re-arrange): **Reset graph**: seeds, depth, direction (one layer at a time: seeds and first layer; full: starting call depths), **Reset Layout**: moves, locks, order (sibling order, straightened calls), Re-arrange (selected functions to their computed place; no selection: every unlocked move dropped), Unlock all, Expand collapsed; ✓ Layout debug (`gaffy.debugLayout`, [Layout debugging](#layout-debugging)), with the rule switches and the decision log below it while on
- Folders: ✓ Include external code (this view; new views: `gaffy.includeExternal`; on: language server asked again; off: hidden at once), ✓ Include standard library (this view; new views: `gaffy.includeStandardLibrary`), then each top-level folder, included or excluded (external and standard library folders listed only while included). Draw-time filters: calls into an excluded folder stay stored, so including it shows them without the language server.
- File: Save (.gaffy) (Autosave Graphs off), ✓ Frozen (see [Freeze on open](#freeze-on-open); also `gaffy: Freeze or Unfreeze View`), ✓ Autosave Graphs (`gaffy.saveViews`), Save as Text (.txt, .md), Refresh Language Server, Edit style.json, Settings (filtered to gaffy)

Status line: nodes, calls, selection; expansion mode (`>> Individual`, `+ - Full layer`, `Locked: paths between seeds`); `Layout Debug` with decision and flag counts; `Frozen`, `Unsaved`, truncated, unrouted calls, last build; while the language server works, `⟳ language server: <phase>` with growing dots.

Toolbar, pulldown: HTML built with d3-selection, VS Code theme variables (`--vscode-menu-*`). Graph: SVG drawn with D3.

Locks: a locked function or box keeps its absolute position; unlocked items placed around it.

"Editor Context Menu…": the definition in an editor, with VS Code's editor context menu at its cursor (entries of every installed extension). Explorer context menu of a file: no VS Code command; "Reveal in Explorer" selects the file, Shift+F10 opens its menu.

## Views from scripts

A script writes a view file with seeds by name and opens it; gaffy resolves each seed (document symbols, call hierarchy) and asks the language server within the view's depths. Seeds: `<path>#<qualified name>` or `<path>:<line>` (1-based, inside the definition), path relative to the folder holding `.baggy/` (the repository), else to the workspace folder; a seed not found is reported in a warning. `"save": true`: the file is saved after every change, whatever `gaffy.autoSave` says.

```python
import json, pathlib, subprocess

view = {"gaffy": 1, "name": "batch", "view": {
    "seeds": ["src/pkg/mod.py#Scoobie.do", "src/pkg/other.py#magoo", "src/pkg/other.py:120"],
    "arrange": "auto", "direction": "both", "depthUp": 2, "depthDown": 3, "save": True}}
p = pathlib.Path(".baggy/gaffy/batch.gaffy")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(view))
subprocess.run(["code", str(p)])
```

`depthUp`: caller levels, `depthDown`: callee levels (`"all"`: every level); `"arrange": "grow"` instead starts one layer at a time. `"between": true`: only the functions on call paths from one seed to another are drawn (connectivity of the seeds; `depthUp`, `depthDown` set how far paths are searched; with both 0, the seeds and the calls among them). The resolved view replaces the names with gaffy keys and stores the graph.

## Building, progress, cache

- Progress: status line `⟳ language server: <phase> …` with growing dots (seed resolution `resolving seeds 3/34`, then layers, definitions, language-server requests, cached answers), the same phase in a banner over the graph; after 400 ms also a notification with cancel.
- Cache: each language-server answer (callers or callees of one definition), in `.baggy/gaffy/cache/calls.json` (`calls-external.json` for views with external code). Depth or direction changes, expansion and view opening ask the language server only for uncached answers.
- Invalidation: a saved, renamed or externally changed source file drops its definitions' cached outgoing calls and all cached incoming calls; files of an extension no cached definition has (logs, bytecode, build output): none. `gaffy: Clear Call Cache`: everything.
- No answer ≠ empty answer: a definition the language server does not resolve (analyzing after a reload, renamed, removed) keeps its stored calls, uncached, unexplored; retries after 2, 4, 8, 15, 30, 60 s (`language server not ready` in the status line), then a warning with the count.
- Timeout: 30 s without an answer counts as no answer (retried); one stalled request never holds the queue.
- Unfrozen view: explored (definition, direction) pairs take cached answers; stale pairs on screen asked again in the background, off screen kept and asked when a side opens onto them. Nothing changed since the last save: no request.
- **Refresh Language Server** (Options > File, `r`, `gaffy: Refresh Language Server`): every on-screen (definition, direction) pair asked again; cached answers of the others dropped (asked when a side or a call depth reaches them).

## Change tracking

- Source save: open views with a definition from that file updated (`gaffy.refreshOnSave`: `touched`, `all`, `off`), asking only the pairs made stale.
- File rename: keys, paths, URIs rewritten in open views, then updated alike.
- Definition identity across line moves: keys `<lang>:<path>#<qualified name>`.
- Views keep every definition the language server named; closed sides, lower call depths, hides only take them off screen.

## Files

```
.baggy/                        shared with giddy (.baggy/giddy/: reports, commits.md)
  gaffy/
    <symbol>_<commit>.gaffy    view: seeds, direction, depth, open sides, call depths, cut calls, collapsed, hidden, grouping,
                               folder include and exclude, tags, straightened calls, Options values, last graph, the
                               directions asked per definition, commit at last build (JSON)
    <symbol>_<commit>.md       text export, <pre> with links to path#Lline, seeds in bold; <commit> = short HEAD hash, or
    <symbol>_<commit>.txt      <YYYYMMDD-HHMM> outside git; later exports of the same symbol and commit: _2, _3, …
    cache/calls.json           cached language-server answers (calls-external.json: views with external code)
    trace/<view>.jsonl         change log (gaffy.trace)
    style.json                 style overrides (gaffy: Edit Style writes the defaults)
```

Placement: views created in VS Code under the workspace folder; views written by giddy or a script under their repository (seed paths, exports and the commit hash refer to the folder holding `.baggy/`). Style and call cache: per workspace folder. Views in a `.gaffy/views/` folder still open; new files go to `.baggy/gaffy/`.

## Layout debugging

Setting `gaffy.debugLayout` (Options > Arrange > Layout debug). Right click a function or box > **Why Here?**: the placement and settle decisions that put it where it is drawn, one line each: rule (as in [docs/heuristics.md](docs/heuristics.md)), function, the unit placed, outcome, values. Decisions past a threshold are flagged (⚑, wavy underline on the graph; thresholds `FLAGS` in [src/core/explain.ts](src/core/explain.ts)): an unmoved box or block sliding ≥ 12 rows, a moved function sliding ≥ 4 rows, a settle move ≥ 12 cells, an unmoved box pushed below a frame stretched by moves inside it. Options > Arrange > Layout debug turns it on; below it, each switchable rule on or off (h13 caller alignment, h15 block descent, h17 item column, h18 item row, h20 unmoved box descent, h21 moved function descent, h23 settle), the picture redrawn without it and nothing saved while one is off; Decision log: every decision in an editor.

Offline, in this repository (code lines from the rule anchors, [scripts/rules.ts](scripts/rules.ts)):

```bash
npm run explain -- <view.gaffy>                       # every decision, with file:line
npm run explain -- <view.gaffy> --unit <text> --flags # one unit's decisions, flagged only
npm run explain -- <view.gaffy> --off h20_unmoved_box_descent,h23_settle   # what moves without these rules
npm run explain -- <view.gaffy> --trace .baggy/gaffy/trace/<view>.jsonl    # replay a gaffy.trace: jumps and flags per change
```

## Freeze on open

A view built earlier (language-server data in it), saved, closed and opened again opens frozen: no language-server requests, settled moves not written; the file stays as saved. Not frozen: a new view, a view written by giddy or a script (no data yet), an unsaved view. The toolbar shows **Unfreeze** (with the build time and commit); clicking it is an edit of the view (`view.live`, the id of this opening, and the Options values), so Ctrl+Z freezes again and Ctrl+Y unfreezes. Every opening has a new id: the next opening is frozen again. Options > File > Frozen toggles the same state. Edits (moves, hides, collapses) work while frozen; sides without stored calls stay closed. A giddy view (`"pinPaths": true`) builds with Paths between seeds only, then the paths stay pinned and the option turns off.

## Style

Precedence: `.baggy/gaffy/style.json` over the `gaffy.style` setting over `DEFAULT_STYLE` ([src/core/style.ts](src/core/style.ts)); numbers clamped to the ranges of [schemas/style.schema.json](schemas/style.schema.json).

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
| `between` | `#c8553d` (brick red) | functions on call paths between two seeds, regular weight |
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
| `gaffy.saveViews` | false | Autosave Graphs: new views written to `.baggy/gaffy/`, saved after each change. Off: closing an unsaved view discards it (hot exit keeps it across window reloads) |
| `gaffy.trace` | false | view change log, undo and redo included, in `.baggy/gaffy/trace/<view>.jsonl`: event, target, grid cell, acting functions, changed fields, moved labels and boxes; trusted workspaces only. Reader: `node tools/gaffy-trace.mjs <file>` (this repository) |
| `gaffy.exclude` | none | globs of folders and files kept off screen (for example `"**/tests/**"`); Options > Folders includes them again per view |
| `gaffy.includeExternal` | false | new views: show external code (Options > Folders per view): installed packages (site-packages, node_modules), stubs, system headers, build output, wasm-pack glue |
| `gaffy.includeStandardLibrary` | false | new views, with external code: builtins and standard library (Python typeshed `stdlib`, `pythonX.Y`; Rust core, alloc, std; C++ standard headers; TypeScript `lib.*.d.ts`); off: installed packages only; drawn without the language server |
| `gaffy.autoSave` | true | save the view file after each graph change |
| `gaffy.refreshOnSave` | touched | update policy after a source save |
| `gaffy.openDefinitions` | true | Open Definitions: a view from the editor opens beside it; a click opens the definition next to the graph. Off: active column; a click only selects |

## Tests and preview

Commands: [docs/development.md](docs/development.md#scripts). Preview page parameters: `dist/preview.html?doc=sh|exp4|star|grow|two[&edges=vector&curve=sigmoid&fill=hue&boxes=off&parentRule=joint]`.

Preview: the webview bundle in a browser, mocked VS Code API, fixture views (`sh`, `exp4`, `star`, `grow`, `two`) over made-up packages; `GAFFY_PREVIEW_FILE=<view.gaffy>` previews any view.

## License

Apache License 2.0 ([LICENSE](LICENSE)). Copies and derived works keep the attribution in [NOTICE](NOTICE): name, copyright, repository. Third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[^lsp]: LSP, Language Server Protocol: JSON-RPC protocol between editors and language servers; call hierarchy requests `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls` since version 3.16.
