/** @xvdp
 * 2D placement of namespace boxes and blocks on the character grid; cells [column, row], origin (0, 0).
 * block: direct members of one box, laid out by grid lanes (layout.ts).
 *
 * Per box, top-down:
 * 1. Items: member block, then child boxes; locked first, then topological call order (DFS reverse postorder,
 *    back edges ignored).
 * 2. Column: past the rightmost earlier sibling caller + routing channel; else the content column.
 * 3. Row: topmost placed caller's row; else below earlier siblings. Unmoved items descend past placed
 *    siblings, offset-moved ones counted unmoved (settle.ts clears collisions): moves never push unmoved
 *    items down.
 * 4. Block rows: roots ordered by (earliest, latest) outside caller row, each at its earliest caller row still
 *    free (level calls); row(i) = max(row(i-1) + 1, pref(i)) (greedy, monotone).
 * 5. Moves: box unit: rigid translation from its unmoved place by `offset`, or onto its `lock` cell (frame
 *    corner); content keeps its rows relative to the frame; vertex unit: shifts its tree descendants,
 *    descending (unlocked) until labels clear. Later items place from unmoved positions (`moved`: shift per
 *    vertex; `base`: unmoved rectangle per item).
 * 6. Frames: from the box's computed corner, grown over content moved up or left. `tight`: frame hugs its
 *    content; lanes count where drawn.
 * Rules (rules.ts): switches h13, h15, h17, h18, h20, h21; parameters h17 channel, h21 margin, flags; the log
 * receives the decisions of the final placement (trial placements dropped).
 */
import { BoxNode } from './boxes';
import { layout, Layout, LayoutInput } from './layout';
import { NodeKey } from './model';
import { induced, VGraph } from './quotient';
import { Decision } from './explain';
import { Rules } from './rules';
import { boxUnit, Cell, collapsedUnit } from './viewdoc';

export interface Pos { row: number; col: number }

export interface Block {
    box: BoxNode;
    L: Layout;
    rowMap: number[];                  // layout row => global row before shifts
    col0: number;                      // global column of layout column 0
    shift: Map<NodeKey, Cell>;         // subtree displacement per vertex
}

export interface Frame { box: BoxNode; unit: string; c0: number; r0: number; c1: number; r1: number }

/** Clickable glyph: opens or restores a side of `key`. */
export interface Marker { row: number; col: number; text: string; key: NodeKey; side: 'up' | 'down' }

export interface Placement {
    blocks: Block[];
    frames: Frame[];
    blockOf: Map<NodeKey, Block>;
    pos: Map<NodeKey, Pos>;            // label start
    end: Map<NodeKey, number>;         // column after the label
    port: Map<NodeKey, Pos>;           // port: cell below label start
    text: Map<NodeKey, string>;
    width: number;
    height: number;
    elbows?: Map<NodeKey, NodeKey[]>;  // stable placement: tree elbows outside blocks
    markers?: Marker[];                // stable arrangement: markers of sides with hidden neighbors
}

export interface PlaceInput {
    vg: VGraph;                        // drawn graph (scene `drawn`)
    tree: BoxNode;
    base: Omit<LayoutInput, 'vg' | 'extIn' | 'extOut' | 'rootRank'>;
    offset: Record<string, Cell>;
    lock: Record<string, Cell>;
    tight?: boolean;                   // frames hug their content (view.tight)
    rules?: Rules;                     // switches, parameters, decision log (rules.ts)
    openedUp?: (k: NodeKey) => NodeKey | undefined;   // the function whose callers revealed `k` (reveal opener, side up)
}

interface Rect { c0: number; r0: number; c1: number; r1: number }
interface Area extends Rect { base: Rect }   // placed rectangle; base: unmoved rectangle
const shifted = (r: Rect, dc: number, dr: number): Rect => ({ c0: r.c0 + dc, r0: r.r0 + dr, c1: r.c1 + dc, r1: r.r1 + dr });
const overlaps = (a: Rect, b: Rect) => a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;

const verticesOf = (b: BoxNode): NodeKey[] => [...b.members, ...b.children.flatMap(verticesOf)];

/**
 * Placement; locks are cells of the drawn (normalized) picture. A run whose normalization shifts the picture (content
 * above row 0 or left of column 0) runs again with the locks offset by that shift, so locked units land on their
 * cells: at most 3 runs.
 */
