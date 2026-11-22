// Generates .HEURISTICS.md (graph picture and explanations) and .heuristics.gaffy (the same graph as a static
// gaffy view) from the spec below. Lines are found by searching each anchor's text after the definition of
// the function it belongs to, so the links follow the code: `npm run heuristics` after a change.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toHtmlPre } from '../src/core/grid';
import { GEdge, GNode } from '../src/core/model';
import { buildScene } from '../src/core/scene';
import { DEFAULT_STYLE, glyphSet } from '../src/core/style';
import { emptyDoc, serializeDoc } from '../src/core/viewdoc';

const ROOT = process.cwd();
const DOC = '.HEURISTICS.md';
const VIEW = '.heuristics.gaffy';

// ---- spec ---------------------------------------------------------------------------------------------
/** Functions of the pipeline: id, file, text of the definition line. */
const FNS: [string, string, string][] = [
    ['render', 'src/webview/main.ts', 'function render() {'],
    ['afterRender', 'src/webview/main.ts', 'function afterRender() {'],
    ['setSide', 'src/webview/main.ts', 'function setSide('],
    ['anchorAt', 'src/webview/main.ts', 'function anchorAt('],
    ['dragUnit', 'src/webview/main.ts', 'function dragUnit('],
    ['topUnits', 'src/webview/main.ts', 'function topUnits('],
    ['settleDrop', 'src/webview/main.ts', 'function settleDrop('],
    ['runCmd', 'src/webview/main.ts', 'function runCmd('],
    ['buildScene', 'src/core/scene.ts', 'export function buildScene('],
    ['sortKeyOf', 'src/core/scene.ts', 'export function sortKeyOf('],
    ['revealView', 'src/core/scene.ts', 'function revealView('],
    ['reveal', 'src/core/reveal.ts', 'export function reveal('],
    ['revealDepth', 'src/core/reveal.ts', 'export function revealDepth('],
    ['boxTree', 'src/core/boxes.ts', 'export function boxTree('],
    ['place', 'src/core/place.ts', 'export function place('],
    ['placeBox', 'src/core/place.ts', 'const placeBox = '],
    ['placeBlock', 'src/core/place.ts', 'const placeBlock = '],
    ['layout', 'src/core/layout.ts', 'export function layout('],
    ['settleMoved', 'src/core/settle.ts', 'export function settleMoved('],
    ['buildGrid', 'src/core/grid.ts', 'export function buildGrid('],
];

/** Calls between pipeline functions: caller, callee, text of the call. */
const CALLS: [string, string, string][] = [
    ['render', 'buildScene', 'scene = buildScene(doc, style, excludeRx, outside())'],
    ['render', 'afterRender', 'setTimeout(afterRender, 0)'],
    ['buildScene', 'sortKeyOf', 'sortKey: (k) => (isStub(k)'],
    ['buildScene', 'revealView', 'revealView('],
    ['revealView', 'reveal', 'return reveal(vq'],
    ['revealView', 'revealDepth', 'return revealDepth(vq'],
    ['buildScene', 'boxTree', 'boxTree('],
    ['buildScene', 'place', 'place({'],
    ['buildScene', 'settleMoved', 'const moves = settleMoved(placement'],
    ['buildScene', 'buildGrid', 'const grid = buildGrid('],
    ['place', 'placeBox', 'const all = placeBox('],
    ['placeBox', 'placeBlock', 'r = placeBlock(box, col, top, true, avoid)'],
    ['placeBox', 'placeBox', 'r = placeBox(it.box, col, rr, [])'],
    ['placeBlock', 'layout', 'const L = layout({ ...inp.base'],
    ['setSide', 'anchorAt', 'anchorAt(k);'],
    ['dragUnit', 'topUnits', 'topUnits(sc, selected)'],
    ['dragUnit', 'settleDrop', 'const [a, b] = settleDrop(units, dc, dr)'],
    ['dragUnit', 'anchorAt', 'if (still) anchorAt(still)'],
    ['runCmd', 'anchorAt', 'if (still) anchorAt(still);'],
];

interface Rule { id: string; stage: string; title: string; in: string; at: string; text: string; also?: [string, string][] }

