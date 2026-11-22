// Generates .ORDERING.md: every function that changes which functions are shown or where they sit, in three
// kinds (user triggers, the functions interpreting them, the layout that places a given state), and the decision
// tree of one call's drawing. Lines are found by searching each anchor's text (after an optional earlier anchor),
// so the links follow the code: `npm run heuristics` regenerates this file with .HEURISTICS.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const OUT = '.ORDERING.md';
const MAIN = 'src/webview/main.ts', CMDS = 'src/host/commands.ts', EDIT = 'src/host/editor.ts', PKG = 'package.json';

// ---- lines ------------------------------------------------------------------------------------------
const files = new Map<string, string[]>();
const linesOf = (f: string) => { if (!files.has(f)) files.set(f, readFileSync(resolve(ROOT, f), 'utf8').split('\n')); return files.get(f)!; };
/** 1-based line of the first line holding `text`, after the line holding `after` when given. */
function line(file: string, text: string, after?: string): number {
    const ls = linesOf(file);
    const from = after ? line(file, after) : 0;
    for (let i = from; i < ls.length; i++) if (ls[i].includes(text)) return i + 1;
    throw new Error(`${file}: not found${after ? ` after "${after}"` : ''}: ${text}`);
}
/** Markdown link to a code line: [file:line](path#Lline). */
const at = (file: string, text: string, after?: string) => { const n = line(file, text, after); return `[${file.split('/').pop()}:${n}](${file}#L${n})`; };
/** The same as an HTML anchor, for the <pre> tree. */
const href = (file: string, text: string, after?: string) => { const n = line(file, text, after); return `<a href="${file}#L${n}">${file.split('/').pop()}:${n}</a>`; };
const menu = (id: string) => at(PKG, `"command": "${id}"`, '"webview/context"');
const reg = (id: string) => at(CMDS, `reg('${id}'`);
const rule = (id: string) => `[${id.slice(0, 3)}](.HEURISTICS.md#${id})`;

