// Generates docs/ordering.md: triggers, interpreters and layout functions that change what shows and where, plus
// the drawing decision tree of one call. Code lines: first match of each anchor (after an optional earlier
// anchor), so links follow the code; `npm run heuristics` regenerates it with docs/heuristics.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const OUT = 'docs/ordering.md';
const MAIN = 'src/webview/main.ts', CMDS = 'src/host/commands.ts', EDIT = 'src/host/editor.ts', PKG = 'package.json';

// ---- lines ------------------------------------------------------------------------------------------
const files = new Map<string, string[]>();
const linesOf = (f: string) => { if (!files.has(f)) files.set(f, readFileSync(resolve(ROOT, f), 'utf8').split('\n')); return files.get(f)!; };
/** 1-based line of the first line holding `text`, after the `after` line when given. */
function line(file: string, text: string, after?: string): number {
    const ls = linesOf(file);
    const from = after ? line(file, after) : 0;
    for (let i = from; i < ls.length; i++) if (ls[i].includes(text)) return i + 1;
    throw new Error(`${file}: not found${after ? ` after "${after}"` : ''}: ${text}`);
}
/** Markdown link to a code line: [file:line](path#Lline). */
const at = (file: string, text: string, after?: string) => { const n = line(file, text, after); return `[${file.split('/').pop()}:${n}](../${file}#L${n})`; };
/** `at` as an HTML anchor, for the <pre> tree. */
const href = (file: string, text: string, after?: string) => { const n = line(file, text, after); return `<a href="../${file}#L${n}">${file.split('/').pop()}:${n}</a>`; };
const menu = (id: string) => at(PKG, `"command": "${id}"`, '"webview/context"');
const reg = (id: string) => at(CMDS, `reg('${id}'`);
const rule = (id: string) => `[${id.slice(0, 3)}](heuristics.md#${id})`;