export function place(inp: PlaceInput): Placement {
    let adjust: Cell = [0, 0];
    for (let run = 0; ; run++) {
        const { P, shift } = placeOnce(inp, adjust, run === 3 || !Object.keys(inp.lock).length);
        if (run === 3 || !Object.keys(inp.lock).length || (shift[0] === adjust[0] && shift[1] === adjust[1])) return P;
        adjust = shift;
    }
}

function placeOnce(inp: PlaceInput, adjust: Cell, final: boolean): { P: Placement; shift: Cell } {
    /** Lock cell of `u` before normalization: the drawn cell minus the normalization shift of this run. */
    const lockOf = (u: string): Cell | undefined => { const l = inp.lock[u]; return l && [l[0] - adjust[0], l[1] - adjust[1]]; };
    /** Move and lock unit of a vertex: its key, or `collapsed:<key>` (collapsed container). */
    const unitOf = (k: NodeKey) => (inp.vg.nodes.get(k)?.collapsed ? collapsedUnit(k) : k);
    const { vg } = inp;
    const R = inp.rules ?? new Rules();
    // decisions of the current placement; trial placements truncate it on restore
    const logs: Decision[] = [];
    const note = (d: Decision) => { if (R.log) logs.push(d); };
    const P: Placement = {
        blocks: [], frames: [], blockOf: new Map(), pos: new Map(), end: new Map(), port: new Map(), text: new Map(),
        width: 0, height: 0,
    };

    // cumulative offset shift per placed vertex
    const moved = new Map<NodeKey, Cell>();
    const addMove = (k: NodeKey, dc: number, dr: number) => { const m = moved.get(k) ?? [0, 0]; moved.set(k, [m[0] + dc, m[1] + dr]); };
    // unmoved departure row: port, else label
    const baseRow = (u: NodeKey) => (P.port.get(u) ?? P.pos.get(u)!).row - (moved.get(u)?.[1] ?? 0);
    const callerRows = (k: NodeKey, inside: ReadonlySet<NodeKey>): number[] =>
        (vg.inc.get(k) ?? []).filter((e) => !inside.has(e.from) && P.pos.has(e.from))
            .map((e) => baseRow(e.from)).sort((a, b) => a - b);

    // ---- block --------------------------------------------------------------------------------------
    const placeBlock = (box: BoxNode, col: number, top: number, auto: boolean, avoid: Rect[]): Area => {
        const keys = new Set(box.members);
        const sub = induced(vg, keys);
        const extIn = new Set<NodeKey>();
        const extOut = new Set<NodeKey>();
        for (const e of vg.edges) {
            if (keys.has(e.to) && !keys.has(e.from)) extIn.add(e.to);
            if (keys.has(e.from) && !keys.has(e.to)) extOut.add(e.from);
        }
        // roots by (earliest, latest) outside caller row, each at its earliest free one:
        // a hub caller spreads them
        const crows = new Map<NodeKey, number[]>();
        const unitB = `block:${box.key}`;
        for (const k of keys) {
            const rows = R.on('h13_caller_alignment') ? callerRows(k, keys) : [];
            if (rows.length) crows.set(k, rows);
        }
        if (crows.size) note({ rule: 'h13_caller_alignment', fn: 'placeBlock', unit: unitB, text: `${crows.size} functions with callers outside the block`,
            values: { callerRows: Object.fromEntries([...crows].slice(0, 12).map(([k, r]) => [k.slice(k.indexOf('#') + 1), r])) } });
        const rank = (k: NodeKey) => {
            const r = crows.get(k);
            return r ? r[0] * 1e5 + r[r.length - 1] : 1e12;
        };
        const L = layout({ ...inp.base, vg: sub, extIn, extOut, rootRank: rank });

        // locked labels of the block (absolute cells): rows of the other functions skip them (R24); a locked
        // function's tree below moves with it
        const lockedKeys = [...keys].filter((k) => inp.lock[unitOf(k)] && L.rowOf.has(k));
        const carried = new Set<NodeKey>();
        const carry = (k: NodeKey) => { carried.add(k); for (const c of L.children.get(k) ?? []) carry(c); };
        lockedKeys.forEach(carry);
        const lockedSpans = lockedKeys.map((k) => { const l = lockOf(unitOf(k))!; return { row: l[1], c0: l[0] - 2, c1: l[0] + L.rows[L.rowOf.get(k)!].text.length + 1 }; });
        const rowsFrom = (t: number) => {
            const map: number[] = [];
            let prev = t - 1;
            L.rows.forEach((r, i) => {
                // approach row (rule `joint`): directly above its root
                const at = r.kind === 'approach' ? L.rows[i + 1] : r;
                const lead = r.kind === 'approach' ? 1 : 0;
                const rows = at?.kind === 'node' && !L.parent.get(at.key) ? crows.get(at.key) : undefined;
                const want = rows?.find((x) => x - lead >= prev + 1);
                prev = Math.max(prev + 1, want !== undefined ? want - lead : -Infinity);
                if (lockedSpans.length && !carried.has(r.key)) {
                    const c0 = col + r.col, c1 = col + Math.max(r.end, r.col + 1);
                    while (lockedSpans.some((x) => x.row === prev && x.c1 >= c0 && x.c0 <= c1)) prev++;
                }
                map[i] = prev;
            });
            return map;
        };
        let rowMap = rowsFrom(top);
        const rectOf = (m: number[]): Rect => ({ c0: col, r0: m[0] ?? top, c1: col + Math.max(0, L.width - 1), r1: m[m.length - 1] ?? top });
        if (auto && R.on('h15_block_descent')) {
            const first = rowMap[0] ?? top;
            const hits: Rect[] = [];
            for (let guard = 0; guard < 1000; guard++) {
                const hit = avoid.find((a) => overlaps(a, rectOf(rowMap)));
                if (!hit) break;
                hits.push(hit);
                top = hit.r1 + 1;
                rowMap = rowsFrom(top);
            }
            const slid = (rowMap[0] ?? top) - first;
            if (hits.length) note({ rule: 'h15_block_descent', fn: 'placeBlock', unit: unitB, text: `rows ${first} → ${first + slid}`,
                values: { hits }, ...(slid >= R.p('h15_block_descent', 'flag') ? { flag: `slid ${slid} rows below its trial row` } : {}) });
        }

        // subtree shifts, parents before children (layout row order)
        const shift = new Map<NodeKey, Cell>();
        const base = (k: NodeKey): Pos => ({ row: rowMap[L.rowOf.get(k)!], col: col + L.rows[L.rowOf.get(k)!].col });
        for (const r of L.rows) {
            if (r.kind !== 'node') continue;
            const k = r.key;
            const p = L.parent.get(k);
            const inherited: Cell = p ? shift.get(p)! : [0, 0];
            const u = unitOf(k);
            const lock = lockOf(u);
            const off = inp.offset[u];
            if (lock) {
                const b = base(k);
                shift.set(k, [lock[0] - b.col, lock[1] - b.row]);
            } else if (off) shift.set(k, [inherited[0] + off[0], inherited[1] + off[1]]);
            else shift.set(k, inherited);
        }

        const block: Block = { box, L, rowMap, col0: col, shift };
        const finalize = () => {
            for (const r of L.rows) {
                if (r.kind !== 'node') continue;
                const b = base(r.key);
                const s = shift.get(r.key)!;
                P.pos.set(r.key, { row: b.row + s[1], col: b.col + s[0] });
                P.end.set(r.key, b.col + s[0] + r.text.length);
                P.text.set(r.key, r.text);
                P.blockOf.set(r.key, block);
                const pr = L.portOf.get(r.key);
                if (pr !== undefined) P.port.set(r.key, { row: rowMap[pr] + s[1], col: b.col + s[0] });
            }
        };
        finalize();

        // unlocked shifted subtrees descend until clear of the block's other labels
        const descendants = (k: NodeKey): NodeKey[] => [k, ...(L.children.get(k) ?? []).flatMap(descendants)];
        const gap = R.p('h21_moved_function_descent', 'margin');
        for (const r of L.rows) {
            const k = r.key;
            if (r.kind !== 'node' || !inp.offset[unitOf(k)] || inp.lock[unitOf(k)] || !R.on('h21_moved_function_descent')) continue;
            const mine = new Set(descendants(k));
            const others = [...keys].filter((x) => !mine.has(x));
            const clash = () => [...mine].some((m) => {
                const pm = P.pos.get(m)!, em = P.end.get(m)!;
                return others.some((o) => {
                    const po = P.pos.get(o)!, eo = P.end.get(o)!;
                    return po.row === pm.row && po.col - gap < em + gap && pm.col - gap < eo + gap;
                });
            });
            let down = 0;
            for (let guard = 0; guard < 500 && clash(); guard++) {
                for (const m of mine) shift.set(m, [shift.get(m)![0], shift.get(m)![1] + 1]);
                finalize();
                down++;
            }
            if (down) note({ rule: 'h21_moved_function_descent', fn: 'placeBlock', unit: unitOf(k), text: `${down} rows down, clear of its block's labels`,
                values: { offset: inp.offset[unitOf(k)], rows: down }, ...(down >= R.p('h21_moved_function_descent', 'flag') ? { flag: `slid ${down} rows past its offset` } : {}) });
        }

        P.blocks.push(block);
        for (const k of keys) { const sh = shift.get(k)!; if (sh[0] || sh[1]) addMove(k, sh[0], sh[1]); }
        // placed and unmoved rectangles
        const span = (at: (k: NodeKey) => Pos, portAt: (k: NodeKey) => Pos | undefined): Rect => {
            let rect: Rect = { c0: Infinity, r0: Infinity, c1: -Infinity, r1: -Infinity };
            const grow = (c0: number, r0: number, c1: number, r1: number) => {
                rect = { c0: Math.min(rect.c0, c0), r0: Math.min(rect.r0, r0), c1: Math.max(rect.c1, c1), r1: Math.max(rect.r1, r1) };
            };
            for (const k of keys) { const p = at(k); grow(p.col, p.row, p.col + P.text.get(k)!.length - 1, p.row); }
            for (const k of keys) { const pp = portAt(k); if (pp) grow(pp.col, pp.row, pp.col, pp.row); }
            for (const l of L.lanes) {
                if (!drawn) { grow(col + l.col, rowMap[l.lo], col + l.col, rowMap[l.hi]); continue; }
                // grid.ts draws lanes only for vertices sharing one shift
                const s0 = shift.get(l.target)!;
                if (!l.sources.every((x) => shift.get(x.key)![0] === s0[0] && shift.get(x.key)![1] === s0[1])) continue;
                grow(col + l.col + s0[0], rowMap[l.lo] + s0[1], col + l.col + s0[0], rowMap[l.hi] + s0[1]);
            }
            return keys.size ? rect : { c0: col, r0: top, c1: col, r1: top };
        };
        let drawn = !!inp.tight;
        const rect = span((k) => P.pos.get(k)!, (k) => P.port.get(k));
        drawn = false;
        const unmoved = span(base, (k) => { const pr = L.portOf.get(k); return pr === undefined ? undefined : { row: rowMap[pr], col: base(k).col }; });
        return { ...rect, base: unmoved };
    };

    // ---- box ----------------------------------------------------------------------------------------
    type Item = { kind: 'block' } | { kind: 'box'; box: BoxNode };
    const placeBox = (box: BoxNode, c0: number, r0: number, avoidOuter: Rect[]): Area => {
        const cc = box.frame ? c0 + 3 : c0;      // border + 2 cells for an arrival `─> f()`
        const cr = box.frame ? r0 + 1 : r0;
        const items: Item[] = [];
        if (box.members.length) items.push({ kind: 'block' });
        for (const c of box.children) items.push({ kind: 'box', box: c });
        const vertsOf = (it: Item) => new Set(it.kind === 'block' ? box.members : verticesOf(it.box));
        const sets = items.map(vertsOf);
        const itemOf = new Map<NodeKey, number>();
        sets.forEach((s, i) => s.forEach((v) => itemOf.set(v, i)));

        // topological order of items
        const succ = items.map(() => new Set<number>());
        for (const e of vg.edges) {
            const a = itemOf.get(e.from), b = itemOf.get(e.to);
            if (a !== undefined && b !== undefined && a !== b) succ[a].add(b);
        }
        const indeg = items.map((_, i) => items.filter((__, j) => succ[j].has(i)).length);
        const seen = new Set<number>();
        const post: number[] = [];
        const visit = (i: number) => {
            if (seen.has(i)) return;
            seen.add(i);
            for (const j of [...succ[i]].sort((a, b) => b - a)) visit(j);
            post.push(i);
        };
        for (let i = items.length - 1; i >= 0; i--) if (!indeg[i]) visit(i);
        for (let i = items.length - 1; i >= 0; i--) visit(i);
        const topo = post.reverse();
        const unitOf = (i: number) => (items[i].kind === 'box' ? boxUnit((items[i] as { box: BoxNode }).box.key) : '');
        const order = [...topo.filter((i) => inp.lock[unitOf(i)]), ...topo.filter((i) => !inp.lock[unitOf(i)])];
        const itemName = (i: number) => (items[i].kind === 'box' ? unitOf(i) : `block:${box.key}`);
        if (order.length > 1) note({ rule: 'h16_item_order', fn: 'placeBox', unit: boxUnit(box.key), text: 'locked items first, then call order',
            values: { order: order.map(itemName) } });

        const placed: { i: number; rect: Rect; base: Rect; f0: number; f1: number }[] = [];   // f0, f1: its frames in P.frames
        // tight: content only, no computed corner
        const corner: Rect = { c0: cc, r0: cr, c1: cc, r1: cr };
        let rect: Rect = inp.tight && items.length ? { c0: Infinity, r0: Infinity, c1: -Infinity, r1: -Infinity } : corner;
        let unmoved: Rect = { ...rect };
        for (const i of order) {
            const it = items[i];
            const inside = sets[i];
            // placed callers of the item
            const callers: NodeKey[] = [];
            for (const v of inside) for (const e of vg.inc.get(v) ?? []) if (!inside.has(e.from) && P.pos.has(e.from)) callers.push(e.from);
            const sibCallers = placed.filter((p) => callers.some((u) => itemOf.get(u) === p.i));
            // channel: base width + 1 column per call from an earlier sibling
            const entering = new Set<string>();
            for (const v of inside) for (const e of vg.inc.get(v) ?? []) if (sibCallers.some((p) => itemOf.get(e.from) === p.i)) entering.add(v);
            // column, row, stacking: from unmoved earlier items
            const channel = R.p('h17_item_column', 'channel');
            // h41: a group whose callers were opened from it (opener side up) hangs below the caller's group, its
            // function one indent right of the caller: `caller()` over `└─> f()`, as a callee below its caller
            // only for a group called from a single sibling group: with callers in several, below one of them
            // lengthens the calls of the others (bindings view: crossing cells 23 => 68)
            const opened = it.kind === 'box' && sibCallers.length === 1 && R.on('h41_callee_below') ? callers.find((u) => {
                const by = inp.openedUp?.(u);
                return by !== undefined && inside.has(by) && sibCallers.some((p) => itemOf.get(u) === p.i);
            }) : undefined;
            const openedBy = opened !== undefined ? inp.openedUp!(opened)! : undefined;
            const colOn = sibCallers.length && R.on('h17_item_column');
            // h41: the group's content column one indent right of the caller (frame border 3 cells left of it)
            const col = opened !== undefined
                ? Math.max(cc, P.pos.get(opened)!.col - (moved.get(opened)?.[0] ?? 0) + R.p('h10_dfs_nearest_parent', 'indent') - 3)
                : colOn ? Math.max(...sibCallers.map((p) => p.base.c1)) + 1 + channel + entering.size : cc;
            // stacking ignores locked siblings, unless overlapped
            const stack = placed.filter((p) => !inp.lock[unitOf(p.i)]);
            const below = stack.length ? Math.max(...stack.map((p) => p.base.r1)) + 1 : cr;
            const rowOn = R.on('h18_item_row');
            const top = opened !== undefined ? placed.find((p) => itemOf.get(opened) === p.i)!.base.r1 + 2
                : rowOn && callers.length ? Math.max(cr, Math.min(...callers.map(baseRow))) : (rowOn && sibCallers.length ? cr : below);
            const name = itemName(i);
            if (opened !== undefined) note({ rule: 'h41_callee_below', fn: 'placeBox', unit: name, text: `column ${col}, row ${top}: below the group of ${opened.slice(opened.indexOf('#') + 1)}, whose callers opened from it`, values: { caller: opened, opener: openedBy } });
            if (opened === undefined) note({ rule: 'h17_item_column', fn: 'placeBox', unit: name, text: colOn ? `column ${col}: right of ${sibCallers.length} calling siblings` : `column ${col}: content column`,
                values: colOn ? { callers: sibCallers.map((p) => itemName(p.i)), right: Math.max(...sibCallers.map((p) => p.base.c1)), channel, entering: entering.size } : {} });
            if (opened === undefined) note({ rule: 'h18_item_row', fn: 'placeBox', unit: name, text: rowOn && callers.length ? `row ${top}: topmost caller row` : `row ${top}: below earlier siblings`,
                values: rowOn && callers.length ? { callerRows: [...new Set(callers.map(baseRow))].sort((a, b) => a - b).slice(0, 12) } : { below } });
            // obstacles: a sibling moved by an offset at its unmoved place (settle.ts clears collisions);
            // a locked sibling, or a frame stretched by moves inside it, where drawn
            const avoid = [...placed.map((p) => (inp.offset[unitOf(p.i)] && !inp.lock[unitOf(p.i)] ? p.base : p.rect)), ...avoidOuter];
            const fi = P.frames.length;
            let r: Area;
            if (it.kind === 'block') {
                r = placeBlock(box, col, top, true, avoid);
            } else {
                const unit = boxUnit(it.box.key);
                const lock = lockOf(unit);
                const off = inp.offset[unit];
                if (lock || off) {
                    // rigid move: placed at its unmoved (trial) row, then labels, lanes and frames translate by
                    // the offset, or onto the lock cell (frame corner)
                    const home = Math.max(cr, top - 1);
                    const b0 = P.blocks.length, f0 = P.frames.length;
                    const u = placeBox(it.box, col, home, []);
                    const [dc, dr] = lock ? [lock[0] - u.c0, lock[1] - u.r0] : off!;
                    translate(b0, f0, inside, dc, dr, unit);
                    if (!lock) for (const v of inside) if (P.pos.get(v)) addMove(v, dc, dr);
                    r = { ...shifted(u, dc, dr), base: lock ? shifted(u.base, dc, dr) : u.base };
                    note({ rule: 'h19_lock_and_box_offset', fn: 'placeBox', unit, text: lock ? `locked: frame corner at (${lock[0]}, ${lock[1]})` : `moved by (${dc}, ${dr}) from row ${home}`,
                        values: { from: [u.c0, u.r0], to: [r.c0, r.r0] } });
                } else {
                    // trial placement; on overlap (h38: frames whose content clashes) down by max(1, hit.r1 + 1 − r.r0)
                    // or right past the hit, the cheaper by `down`, `right` (0: never), `cross` (calls the frame spans)
                    // (r.r0 < rr when inner content moved up)
                    let rr = Math.max(cr, top - 1), dcol = 0;
                    const rr0 = rr;
                    const snapshot = snapshotP();
                    r = placeBox(it.box, col, rr, []);
                    const hits: string[] = [];
                    const overlapped: string[] = [];
                    let pushed: string | undefined, pinned: string | undefined;
                    const soft = R.on('h38_frame_overlap') && !!it.box.frame;
                    const wDown = R.p('h20_unmoved_box_descent', 'down'), wRight = R.p('h20_unmoved_box_descent', 'right'), wCross = R.p('h20_unmoved_box_descent', 'cross');
                    const blocking = (a: Rect): boolean => {
                        if (!overlaps(a, r)) return false;
                        const by = placed.find((p) => p.rect === a || p.base === a);
                        if (!soft || !by || items[by.i].kind !== 'box' || !(items[by.i] as { box: BoxNode }).box.frame) return true;
                        // h38: frames may overlap where neither holds a label, header or arrival cell of the other
                        const clash = frameClash(sets[i], P.frames.slice(fi), r, sets[by.i], P.frames.slice(by.f0, by.f1), by.rect, a, R.p('h38_frame_overlap', 'margin'));
                        if (!clash && !overlapped.includes(itemName(by.i))) overlapped.push(itemName(by.i));
                        return clash;
                    };
                    for (let guard = 0; guard < 200 && R.on('h20_unmoved_box_descent'); guard++) {
                        const hit = avoid.find(blocking);
                        if (!hit) break;
                        const by = placed.find((p) => p.rect === hit || p.base === hit);
                        const who = by ? itemName(by.i) : 'outer content';
                        hits.push(who);
                        if (by && by.rect === hit && (by.rect.r0 !== by.base.r0 || by.rect.r1 !== by.base.r1)) pushed = who;
                        const down = Math.max(1, hit.r1 + 1 - r.r0), right = Math.max(1, hit.c1 + 2 - r.c0);
                        const costDown = wDown * down + wCross * spanned(shifted(r, 0, down), inside);
                        const costRight = wRight > 0 ? wRight * right + wCross * spanned(shifted(r, right, 0), inside) : Infinity;
                        restoreP(snapshot);
                        const top0 = r.r0, left0 = r.c0;
                        if (costRight < costDown) dcol += right; else rr += down;
                        r = placeBox(it.box, col + dcol, rr, []);
                        // locked content pins the frame (locks are absolute): moving the rest makes no progress
                        if (r.r0 <= top0 && r.c0 <= left0) { pinned = who; break; }
                    }
                    if (hits.length) {
                        const flag = pinned ? `overlaps ${pinned}: a locked unit inside pins the frame` : pushed ? `pushed below ${pushed}, a frame stretched by moves inside it`
                            : rr - rr0 >= R.p('h20_unmoved_box_descent', 'flag') ? `slid ${rr - rr0} rows below its trial row` : undefined;
                        note({ rule: 'h20_unmoved_box_descent', fn: 'placeBox', unit, text: `rows ${rr0} → ${rr}${dcol ? `, ${dcol} columns right` : ''}`,
                            values: { below: [...new Set(hits)], from: [col, rr0], to: [col + dcol, rr] }, ...(flag ? { flag } : {}) });
                    }
                    if (overlapped.length) note({ rule: 'h38_frame_overlap', fn: 'placeBox', unit, text: `frame overlaps ${overlapped.join(', ')}: no label inside the other`, values: { with: overlapped } });
                }
            }
            placed.push({ i, rect: r, base: r.base, f0: fi, f1: P.frames.length });
            rect = { c0: Math.min(rect.c0, r.c0), r0: Math.min(rect.r0, r.r0), c1: Math.max(rect.c1, r.c1), r1: Math.max(rect.r1, r.r1) };
            unmoved = { c0: Math.min(unmoved.c0, r.base.c0), r0: Math.min(unmoved.r0, r.base.r0), c1: Math.max(unmoved.c1, r.base.c1), r1: Math.max(unmoved.r1, r.base.r1) };
        }

        if (box.frame) {
            // frame encloses all content, also moved up or left
            const frame = (x: Rect): Rect => {
                const f0 = inp.tight ? x.c0 - 3 : Math.min(c0, x.c0 - 3), g0 = inp.tight ? x.r0 - 1 : Math.min(r0, x.r0 - 1);
                return { c0: f0, r0: g0, c1: Math.max(x.c1 + 2, f0 + box.label.length + 5), r1: x.r1 + 1 };
            };
            const f = frame(rect);
            P.frames.push({ box, unit: boxUnit(box.key), ...f });
            return { ...f, base: frame(unmoved) };
        }
        return { ...rect, base: unmoved };
    };

    /**
     * h38: content of two frames clashes: a label (with its two arrival cells) or header of one lies within `margin`
     * of the other's frame. `a` (first frame) at `ra`; the second at `rb` as drawn, tested at `at` (its unmoved
     * place for a sibling moved by an offset: its content shifts with it, the moves being rigid).
     */
    const frameClash = (va: ReadonlySet<NodeKey>, fa: Frame[], ra: Rect, vb: ReadonlySet<NodeKey>, fb: Frame[], rb: Rect, at: Rect, margin: number): boolean => {
        const spans = (vs: ReadonlySet<NodeKey>, fs: Frame[], dc: number, dr: number) => [
            ...[...vs].filter((v) => P.pos.has(v)).map((v) => { const p = P.pos.get(v)!; return { row: p.row + dr, c0: p.col - 2 + dc, c1: p.col + P.text.get(v)!.length - 1 + dc }; }),
            ...fs.map((f) => ({ row: f.r0 + dr, c0: f.c0 + 2 + dc, c1: f.c0 + 3 + f.box.label.length + dc })),
        ];
        const within = (sp: { row: number; c0: number; c1: number }, x: Rect) => sp.row >= x.r0 - margin && sp.row <= x.r1 + margin && sp.c1 >= x.c0 - margin && sp.c0 <= x.c1 + margin;
        return spans(va, fa, 0, 0).some((sp) => within(sp, at)) || spans(vb, fb, at.c0 - rb.c0, at.r0 - rb.r0).some((sp) => within(sp, ra));
    };

    /** E5: calls between placed functions outside `own` whose bounding box (caller to callee) meets `x`. */
    const spanned = (x: Rect, own: ReadonlySet<NodeKey>): number => {
        let n = 0;
        for (const e of vg.edges) {
            if (own.has(e.from) || own.has(e.to)) continue;
            const a = P.pos.get(e.from), b = P.pos.get(e.to);
            if (a && b && overlaps(x, { c0: Math.min(a.col, b.col), r0: Math.min(a.row, b.row), c1: Math.max(a.col, b.col), r1: Math.max(a.row, b.row) })) n++;
        }
        return n;
    };

    /**
     * Translates vertices `keys`, and the blocks and frames placed from indices `b0`, `f0`, by (dc, dr). Locks are
     * absolute: a moved box (`unit`, h19) leaves the locked units inside it in place, a locked function with its tree
     * below, a locked box with its content; the final normalization (`unit` undefined) moves everything.
     */
    const translate = (b0: number, f0: number, keys: Iterable<NodeKey>, dc: number, dr: number, unit?: string) => {
        if (!dc && !dr) return;
        const held = unit === undefined ? [] : P.frames.slice(f0).filter((f) => f.unit !== unit && inp.lock[f.unit]);
        const heldKeys = new Set(held.flatMap((f) => verticesOf(f.box)));
        const lockedTree = (k: NodeKey): boolean => {
            if (unit === undefined) return false;
            const L = P.blockOf.get(k)?.L;
            for (let x: NodeKey | null | undefined = k; x; x = L?.parent.get(x)) if (inp.lock[unitOf(x)]) return true;
            return false;
        };
        const within = (b: BoxNode) => held.some((f) => f.box === b || verticesOf(f.box).some((v) => verticesOf(b).includes(v)) && verticesOf(b).every((v) => heldKeys.has(v)));
        for (const k of keys) {
            const p = P.pos.get(k);
            if (!p || heldKeys.has(k) || lockedTree(k)) continue;
            // new objects: trial snapshots share the Pos objects
            P.pos.set(k, { row: p.row + dr, col: p.col + dc });
            P.end.set(k, P.end.get(k)! + dc);
            const q = P.port.get(k);
            if (q) P.port.set(k, { row: q.row + dr, col: q.col + dc });
        }
        for (const f of P.frames.slice(f0)) { if (!within(f.box)) { f.c0 += dc; f.c1 += dc; f.r0 += dr; f.r1 += dr; } }
        for (const b of P.blocks.slice(b0)) { if (!within(b.box)) { b.col0 += dc; b.rowMap = b.rowMap.map((r) => r + dr); } }
    };

    // trial-placement snapshots include `moved`: else retries re-add inner moves,
    // drifting `baseRow` by retries × offset
    const snapshotP = () => ({
        blocks: P.blocks.length, frames: P.frames.length, moved: new Map(moved), logs: logs.length,
        pos: new Map(P.pos), end: new Map(P.end), port: new Map(P.port), text: new Map(P.text), blockOf: new Map(P.blockOf),
    });
    const restoreP = (s: ReturnType<typeof snapshotP>) => {
        P.blocks.length = s.blocks;
        P.frames.length = s.frames;
        logs.length = s.logs;
        moved.clear();
        for (const [k, m] of s.moved) moved.set(k, m);
        P.pos = s.pos; P.end = s.end; P.port = s.port; P.text = s.text; P.blockOf = s.blockOf;
    };

    const all = placeBox(inp.tree, 0, 0, []);
    // normalize: no negative coordinates (from moves up or left)
    let minC = 0, minR = 0;
    for (const p of P.pos.values()) { minC = Math.min(minC, p.col); minR = Math.min(minR, p.row); }
    for (const f of P.frames) { minC = Math.min(minC, f.c0); minR = Math.min(minR, f.r0); }
    translate(0, 0, [...P.pos.keys()], -minC, -minR);
    // a run with locks whose shift differs from the one assumed runs again (place); its decisions are not kept
    if (!final && (-minC !== adjust[0] || -minR !== adjust[1])) return { P, shift: [-minC, -minR] };
    let W = Math.max(0, all.c1 + 1), H = Math.max(0, all.r1 + 1);
    for (const [k, p] of P.pos) { W = Math.max(W, P.end.get(k)! + 1); H = Math.max(H, p.row + 1); }
    for (const f of P.frames) { W = Math.max(W, f.c1 + 1); H = Math.max(H, f.r1 + 1); }
    for (const b of P.blocks) for (const l of b.L.lanes) W = Math.max(W, b.col0 + l.col + 1);
    P.width = W;
    P.height = H;
    for (const d of logs) R.note(d);
    return { P, shift: [-minC, -minR] };
}