// ---- 1. triggers --------------------------------------------------------------------------------------
type Row = string[];
const T_MOUSE: Row[] = [
    ['double click a label (one layer at a time)', at(MAIN, ".on('dblclick', (ev: MouseEvent, d) => {"), '`toggleSides`; on a collapsed container: expand (`collapsed` filter, `anchorAt`)'],
    ['drag a label', at(MAIN, 'nodes.call(dragUnit('), '`dragUnit` (unit: the vertex, `collapsed:<key>` for a collapsed one, or the selection)'],
    ['click `>> ` before a label', at(MAIN, "markerClick(d.key, 'up'); })"), "`markerClick(key, 'up')`"],
    ['click `>` of a `└─>>` row', at(MAIN, '.on(\'click\', (ev: MouseEvent, m) => { ev.stopPropagation(); markerClick(m.key, m.side); })'), '`markerClick(key, side)`'],
    ['click the elbow of a `└─>>` row', at(MAIN, ".on('click', (ev: MouseEvent, p) => {"), "`markerClick(caller, 'down')`"],
    ['click an arrowhead', at(MAIN, '.on(\'click\', (ev: MouseEvent, h) => { ev.stopPropagation(); h.act!.run(); })'), '`closingOf(…).run` → `setSide(…, false)`: closes the level it points into'],
    ['double click a call', at(MAIN, ".on('dblclick', (ev: MouseEvent, p) => {"), '`isolateCalls` (the selection holding the call, else the calls through the cell)'],
    ['double click a box header', at(MAIN, "heads.on('dblclick'"), 'collapse the container (`collapsed` push)'],
    ['drag a box header', at(MAIN, 'heads.call(dragUnit('), '`dragUnit` (unit `box:<key>`)'],
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
    ['i', at(MAIN, "case 'i': runCmd('isolate')"), "`runCmd('isolate')`"],
    ['Escape', at(MAIN, "case 'Escape':", "svg.on('keydown'"), "clear the selection, else `runCmd('showAll')`"],
    ['k', at(MAIN, "case 'k': if (k) runCmd("), "`runCmd('lock' | 'unlock')` on the focused unit"],
    ['u', at(MAIN, "case 'u': commit((d) => { d.view.hidden = []; })"), '`hidden = []`'],
    ['b', at(MAIN, "case 'b': commit("), '`boxes` toggled'],
    ['r', at(MAIN, "case 'r': api.postMessage({ type: 'refresh' })"), 'host `refresh`: new data from the language server'],
];
const T_BAR: Row[] = [
    ['call depth `all` `+` `−` (full layout)', at(MAIN, "const all: Btn = { label: 'all'"), '`setDepth(side, …)`'],
    ['**Show all (n)**', at(MAIN, 'label: `Show all (${removed})`'), "`runCmd('showAll')`"],
    ['**Isolate**', at(MAIN, "{ label: 'Isolate', title:"), "`runCmd('isolateSelection')`"],
    ['Options > Layout: `>> : Expand Individual Callers`, `+ - call depth - +`', at(MAIN, "label: '>> : Expand Individual Callers'"), "`setArrange('grow' | 'auto')`"],
    ['Options > Call depth by: shortest, longest path', at(MAIN, "label: r === 'shortest' ? 'Shortest call path'"), '`depthRule`'],
    ['Options > Group namespaces; Reset grouping', at(MAIN, "label: 'Group namespaces'"), '`boxes`; `group`, `ungroup` = []'],
    ['Options > Tree parent: dfs, nearest, joint', at(MAIN, "label: m === 'dfs' ? 'First caller found (dfs)'"), '`parentRule`'],
    ['Options > Arrange > Reset view', at(MAIN, "{ label: 'Reset view', title:"), "`runCmd('resetView')`"],
    ['Options > Arrange > Reset layout', at(MAIN, "{ label: 'Reset layout', title:"), "`runCmd('resetLayout')`"],
    ['Options > Arrange > Tight boxes', at(MAIN, "{ label: 'Tight boxes', title:"), '`tight`'],
    ['Options > Arrange > Re-arrange', at(MAIN, "label: selected.size ? `Re-arrange selected"), "`runCmd('rearrangeSelection' | 'rearrange')`"],
    ['Options > Arrange > Unlock all', at(MAIN, 'label: `Unlock all ('), "`runCmd('unlockAll')`"],
    ['Options > Arrange > Expand collapsed', at(MAIN, 'label: `Expand collapsed ('), '`collapsed = []`'],
    ['Options > Arrange > Straightened calls: clear', at(MAIN, 'label: `Straightened calls ('), '`straight = []` (routing order only)'],
    ['Options > Folders > a folder', at(MAIN, "label: f.label, title: `${f.path}: ${f.excluded"), '`exclude`, `include`'],
    ['Options > Settings > include external code, standard library', at(MAIN, "label: 'Include external code'"), 'host setting; the webview redraws'],
];
const T_MENU: Row[] = [
    ['Make Seed, Remove Seed', `${menu('gaffy.node.makeSeed')}, ${reg('gaffy.node.makeSeed')}`, "forwarded: `runCmd('makeSeed' | 'removeSeed')`"],
    ['Open Callers / Open Called / Close Callers / Close Called (one layer)', `${menu('gaffy.node.openCallers')}, ${reg('gaffy.node.openCallers')}`, "forwarded: `runCmd('openUp' …)` → `setSide`"],
    ['Hide Selection, Show Only Selection', `${menu('gaffy.sel.hide')}, ${reg('gaffy.sel.hide')}`, "forwarded: `runCmd('hideSelection' | 'isolate')`"],
    ['Hide', `${menu('gaffy.node.hide')}, ${reg('gaffy.node.hide')}`, 'host: `hidden` push'],
    ['Show Hidden Neighbors…', `${menu('gaffy.node.showHidden')}, ${reg('gaffy.node.showHidden')}`, 'host quick pick: `hidden` minus the picked'],
    ['Collapse Class / Module / Package', `${menu('gaffy.node.collapseClass')}, ${reg('gaffy.node.collapseClass')}`, 'host `collapse(kinds)`: `collapsed` push'],
    ['Expand Container', `${menu('gaffy.node.expandContainer')}, ${reg('gaffy.node.expandContainer')}`, 'host: `collapsed` filter'],
    ['Group Module, Ungroup Module, Group Submodules', `${menu('gaffy.node.groupModule')}, ${reg('gaffy.node.groupModule')}`, 'host: `group`, `ungroup`'],
    ['Re-arrange Selection', `${menu('gaffy.sel.rearrange')}, ${reg('gaffy.sel.rearrange')}`, "forwarded: `runCmd('rearrangeSelection')`"],
    ['Lock Position, Unlock Position', `${menu('gaffy.node.lock')}, ${reg('gaffy.node.lock')}`, "forwarded: `runCmd('lock' | 'unlock')`"],
    ['Move Up One, Move Down One', `${menu('gaffy.node.moveUp')}, ${reg('gaffy.node.moveUp')}`, 'host `move(±1)`: `sibling`'],
    ['Tag…', `${menu('gaffy.node.tag')}, ${reg('gaffy.node.tag')}`, 'host: `tags` (a longer label widens its column)'],
    ['Straighten This Call', `${menu('gaffy.edge.straighten')}, ${reg('gaffy.edge.straighten')}`, "forwarded: `runCmd('straighten')` (routing order only)"],
    ['Isolate This Call, Isolate the Path Through This Call', `${menu('gaffy.edge.subtree')}, ${reg('gaffy.edge.subtree')}`, "forwarded: `runCmd('callSubtree' | 'callPath')`"],
    ['Show All, Unhide All, Re-arrange, Unlock All, Reset View, Reset Layout, Tight Boxes, Toggle Group Namespaces, Refresh', `${menu('gaffy.showAll')}, ${reg('gaffy.showAll')}`, 'forwarded to `runCmd`, or host one-field updates'],
];
const T_OUT: Row[] = [
    ['editor: gaffy> Call Hierarchy (up, dn); explorer: Call Hierarchies', `${reg('gaffy.graphCallers')}, ${reg('gaffy.graphFile')}`, '`createView`: a new view'],
    ['editor: gaffy> Add to Call Graph', reg('gaffy.addToView'), 'seed added, `Session.refresh`'],
    ['VS Code undo, redo; an edit of the .gaffy text', at(EDIT, 'vscode.workspace.onDidChangeTextDocument((e) => {', 'async resolveCustomTextEditor('), 'the webview receives the text (`state`) and redraws'],
    ['saving a source file; renaming a file', at('src/host/extension.ts', 'onDidSaveTextDocument'), 'refresh of the views that show it'],
];