// ---- 1. triggers --------------------------------------------------------------------------------------
type Row = string[];
const T_MOUSE: Row[] = [
    ['double click a label (one layer at a time)', at(MAIN, ".on('dblclick', (ev: MouseEvent, d) => {"), '`toggleSides`; on a collapsed container: expand (`collapsed` filter, `anchorAt`)'],
    ['drag a label', at(MAIN, 'nodes.call(dragUnit('), '`dragUnit` (unit: the function, `collapsed:<key>` for a collapsed one, or the selection)'],
    ['click `>> ` before a label', at(MAIN, "markerClick(d.key, 'up'); })"), "`markerClick(key, 'up')`"],
    ['click `>` of a `└─>>` row', at(MAIN, '.on(\'click\', (ev: MouseEvent, m) => { ev.stopPropagation(); markerClick(m.key, m.side); })'), '`markerClick(key, side)`'],
    ['click the branch of a `└─>>` row', at(MAIN, ".on('click', (ev: MouseEvent, p) => {"), "`markerClick(caller, 'down')`"],
    ['click an arrowhead', at(MAIN, '.on(\'click\', (ev: MouseEvent, h) => { ev.stopPropagation(); h.act!.run(); })'), '`closingOf(...).run` → `setSide(..., false)`: closes the level it points into'],
    ['double click a call', at(MAIN, ".on('dblclick', (ev: MouseEvent, p) => {"), '`isolateCalls` (the selection holding the call, else the calls through the cell)'],
    ['double click a group header', at(MAIN, "heads.on('dblclick'"), 'collapse the group (`collapsed` push)'],
    ['drag a group header', at(MAIN, 'heads.call(dragUnit('), '`dragUnit` (unit `box:<key>`)'],
    ['wheel, drag the background', at(MAIN, "svg.call(zoomer).on('dblclick.zoom', null)"), 'zoom and pan only: no view change'],
];
const T_KEYS: Row[] = [
    ['Alt+↑, Alt+↓', at(MAIN, 'moveSibling(key === \'ArrowUp\' ? -1 : 1)'), '`moveSibling(±1)`'],
    ['e, Space', at(MAIN, "case 'e': case ' ':"), '`setSide(k, side, true)` for each side with more'],
    ['←, c', at(MAIN, "case 'ArrowLeft': case 'c':"), '`collapseInnermost`'],
    ['→', at(MAIN, "case 'ArrowRight':", "svg.on('keydown'"), 'expand the focused collapsed container'],
    ['Delete, Backspace', at(MAIN, "case 'Delete': case 'Backspace':"), "`runCmd('remove')`"],
    ['h', at(MAIN, "case 'h': runCmd('hideSelection')"), "`runCmd('hideSelection')`"],
    ['a', at(MAIN, "case 'a': runCmd("), "`runCmd('rearrangeSelection')` with a selection, else `runCmd('rearrange')`"],
    ['i', at(MAIN, "case 'i': runCmd('isolateSelection')"), "`runCmd('isolateSelection')`"],
    ['Escape', at(MAIN, "case 'Escape':", "svg.on('keydown'"), "clear the selection, else `runCmd('showAll')`"],
    ['k', at(MAIN, "case 'k': if (k) runCmd("), "`runCmd('lock' | 'unlock')` on the focused unit"],
    ['u', at(MAIN, "case 'u': commit((d) => { d.view.hidden = []; })"), '`hidden = []`'],
    ['b', at(MAIN, "case 'b': commit("), '`boxes` toggled'],
    ['r', at(MAIN, "case 'r': api.postMessage({ type: 'refresh' })"), 'host `refresh`: new data from the language server'],
];
const T_BAR: Row[] = [
    ['call depth `all` `+` `−` (full layout)', at(MAIN, "const all: Btn = { label: 'all'"), '`setDepth(side, ...)`'],
    ['**Show all (n)**', at(MAIN, 'label: `Show all (${removed})`'), "`runCmd('showAll')`"],
    ['**Switch expand mode to >>**, **Switch expand mode to -+**', at(MAIN, "label: 'Switch expand mode to -+'"), "`setArrange('auto' | 'grow')`: switches to the mode it names"],
    ['**Isolate**', at(MAIN, "{ label: 'Isolate', title:"), "`runCmd('isolateSelection')`"],
    ['Options > Call Expansion: Individual On Graph, Global Toolbar', at(MAIN, "label: 'Individual On Graph: >>'"), "`setArrange('grow' | 'auto')`"],
    ['Options > Call Expansion > Paths between seeds only', at(MAIN, "label: 'Paths between seeds only'"), '`between`: full view, drawn functions filtered to seed-to-seed call paths (`onPaths`); one layer at a time, the reveal is the paths of the whole graph (`revealPaths`); off: the paths become `pinned`, every side closed (`toggleBetween`)'],
    ['marker click, one layer at a time with Paths between seeds only', at(MAIN, 'cannot expand ${'), 'refused, status line: the side leads to no other seed'],
    ['Options > Arrange > Layout debug (gaffy.debugLayout)', at(MAIN, "label: 'Layout debug'"), 'debugging panel (dbgpanel.ts): Rules (switches, alternatives, parameters written to `view.rules`, saved with the graph), Actions (running log of moves and the decisions behind them), Calls (how each call line is drawn); Layout: explain position reads `decisions` (explain.ts)'],
    ['Options > Call depth by: shortest, longest path', at(MAIN, "label: r === 'shortest' ? 'Shortest call path'"), '`depthRule`'],
    ['Options > Grouping > by Namespace', at(MAIN, "label: 'by Namespace'"), '`boxes`'],
    ['Options > Grouping > Tight', at(MAIN, "{ label: 'Tight', title:"), '`tight`'],
    ['Options > Grouping > Reset grouping', at(MAIN, 'label: `Reset grouping ('), '`group`, `ungroup` = [], `dropMovesWithin` for each'],
    ['Options > Parenting: first caller found, nearest caller above, left merge', at(MAIN, "label: m === 'dfs' ? 'First caller found'"), '`parentRule`'],
    ['Options > Arrange > Reset graph: seeds, depth, direction', at(MAIN, "{ label: 'Reset graph: seeds, depth, direction', title:"), "`runCmd('resetView')`"],
    ['Options > Arrange > Reset Layout: moves, locks, order', at(MAIN, "{ label: 'Reset Layout: moves, locks, order', title:"), "`runCmd('resetLayout')`"],
    ['Options > Arrange > Re-arrange', at(MAIN, "label: selected.size ? `Re-arrange selected"), "`runCmd('rearrangeSelection' | 'rearrange')`"],
    ['Options > Arrange > Unlock all', at(MAIN, 'label: `Unlock all ('), "`runCmd('unlockAll')`"],
    ['Options > Arrange > Expand collapsed', at(MAIN, 'label: `Expand collapsed ('), "`runCmd('expandAll')`"],
    ['Options > Folders > Include external code, Include standard library', at(MAIN, "label: 'Include external code'"), 'host setting; the webview redraws; their folders leave the list when off'],
    ['Options > Folders > a folder', at(MAIN, "label: f.label, title: `${f.path}: ${f.excluded"), '`exclude`, `include`'],
    ['Options > File > Save (.gaffy), Autosave Graphs, Save as Text, Refresh Language Server', at(MAIN, "label: 'Save (.gaffy)'"), 'host: save, setting `gaffy.autoSave` (command `gaffy.toggleAutoSave`, as the canvas menu), export, `refresh` (new data)'],
    ['Options > File > Frozen; toolbar Unfreeze', at(MAIN, "act: () => api.postMessage({ type: 'hold', on: !settings.held })"), 'host `hold`: Unfreeze writes `live` (this opening) and the Options values into the view; Freeze removes `live`. A view holding a graph opens frozen'],
];
const T_MENU: Row[] = [
    ['Make Seed, Remove Seed', `${menu('gaffy.node.makeSeed')}, ${reg('gaffy.node.makeSeed')}`, "forwarded: `runCmd('makeSeed' | 'removeSeed')`"],
    ['Open Callers / Open Called / Close Callers / Close Called (one layer)', `${menu('gaffy.node.openCallers')}, ${reg('gaffy.node.openCallers')}`, "forwarded: `runCmd('openUp' ...)` → `setSide`"],
    ['Isolate Selection, Hide Selection', `${at(PKG, '"command": "gaffy.isolateSelection"', '"group": "2_selection@1"')}, ${reg('gaffy.sel.hide')}`, "forwarded: `runCmd('isolateSelection' | 'hideSelection')` (the selection, else the function right clicked; seeds stay)"],
    ['Show Hidden Neighbors...', `${menu('gaffy.node.showHidden')}, ${reg('gaffy.node.showHidden')}`, 'host quick pick: `hidden` minus the picked'],
    ['Collapse Class / Module / Package', `${menu('gaffy.node.collapseClass')}, ${reg('gaffy.node.collapseClass')}`, 'host `collapse(kinds)`: `collapsed` push'],
    ['Expand Container', `${menu('gaffy.node.expandContainer')}, ${reg('gaffy.node.expandContainer')}`, 'host: `collapsed` filter'],
    ['Group Module, Ungroup Module, Group Submodules', `${menu('gaffy.node.groupModule')}, ${reg('gaffy.node.groupModule')}`, 'host: `group`, `ungroup`; `dropMovesWithin` the container'],
    ['Re-arrange selected', `${menu('gaffy.sel.rearrange')}, ${reg('gaffy.sel.rearrange')}`, "forwarded: `runCmd('rearrangeSelection')`"],
    ['Lock Position, Unlock Position', `${menu('gaffy.node.lock')}, ${reg('gaffy.node.lock')}`, "forwarded: `runCmd('lock' | 'unlock')`"],
    ['Move Up One, Move Down One', `${menu('gaffy.node.moveUp')}, ${reg('gaffy.node.moveUp')}`, 'host `move(±1)`: `sibling`'],
    ['Tag...', `${menu('gaffy.node.tag')}, ${reg('gaffy.node.tag')}`, 'host: `tags` (a longer label widens its column)'],
    ['Straighten This Call', `${menu('gaffy.edge.straighten')}, ${reg('gaffy.edge.straighten')}`, "forwarded: `runCmd('straighten')` (search order only)"],
    ['Isolate This Call, Isolate the Path Through This Call', `${menu('gaffy.edge.subtree')}, ${reg('gaffy.edge.subtree')}`, "forwarded: `runCmd('callSubtree' | 'callPath')`"],
    ['canvas: Save (.gaffy), Autosave Graphs, Save as Text (.txt, .md), Refresh Language Server', `${menu('gaffy.view.save')}, ${reg('gaffy.view.save')}`, 'host: save, setting, export, `refresh`'],
    ['canvas: Group namespaces, Tight groups, Reset graph, Reset Layout, Re-arrange, Unlock all, Expand collapsed', `${menu('gaffy.toggleBoxes')}, ${reg('gaffy.toggleBoxes')}`, 'host `boxes`, `tight`; the rest forwarded to `runCmd` (the Options Arrange entries)'],
];
const T_OUT: Row[] = [
    ['editor: gaffy> Call Hierarchy (up, dn); explorer: Call Hierarchies', `${reg('gaffy.graphCallers')}, ${reg('gaffy.graphFile')}`, '`createView`: a new view'],
    ['editor: gaffy> Add to Call Graph', reg('gaffy.addToView'), 'seed added and joined (`view.joins`: closed, drawn with its call paths to the other seeds), `Session.refresh`, `Session.pathData`'],
    ['VS Code undo, redo; an edit of the .gaffy text', at(EDIT, 'vscode.workspace.onDidChangeTextDocument((e) => {', 'async resolveCustomTextEditor('), 'the webview receives the text (`state`) and redraws'],
    ['saving a source file; renaming a file', at('src/host/extension.ts', 'onDidSaveTextDocument'), 'refresh of the views that show it'],
];

