# gaffy node order: triggers, interpreters, layout

Taxonomy of graph layout ordering functions. Drawing decision tree per call.

1. **Triggers**: user actions in the webview (mouse, keys, toolbar, Options), the context menu, and events outside the view.
2. **Interpreters**: functions that turn a trigger into a change of the view document (`ViewDoc.view`) and commit it; each commit is one undo step.
3. **Layout**: functions that compute positions from a view document, on every redraw; the same document gives the same picture.

Terms:
- **unit**: group of displaced symbols: a function with its tree below, a namespace box with its content (`box:<key>`), or a collapsed container (`collapsed:<key>`).
- **offset**: move distance `[Δcolumn, Δrow]` from its computed place; If lock then abs cell.
- **settle**: units moved to the nearest clear offset  (`settleMoved`); offests saved in webview.
- **anchor**: symbol that does not shift on graph window, when a graph rearranges.


## 1. Triggers

Canvas (mouse):

| trigger | code | calls |
|---|---|---|
| double click a label (one layer at a time) | [main.ts:575](../src/webview/main.ts#L575) | `toggleSides`; on a collapsed container: expand (`collapsed` filter, `anchorAt`) |
| drag a label | [main.ts:582](../src/webview/main.ts#L582) | `dragUnit` (unit: the vertex, `collapsed:<key>` for a collapsed one, or the selection) |
| click `>> ` before a label | [main.ts:556](../src/webview/main.ts#L556) | `markerClick(key, 'up')` |
| click `>` of a `└─>>` row | [main.ts:590](../src/webview/main.ts#L590) | `markerClick(key, side)` |
| click the elbow of a `└─>>` row | [main.ts:502](../src/webview/main.ts#L502) | `markerClick(caller, 'down')` |
| click an arrowhead | [main.ts:536](../src/webview/main.ts#L536) | `closingOf(…).run` → `setSide(…, false)`: closes the level it points into |
| double click a call | [main.ts:515](../src/webview/main.ts#L515) | `isolateCalls` (the selection holding the call, else the calls through the cell) |
| double click a box header | [main.ts:614](../src/webview/main.ts#L614) | collapse the container (`collapsed` push) |
| drag a box header | [main.ts:619](../src/webview/main.ts#L619) | `dragUnit` (unit `box:<key>`) |
| wheel, drag the background | [main.ts:88](../src/webview/main.ts#L88) | zoom and pan only: no view change |

Keys (focused function `k`):

| key | code | calls |
|---|---|---|
| Alt+↑, Alt+↓ | [main.ts:1473](../src/webview/main.ts#L1473) | `moveSibling(±1)` |
| e, Space | [main.ts:1481](../src/webview/main.ts#L1481) | `setSide(k, side, true)` for each side with more |
| ←, c | [main.ts:1482](../src/webview/main.ts#L1482) | `collapseInnermost` |
| → | [main.ts:1483](../src/webview/main.ts#L1483) | expand the focused collapsed container |
| Delete, Backspace | [main.ts:1484](../src/webview/main.ts#L1484) | `runCmd('remove')` |
| h | [main.ts:1485](../src/webview/main.ts#L1485) | `runCmd('hideSelection')` |
| a | [main.ts:1486](../src/webview/main.ts#L1486) | `runCmd('rearrangeSelection')` with a selection, else `runCmd('rearrange')` |
| i | [main.ts:1487](../src/webview/main.ts#L1487) | `runCmd('isolateSelection')` |
| Escape | [main.ts:1488](../src/webview/main.ts#L1488) | clear the selection, else `runCmd('showAll')` |
| k | [main.ts:1494](../src/webview/main.ts#L1494) | `runCmd('lock' | 'unlock')` on the focused unit |
| u | [main.ts:1495](../src/webview/main.ts#L1495) | `hidden = []` |
| b | [main.ts:1497](../src/webview/main.ts#L1497) | `boxes` toggled |
| r | [main.ts:1498](../src/webview/main.ts#L1498) | host `refresh`: new data from the language server |

Toolbar and Options:

| entry | code | calls |
|---|---|---|
| call depth `all` `+` `−` (full layout) | [main.ts:1671](../src/webview/main.ts#L1671) | `setDepth(side, …)` |
| **Show all (n)** | [main.ts:1681](../src/webview/main.ts#L1681) | `runCmd('showAll')` |
| **Expand mode >>**, **Expand mode -+** | [main.ts:1691](../src/webview/main.ts#L1691) | `setArrange('auto' | 'grow')`: switches to the mode it names |
| **Isolate** | [main.ts:1682](../src/webview/main.ts#L1682) | `runCmd('isolateSelection')` |
| Options > Call Expansion: Individual On Graph, Global Toolbar | [main.ts:1697](../src/webview/main.ts#L1697) | `setArrange('grow' | 'auto')` |
| Options > Seeds > Only paths between seeds | [main.ts:1703](../src/webview/main.ts#L1703) | `between`: full view, drawn functions filtered to seed-to-seed call paths (`onPaths`); one layer at a time, the reveal is the paths of the whole graph (`revealPaths`); off: the paths become `pinned`, every side closed (`toggleBetween`) |
| marker click, one layer at a time with Only paths between seeds | [main.ts:784](../src/webview/main.ts#L784) | refused, status line: the side leads to no other seed |
| Options > Layout debugging (gaffy.debugLayout) | [main.ts:1760](../src/webview/main.ts#L1760) | rules switched off (`rulesOff`, webview state): the picture without them, nothing saved meanwhile; Why Here? and the decision log read `decisions` (explain.ts) |
| Options > Call depth by: shortest, longest path | [main.ts:1709](../src/webview/main.ts#L1709) | `depthRule` |
| Options > Namespaces > Group namespaces | [main.ts:1713](../src/webview/main.ts#L1713) | `boxes` |
| Options > Namespaces > Tight groups | [main.ts:1715](../src/webview/main.ts#L1715) | `tight` |
| Options > Namespaces > Reset grouping | [main.ts:1717](../src/webview/main.ts#L1717) | `group`, `ungroup` = [], `dropMovesWithin` for each |
| Options > Tree parent: first caller found, nearest caller above, left merge | [main.ts:1727](../src/webview/main.ts#L1727) | `parentRule` |
| Options > Arrange > Reset graph: seeds, depth, direction | [main.ts:1733](../src/webview/main.ts#L1733) | `runCmd('resetView')` |
| Options > Arrange > Reset Layout: moves, locks, order | [main.ts:1736](../src/webview/main.ts#L1736) | `runCmd('resetLayout')` |
| Options > Arrange > Re-arrange | [main.ts:1737](../src/webview/main.ts#L1737) | `runCmd('rearrangeSelection' | 'rearrange')` |
| Options > Arrange > Unlock all | [main.ts:1740](../src/webview/main.ts#L1740) | `runCmd('unlockAll')` |
| Options > Arrange > Expand collapsed | [main.ts:1741](../src/webview/main.ts#L1741) | `runCmd('expandAll')` |
| Options > Folders > Include external code, Include standard library | [main.ts:1744](../src/webview/main.ts#L1744) | host setting; the webview redraws; their folders leave the list when off |
| Options > Folders > a folder | [main.ts:1749](../src/webview/main.ts#L1749) | `exclude`, `include` |
| Options > File > Save (.gaffy), Autosave Graphs, Save as Text, Refresh Language Server | [main.ts:1767](../src/webview/main.ts#L1767) | host: save, setting `gaffy.saveViews`, export, `refresh` (new data) |
| Options > File > Frozen; toolbar Unfreeze | [main.ts:1771](../src/webview/main.ts#L1771) | host `hold`: Unfreeze writes `live` (this opening) and the Options values into the view; Freeze removes `live`. A view holding a graph opens frozen |

Context menu (`webview/context` entry, host registration; *forwarded* entries post `cmd` to the webview):

| entry | code | calls |
|---|---|---|
| Make Seed, Remove Seed | [package.json:602](../package.json#L602), [commands.ts:394](../src/host/commands.ts#L394) | forwarded: `runCmd('makeSeed' | 'removeSeed')` |
| Open Callers / Open Called / Close Callers / Close Called (one layer) | [package.json:582](../package.json#L582), [commands.ts:249](../src/host/commands.ts#L249) | forwarded: `runCmd('openUp' …)` → `setSide` |
| Isolate Selection, Hide Selection | [package.json:637](../package.json#L637), [commands.ts:273](../src/host/commands.ts#L273) | forwarded: `runCmd('isolateSelection' | 'hideSelection')` (the selection, else the function right clicked; seeds stay) |
| Show Hidden Neighbors… | [package.json:647](../package.json#L647), [commands.ts:268](../src/host/commands.ts#L268) | host quick pick: `hidden` minus the picked |
| Collapse Class / Module / Package | [package.json:652](../package.json#L652), [commands.ts:372](../src/host/commands.ts#L372) | host `collapse(kinds)`: `collapsed` push |
| Expand Container | [package.json:667](../package.json#L667), [commands.ts:391](../src/host/commands.ts#L391) | host: `collapsed` filter |
| Group Module, Ungroup Module, Group Submodules | [package.json:672](../package.json#L672), [commands.ts:376](../src/host/commands.ts#L376) | host: `group`, `ungroup`; `dropMovesWithin` the container |
| Re-arrange selected | [package.json:532](../package.json#L532), [commands.ts:274](../src/host/commands.ts#L274) | forwarded: `runCmd('rearrangeSelection')` |
| Lock Position, Unlock Position | [package.json:692](../package.json#L692), [commands.ts:265](../src/host/commands.ts#L265) | forwarded: `runCmd('lock' | 'unlock')` |
| Move Up One, Move Down One | [package.json:707](../package.json#L707), [commands.ts:412](../src/host/commands.ts#L412) | host `move(±1)`: `sibling` |
| Tag… | [package.json:717](../package.json#L717), [commands.ts:396](../src/host/commands.ts#L396) | host: `tags` (a longer label widens its column) |
| Straighten This Call | [package.json:722](../package.json#L722), [commands.ts:253](../src/host/commands.ts#L253) | forwarded: `runCmd('straighten')` (routing order only) |
| Isolate This Call, Isolate the Path Through This Call | [package.json:727](../package.json#L727), [commands.ts:254](../src/host/commands.ts#L254) | forwarded: `runCmd('callSubtree' | 'callPath')` |
| canvas: Save (.gaffy), Autosave Graphs, Save as Text (.txt, .md), Refresh Language Server | [package.json:462](../package.json#L462), [commands.ts:324](../src/host/commands.ts#L324) | host: save, setting, export, `refresh` |
| canvas: Group namespaces, Tight groups, Reset graph, Reset Layout, Re-arrange, Unlock all, Expand collapsed | [package.json:497](../package.json#L497), [commands.ts:241](../src/host/commands.ts#L241) | host `boxes`, `tight`; the rest forwarded to `runCmd` (the Options Arrange entries) |

Outside the view:

| event | code | calls |
|---|---|---|
| editor: gaffy> Call Hierarchy (up, dn); explorer: Call Hierarchies | [commands.ts:181](../src/host/commands.ts#L181), [commands.ts:194](../src/host/commands.ts#L194) | `createView`: a new view |
| editor: gaffy> Add to Call Graph | [commands.ts:184](../src/host/commands.ts#L184) | seed added, `Session.refresh` |
| VS Code undo, redo; an edit of the .gaffy text | [editor.ts:587](../src/host/editor.ts#L587) | the webview receives the text (`state`) and redraws |
| saving a source file; renaming a file | [extension.ts:58](../src/host/extension.ts#L58) | refresh of the views that show it |

## 2. Interpreters

| function | code | view fields written | what it does |
|---|---|---|---|
| `commit` | [main.ts:184](../src/webview/main.ts#L184) | any | clones the view, applies the change, redraws, posts the text to the host (an undo step) |
| `toggleSides` | [main.ts:737](../src/webview/main.ts#L737) | `open` | closes both sides, or opens every side with more |
| `setSide` | [main.ts:747](../src/webview/main.ts#L747) | `open`; `hidden`, `cut` (restore) | opens or closes one side; asks the host for data the side lacks; starts the offset handover (h34) |
| `markerClick` | [main.ts:780](../src/webview/main.ts#L780) | via `setSide`, `restoreHidden` | opens the side, else brings hidden neighbors back |
| `restoreHidden` | [main.ts:796](../src/webview/main.ts#L796) | `hidden`, `cut` | shows the hidden neighbors of one side and the hidden functions on their way from the seeds |
| `closingOf` | [main.ts:822](../src/webview/main.ts#L822) | via `setSide` | chooses the side an arrowhead closes |
| `isolateCalls`, `isolate`, `hide` | [main.ts:857](../src/webview/main.ts#L857) | `hidden` | keeps the given functions (and their path from the seeds); hides the rest, seeds excepted |
| `dragUnit` | [main.ts:1080](../src/webview/main.ts#L1080) | `offset` or `lock` | drop: cell delta, `settleDrop`, `moveUnit` per unit; anchor on a function that did not move |
| `topUnits` | [main.ts:1071](../src/webview/main.ts#L1071) | - | units a multi-selection drag moves: each selected function with its tree, once |
| `settleDrop` | [main.ts:1181](../src/webview/main.ts#L1181) | - | drop repulsion: tries cells along the drag, then sideways, ≤ 12 cells or 1.5 s |
| `moveUnit` | [main.ts:1133](../src/webview/main.ts#L1133) | `offset[unit]` or `lock[unit]` | adds the move to the lock when locked, else to the offset |
| `lockUnit`, `unlockUnit` | [main.ts:1204](../src/webview/main.ts#L1204) | `lock`, `offset` | lock: the anchor cell becomes absolute; unlock: the offset from the computed place |
| `moveSibling` | [main.ts:1449](../src/webview/main.ts#L1449) | `sibling` | swaps the focused function with its neighbor under one tree parent |
| `collapseInnermost` | [main.ts:1461](../src/webview/main.ts#L1461) | `collapsed` | collapses the innermost container not collapsed yet |
| `setArrange`, `setDepth` | [main.ts:1552](../src/webview/main.ts#L1552) | `arrange`, `open`, `depthUp`, `depthDown` | switches one layer at a time ⇄ full, keeping what is on screen; call depths per side |
| `runCmd` | [main.ts:1249](../src/webview/main.ts#L1249) | per case | command dispatch: the cases below |
| `runCmd: 'remove'` | [main.ts:1311](../src/webview/main.ts#L1311) | `cut` or `hidden` | cuts selected calls (one layer at a time), else hides the selection |
| `runCmd: 'showAll'` | [main.ts:1297](../src/webview/main.ts#L1297) | `hidden`, `cut`, `collapsed` | shows everything hidden, removed or collapsed |
| `runCmd: 'resetView'` | [main.ts:1274](../src/webview/main.ts#L1274) | most fields | back to the seeds: no hidden, collapsed, moves, locks, grouping |
| `runCmd: 'resetLayout'` | [main.ts:1296](../src/webview/main.ts#L1296) | `offset`, `lock`, `sibling`, `straight` | every computed place again |
| `runCmd: 'rearrangeSelection'`, `'rearrange'` | [main.ts:1375](../src/webview/main.ts#L1375) | `offset`, `lock` | the selected units (or all unlocked) back to their computed place |
| `runCmd: 'makeSeed'`, `'removeSeed'` | [main.ts:1364](../src/webview/main.ts#L1364) | `seeds` | adds or drops a seed; the host asks for the new seed's sides |
| `runCmd: 'expandAll'` | [main.ts:1386](../src/webview/main.ts#L1386) | `collapsed` | expands every collapsed container |
| `dropMovesWithin` | [viewdoc.ts:31](../src/core/viewdoc.ts#L31) | `offset`, `lock` | drops the moves and locks inside a container whose grouping changes (group, ungroup, reset grouping) |
| `afterRender`: adopt | [main.ts:655](../src/webview/main.ts#L655) | `offset` | offset handover: the new tree parent of a moved function takes its offset (h34) |
| `afterRender`: settle | [main.ts:666](../src/webview/main.ts#L666) | `offset` | saves the offsets settle drew with, ≤ 3 saves in a row (h35) |
| `anchorAt`, `render` | [main.ts:732](../src/webview/main.ts#L732) | - | no view change: pans so the function acted on keeps its screen spot (h30, h31) |
| host `Session.update`, `write` | [editor.ts:102](../src/host/editor.ts#L102) | any | replaces the document text (host commands, language server data) |
| host `collapse`, `expandContainer`, `move`, group commands | [commands.ts:367](../src/host/commands.ts#L367) | `collapsed`, `sibling`, `group`, `ungroup` | context menu changes made on the host |
| host `Session.revalidate`, `expand`, `ask` | [editor.ts:436](../src/host/editor.ts#L436) | `graph`, `explored` | new calls from the language server: new functions appear where their sides are open |

## 3. Layout

In pipeline order; positions depend on the view document only.

| function | code | what it does | rules |
|---|---|---|---|
| `buildScene` | [scene.ts:106](../src/core/scene.ts#L106) | the pipeline below, run on every redraw |  |
| `excludedKeys`, `quotient` | [scene.ts:94](../src/core/scene.ts#L94) | drops excluded and hidden functions; a collapsed container stands for its members |  |
| `revealView` → `reveal` / `revealDepth` | [scene.ts:317](../src/core/scene.ts#L317) | what is on screen: open sides (one layer at a time) or call depths (full) | [h01](heuristics.md#h01_first_revealer), [h02](heuristics.md#h02_call_depth_by_path) |
| `seedsIn` | [scene.ts:286](../src/core/scene.ts#L286) | the vertex standing for each seed (itself or its collapsed container) |  |
| `boxTree` | [boxes.ts:45](../src/core/boxes.ts#L45) | namespace boxes and their order | [h03](heuristics.md#h03_box_order) |
| `sortKeyOf` | [scene.ts:78](../src/core/scene.ts#L78) | tie order: path, definition line, key | [h04](heuristics.md#h04_sort_key) |
| `layout` | [layout.ts:78](../src/core/layout.ts#L78) | rows and lanes in one block: root order, child order, tree parent, ports, lanes | [h06](heuristics.md#h06_root_order)–[h12](heuristics.md#h12_lane_packing) |
| `place` → `placeBox` | [place.ts:242](../src/core/place.ts#L242) | items of a box (its block, then child boxes): order, column, row; unmoved boxes descend below earlier siblings | [h16](heuristics.md#h16_item_order)–[h20](heuristics.md#h20_unmoved_box_descent) |
| `placeBlock` | [place.ts:100](../src/core/place.ts#L100) | one block: caller alignment, monotone rows, descent, offsets and locks per vertex | [h13](heuristics.md#h13_caller_alignment)–[h15](heuristics.md#h15_block_descent), [h21](heuristics.md#h21_moved_function_descent) |
| frames | [place.ts:361](../src/core/place.ts#L361) | frame extents (tight or keeping the computed corner) | [h22](heuristics.md#h22_frame_extent) |
| `settleMoved` | [settle.ts:47](../src/core/settle.ts#L47) | moved units on other content go to the nearest clear offset, least displacement first, ≤ 3 rounds | [h23](heuristics.md#h23_settle) |
| `buildGrid` | [grid.ts:107](../src/core/grid.ts#L107) | draws the calls (section 4) | [h24](heuristics.md#h24_tree_lines_first)–[h29](heuristics.md#h29_route_cost) |

## 4. Drawing one call

<pre>
call u → v in the data (graph.edges)
├── u or v in an excluded folder, external, standard library ──────────► not drawn, no marker         <a href="../src/core/scene.ts#L94">scene.ts:94</a>
├── u or v hidden, or the call cut (removed) ──────────────────────────► not drawn; <code>>></code> or <code>└─>></code> on the end shown   <a href="../src/core/scene.ts#L51">scene.ts:51</a>
├── u and v in one collapsed container ─────────────────────────────────► counted on the container (tooltip: internal calls)   <a href="../src/core/quotient.ts#L47">quotient.ts:47</a>
├── u or v in a collapsed container ────────────────────────────────────► drawn from or to the container's vertex
├── an end not revealed (side closed, past the call depth) ─────────────► not drawn; marker on the end shown   <a href="../src/core/reveal.ts#L44">reveal.ts:44</a>
├── u = v, or v above u in the same chain of one block ─────────────────► <code>↻</code>, <code>↻ v()</code> after u's label, no line   <a href="../src/core/layout.ts#L220">layout.ts:220</a>
└── both ends placed
    ├── u is v's tree parent, one block, one shift ─────────────────────► tree elbow <code>└─></code> (net t:u)   <a href="../src/core/grid.ts#L264">grid.ts:264</a>
    ├── v takes calls through a lane (joint rule, callers in the block)
    │   ├── every source and v share one shift, the lane column clear ──► lane <code>┌──┘ └─></code> or <code>&lt;──┘</code> (net l:v)   <a href="../src/core/grid.ts#L265">grid.ts:265</a>
    │   └── otherwise ────────────────────────────────────────────────► routed
    └── routed (A*), in order: straightened, level (shortest first), the rest (longest first)   <a href="../src/core/grid.ts#L327">grid.ts:327</a>
        ├── arrival side, decided per callee before routing   <a href="../src/core/grid.ts#L349">grid.ts:349</a>
        │   ├── v's lane already enters from the left ────────────────► left <code>──> v()</code>
        │   ├── v sends calls from its label end ──────────────────────► left
        │   ├── callers mostly left of v, two cells before v free ─────► left
        │   └── otherwise ────────────────────────────────────────────► right end <code>v() <──</code>
        ├── departure   <a href="../src/core/grid.ts#L446">grid.ts:446</a>
        │   ├── u's label end (cost 0), unless u receives at its end
        │   ├── under or over u's first character (cost 2), when free
        │   └── no start free ────────────────────────────────────────► dashed fallback
        └── search: (cell, heading) states, step 1, bend +3, crossing +6, frame border +4, own line 0.3   <a href="../src/core/grid.ts#L466">grid.ts:466</a>
            ├── pass 1 strict: no running along or turning on another line ► drawn
            ├── pass 2 relaxed: those at +400 and +40 ────────────────► drawn
            └── no route in 400 000 steps ────────────────────────────► dashed fallback L with its arrowhead   <a href="../src/core/grid.ts#L435">grid.ts:435</a>
</pre>

Nets: `t:<parent>` holds a tree stem and its elbows, `l:<target>` every call into one function (lanes, routes, the arrival). Calls into one function merge into one trunk (cost 0.3 on its own net).

## 5. Dragging a function or a group

Three mechanisms move the rest of the picture after a drop, in this order: placement (positions from the stored moves), settle (moved units that collide go to the nearest clear place) and the pan (the still function keeps its spot on screen). Content never moved is not relocated to make room, except that an unmoved group slides below an earlier sibling that is locked or stretched by moves inside it.

<pre>
drop: pointer delta in whole cells; zero cells: nothing   <a href="../src/webview/main.ts#L1116">main.ts:1116</a>
├── 1. units: a group is its box (selection ignored); a function is itself with its tree below, or every selected
│      function with its tree, once each, when one of several selected is dragged   <a href="../src/webview/main.ts#L1091">main.ts:1091</a>
├── 2. drop spot: as dropped when no call loses its route and the dropped labels collide with nothing; else the
│      nearest such spot up to 12 cells along the drag or sideways (1.5 s); else as dropped   <a href="../src/webview/main.ts#L1181">main.ts:1181</a>
├── 3. stored: a locked unit moves its lock, any other its offset   <a href="../src/webview/main.ts#L1133">main.ts:1133</a>
├── 4. placement: what was not moved keeps its computed place
│   ├── a moved function lands at its computed place + offset, with its tree   <a href="../src/core/place.ts#L170">place.ts:170</a>
│   │   └── labels within 2 cells of another label of its group on the row ─────► slides down until clear   <a href="../src/core/place.ts#L195">place.ts:195</a>
│   ├── a moved group: placed as unmoved, then translated whole by its offset; a locked one onto its cell   <a href="../src/core/place.ts#L318">place.ts:318</a>
│   ├── a sibling placed later (order: locked first, then calling order)   <a href="../src/core/place.ts#L272">place.ts:272</a>
│   │   ├── after a group moved by an offset: counts it at its unmoved place ───► stays   <a href="../src/core/place.ts#L307">place.ts:307</a>
│   │   └── after a locked group, or one stretched by moves inside it ─────────► slides below it   <a href="../src/core/place.ts#L344">place.ts:344</a>
│   ├── frames grow to hold moved content (Tight groups: fit it on all sides) ────► later siblings of the
│   │   enclosing group may slide below it   <a href="../src/core/place.ts#L361">place.ts:361</a>
│   └── content above row 0 or left of column 0 ──────────────────────────────► whole picture shifts back   <a href="../src/core/place.ts#L405">place.ts:405</a>
├── 5. settle, up to 3 rounds in every redraw: moved, unlocked units that collide (on content, or a frame
│      touching another frame with no free row or column between) move to the nearest clear offset, the least
│      displacement (distance × labels) first; unmoved and locked units never move here   <a href="../src/core/settle.ts#L47">settle.ts:47</a>
└── 6. the view saves the settled offsets (at most 3 saves in a row) and pans so the still function keeps its spot   <a href="../src/webview/main.ts#L645">main.ts:645</a>
</pre>

| condition | code | effect |
|---|---|---|
| which units move | [main.ts:1091](../src/webview/main.ts#L1091) | a box header moves `box:<key>`; a label its unit (`vertexUnit`, `collapsed:<key>` for a collapsed container), or `topUnits` of the selection |
| units of a selection | [main.ts:1071](../src/webview/main.ts#L1071) | each selected function with its tree, skipping one inside another selected function's tree |
| still function | [main.ts:1122](../src/webview/main.ts#L1122) | the first seed, else any function, outside what moves; none: the drop is a pan of everything |
| drop accepted | [main.ts:1194](../src/webview/main.ts#L1194) | a probe redraw: no more unroutable calls, `collisions` of the dropped labels and frames zero; each probe settles (step 5), so the first spot usually passes |
| drop search | [main.ts:1196](../src/webview/main.ts#L1196) | k cells further along the drag, then sideways either way, then back; k ≤ 12 |
| lock or offset | [main.ts:1133](../src/webview/main.ts#L1133) | `lock[unit]` when locked, else `offset[unit]` += (Δcolumn, Δrow) |
| function offset | [place.ts:170](../src/core/place.ts#L170) | the shift of a function: its lock, else its parent's shift + its offset; the tree below inherits it |
| moved function descent | [place.ts:195](../src/core/place.ts#L195) | labels on one row closer than 2 cells to another label of the group: down one row, at most 500 |
| sibling order | [place.ts:272](../src/core/place.ts#L272) | locked items first, then the topological order of calls between items; "earlier" in the rows below |
| stacking | [place.ts:297](../src/core/place.ts#L297) | rows and columns of later siblings from earlier siblings' unmoved extents |
| what later items avoid | [place.ts:307](../src/core/place.ts#L307) | an earlier box moved by an offset at its unmoved place; a locked box, or one stretched by moves inside it, where drawn |
| unmoved block descent | [place.ts:145](../src/core/place.ts#L145) | the functions of a group slide below what they avoid |
| moved group | [place.ts:318](../src/core/place.ts#L318) | placed at the row it would take unmoved, then translated whole (labels, lanes, inner frames) by the offset |
| unmoved group descent | [place.ts:344](../src/core/place.ts#L344) | trial placement, then below the overlapped earlier sibling, by the distance from its top |
| frame extent | [place.ts:361](../src/core/place.ts#L361) | Tight groups: the content's bounding box; otherwise the computed corner, growing to hold content moved up or left |
| picture origin | [place.ts:405](../src/core/place.ts#L405) | everything shifts so nothing lies above row 0 or left of column 0; the pan cancels it on screen |
| settle rounds | [scene.ts:207](../src/core/scene.ts#L207) | at most 3 rounds of settle per redraw |
| settle candidates | [settle.ts:52](../src/core/settle.ts#L52) | units with an offset, unlocked, on screen |
| collision | [settle.ts:59](../src/core/settle.ts#L59) | a label on another frame's border; closer than 4 cells to a label of its row; another label inside its frame; its frame partly over another |
| clear offset | [settle.ts:75](../src/core/settle.ts#L75) | rings of up to 12 cells (vertical first), then straight lines up to 80; never off the canvas |
| who moves first | [settle.ts:96](../src/core/settle.ts#L96) | distance × labels moved: a small unit yields to a large one |
| save and pan | [main.ts:645](../src/webview/main.ts#L645) | the settled offsets become the view's offsets (at most 3 saves in a row); render pans to the still function |

Consequences:
- A group dropped onto unmoved content: the content stays; when the dropped group collides, settle moves it, or another moved unit when that displaces fewer labels.
- A group dropped onto something moved earlier: settle moves whichever of the two displaces fewer labels.
- A function dragged far down or right: its group's frame stretches to hold it, and later siblings of that group in the same parent slide below the stretched frame; the remaining source of large vertical moves.
- Drop repulsion (step 2) seldom changes the drop: each probe redraw settles already, so the dropped spot tests clear.

## Trace

Setting `gaffy.trace` records every view change to `.baggy/gaffy/trace/<view>.jsonl` ([trace.ts:26](../src/host/trace.ts#L26)): the event, its target and grid cell, the functions above that acted, the view fields changed, the labels and boxes that moved; undo and redo included. `node tools/gaffy-trace.mjs <file>` prints it as a list ([tools/gaffy-trace.mjs](../tools/gaffy-trace.mjs)).