/** Heuristics and the decisions that choose between them: the node they hang under, text of their code line, definition. */
const RULES: Rule[] = [
    { id: 'h01_first_revealer', stage: 'Reveal', title: 'First revealer', in: 'reveal', at: 'for (const e of [...(vg.out.get(k) ?? [])].sort((a, b) => a.line - b.line))',
        text: 'One layer at a time: sides open in seed order, and each function\'s neighbours by call line. The first function to reveal another is its opener: the opener fixes the side the revealed function may open and the level an arrowhead into it closes.' },
    { id: 'h02_call_depth_by_path', stage: 'Reveal', title: 'Call depth by path', in: 'revealDepth', at: '// longest: per side',
        text: 'Full layout: a function\'s level is its fewest calls from a seed (shortest) or its most calls with loops ignored (longest).' },
    { id: 'h03_box_order', stage: 'Boxes', title: 'Box first-appearance order', in: 'boxTree', at: 'for (const v of all) {',
        text: 'Boxes are created in the order their functions occur in the data. The order only breaks ties of h16_item_order.' },
    { id: 'h04_sort_key', stage: 'Block layout', title: 'Sort key', in: 'sortKeyOf', at: 'return `${n?.path',
        text: 'Ties are broken by (file path, definition line, name).' },
    { id: 'h05_marker_row_first', stage: 'Block layout', title: 'Marker row first', in: 'buildScene', at: 'sortKey: (k) => (isStub(k)',
        text: 'A `└─>>` marker has the empty sort key: it is always a function\'s first child row.' },
    { id: 'h06_root_order', stage: 'Block layout', title: 'Root order', in: 'layout', at: 'const rootCmp = ',
        text: 'The top-level functions of a block are ordered by your Move Up/Down order, then the rows of their outside callers (h13_caller_alignment), then seed order, then h04_sort_key.' },
    { id: 'h07_child_order', stage: 'Block layout', title: 'Child order', in: 'layout', at: 'const orderedOut = ',
        text: 'A function\'s calls are ordered by your Move Up/Down order, then call line, then h04_sort_key.' },
    { id: 'h08_row_order', stage: 'Block layout', title: 'Row order', in: 'layout', at: 'const order = post.reverse();',
        text: 'Rows follow a depth-first walk from uncalled functions (seeds first where a loop has no entry). Every caller row lies above its callee rows, except calls back up a loop, which show as `↻` tags.' },
    { id: 'tree_parent_rule', stage: 'Block layout', title: 'Decision: tree parent rule', in: 'layout', at: 'if (joint && callers.length >= 2)',
        text: 'Chooses the caller a function hangs under (`└─>`): `joint` (style `grid.parentRule`, the default) for a function with two or more callers in the block, else `dfs` or `nearest`.' },
    { id: 'h09_joint_parent', stage: 'Block layout', title: 'Joint parent', in: 'tree_parent_rule', at: 'if (joint && callers.length >= 2)',
        text: 'Two or more callers in the block: a caller directly above shares its branch (`├───┴─>`); otherwise the function takes no tree parent and every call enters from the left through one collector line (`┌──┘`, `└─>`).' },
    { id: 'h10_dfs_nearest_parent', stage: 'Block layout', title: 'dfs / nearest parent', in: 'tree_parent_rule', at: "const cands: NodeKey[] = inp.parentRule === 'nearest'",
        text: '`dfs`: the caller that first reached the function in the walk. `nearest`: the closest caller above whose vertical line no row in between would cross. Without a parent, a function is indented under its nearest caller.' },
    { id: 'h11_port_row', stage: 'Block layout', title: 'Port row', in: 'layout', at: 'portOf.set(k, rows.length);',
        text: 'A function that both receives and sends routed calls gets a row below it; its outgoing lines leave from there, so an incoming and an outgoing line never share a row.' },
    { id: 'h12_lane_packing', stage: 'Block layout', title: 'Lane packing', in: 'layout', at: 'lanes.sort((a, b) =>',
        text: 'Vertical call lines are placed shortest first, each in the first free column right of every label it passes.' },
    { id: 'h13_caller_alignment', stage: 'Placement', title: 'Caller alignment', in: 'placeBlock', at: 'const rank = (k: NodeKey) =>',
        text: 'Each top-level function of a block takes the earliest outside-caller row still free, so its incoming call can run level.' },
    { id: 'h14_monotone_rows', stage: 'Placement', title: 'Monotone rows', in: 'placeBlock', at: 'const rowsFrom = (t: number) =>',
        text: 'A row\'s position is the larger of "row above + 1" and its preferred row (h13_caller_alignment); an approach row stays directly above its function.' },
    { id: 'h15_block_descent', stage: 'Placement', title: 'Block descent', in: 'placeBlock', at: 'const hit = avoid.find((a) => overlaps(a, rectOf(rowMap)));',
        text: 'A block that would overlap something already placed moves down until clear.' },
    { id: 'h21_moved_function_descent', stage: 'Placement', title: 'Moved function descent', in: 'placeBlock', at: '// shifted unlocked subtrees descend',
        text: 'A moved, unlocked function with its tree moves down until its labels clear the other labels of its own block.' },
    { id: 'h16_item_order', stage: 'Placement', title: 'Item order', in: 'placeBox', at: 'const order = [...topo.filter',
        text: 'Within a box: locked items first, then callers\' items before callees\' items (ties by h03_box_order).' },
    { id: 'h17_item_column', stage: 'Placement', title: 'Item column', in: 'placeBox', at: 'const col = sibCallers.length ?',
        text: 'An item goes right of the rightmost earlier item that calls into it, plus a channel of `route.channel` columns + 1 per incoming call; otherwise at the box\'s left edge.' },
    { id: 'h18_item_row', stage: 'Placement', title: 'Item row', in: 'placeBox', at: 'const top = callers.length ?',
        text: 'An item starts at its first placed caller\'s row, else below the unlocked items already placed.' },
    { id: 'item_state', stage: 'Placement', title: 'Decision: locked, moved or unmoved item', in: 'placeBox', at: 'const lock = inp.lock[unit];',
        text: 'A box item is placed by its lock, by its offset, or by trial placement.' },
    { id: 'h19_lock_and_box_offset', stage: 'Placement', title: 'Lock and box offset', in: 'item_state', at: 'if (lock) r = placeBox(it.box, lock[0], lock[1], []);',
        text: 'A locked box sits at its fixed cell; a moved box is displaced from the row it would take unmoved.' },
    { id: 'h20_unmoved_box_descent', stage: 'Placement', title: 'Unmoved box descent', in: 'item_state', at: '// trial placement, then descend below overlapped siblings',
        text: 'An unmoved box that overlaps an earlier item moves down until clear. Moved boxes are exempt; h23_settle handles them.' },
    { id: 'h22_frame_extent', stage: 'Placement', title: 'Frame extent', in: 'placeBox', at: 'const frame = (x: Rect): Rect =>',
        text: 'Tight boxes (style `boxes.tight`, the default): a frame is its content\'s bounding box plus margin. Otherwise the frame keeps the box\'s unmoved corner and only grows.' },
    { id: 'h23_settle', stage: 'Placement', title: 'Settle', in: 'settleMoved', at: 'const ranked = todo.map(',
        text: 'Every redraw, moved units whose labels or frames lie on other content move to the nearest clear offset, up to 3 rounds (the loop in buildScene). The shortest move goes first; ties: boxes before functions, then the smaller unit. Search: 12 cells around (vertical first), then straight lines up to 80, never off the top or left edge. Locked units never move. Lines are not considered.' },
    { id: 'h24_tree_lines_first', stage: 'Routing', title: 'Tree lines first', in: 'buildGrid', at: 'for (const [p, kids] of P.elbows ?? [])',
        text: 'Tree branches and lanes are drawn before routed calls; a branch between functions with different offsets is routed instead.' },
    { id: 'h25_routing_order', stage: 'Routing', title: 'Routing order', in: 'buildGrid', at: 'todo.sort((a, b) => pri(b) - pri(a)',
        text: 'Straightened calls first, then level calls (shortest first), then the rest (longest first).' },
    { id: 'h26_arrival_side', stage: 'Routing', title: 'Arrival side', in: 'buildGrid', at: 'const sends = departs.has(v)',
        text: 'A call enters from the left when most callers are to the function\'s left, or the function sends from its label end, or the joint rule applies; else at its right end. The two cells on the entering side are reserved for its incoming calls.' },
    { id: 'h27_departure_reservation', stage: 'Routing', title: 'Departure reservation', in: 'buildGrid', at: '// departure cells reserved for their caller',
        text: 'The two cells right of a caller\'s label end, or right of its port, are reserved for its outgoing calls.' },
    { id: 'h28_departure_point', stage: 'Routing', title: 'Departure point', in: 'buildGrid', at: 'const starts: { id: number; r: number; c: number; d: number; cost: number }[] =',
        text: 'A call leaves from the label end (cost 0) or from under or over the first character (cost 2). A function whose end receives calls never sends from it; with no free start the call is drawn dashed.' },
    { id: 'h29_route_cost', stage: 'Routing', title: 'Route cost', in: 'buildGrid', at: 'if (nd !== d) step += opts.cost.bend + turnPenalty;',
        text: 'A* over (cell, heading), guided by the grid (Manhattan) distance to the arrival cell. Each step costs 1; +4 entering a frame border (`route.border`), +6 crossing another call\'s line (`route.cross`), 0.3 along this target\'s own line (joining it), +3 per change of heading (`route.bend`), +2 for a vertical step next to another call\'s vertical line (`route.adjacent`). Never: label cells and padding, markers, reversing, running along a border, cells reserved for another call. The first pass forbids running along or turning on another line; a second pass allows them at +400 and +40. No route in both passes (400 000 search steps): dashed.' },
    { id: 'h30_action_anchor', stage: 'Webview', title: 'Action anchor', in: 'render', at: 'const at = nameCell(sc, anchor.key);', also: [['anchorAt', 'anchor = { key: k, at:']],
        text: 'The function you last opened, closed or removed keeps its spot on screen: the view pans to compensate.' },
    { id: 'h31_still_anchor', stage: 'Webview', title: 'Still anchor', in: 'dragUnit', at: 'const still = [...doc!.view.seeds', also: [['runCmd', 'const still = [...doc.view.seeds']],
        text: 'After a drag or Re-arrange Selection, the view stays fixed on a seed or another function that did not move.' },
    { id: 'h32_multi_unit_drag', stage: 'Webview', title: 'Multi-unit drag', in: 'topUnits', at: 'return [...keys].filter((k) => {',
        text: 'Dragging a selected function moves each selected function with the functions below it, each once; one inside another selected function\'s tree moves with that function.' },
    { id: 'h33_drop_repulsion', stage: 'Webview', title: 'Drop repulsion', in: 'settleDrop', at: 'if (clean(dc, dr)) return [dc, dr];',
        text: 'A drop on content, or one that leaves a call unroutable, moves on in the drag direction, then sideways, up to 12 cells or 1.5 s. Since h23_settle runs in buildScene, every trial spot looks clear and this rule changes nothing.' },
    { id: 'h34_offset_handover', stage: 'Webview', title: 'Offset handover', in: 'afterRender', at: 'commit((x) => { x.view.offset[p] = off;', also: [['setSide', 'adopt = { key: k, renders: 0 }']],
        text: 'Opening the callers of a moved function: when a caller revealed by that opening becomes its tree parent and has no offset or lock, the caller takes the function\'s offset and the function loses it. The offset now moves both, so the caller sits right above the function where you put it.' },
    { id: 'h35_save_what_is_drawn', stage: 'Webview', title: 'Save what is drawn', in: 'afterRender', at: 'if (sc.offsets === doc.view.offset)',
        text: 'The view saves the offsets h23_settle drew with, at most 3 saves in a row; any other change resets the count.' },
];