// ---- 2. interpreters ---------------------------------------------------------------------------------
const I: Row[] = [
    ['`commit`', at(MAIN, 'function commit('), 'any', 'clones the view, applies the change, redraws, posts the text to the host (an undo step)'],
    ['`toggleSides`', at(MAIN, 'function toggleSides('), '`open`', 'closes both sides, or opens every side with more'],
    ['`setSide`', at(MAIN, 'function setSide('), '`open`; `hidden`, `cut` (restore)', 'opens or closes one side; asks the host for data the side lacks; starts the move handover (h34)'],
    ['`markerClick`', at(MAIN, 'function markerClick('), 'via `setSide`, `restoreHidden`', 'opens the side, else brings hidden neighbors back'],
    ['`restoreHidden`', at(MAIN, 'function restoreHidden('), '`hidden`, `cut`', 'shows the hidden neighbors of one side and the hidden functions on their way from the seeds'],
    ['`closingOf`', at(MAIN, 'function closingOf('), 'via `setSide`', 'chooses the side an arrowhead closes'],
    ['`isolateCalls`, `isolate`, `hide`', at(MAIN, 'function isolateCalls('), '`hidden`', 'keeps the given functions (and their path from the seeds); hides the rest, seeds excepted'],
    ['`dragUnit`', at(MAIN, 'function dragUnit('), '`offset` or `lock`', 'drop: cell delta, `settleDrop`, `moveUnit` per unit; anchor on a function that did not move'],
    ['`topUnits`', at(MAIN, 'function topUnits('), '-', 'units a multi-selection drag moves: each selected function with its tree, once'],
    ['`settleDrop`', at(MAIN, 'function settleDrop('), '-', 'drop repulsion: tries cells along the drag, then sideways, ≤ 12 cells or 1.5 s'],
    ['`moveUnit`', at(MAIN, 'function moveUnit('), '`offset[unit]` or `lock[unit]`', 'adds the move to the lock when locked, else to the stored move (`offset`)'],
    ['`lockUnit`, `unlockUnit`', at(MAIN, 'function lockUnit('), '`lock`, `offset`', 'lock: the anchor cell becomes absolute; unlock: the move from the computed place'],
    ['`moveSibling`', at(MAIN, 'function moveSibling('), '`sibling`', 'swaps the focused function with its neighbor under one tree parent'],
    ['`collapseInnermost`', at(MAIN, 'function collapseInnermost('), '`collapsed`', 'collapses the innermost container not collapsed yet'],
    ['`setArrange`, `setDepth`', at(MAIN, 'function setArrange('), '`arrange`, `open`, `depthUp`, `depthDown`', 'switches one layer at a time ⇄ full, keeping what is on screen; call depths per side'],
    ['`runCmd`', at(MAIN, 'function runCmd('), 'per case', 'command dispatch: the cases below'],
    ["`runCmd: 'remove'`", at(MAIN, "case 'remove': {"), '`cut` or `hidden`', 'cuts selected calls (one layer at a time), else hides the selection'],
    ["`runCmd: 'showAll'`", at(MAIN, "case 'showAll':"), '`hidden`, `cut`, `collapsed`', 'shows everything hidden, removed or collapsed'],
    ["`runCmd: 'resetView'`", at(MAIN, "case 'resetView':"), 'most fields', 'back to the seeds: no hidden, collapsed, moves, locks, grouping'],
    ["`runCmd: 'resetLayout'`", at(MAIN, "case 'resetLayout':"), '`offset`, `lock`, `sibling`, `straight`', 'every computed place again'],
    ["`runCmd: 'rearrangeSelection'`, `'rearrange'`", at(MAIN, "case 'rearrangeSelection': {"), '`offset`, `lock`', 'the selected units (or all unlocked) back to their computed place'],
    ["`runCmd: 'makeSeed'`, `'removeSeed'`", at(MAIN, "case 'makeSeed':"), '`seeds`, `joins`', 'adds a joined seed (`joins`: closed, its call paths to the other seeds drawn) or drops a seed; the host asks along both directions to the view\'s depth'],
    ["`runCmd: 'expandAll'`", at(MAIN, "case 'expandAll':"), '`collapsed`', 'expands every collapsed container'],
    ['`dropMovesWithin`', at('src/core/viewdoc.ts', 'export function dropMovesWithin('), '`offset`, `lock`', 'drops the moves and locks inside a container whose grouping changes (group, ungroup, reset grouping)'],
    ['`afterRender`: adopt', at(MAIN, "cause = { event: 'auto', fn: 'afterRender:adopt'"), '`offset`', 'move handover: the new parent of a moved function takes its move (h34)'],
    ['`afterRender`: settle', at(MAIN, "cause = { event: 'auto', fn: 'afterRender:settle'"), '`offset`', 'saves the moves settle drew with, ≤ 3 saves in a row (h35)'],
    ['`anchorAt`, `render`', at(MAIN, 'function anchorAt('), '-', 'no view change: pans so the function acted on keeps its screen spot (h30, h31)'],
    ['host `Session.update`, `write`', at(EDIT, 'async write(doc: ViewDoc)'), 'any', 'replaces the document text (host commands, language server data)'],
    ['host `collapse`, `expandContainer`, `move`, group commands', at(CMDS, 'const collapse = (kinds: string[]'), '`collapsed`, `sibling`, `group`, `ungroup`', 'context menu changes made on the host'],
    ['host `Session.revalidate`, `expand`, `ask`', at(EDIT, 'revalidate(force = false)'), '`graph`, `explored`', 'new calls from the language server: new functions appear where their sides are open'],
];