// ---- 2. interpreters ---------------------------------------------------------------------------------
const I: Row[] = [
    ['`commit`', at(MAIN, 'function commit('), 'any', 'clones the view, applies the change, redraws, posts the text to the host (an undo step)'],
    ['`toggleSides`', at(MAIN, 'function toggleSides('), '`open`', 'closes both sides, or opens every side with more'],
    ['`setSide`', at(MAIN, 'function setSide('), '`open`; `hidden`, `cut` (restore)', 'opens or closes one side; asks the host for data the side lacks; starts the offset handover (h34)'],
    ['`markerClick`', at(MAIN, 'function markerClick('), 'via `setSide`, `restoreHidden`', 'opens the side, else brings hidden neighbors back'],
    ['`restoreHidden`', at(MAIN, 'function restoreHidden('), '`hidden`, `cut`', 'shows the hidden neighbors of one side and the hidden functions on their way from the seeds'],
    ['`closingOf`', at(MAIN, 'function closingOf('), 'via `setSide`', 'chooses the side an arrowhead closes'],
    ['`isolateCalls`, `isolate`, `hide`', at(MAIN, 'function isolateCalls('), '`hidden`', 'keeps the given functions (and their path from the seeds); hides the rest, seeds excepted'],
    ['`dragUnit`', at(MAIN, 'function dragUnit('), '`offset` or `lock`', 'drop: cell delta, `settleDrop`, `moveUnit` per unit; anchor on a function that did not move'],
    ['`topUnits`', at(MAIN, 'function topUnits('), '-', 'units a multi-selection drag moves: each selected function with its tree, once'],
    ['`settleDrop`', at(MAIN, 'function settleDrop('), '-', 'drop repulsion: tries cells along the drag, then sideways, ≤ 12 cells or 1.5 s'],
    ['`moveUnit`', at(MAIN, 'function moveUnit('), '`offset[unit]` or `lock[unit]`', 'adds the move to the lock when locked, else to the offset'],
    ['`lockUnit`, `unlockUnit`', at(MAIN, 'function lockUnit('), '`lock`, `offset`', 'lock: the anchor cell becomes absolute; unlock: the offset from the computed place'],
    ['`moveSibling`', at(MAIN, 'function moveSibling('), '`sibling`', 'swaps the focused function with its neighbor under one tree parent'],
    ['`collapseInnermost`', at(MAIN, 'function collapseInnermost('), '`collapsed`', 'collapses the innermost container not collapsed yet'],
    ['`setArrange`, `setDepth`', at(MAIN, 'function setArrange('), '`arrange`, `open`, `depthUp`, `depthDown`', 'switches one layer at a time ⇄ full, keeping what is on screen; call depths per side'],
    ['`runCmd`', at(MAIN, 'function runCmd('), 'per case', 'command dispatch: the cases below'],
    ["`runCmd: 'remove'`", at(MAIN, "case 'remove': {"), '`cut` or `hidden`', 'cuts selected calls (one layer at a time), else hides the selection'],
    ["`runCmd: 'showAll'`", at(MAIN, "case 'showAll':"), '`hidden`, `cut`, `collapsed`', 'shows everything hidden, removed or collapsed'],
    ["`runCmd: 'resetView'`", at(MAIN, "case 'resetView':"), 'most fields', 'back to the seeds: no hidden, collapsed, moves, locks, grouping'],
    ["`runCmd: 'resetLayout'`", at(MAIN, "case 'resetLayout':"), '`offset`, `lock`, `sibling`, `straight`', 'every computed place again'],
    ["`runCmd: 'rearrangeSelection'`, `'rearrange'`", at(MAIN, "case 'rearrangeSelection': {"), '`offset`, `lock`', 'the selected units (or all unlocked) back to their computed place'],
    ["`runCmd: 'makeSeed'`, `'removeSeed'`", at(MAIN, "case 'makeSeed':"), '`seeds`', 'adds or drops a seed; the host asks for the new seed\'s sides'],
    ['`afterRender`: adopt', at(MAIN, "cause = { event: 'auto', fn: 'afterRender:adopt'"), '`offset`', 'offset handover: the new tree parent of a moved function takes its offset (h34)'],
    ['`afterRender`: settle', at(MAIN, "cause = { event: 'auto', fn: 'afterRender:settle'"), '`offset`', 'saves the offsets settle drew with, ≤ 3 saves in a row (h35)'],
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
    ['`seedsIn`', at('src/core/scene.ts', 'export function seedsIn('), 'the vertex standing for each seed (itself or its collapsed container)', ''],
    ['`boxTree`', at('src/core/boxes.ts', 'export function boxTree('), 'namespace boxes and their order', rule('h03_box_order')],
    ['`sortKeyOf`', at('src/core/scene.ts', 'export function sortKeyOf('), 'tie order: path, definition line, key', rule('h04_sort_key')],
    ['`layout`', at('src/core/layout.ts', 'export function layout('), 'rows and lanes in one block: root order, child order, tree parent, ports, lanes', `${rule('h06_root_order')}–${rule('h12_lane_packing')}`],
    ['`place` → `placeBox`', at('src/core/place.ts', 'const placeBox = '), 'items of a box (its block, then child boxes): order, column, row; unmoved boxes descend below earlier siblings', `${rule('h16_item_order')}–${rule('h20_unmoved_box_descent')}`],
    ['`placeBlock`', at('src/core/place.ts', 'const placeBlock = '), 'one block: caller alignment, monotone rows, descent, offsets and locks per vertex', `${rule('h13_caller_alignment')}–${rule('h15_block_descent')}, ${rule('h21_moved_function_descent')}`],
    ['frames', at('src/core/place.ts', 'const frame = (x: Rect): Rect =>'), 'frame extents (tight or keeping the computed corner)', rule('h22_frame_extent')],
    ['`settleMoved`', at('src/core/settle.ts', 'export function settleMoved('), 'moved units on other content go to the nearest clear offset, least displacement first, ≤ 3 rounds', rule('h23_settle')],
    ['`buildGrid`', at('src/core/grid.ts', 'export function buildGrid('), 'draws the calls (section 4)', `${rule('h24_tree_lines_first')}–${rule('h29_route_cost')}`],
];