// ---- lines ------------------------------------------------------------------------------------------
const files = new Map<string, string[]>();
const linesOf = (f: string) => { if (!files.has(f)) files.set(f, readFileSync(resolve(ROOT, f), 'utf8').split('\n')); return files.get(f)!; };
/** 0-based line of the first line holding `text` at or after line `from`. */
function find(file: string, text: string, from = 0): number {
    const ls = linesOf(file);
    for (let i = from; i < ls.length; i++) if (ls[i].includes(text)) return i;
    throw new Error(`${file}: not found after line ${from + 1}: ${text}`);
}
const fn = new Map(FNS.map(([id, file, def]) => [id, { id, file, line: find(file, def) }] as const));
const fileOf = (id: string): string => fn.get(id)?.file ?? fileOf(RULES.find((r) => r.id === id)!.in);
const defLine = (id: string): number => fn.get(id)?.line ?? defLine(RULES.find((r) => r.id === id)!.in);
const ruleLine = new Map(RULES.map((r) => [r.id, find(fileOf(r.in), r.at, defLine(r.in))] as const));
/** The function a rule or decision belongs to (a decision's rules: the decision's function). */
const fnOf = (id: string): string => (fn.has(id) ? id : fnOf(RULES.find((r) => r.id === id)!.in));

// ---- explanations (.HEURISTICS.md) ---------------------------------------------------------------------
const STAGES = ['Reveal', 'Boxes', 'Block layout', 'Placement', 'Routing', 'Webview'];
const code = (file: string, line: number) => `[${file.split('/').pop()}:${line + 1}](${file}#L${line + 1})`;
const body: string[] = [];
const heading = new Map<string, number>();       // rule id → 0-based line of its heading in the document
const intro = [
    '# gaffy layout heuristics',
    '',
    'The rules that decide what is on screen, where it sits and how calls are drawn, in the order the code applies them. Generated by `npm run heuristics` from [scripts/heuristics.ts](scripts/heuristics.ts); the same graph opens in gaffy as [.heuristics.gaffy](.heuristics.gaffy) (a static view: no language server).',
    '',
    'Structure: a pipeline of stages (reveal → boxes → block layout → placement → settle → routing, then the webview after layout). Inside the stages, decisions choose between rules (`tree_parent_rule`, `item_state`); four rules are orderings rather than steps (h04, h06, h07, h25); two loops repeat at most 3 times (settle inside `buildScene`, save and redraw in the webview).',
    '',
    'Reading the graph: a function calls the functions and rules below it in code order (call line). In the picture and in gaffy, a function opens its code, a rule or decision opens its explanation below; in gaffy, right click a line > Go to Call Site opens the rule\'s code line.',
    '',
    '## Terms',
    '',
    '- **block**: the functions directly in one namespace box, laid out together.',
    '- **tree parent**: the caller a function hangs under (`└─>`); its other callers reach it by routed lines.',
    '- **offset**: the stored displacement (columns, rows) of something you dragged, from where the layout would put it.',
    '- **unit**: a function with the functions hanging below it, or a box with its content; an offset moves its whole unit.',
    '',
];