// ---- 3. layout ------------------------------------------------------------------------------------
const P: Row[] = [
    ['`buildScene`', at('src/core/scene.ts', 'export function buildScene('), 'the pipeline below, run on every redraw', ''],
    ['`excludedKeys`, `quotient`', at('src/core/scene.ts', 'function excludedKeys('), 'drops excluded and hidden functions; a collapsed container stands for its members', ''],
    ['`revealView` → `reveal` / `revealDepth`', at('src/core/scene.ts', 'function revealView('), 'what is on screen: open sides (one layer at a time) or call depths (full)', `${rule('h01_first_revealer')}, ${rule('h02_call_depth_by_path')}`],
    ['`seedsIn`', at('src/core/scene.ts', 'export function seedsIn('), 'the function standing for each seed (itself or its collapsed group)', ''],
    ['`boxTree`', at('src/core/boxes.ts', 'export function boxTree('), 'groups and their order', rule('h03_box_order')],
    ['`sortKeyOf`', at('src/core/scene.ts', 'export function sortKeyOf('), 'tie order: path, definition line, key', rule('h04_sort_key')],
    ['`layout`', at('src/core/layout.ts', 'export function layout('), 'rows of one block: root order, child order, parents, exit rows, trunk columns', `${rule('h06_root_order')}–${rule('h12_lane_packing')}`],
    ['`place` → `placeBox`', at('src/core/place.ts', 'const placeBox = '), 'the block and subgroups of a group: order, column, row; unmoved groups slide below earlier ones', `${rule('h16_item_order')}–${rule('h20_unmoved_box_descent')}`],
    ['`placeBlock`', at('src/core/place.ts', 'const placeBlock = '), 'one block: caller alignment, rows only down, descent, moves and locks per function', `${rule('h13_caller_alignment')}–${rule('h15_block_descent')}, ${rule('h21_moved_function_descent')}`],
    ['frames', at('src/core/place.ts', 'const frame = (x: Rect): Rect =>'), 'frame extents (tight or keeping the computed corner)', rule('h22_frame_extent')],
    ['`settleMoved`', at('src/core/settle.ts', 'export function settleMoved('), 'moved units on other content go to the nearest clear spot, least displacement first, ≤ 3 rounds', rule('h23_settle')],
    ['`buildGrid`', at('src/core/grid.ts', 'export function buildGrid('), 'draws the calls (section 4)', `${rule('h24_tree_lines_first')}–${rule('h29_route_cost')}`],
];