// ---- 4. one call ------------------------------------------------------------------------------------
const G = 'src/core/grid.ts', S = 'src/core/scene.ts', Q = 'src/core/quotient.ts', LY = 'src/core/layout.ts';
const tree = `<pre>
call u → v in the data (graph.edges)
├── u or v in an excluded folder, external, standard library ──────────► not drawn, no marker         ${href(S, 'function excludedKeys(')}
├── u or v hidden, or the call cut (removed) ──────────────────────────► not drawn; <code>>></code> or <code>└─>></code> on the end shown   ${href(S, 'function dropCalls(')}
├── u and v in one collapsed container ─────────────────────────────────► counted on the container (tooltip: internal calls)   ${href(Q, 'export function quotient(')}
├── u or v in a collapsed container ────────────────────────────────────► drawn from or to the container's vertex
├── an end not revealed (side closed, past the call depth) ─────────────► not drawn; marker on the end shown   ${href('src/core/reveal.ts', 'export function reveal(')}
├── u = v, or v above u in the same chain of one block ─────────────────► <code>↻</code>, <code>↻ v()</code> after u's label, no line   ${href(LY, "vg.selfLoops.has(k) ? ' ↻' : ''")}
└── both ends placed
    ├── u is v's tree parent, one block, one shift ─────────────────────► tree elbow <code>└─></code> (net t:u)   ${href(G, 'for (const [p, kids] of L.children) elbows(')}
    ├── v takes calls through a lane (joint rule, callers in the block)
    │   ├── every source and v share one shift, the lane column clear ──► lane <code>┌──┘ └─></code> or <code>&lt;──┘</code> (net l:v)   ${href(G, 'for (const ln of L.lanes) {', '// ---- 2.')}
    │   └── otherwise ────────────────────────────────────────────────► routed
    └── routed (A*), in order: straightened, level (shortest first), the rest (longest first)   ${href(G, 'todo.sort((a, b) => pri(b) - pri(a)')}
        ├── arrival side, decided per callee before routing   ${href(G, 'const left = own || sends ||')}
        │   ├── v's lane already enters from the left ────────────────► left <code>──> v()</code>
        │   ├── v sends calls from its label end ──────────────────────► left
        │   ├── callers mostly left of v, two cells before v free ─────► left
        │   └── otherwise ────────────────────────────────────────────► right end <code>v() <──</code>
        ├── departure   ${href(G, 'const starts: { id: number;')}
        │   ├── u's label end (cost 0), unless u receives at its end
        │   ├── under or over u's first character (cost 2), when free
        │   └── no start free ────────────────────────────────────────► dashed fallback
        └── search: (cell, heading) states, step 1, bend +3, crossing +6, frame border +4, own line 0.3   ${href(G, 'for (let pass = 0; pass < 2 && goal < 0; pass++)')}
            ├── pass 1 strict: no running along or turning on another line ► drawn
            ├── pass 2 relaxed: those at +400 and +40 ────────────────► drawn
            └── no route in 400 000 steps ────────────────────────────► dashed fallback L with its arrowhead   ${href(G, 'const fallback = () => {')}
</pre>`;