// ---- graph ------------------------------------------------------------------------------------------
const NODE_FILE = (f: string) => `ts:${f}`;
const key = (id: string) => `${NODE_FILE(fileOf(id))}#${id}`;
const module = (f: string) => f.replace(/\.ts$/, '');
const uriOf = (f: string) => pathToFileURL(resolve(ROOT, f)).href;

function graph(docLines: Map<string, number>): { nodes: Record<string, GNode>; edges: GEdge[] } {
    const nodes: Record<string, GNode> = {};
    const add = (n: GNode) => { nodes[n.key] = n; };
    const dirs = new Set<string>();
    for (const f of new Set([...fn.values()].map((x) => x.file))) {
        const parts = f.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        add({ key: NODE_FILE(f), kind: 'file', name: f.split('/').pop()!.replace(/\.ts$/, ''), qual: '', module: module(f), parent: `dir:${parts.join('/')}`, uri: uriOf(f), path: f, line: 0 });
    }
    for (const d of dirs) {
        const up = d.includes('/') ? `dir:${d.slice(0, d.lastIndexOf('/'))}` : null;
        add({ key: `dir:${d}`, kind: 'folder', name: d.split('/').pop()!, qual: '', module: d, parent: up, uri: uriOf(d), path: d });
    }
    for (const x of fn.values()) {
        add({ key: key(x.id), kind: 'function', name: x.id, qual: x.id, module: module(x.file), parent: NODE_FILE(x.file), uri: uriOf(x.file), path: x.file, line: x.line, detail: 'code' });
    }
    for (const r of RULES) {
        // boxed with the code that applies it, opening its explanation
        add({ key: key(r.id), kind: 'function', name: r.id, qual: r.id, module: module(fileOf(r.in)), parent: NODE_FILE(fileOf(r.in)), uri: uriOf(DOC), path: DOC, line: docLines.get(r.id) ?? 0,
            detail: `${r.title}: code ${fileOf(r.in)}:${ruleLine.get(r.id)! + 1}` });
    }
    const edges: GEdge[] = [];
    for (const [a, b, at] of CALLS) edges.push({ from: key(a), to: key(b), line: find(fileOf(a), at, defLine(a)) });
    for (const r of RULES) {
        edges.push({ from: key(r.in), to: key(r.id), line: ruleLine.get(r.id)! });
        for (const [a, at] of r.also ?? []) edges.push({ from: key(a), to: key(r.id), line: find(fileOf(a), at, defLine(a)) });
    }
    return { nodes, edges };
}