// ---- 4. one call ------------------------------------------------------------------------------------
const G = 'src/core/grid.ts', S = 'src/core/scene.ts', Q = 'src/core/quotient.ts', LY = 'src/core/layout.ts';
const tree = `<pre>
call u → v in the data (graph.edges)
├── u or v in an excluded folder, external, standard library ──────────► not drawn, no marker         ${href(S, 'function excludedKeys(')}
├── u or v hidden, or the call cut (removed) ──────────────────────────► not drawn; <code>>></code> or <code>└─>></code> on the end shown   ${href(S, 'function dropCalls(')}
├── u and v in one collapsed container ─────────────────────────────────► counted on the container (tooltip: internal calls)   ${href(Q, 'export function quotient(')}
├── u or v in a collapsed container ────────────────────────────────────► drawn from or to the collapsed group
├── an end not revealed (side closed, past the call depth) ─────────────► not drawn; marker on the end shown   ${href('src/core/reveal.ts', 'export function reveal(')}
├── u = v, or v above u in the same chain of one block ─────────────────► <code>↻</code>, <code>↻ v()</code> after u's label, no line   ${href(LY, "vg.selfLoops.has(k) ? ' ↻' : ''")}
└── both ends placed
    ├── u is v's parent, one block, one shift ──────────────────────────► branch <code>└─></code> on u's stem (net t:u)   ${href(G, 'for (const [p, kids] of L.children) elbows(')}
    ├── v takes calls through a trunk (callers in the block)
    │   ├── every caller and v share one shift, the trunk column clear ─► trunk <code>┌──┘ └─></code> or <code>&lt;──┘</code> (net l:v)   ${href(G, 'for (const ln of L.lanes) {', '// ---- 2.')}
    │   └── otherwise ────────────────────────────────────────────────► path search
    └── path search (A*), in search order: straightened, then callers top to bottom (h25, row)   ${href(G, 'todo.sort((a, b) => pri(b) - pri(a)')}
        ├── arrival side, decided per called before path search   ${href(G, 'const left = own || (sends && approach) ||')}
        │   ├── v's trunk already enters from the left ───────────────► left <code>──> v()</code>
        │   ├── v sends calls from its label end ──────────────────────► left
        │   ├── callers mostly left of v, two cells before v free ─────► left
        │   └── otherwise ────────────────────────────────────────────► right end <code>v() <──</code>
        ├── departure   ${href(G, 'const starts: { id: number;')}
        │   ├── u's label end (cost 0), unless u receives at its end
        │   ├── under or over u's first character (cost 2), when free
        │   └── no start free ────────────────────────────────────────► dashed fallback
        └── search: (cell, heading) states, step 1, bend +3, crossing +6, frame border +4, own line 0.3   ${href(G, 'for (pass = 0; pass < 2 && goal < 0; pass++)')}
            ├── pass 1 strict: no running along or turning on another line ► drawn
            ├── pass 2 relaxed: those at +400 and +40 ────────────────► drawn
            └── no route in 400 000 steps ────────────────────────────► dashed fallback L with its arrowhead   ${href(G, 'const fallback = () => {')}
</pre>`;

