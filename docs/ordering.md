# gaffy node order: triggers, interpreters, layout

Taxonomy of graph layout ordering functions. Drawing decision tree per call.

1. **Triggers**: user actions in the webview (mouse, keys, toolbar, Options), the context menu, and events outside the view.
2. **Interpreters**: functions that turn a trigger into a change of the view document (`ViewDoc.view`) and commit it; each commit is one undo step.
3. **Layout**: functions that compute positions from a view document, on every redraw; the same document gives the same picture.

Terms: [terms.md](terms.md).


## 1. Triggers

Canvas (mouse):

| trigger | code | calls |
|---|---|---|
| double click a label (one layer at a time) | [main.ts:618](../src/webview/main.ts#L618) | `toggleSides`; on a collapsed container: expand (`collapsed` filter, `anchorAt`) |
| drag a label | [main.ts:625](../src/webview/main.ts#L625) | `dragUnit` (unit: the function, `collapsed:<key>` for a collapsed one, or the selection) |
| click `>> ` before a label | [main.ts:599](../src/webview/main.ts#L599) | `markerClick(key, 'up')` |
| click `>` of a `└─>>` row | [main.ts:633](../src/webview/main.ts#L633) | `markerClick(key, side)` |
| click the branch of a `└─>>` row | [main.ts:545](../src/webview/main.ts#L545) | `markerClick(caller, 'down')` |
| click an arrowhead | [main.ts:579](../src/webview/main.ts#L579) | `closingOf(...).run` → `setSide(..., false)`: closes the level it points into |
| double click a call | [main.ts:558](../src/webview/main.ts#L558) | `isolateCalls` (the selection holding the call, else the calls through the cell) |
| double click a group header | [main.ts:657](../src/webview/main.ts#L657) | collapse the group (`collapsed` push) |
| drag a group header | [main.ts:662](../src/webview/main.ts#L662) | `dragUnit` (unit `box:<key>`) |
| wheel, drag the background | [main.ts:99](../src/webview/main.ts#L99) | zoom and pan only: no view change |

Keys (focused function `k`):

| key | code | calls |
|---|---|---|
| Alt+↑, Alt+↓ | [main.ts:1532](../src/webview/main.ts#L1532) | `moveSibling(±1)` |
| e, Space | [main.ts:1540](../src/webview/main.ts#L1540) | `setSide(k, side, true)` for each side with more |
| ←, c | [main.ts:1541](../src/webview/main.ts#L1541) | `collapseInnermost` |
| → | [main.ts:1542](../src/webview/main.ts#L1542) | expand the focused collapsed container |
| Delete, Backspace | [main.ts:1543](../src/webview/main.ts#L1543) | `runCmd('remove')` |
| h | [main.ts:1544](../src/webview/main.ts#L1544) | `runCmd('hideSelection')` |
| a | [main.ts:1545](../src/webview/main.ts#L1545) | `runCmd('rearrangeSelection')` with a selection, else `runCmd('rearrange')` |
| i | [main.ts:1546](../src/webview/main.ts#L1546) | `runCmd('isolateSelection')` |
| Escape | [main.ts:1547](../src/webview/main.ts#L1547) | clear the selection, else `runCmd('showAll')` |
| k | [main.ts:1553](../src/webview/main.ts#L1553) | `runCmd('lock' | 'unlock')` on the focused unit |
| u | [main.ts:1554](../src/webview/main.ts#L1554) | `hidden = []` |
| b | [main.ts:1556](../src/webview/main.ts#L1556) | `boxes` toggled |
| r | [main.ts:1557](../src/webview/main.ts#L1557) | host `refresh`: new data from the language server |

Toolbar and Options:

| entry | code | calls |
|---|---|---|
| call depth `all` `+` `−` (full layout) | [main.ts:1721](../src/webview/main.ts#L1721) | `setDepth(side, ...)` |
| **Show all (n)** | [main.ts:1731](../src/webview/main.ts#L1731) | `runCmd('showAll')` |
| **Switch expand mode to >>**, **Switch expand mode to -+** | [main.ts:1741](../src/webview/main.ts#L1741) | `setArrange('auto' | 'grow')`: switches to the mode it names |
| **Isolate** | [main.ts:1732](../src/webview/main.ts#L1732) | `runCmd('isolateSelection')` |
| Options > Call Expansion: Individual On Graph, Global Toolbar | [main.ts:1747](../src/webview/main.ts#L1747) | `setArrange('grow' | 'auto')` |
| Options > Call Expansion > Paths between seeds only | [main.ts:1751](../src/webview/main.ts#L1751) | `between`: full view, drawn functions filtered to seed-to-seed call paths (`onPaths`); one layer at a time, the reveal is the paths of the whole graph (`revealPaths`); off: the paths become `pinned`, every side closed (`toggleBetween`) |
| marker click, one layer at a time with Paths between seeds only | [main.ts:829](../src/webview/main.ts#L829) | refused, status line: the side leads to no other seed |
| Options > Arrange > Layout debug (gaffy.debugLayout) | [main.ts:1790](../src/webview/main.ts#L1790) | debugging panel (dbgpanel.ts): Rules (switches, alternatives, parameters written to `view.rules`, saved with the graph), Actions (running log of moves and the decisions behind them), Edges (routing record per call); Why Here? reads `decisions` (explain.ts) |
| Options > Call depth by: shortest, longest path | [main.ts:1757](../src/webview/main.ts#L1757) | `depthRule` |
| Options > Grouping > by Namespace | [main.ts:1761](../src/webview/main.ts#L1761) | `boxes` |
| Options > Grouping > Tight | [main.ts:1763](../src/webview/main.ts#L1763) | `tight` |
| Options > Grouping > Reset grouping | [main.ts:1765](../src/webview/main.ts#L1765) | `group`, `ungroup` = [], `dropMovesWithin` for each |
| Options > Parenting: first caller found, nearest caller above, left merge | [main.ts:1769](../src/webview/main.ts#L1769) | `parentRule` |
| Options > Arrange > Reset graph: seeds, depth, direction | [main.ts:1781](../src/webview/main.ts#L1781) | `runCmd('resetView')` |
| Options > Arrange > Reset Layout: moves, locks, order | [main.ts:1784](../src/webview/main.ts#L1784) | `runCmd('resetLayout')` |
| Options > Arrange > Re-arrange | [main.ts:1785](../src/webview/main.ts#L1785) | `runCmd('rearrangeSelection' | 'rearrange')` |
| Options > Arrange > Unlock all | [main.ts:1788](../src/webview/main.ts#L1788) | `runCmd('unlockAll')` |
| Options > Arrange > Expand collapsed | [main.ts:1789](../src/webview/main.ts#L1789) | `runCmd('expandAll')` |
| Options > Folders > Include external code, Include standard library | [main.ts:1803](../src/webview/main.ts#L1803) | host setting; the webview redraws; their folders leave the list when off |
| Options > Folders > a folder | [main.ts:1808](../src/webview/main.ts#L1808) | `exclude`, `include` |
| Options > File > Save (.gaffy), Autosave Graphs, Save as Text, Refresh Language Server | [main.ts:1821](../src/webview/main.ts#L1821) | host: save, setting `gaffy.autoSave` (command `gaffy.toggleAutoSave`, as the canvas menu), export, `refresh` (new data) |
| Options > File > Frozen; toolbar Unfreeze | [main.ts:1825](../src/webview/main.ts#L1825) | host `hold`: Unfreeze writes `live` (this opening) and the Options values into the view; Freeze removes `live`. A view holding a graph opens frozen |

Context menu (`webview/context` entry, host registration; *forwarded* entries post `cmd` to the webview):

| entry | code | calls |
|---|---|---|
| Make Seed, Remove Seed | [package.json:597](../package.json#L597), [commands.ts:409](../src/host/commands.ts#L409) | forwarded: `runCmd('makeSeed' | 'removeSeed')` |
| Open Callers / Open Called / Close Callers / Close Called (one layer) | [package.json:577](../package.json#L577), [commands.ts:262](../src/host/commands.ts#L262) | forwarded: `runCmd('openUp' ...)` → `setSide` |
| Isolate Selection, Hide Selection | [package.json:632](../package.json#L632), [commands.ts:286](../src/host/commands.ts#L286) | forwarded: `runCmd('isolateSelection' | 'hideSelection')` (the selection, else the function right clicked; seeds stay) |
| Show Hidden Neighbors... | [package.json:642](../package.json#L642), [commands.ts:281](../src/host/commands.ts#L281) | host quick pick: `hidden` minus the picked |
| Collapse Class / Module / Package | [package.json:647](../package.json#L647), [commands.ts:387](../src/host/commands.ts#L387) | host `collapse(kinds)`: `collapsed` push |
| Expand Container | [package.json:662](../package.json#L662), [commands.ts:406](../src/host/commands.ts#L406) | host: `collapsed` filter |
| Group Module, Ungroup Module, Group Submodules | [package.json:667](../package.json#L667), [commands.ts:391](../src/host/commands.ts#L391) | host: `group`, `ungroup`; `dropMovesWithin` the container |
| Re-arrange selected | [package.json:527](../package.json#L527), [commands.ts:287](../src/host/commands.ts#L287) | forwarded: `runCmd('rearrangeSelection')` |
| Lock Position, Unlock Position | [package.json:687](../package.json#L687), [commands.ts:278](../src/host/commands.ts#L278) | forwarded: `runCmd('lock' | 'unlock')` |
| Move Up One, Move Down One | [package.json:702](../package.json#L702), [commands.ts:427](../src/host/commands.ts#L427) | host `move(±1)`: `sibling` |
| Tag... | [package.json:712](../package.json#L712), [commands.ts:411](../src/host/commands.ts#L411) | host: `tags` (a longer label widens its column) |
| Straighten This Call | [package.json:717](../package.json#L717), [commands.ts:266](../src/host/commands.ts#L266) | forwarded: `runCmd('straighten')` (search order only) |
| Isolate This Call, Isolate the Path Through This Call | [package.json:722](../package.json#L722), [commands.ts:267](../src/host/commands.ts#L267) | forwarded: `runCmd('callSubtree' | 'callPath')` |
| canvas: Save (.gaffy), Autosave Graphs, Save as Text (.txt, .md), Refresh Language Server | [package.json:457](../package.json#L457), [commands.ts:337](../src/host/commands.ts#L337) | host: save, setting, export, `refresh` |
| canvas: Group namespaces, Tight groups, Reset graph, Reset Layout, Re-arrange, Unlock all, Expand collapsed | [package.json:492](../package.json#L492), [commands.ts:254](../src/host/commands.ts#L254) | host `boxes`, `tight`; the rest forwarded to `runCmd` (the Options Arrange entries) |

Outside the view:

| event | code | calls |
|---|---|---|
| editor: gaffy> Call Hierarchy (up, dn); explorer: Call Hierarchies | [commands.ts:196](../src/host/commands.ts#L196), [commands.ts:207](../src/host/commands.ts#L207) | `createView`: a new view |
| editor: gaffy> Add to Call Graph | [commands.ts:199](../src/host/commands.ts#L199) | seed added and joined (`view.joins`: closed, drawn with its call paths to the other seeds), `Session.refresh`, `Session.pathData` |
| VS Code undo, redo; an edit of the .gaffy text | [editor.ts:639](../src/host/editor.ts#L639) | the webview receives the text (`state`) and redraws |
| saving a source file; renaming a file | [extension.ts:58](../src/host/extension.ts#L58) | refresh of the views that show it |

## 2. Interpreters

| function | code | view fields written | what it does |
|---|---|---|---|
| `commit` | [main.ts:197](../src/webview/main.ts#L197) | any | clones the view, applies the change, redraws, posts the text to the host (an undo step) |
| `toggleSides` | [main.ts:782](../src/webview/main.ts#L782) | `open` | closes both sides, or opens every side with more |
| `setSide` | [main.ts:792](../src/webview/main.ts#L792) | `open`; `hidden`, `cut` (restore) | opens or closes one side; asks the host for data the side lacks; starts the move handover (h34) |
| `markerClick` | [main.ts:825](../src/webview/main.ts#L825) | via `setSide`, `restoreHidden` | opens the side, else brings hidden neighbors back |
| `restoreHidden` | [main.ts:841](../src/webview/main.ts#L841) | `hidden`, `cut` | shows the hidden neighbors of one side and the hidden functions on their way from the seeds |
| `closingOf` | [main.ts:867](../src/webview/main.ts#L867) | via `setSide` | chooses the side an arrowhead closes |
| `isolateCalls`, `isolate`, `hide` | [main.ts:902](../src/webview/main.ts#L902) | `hidden` | keeps the given functions (and their path from the seeds); hides the rest, seeds excepted |
| `dragUnit` | [main.ts:1128](../src/webview/main.ts#L1128) | `offset` or `lock` | drop: cell delta, `settleDrop`, `moveUnit` per unit; anchor on a function that did not move |
| `topUnits` | [main.ts:1119](../src/webview/main.ts#L1119) | - | units a multi-selection drag moves: each selected function with its tree, once |
| `settleDrop` | [main.ts:1229](../src/webview/main.ts#L1229) | - | drop repulsion: tries cells along the drag, then sideways, ≤ 12 cells or 1.5 s |
| `moveUnit` | [main.ts:1181](../src/webview/main.ts#L1181) | `offset[unit]` or `lock[unit]` | adds the move to the lock when locked, else to the stored move (`offset`) |
| `lockUnit`, `unlockUnit` | [main.ts:1253](../src/webview/main.ts#L1253) | `lock`, `offset` | lock: the anchor cell becomes absolute; unlock: the move from the computed place |
| `moveSibling` | [main.ts:1508](../src/webview/main.ts#L1508) | `sibling` | swaps the focused function with its neighbor under one tree parent |
| `collapseInnermost` | [main.ts:1520](../src/webview/main.ts#L1520) | `collapsed` | collapses the innermost container not collapsed yet |
| `setArrange`, `setDepth` | [main.ts:1612](../src/webview/main.ts#L1612) | `arrange`, `open`, `depthUp`, `depthDown` | switches one layer at a time ⇄ full, keeping what is on screen; call depths per side |
| `runCmd` | [main.ts:1298](../src/webview/main.ts#L1298) | per case | command dispatch: the cases below |
| `runCmd: 'remove'` | [main.ts:1360](../src/webview/main.ts#L1360) | `cut` or `hidden` | cuts selected calls (one layer at a time), else hides the selection |
| `runCmd: 'showAll'` | [main.ts:1346](../src/webview/main.ts#L1346) | `hidden`, `cut`, `collapsed` | shows everything hidden, removed or collapsed |
| `runCmd: 'resetView'` | [main.ts:1323](../src/webview/main.ts#L1323) | most fields | back to the seeds: no hidden, collapsed, moves, locks, grouping |
| `runCmd: 'resetLayout'` | [main.ts:1345](../src/webview/main.ts#L1345) | `offset`, `lock`, `sibling`, `straight` | every computed place again |
| `runCmd: 'rearrangeSelection'`, `'rearrange'` | [main.ts:1434](../src/webview/main.ts#L1434) | `offset`, `lock` | the selected units (or all unlocked) back to their computed place |
| `runCmd: 'makeSeed'`, `'removeSeed'` | [main.ts:1413](../src/webview/main.ts#L1413) | `seeds`, `joins` | adds a joined seed (`joins`: closed, its call paths to the other seeds drawn) or drops a seed; the host asks along both directions to the view's depth |
| `runCmd: 'expandAll'` | [main.ts:1445](../src/webview/main.ts#L1445) | `collapsed` | expands every collapsed container |
| `dropMovesWithin` | [viewdoc.ts:33](../src/core/viewdoc.ts#L33) | `offset`, `lock` | drops the moves and locks inside a container whose grouping changes (group, ungroup, reset grouping) |
| `afterRender`: adopt | [main.ts:700](../src/webview/main.ts#L700) | `offset` | move handover: the new parent of a moved function takes its move (h34) |
| `afterRender`: settle | [main.ts:711](../src/webview/main.ts#L711) | `offset` | saves the moves settle drew with, ≤ 3 saves in a row (h35) |
| `anchorAt`, `render` | [main.ts:777](../src/webview/main.ts#L777) | - | no view change: pans so the function acted on keeps its screen spot (h30, h31) |
| host `Session.update`, `write` | [editor.ts:123](../src/host/editor.ts#L123) | any | replaces the document text (host commands, language server data) |
| host `collapse`, `expandContainer`, `move`, group commands | [commands.ts:382](../src/host/commands.ts#L382) | `collapsed`, `sibling`, `group`, `ungroup` | context menu changes made on the host |
| host `Session.revalidate`, `expand`, `ask` | [editor.ts:486](../src/host/editor.ts#L486) | `graph`, `explored` | new calls from the language server: new functions appear where their sides are open |

## 3. Layout

In pipeline order; positions depend on the view document only.

| function | code | what it does | rules |
|---|---|---|---|
| `buildScene` | [scene.ts:121](../src/core/scene.ts#L121) | the pipeline below, run on every redraw |  |
| `excludedKeys`, `quotient` | [scene.ts:104](../src/core/scene.ts#L104) | drops excluded and hidden functions; a collapsed container stands for its members |  |
| `revealView` → `reveal` / `revealDepth` | [scene.ts:385](../src/core/scene.ts#L385) | what is on screen: open sides (one layer at a time) or call depths (full) | [h01](heuristics.md#h01_first_revealer), [h02](heuristics.md#h02_call_depth_by_path) |
| `seedsIn` | [scene.ts:350](../src/core/scene.ts#L350) | the function standing for each seed (itself or its collapsed group) |  |
| `boxTree` | [boxes.ts:45](../src/core/boxes.ts#L45) | groups and their order | [h03](heuristics.md#h03_box_order) |
| `sortKeyOf` | [scene.ts:88](../src/core/scene.ts#L88) | tie order: path, definition line, key | [h04](heuristics.md#h04_sort_key) |
| `layout` | [layout.ts:80](../src/core/layout.ts#L80) | rows of one block: root order, child order, parents, exit rows, trunk columns | [h06](heuristics.md#h06_root_order)–[h12](heuristics.md#h12_lane_packing) |
| `place` → `placeBox` | [place.ts:277](../src/core/place.ts#L277) | the block and subgroups of a group: order, column, row; unmoved groups slide below earlier ones | [h16](heuristics.md#h16_item_order)–[h20](heuristics.md#h20_unmoved_box_descent) |
| `placeBlock` | [place.ts:123](../src/core/place.ts#L123) | one block: caller alignment, rows only down, descent, moves and locks per function | [h13](heuristics.md#h13_caller_alignment)–[h15](heuristics.md#h15_block_descent), [h21](heuristics.md#h21_moved_function_descent) |
| frames | [place.ts:452](../src/core/place.ts#L452) | frame extents (tight or keeping the computed corner) | [h22](heuristics.md#h22_frame_extent) |
| `settleMoved` | [settle.ts:47](../src/core/settle.ts#L47) | moved units on other content go to the nearest clear spot, least displacement first, ≤ 3 rounds | [h23](heuristics.md#h23_settle) |
| `buildGrid` | [grid.ts:132](../src/core/grid.ts#L132) | draws the calls (section 4) | [h24](heuristics.md#h24_tree_lines_first)–[h29](heuristics.md#h29_route_cost) |

## 4. Drawing one call

<pre>
call u → v in the data (graph.edges)
├── u or v in an excluded folder, external, standard library ──────────► not drawn, no marker         <a href="../src/core/scene.ts#L104">scene.ts:104</a>
├── u or v hidden, or the call cut (removed) ──────────────────────────► not drawn; <code>>></code> or <code>└─>></code> on the end shown   <a href="../src/core/scene.ts#L52">scene.ts:52</a>
├── u and v in one collapsed container ─────────────────────────────────► counted on the container (tooltip: internal calls)   <a href="../src/core/quotient.ts#L47">quotient.ts:47</a>
├── u or v in a collapsed container ────────────────────────────────────► drawn from or to the collapsed group
├── an end not revealed (side closed, past the call depth) ─────────────► not drawn; marker on the end shown   <a href="../src/core/reveal.ts#L44">reveal.ts:44</a>
├── u = v, or v above u in the same chain of one block ─────────────────► <code>↻</code>, <code>↻ v()</code> after u's label, no line   <a href="../src/core/layout.ts#L224">layout.ts:224</a>
└── both ends placed
    ├── u is v's parent, one block, one shift ──────────────────────────► branch <code>└─></code> on u's stem (net t:u)   <a href="../src/core/grid.ts#L365">grid.ts:365</a>
    ├── v takes calls through a trunk (callers in the block)
    │   ├── every caller and v share one shift, the trunk column clear ─► trunk <code>┌──┘ └─></code> or <code>&lt;──┘</code> (net l:v)   <a href="../src/core/grid.ts#L366">grid.ts:366</a>
    │   └── otherwise ────────────────────────────────────────────────► path search
    └── path search (A*), in search order: straightened, then callers top to bottom (h25, row)   <a href="../src/core/grid.ts#L432">grid.ts:432</a>
        ├── arrival side, decided per called before path search   <a href="../src/core/grid.ts#L461">grid.ts:461</a>
        │   ├── v's trunk already enters from the left ───────────────► left <code>──> v()</code>
        │   ├── v sends calls from its label end ──────────────────────► left
        │   ├── callers mostly left of v, two cells before v free ─────► left
        │   └── otherwise ────────────────────────────────────────────► right end <code>v() <──</code>
        ├── departure   <a href="../src/core/grid.ts#L588">grid.ts:588</a>
        │   ├── u's label end (cost 0), unless u receives at its end
        │   ├── under or over u's first character (cost 2), when free
        │   └── no start free ────────────────────────────────────────► dashed fallback
        └── search: (cell, heading) states, step 1, bend +3, crossing +6, frame border +4, own line 0.3   <a href="../src/core/grid.ts#L610">grid.ts:610</a>
            ├── pass 1 strict: no running along or turning on another line ► drawn
            ├── pass 2 relaxed: those at +400 and +40 ────────────────► drawn
            └── no route in 400 000 steps ────────────────────────────► dashed fallback L with its arrowhead   <a href="../src/core/grid.ts#L576">grid.ts:576</a>
</pre>

Nets: `t:<parent>` holds a parent's stem and branches, `l:<target>` the trunk of one function: every call into it (trunk columns, searched paths, the arrival). Searched calls join the trunk of their called (cost `bundle`, 0.3).

## 5. Dragging a function or a group

Three mechanisms move the rest of the picture after a drop, in this order: placement (positions from the stored moves), settle (moved units that collide go to the nearest clear place) and the pan (the still function keeps its spot on screen). Content never moved is not relocated to make room, except that an unmoved group slides below an earlier sibling that is locked or stretched by moves inside it.

<pre>
drop: pointer delta in whole cells; zero cells: nothing   <a href="../src/webview/main.ts#L1164">main.ts:1164</a>
├── 1. units: a group with its content (selection ignored); a function with the functions hanging under it, or every selected
│      function with those under it, once each, when one of several selected is dragged   <a href="../src/webview/main.ts#L1139">main.ts:1139</a>
├── 2. drop spot: as dropped when no call loses its route and the dropped labels collide with nothing; else the
│      nearest such spot up to 12 cells along the drag or sideways (1.5 s); else as dropped   <a href="../src/webview/main.ts#L1229">main.ts:1229</a>
├── 3. stored: a locked unit moves its lock, any other its move   <a href="../src/webview/main.ts#L1181">main.ts:1181</a>
├── 4. placement: what was not moved keeps its computed place
│   ├── a moved function lands at its computed place + move, with the functions under it   <a href="../src/core/place.ts#L204">place.ts:204</a>
│   │   └── labels within 2 cells of another label of its group on the row ─────► slides down until clear   <a href="../src/core/place.ts#L230">place.ts:230</a>
│   ├── a moved group: placed as unmoved, then shifted whole by its move; a locked one onto its cell   <a href="../src/core/place.ts#L388">place.ts:388</a>
│   ├── a sibling placed later (order: locked first, then calling order)   <a href="../src/core/place.ts#L307">place.ts:307</a>
│   │   ├── after a group moved by a drag: counts it at its unmoved place ─────► stays   <a href="../src/core/place.ts#L376">place.ts:376</a>
│   │   └── after a locked group, or one stretched by moves inside it ─────────► slides below it   <a href="../src/core/place.ts#L431">place.ts:431</a>
│   ├── frames grow to hold moved content (Tight groups: fit it on all sides) ────► later siblings of the
│   │   enclosing group may slide below it   <a href="../src/core/place.ts#L452">place.ts:452</a>
│   └── blank margin, or content above row 0 or left of column 0 ──────────────► whole picture shifts to 0, 0   <a href="../src/core/place.ts#L536">place.ts:536</a>
├── 5. settle, up to 3 rounds in every redraw: moved, unlocked units that collide (on content, or a frame
│      touching another frame with no free row or column between) move to the nearest clear spot, the least
│      displacement (distance × labels) first; unmoved and locked units never move here   <a href="../src/core/settle.ts#L47">settle.ts:47</a>
└── 6. the view saves the settled moves (at most 3 saves in a row) and pans so the still function keeps its spot   <a href="../src/webview/main.ts#L690">main.ts:690</a>
</pre>

| condition | code | effect |
|---|---|---|
| which units move | [main.ts:1139](../src/webview/main.ts#L1139) | a group header moves `box:<key>`; a label its unit (`vertexUnit`, `collapsed:<key>` for a collapsed group), or `topUnits` of the selection |
| units of a selection | [main.ts:1119](../src/webview/main.ts#L1119) | each selected function with its tree, skipping one inside another selected function's tree |
| still function | [main.ts:1170](../src/webview/main.ts#L1170) | the first seed, else any function, outside what moves; none: the drop is a pan of everything |
| drop accepted | [main.ts:1243](../src/webview/main.ts#L1243) | a probe redraw: no more unroutable calls, `collisions` of the dropped labels and frames zero; each probe settles (step 5), so the first spot usually passes |
| drop search | [main.ts:1245](../src/webview/main.ts#L1245) | k cells further along the drag, then sideways either way, then back; k ≤ 12 |
| lock or move | [main.ts:1181](../src/webview/main.ts#L1181) | `lock[unit]` when locked, else `offset[unit]` += (Δcolumn, Δrow) |
| function move | [place.ts:204](../src/core/place.ts#L204) | the shift of a function: its lock, else its parent's shift + its move; the functions under it inherit it |
| moved function descent | [place.ts:230](../src/core/place.ts#L230) | labels on one row closer than 2 cells to another label of the group: down one row, at most 500 |
| sibling order | [place.ts:307](../src/core/place.ts#L307) | locked ones first, then the topological order of calls between the block and subgroups; "earlier" in the rows below |
| stacking | [place.ts:359](../src/core/place.ts#L359) | rows and columns of later siblings from earlier siblings' unmoved extents |
| what later groups avoid | [place.ts:376](../src/core/place.ts#L376) | an earlier group moved by a drag at its unmoved place; a locked group, or one stretched by moves inside it, where drawn |
| unmoved block descent | [place.ts:179](../src/core/place.ts#L179) | the functions of a group slide below what they avoid |
| moved group | [place.ts:388](../src/core/place.ts#L388) | placed at the row it would take unmoved, then shifted whole (labels, trunks, inner frames) by its move |
| unmoved group descent | [place.ts:431](../src/core/place.ts#L431) | trial placement, then below the overlapped earlier sibling, by the distance from its top |
| frame extent | [place.ts:452](../src/core/place.ts#L452) | Tight frames: the content's bounding box; otherwise the computed corner, growing to hold content moved up or left |
| picture origin | [place.ts:536](../src/core/place.ts#L536) | everything shifts so the content starts at row 0 and column 0 (with locks: only content above row 0 or left of column 0 shifts back); the pan cancels it on screen |
| settle rounds | [scene.ts:269](../src/core/scene.ts#L269) | at most 3 rounds of settle per redraw |
| settle candidates | [settle.ts:56](../src/core/settle.ts#L56) | units with a move, unlocked, on screen |
| collision | [settle.ts:63](../src/core/settle.ts#L63) | a label on another frame's border; closer than 4 cells to a label of its row; another label inside its frame; its frame partly over another |
| clear spot | [settle.ts:82](../src/core/settle.ts#L82) | rings of up to 12 cells (vertical first), then straight lines up to 80; never off the canvas |
| who moves first | [settle.ts:103](../src/core/settle.ts#L103) | distance × labels moved: a small unit yields to a large one |
| save and pan | [main.ts:690](../src/webview/main.ts#L690) | the settled moves become the view's moves (at most 3 saves in a row); render pans to the still function |

Consequences:
- A group dropped onto unmoved content: the content stays; when the dropped group collides, settle moves it, or another moved unit when that displaces fewer labels.
- A group dropped onto something moved earlier: settle moves whichever of the two displaces fewer labels.
- A function dragged far down or right: its group's frame stretches to hold it, and later siblings of that group in the same parent slide below the stretched frame; the remaining source of large vertical moves.
- Drop repulsion (step 2) seldom changes the drop: each probe redraw settles already, so the dropped spot tests clear.

## Trace

Setting `gaffy.trace` records every view change to `.baggy/gaffy/trace/<view>.jsonl` ([trace.ts:26](../src/host/trace.ts#L26)): the event, its target and grid cell, the functions above that acted, the view fields changed, the labels and groups that moved; undo and redo included. `node tools/gaffy-trace.mjs <file>` prints it as a list ([tools/gaffy-trace.mjs](../tools/gaffy-trace.mjs)).