function view(docLines: Map<string, number>) {
    const doc = emptyDoc('heuristics', { seeds: ['render', 'setSide', 'dragUnit', 'runCmd'].map(key), direction: 'out', arrange: 'auto', depthUp: 0, depthDown: 'all' });
    doc.view.static = true;
    doc.graph = graph(docLines);
    doc.explored = Object.fromEntries(Object.keys(doc.graph.nodes).map((k) => [k, 'both' as const]));
    return doc;
}

// ---- write --------------------------------------------------------------------------------------------
// headings first (their lines feed the graph), the picture between intro and explanations
function sections(): string[] {
    const out: string[] = [];
    for (const stage of STAGES) {
        out.push(`## ${stage}`, '');
        for (const r of RULES.filter((x) => x.stage === stage)) {
            heading.set(r.id, out.length);
            out.push(`### ${r.id}`, '', `**${r.title}.** ${r.text}`, '', `Code: ${code(fileOf(r.in), ruleLine.get(r.id)!)}, in \`${fnOf(r.in)}\`` +
                (r.also ?? []).map(([a, at]) => `; ${code(fileOf(a), find(fileOf(a), at, defLine(a)))}, in \`${a}\``).join('') + '.', '');
        }
    }
    return out;
}
body.push(...sections());
// the picture's height is fixed by the graph, not by the heading lines: draw once to measure, then with the lines
const draw = (docLines: Map<string, number>) => {
    const d = view(docLines);
    const sc = buildScene(d, DEFAULT_STYLE);
    const href = (k: string) => {
        const id = k.slice(k.indexOf('#') + 1);
        if (fn.has(id)) return `${fn.get(id)!.file}#L${fn.get(id)!.line + 1}`;
        return RULES.some((r) => r.id === id) ? `#${id}` : undefined;
    };
    return { d, pre: ['## Pipeline graph', '', '<pre>', toHtmlPre(sc.grid, glyphSet(DEFAULT_STYLE), href, (k) => d.view.seeds.includes(k)), '</pre>', ''] };
};
// heading lines depend on the picture's height; node lines (the headings) can break ties in the layout:
// redraw until the height is stable
const height = (pre: string[]) => pre.join('\n').split('\n').length;
let final = draw(new Map());
for (let round = 0; round < 4; round++) {
    const next = draw(new Map([...heading].map(([id, l]) => [id, intro.length + height(final.pre) + l])));
    const same = height(next.pre) === height(final.pre);
    final = next;
    if (same) break;
}
writeFileSync(resolve(ROOT, DOC), [...intro, ...final.pre, ...body].join('\n'));
writeFileSync(resolve(ROOT, VIEW), serializeDoc(final.d));
console.log(`${DOC}: ${RULES.length} rules, ${fn.size} functions; ${VIEW}`);