// ---- 5. a drag -------------------------------------------------------------------------------------
const PL = 'src/core/place.ts', ST = 'src/core/settle.ts';
const drag = `<pre>
drop: pointer delta in whole cells; zero cells: nothing   ${href(MAIN, 'const dc = Math.round((ev.x - ev.subject.x) / cw)')}
├── 1. units: a group with its content (selection ignored); a function with the functions hanging under it, or every selected
│      function with those under it, once each, when one of several selected is dragged   ${href(MAIN, "units = !unit.startsWith('box:') && selected.has(d.key)")}
├── 2. drop spot: as dropped when no call loses its route and the dropped labels collide with nothing; else the
│      nearest such spot up to 12 cells along the drag or sideways (1.5 s); else as dropped   ${href(MAIN, 'function settleDrop(')}
├── 3. stored: a locked unit moves its lock, any other its move   ${href(MAIN, 'function moveUnit(')}
├── 4. placement: what was not moved keeps its computed place
│   ├── a moved function lands at its computed place + move, with the functions under it   ${href(PL, '} else if (off) shift.set(k,')}
│   │   └── labels within 2 cells of another label of its group on the row ─────► slides down until clear   ${href(PL, 'const mine = new Set(descendants(k));')}
│   ├── a moved group: placed as unmoved, then shifted whole by its move; a locked one onto its cell   ${href(PL, 'const home = Math.max(cr, top - 1);')}
│   ├── a sibling placed later (order: locked first, then calling order)   ${href(PL, 'const order = [...topo.filter(')}
│   │   ├── after a group moved by a drag: counts it at its unmoved place ─────► stays   ${href(PL, 'const avoid = [...placed.map(')}
│   │   └── after a locked group, or one stretched by moves inside it ─────────► slides below it   ${href(PL, 'if (costRight < costDown) dcol += right; else rr += down;')}
│   ├── frames grow to hold moved content (Tight groups: fit it on all sides) ────► later siblings of the
│   │   enclosing group may slide below it   ${href(PL, 'const frame = (x: Rect): Rect =>')}
│   └── blank margin, or content above row 0 or left of column 0 ──────────────► whole picture shifts to 0, 0   ${href(PL, 'const trim = !Object.keys(inp.lock).length;')}
├── 5. settle, up to 3 rounds in every redraw: moved, unlocked units that collide (on content, or a frame
│      touching another frame with no free row or column between) move to the nearest clear spot, the least
│      displacement (distance × labels) first; unmoved and locked units never move here   ${href(ST, 'export function settleMoved(')}
└── 6. the view saves the settled moves (at most 3 saves in a row) and pans so the still function keeps its spot   ${href(MAIN, 'function afterRender() {')}
</pre>`;
const DRAG: Row[] = [
    ['which units move', at(MAIN, "units = !unit.startsWith('box:') && selected.has(d.key)"), 'a group header moves `box:<key>`; a label its unit (`vertexUnit`, `collapsed:<key>` for a collapsed group), or `topUnits` of the selection'],
    ['units of a selection', at(MAIN, 'function topUnits('), 'each selected function with its tree, skipping one inside another selected function\'s tree'],
    ['still function', at(MAIN, 'const still = [...doc!.view.seeds, ...sc.placement.pos.keys()]'), 'the first seed, else any function, outside what moves; none: the drop is a pan of everything'],
    ['drop accepted', at(MAIN, 'if (clean(dc, dr)) return [dc, dr];'), 'a probe redraw: no more unroutable calls, `collisions` of the dropped labels and frames zero; each probe settles (step 5), so the first spot usually passes'],
    ['drop search', at(MAIN, 'for (let k = 1; k <= cells && performance.now() - t0 < ms; k++)'), 'k cells further along the drag, then sideways either way, then back; k ≤ 12'],
    ['lock or move', at(MAIN, 'function moveUnit('), '`lock[unit]` when locked, else `offset[unit]` += (Δcolumn, Δrow)'],
    ['function move', at(PL, '} else if (off) shift.set(k,'), 'the shift of a function: its lock, else its parent\'s shift + its move; the functions under it inherit it'],
    ['moved function descent', at(PL, 'const mine = new Set(descendants(k));'), 'labels on one row closer than 2 cells to another label of the group: down one row, at most 500'],
    ['sibling order', at(PL, 'const order = [...topo.filter('), 'locked ones first, then the topological order of calls between the block and subgroups; "earlier" in the rows below'],
    ['stacking', at(PL, 'const below = stack.length ?'), 'rows and columns of later siblings from earlier siblings\' unmoved extents'],
    ['what later groups avoid', at(PL, 'const avoid = [...placed.map('), 'an earlier group moved by a drag at its unmoved place; a locked group, or one stretched by moves inside it, where drawn'],
    ['unmoved block descent', at(PL, 'const hit = avoid.find((a) => overlaps(a, rectOf(rowMap)));'), 'the functions of a group slide below what they avoid'],
    ['moved group', at(PL, 'const home = Math.max(cr, top - 1);'), 'placed at the row it would take unmoved, then shifted whole (labels, trunks, inner frames) by its move'],
    ['unmoved group descent', at(PL, 'if (costRight < costDown) dcol += right; else rr += down;'), 'trial placement, then below the overlapped earlier sibling, by the distance from its top'],
    ['frame extent', at(PL, 'const frame = (x: Rect): Rect =>'), 'Tight frames: the content\'s bounding box; otherwise the computed corner, growing to hold content moved up or left'],
    ['picture origin', at(PL, 'const trim = !Object.keys(inp.lock).length;'), 'everything shifts so the content starts at row 0 and column 0 (with locks: only content above row 0 or left of column 0 shifts back); the pan cancels it on screen'],
    ['settle rounds', at('src/core/scene.ts', "for (let round = 0; round < R.p('h23_settle', 'rounds'); round++) {"), 'at most 3 rounds of settle per redraw'],
    ['settle candidates', at(ST, 'const moved = Object.keys(doc.view.offset).filter('), 'units with a move, unlocked, on screen'],
    ['collision', at(ST, 'const hits = (x: Unit, a: number, d: number) =>'), 'a label on another frame\'s border; closer than 4 cells to a label of its row; another label inside its frame; its frame partly over another'],
    ['clear spot', at(ST, 'const nearest = (x: Unit)'), 'rings of up to 12 cells (vertical first), then straight lines up to 80; never off the canvas'],
    ['who moves first', at(ST, 'const cost = (r: { x: Unit;'), 'distance × labels moved: a small unit yields to a large one'],
    ['save and pan', at(MAIN, 'function afterRender() {'), 'the settled moves become the view\'s moves (at most 3 saves in a row); render pans to the still function'],
];

