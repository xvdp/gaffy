// Layout pipeline spec shared by scripts/heuristics.ts (docs) and scripts/explain.ts (decision log): functions,
// calls, and the code anchor of each rule of src/core/rules.ts (texts, switches, parameters live there); `locate`
// resolves anchors to lines in the working tree.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RULES as SPECS, RuleSpec } from '../src/core/rules';

// ---- spec ---------------------------------------------------------------------------------------------
/** Pipeline functions: id, file, definition-line text. */
export const FNS: [string, string, string][] = [
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

/** Pipeline calls: caller, callee, call text. */
export const CALLS: [string, string, string][] = [
    ['render', 'buildScene', 'scene = buildScene(doc, style, excludes, outside(), debugOf(log))'],
    ['render', 'afterRender', 'setTimeout(afterRender, 0)'],
    ['buildScene', 'sortKeyOf', 'sortKey: (k) => (isStub(k)'],
    ['buildScene', 'revealView', 'revealView('],
    ['revealView', 'reveal', 'return reveal(vq'],
    ['revealView', 'revealDepth', 'revealDepth(vq, depthSeeds'],
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
    ['dragUnit', 'anchorAt', "if (still && R().on('h31_still_anchor')) anchorAt(still); else anchor"],
    ['runCmd', 'anchorAt', "if (still && R().on('h31_still_anchor')) anchorAt(still);"],
];

export interface Anchor { id: string; in: string; at: string; also?: [string, string][] }

/** Code anchor per rule (src/core/rules.ts): function holding it (`in`), text of its line (`at`), further sites. */
export const ANCHORS: Anchor[] = [
    { id: 'h01_first_revealer', in: 'reveal', at: 'for (const e of [...(vg.out.get(k) ?? [])].sort((a, b) => a.line - b.line))' },
    { id: 'h02_call_depth_by_path', in: 'revealDepth', at: "if (rule === 'shortest') {" },
    { id: 'h03_box_order', in: 'boxTree', at: 'for (const v of all) {' },
    { id: 'h04_sort_key', in: 'sortKeyOf', at: 'return `${n?.path' },
    { id: 'h05_marker_row_first', in: 'buildScene', at: 'sortKey: (k) => (isStub(k)' },
    { id: 'h06_root_order', in: 'layout', at: 'const rootCmp = ' },
    { id: 'h07_child_order', in: 'layout', at: 'const orderedOut = ' },
    { id: 'h08_row_order', in: 'layout', at: 'const order = post.reverse();' },
    { id: 'tree_parent_rule', in: 'layout', at: 'if (joint && callers.length >= 2)' },
    { id: 'h09_joint_parent', in: 'tree_parent_rule', at: 'if (joint && callers.length >= 2)' },
    { id: 'h10_dfs_nearest_parent', in: 'tree_parent_rule', at: "const cands: NodeKey[] = inp.parentRule === 'nearest'" },
    { id: 'h11_port_row', in: 'layout', at: 'portOf.set(k, rows.length);' },
    { id: 'h12_lane_packing', in: 'layout', at: 'lanes.sort((a, b) =>' },
    { id: 'h13_caller_alignment', in: 'placeBlock', at: 'const rank = (k: NodeKey) =>' },
    { id: 'h14_monotone_rows', in: 'placeBlock', at: 'const rowsFrom = (t: number) =>' },
    { id: 'h15_block_descent', in: 'placeBlock', at: 'const hit = avoid.find((a) => overlaps(a, rectOf(rowMap)));' },
    { id: 'h21_moved_function_descent', in: 'placeBlock', at: 'const mine = new Set(descendants(k));' },
    { id: 'h16_item_order', in: 'placeBox', at: 'const order = [...topo.filter' },
    { id: 'h17_item_column', in: 'placeBox', at: ': colOn ? Math.max(...sibCallers' },
    { id: 'h18_item_row', in: 'placeBox', at: ': rowOn && callers.length ? Math.max(cr' },
    { id: 'h41_callee_below', in: 'placeBox', at: "R.on('h41_callee_below')" },
    { id: 'item_state', in: 'placeBox', at: 'const lock = lockOf(unit);' },
    { id: 'h19_lock_and_box_offset', in: 'item_state', at: 'const [dc, dr] = lock ? ' },
    { id: 'h20_unmoved_box_descent', in: 'item_state', at: 'const snapshot = snapshotP();' },
    { id: 'h22_frame_extent', in: 'placeBox', at: 'const frame = (x: Rect): Rect =>' },
    { id: 'h23_settle', in: 'settleMoved', at: 'const ranked = todo.map(' },
    { id: 'h38_frame_overlap', in: 'placeBox', at: "const soft = R.on('h38_frame_overlap')", also: [['settleMoved', "R.on('h38_frame_overlap')"]] },
    { id: 'h24_tree_lines_first', in: 'buildGrid', at: '// h24: tree elbows and lanes first' },
    { id: 'h25_routing_order', in: 'buildGrid', at: 'todo.sort((a, b) => pri(b) - pri(a)' },
    { id: 'h26_arrival_side', in: 'buildGrid', at: 'const sends = departs.has(v)' },
    { id: 'h27_departure_reservation', in: 'buildGrid', at: 'if (!reserved.has(cellId(r, cc))) reserved.set(cellId(r, cc), `src:${e.from}`)' },
    { id: 'h28_departure_point', in: 'buildGrid', at: 'const starts: { id: number; r: number; c: number; d: number; cost: number }[] =' },
    { id: 'h29_route_cost', in: 'buildGrid', at: 'if (nd !== d) step += cost.bend + turnPenalty;' },
    { id: 'h39_reroute', in: 'buildGrid', at: "const rounds = R.p('h39_reroute', 'rounds')" },
    { id: 'h40_lookahead', in: 'buildGrid', at: "const LOOK = routable ? R.p('h40_lookahead', 'weight') : 0;" },
    { id: 'h36_call_kind_style', in: 'buildGrid', at: 'const kinds = new Map<number, CallKind>();' },
    { id: 'h37_hops', in: 'render', at: 'for (const [net, d] of maskPaths(g))' },
    { id: 'h30_action_anchor', in: 'render', at: 'const at = nameCell(sc, anchor.key);', also: [['anchorAt', 'anchor = { key: k, at:']] },
    { id: 'h31_still_anchor', in: 'dragUnit', at: 'const still = [...doc!.view.seeds', also: [['runCmd', 'const still = [...doc.view.seeds']] },
    { id: 'h32_multi_unit_drag', in: 'topUnits', at: 'return [...keys].filter((k) => {' },
    { id: 'h33_drop_repulsion', in: 'settleDrop', at: 'if (clean(dc, dr)) return [dc, dr];' },
    { id: 'h34_offset_handover', in: 'afterRender', at: 'commit((x) => { x.view.offset[p] = off;', also: [['setSide', 'adopt = { key: k, renders: 0 }']] },
    { id: 'h35_save_what_is_drawn', in: 'afterRender', at: 'if (sc.offsets === doc.view.offset)' },
];

export interface Rule extends RuleSpec, Anchor {}

/** Rules of the registry with their anchors, in registry order. */
export const RULES: Rule[] = SPECS.flatMap((r) => {
    const a = ANCHORS.find((x) => x.id === r.id);
    return a ? [{ ...r, ...a }] : [];
});
/** Registry rules without an anchor: `npm run heuristics` fails on them. */
export const UNANCHORED = SPECS.filter((r) => !ANCHORS.some((a) => a.id === r.id)).map((r) => r.id);

// ---- lines ------------------------------------------------------------------------------------------
/** Code lines of functions and rules (0-based), from the anchors; throws on a missing anchor. */
export function locate(root: string) {
    const files = new Map<string, string[]>();
    const linesOf = (f: string) => { if (!files.has(f)) files.set(f, readFileSync(resolve(root, f), 'utf8').split('\n')); return files.get(f)!; };
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
    /** Function owning a rule or decision (a decision's rules: the decision's function). */
    const fnOf = (id: string): string => (fn.has(id) ? id : fnOf(RULES.find((r) => r.id === id)!.in));
    return { find, fn, fileOf, defLine, ruleLine, fnOf };
}