// ---- document ------------------------------------------------------------------------------------
const table = (head: string[], rows: Row[]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const doc = `# gaffy node order: triggers, interpreters, layout

Every function that changes which functions a view shows or where they sit, in three kinds, and the decision tree of one call's drawing. Generated by \`npm run heuristics\` from [scripts/ordering.ts](scripts/ordering.ts): the line links follow the code. The rules named h01–h35 are explained in [.HEURISTICS.md](.HEURISTICS.md).

1. **Triggers**: user actions in the webview (mouse, keys, toolbar, Options), the context menu, and events outside the view.
2. **Interpreters**: functions that turn a trigger into a change of the view document (\`ViewDoc.view\`) and commit it; each commit is one undo step.
3. **Layout**: functions that compute positions from a view document, on every redraw; the same document gives the same picture.

Terms:
- **unit**: what one move displaces: a function with its tree below it (key), a namespace box with its content (\`box:<key>\`), or a collapsed container (\`collapsed:<key>\`).
- **offset**: a unit's move \`[Δcolumn, Δrow]\` from its computed place; **lock**: its absolute cell.
- **settle**: moved units that content grew into move to the nearest clear offset (\`settleMoved\`); the webview saves those offsets.
- **anchor**: the function the view pans to keep still after an action (no view change).

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

Nets: \`t:<parent>\` holds a tree stem and its elbows, \`l:<target>\` every call into one function (lanes, routes, the arrival). Calls into one function merge into one trunk (cost 0.3 on its own net).

## Trace

Setting \`gaffy.trace\` records every view change to \`.gaffy/trace/<view>.jsonl\` (${at('src/host/trace.ts', 'export class Trace')}): the event, its target and grid cell, the functions above that acted, the view fields changed, the labels and boxes that moved; undo and redo included. \`node tools/gaffy-trace.mjs <file>\` prints it as a list ([tools/gaffy-trace.mjs](tools/gaffy-trace.mjs)).
`;
writeFileSync(resolve(ROOT, OUT), doc);
console.log(`${OUT}: ${T_MOUSE.length + T_KEYS.length + T_BAR.length + T_MENU.length + T_OUT.length} triggers, ${I.length} interpreters, ${P.length} layout functions`);