// ---- document ------------------------------------------------------------------------------------
const table = (head: string[], rows: Row[]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const doc = `# gaffy node order: triggers, interpreters, layout

Taxonomy of graph layout ordering functions. Drawing decision tree per call.

1. **Triggers**: user actions in the webview (mouse, keys, toolbar, Options), the context menu, and events outside the view.
2. **Interpreters**: functions that turn a trigger into a change of the view document (\`ViewDoc.view\`) and commit it; each commit is one undo step.
3. **Layout**: functions that compute positions from a view document, on every redraw; the same document gives the same picture.

Terms: [terms.md](terms.md).


## 1. Triggers

Canvas (mouse):

${table(['trigger', 'code', 'calls'], T_MOUSE)}

Keys (focused function \`k\`):

${table(['key', 'code', 'calls'], T_KEYS)}

Toolbar and Options:

${table(['entry', 'code', 'calls'], T_BAR)}

Context menu (\`webview/context\` entry, host registration; *forwarded* entries post \`cmd\` to the webview):

${table(['entry', 'code', 'calls'], T_MENU)}

Outside the view:

${table(['event', 'code', 'calls'], T_OUT)}

## 2. Interpreters

${table(['function', 'code', 'view fields written', 'what it does'], I)}

## 3. Layout

In pipeline order; positions depend on the view document only.

${table(['function', 'code', 'what it does', 'rules'], P)}

## 4. Drawing one call

${tree}

Nets: \`t:<parent>\` holds a parent's stem and branches, \`l:<target>\` the trunk of one function: every call into it (trunk columns, searched paths, the arrival). Searched calls join the trunk of their called (cost \`bundle\`, 0.3).

## 5. Dragging a function or a group

Three mechanisms move the rest of the picture after a drop, in this order: placement (positions from the stored moves), settle (moved units that collide go to the nearest clear place) and the pan (the still function keeps its spot on screen). Content never moved is not relocated to make room, except that an unmoved group slides below an earlier sibling that is locked or stretched by moves inside it.

${drag}

${table(['condition', 'code', 'effect'], DRAG)}

Consequences:
- A group dropped onto unmoved content: the content stays; when the dropped group collides, settle moves it, or another moved unit when that displaces fewer labels.
- A group dropped onto something moved earlier: settle moves whichever of the two displaces fewer labels.
- A function dragged far down or right: its group's frame stretches to hold it, and later siblings of that group in the same parent slide below the stretched frame; the remaining source of large vertical moves.
- Drop repulsion (step 2) seldom changes the drop: each probe redraw settles already, so the dropped spot tests clear.

## Trace

Setting \`gaffy.trace\` records every view change to \`.baggy/gaffy/trace/<view>.jsonl\` (${at('src/host/trace.ts', 'export class Trace')}): the event, its target and grid cell, the functions above that acted, the view fields changed, the labels and groups that moved; undo and redo included. \`node tools/gaffy-trace.mjs <file>\` prints it as a list ([tools/gaffy-trace.mjs](../tools/gaffy-trace.mjs)).
`;
writeFileSync(resolve(ROOT, OUT), doc);
console.log(`${OUT}: ${T_MOUSE.length + T_KEYS.length + T_BAR.length + T_MENU.length + T_OUT.length} triggers, ${I.length} interpreters, ${P.length} layout functions`);
