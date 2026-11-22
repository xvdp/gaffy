/**
 * 2D placement of namespace boxes and blocks on the character grid. A block is the set of direct
 * members of one box, laid out by the grid lanes layout (layout.ts).
 *
 * Per box, top-down from the canvas:
 * 1. Items: the member block, then the child boxes. Item order: locked boxes first, then the rest in
 *    topological order of the calls between items (DFS reverse postorder; back edges ignored).
 * 2. Column: right of the rightmost earlier sibling item that calls into the item, plus a routing
 *    channel; the content column of the box when no earlier sibling calls into it.
 * 3. Row: an item called from vertices placed earlier starts at the row of its first such caller;
 *    otherwise below the earlier siblings. Unmoved items descend until they overlap no placed sibling; a
 *    sibling box moved by an offset counts at its unmoved place (settle.ts clears it where it collides), so a
 *    move never pushes unmoved items down.
 * 4. Rows inside a block: roots of the block are ordered by the rows of their callers outside the
 *    block; a root starts no higher than its latest outside caller, so the call draws level. Rows only
 *    move down: row(i) = max(row(i-1) + 1, pref(i)) (greedy, monotone).
 * 5. Moves: a box unit keeps `offset` relative to its computed position, or its `lock` position;
 *    a vertex unit shifts its tree descendants in the block. A shifted subtree without lock descends
 *    until its labels overlap no other label of the block. What was not moved stays where it was:
 *    columns, rows and stacking of later items come from the unmoved positions (`moved` holds each
 *    vertex's shift, `base` each item's unmoved rectangle); frames enclose the moved content.
 * 6. Frames: a frame starts at its box's computed corner and grows to enclose content moved up or left.
 *    `tight`: a frame encloses only its content, on all four sides; content moved right or down pulls the
 *    left and top edges along, and lanes count where they are drawn (shifted with their vertices).
 *
 * Coordinates: cells [column, row], canvas origin at (0, 0).
 */
import { BoxNode } from './boxes';
import { layout, Layout, LayoutInput } from './layout';
import { NodeKey } from './model';
import { induced, VGraph } from './quotient';
import { boxUnit, Cell, collapsedUnit } from './viewdoc';

export interface Pos { row: number; col: number }

export interface Block {
    box: BoxNode;
    L: Layout;
    rowMap: number[];                  // layout row → global row before shifts
    col0: number;                      // global column of layout column 0
    shift: Map<NodeKey, Cell>;         // subtree displacement per vertex
}

export interface Frame { box: BoxNode; unit: string; c0: number; r0: number; c1: number; r1: number }

/** Clickable glyphs in the grid: open or restore one side of `key`. */
export interface Marker { row: number; col: number; text: string; key: NodeKey; side: 'up' | 'down' }

export interface Placement {
    blocks: Block[];
    frames: Frame[];
    blockOf: Map<NodeKey, Block>;
    pos: Map<NodeKey, Pos>;            // label start
    end: Map<NodeKey, number>;         // first column right of the label
    port: Map<NodeKey, Pos>;           // port row cell (under the label start)
    text: Map<NodeKey, string>;
    width: number;
    height: number;
    elbows?: Map<NodeKey, NodeKey[]>;  // stable placement: tree elbows outside blocks
    markers?: Marker[];                // stable arrangement: markers of sides with neighbors off screen
}

export interface PlaceInput {
    vg: VGraph;                        // drawn graph (scene `drawn`)
    tree: BoxNode;
    base: Omit<LayoutInput, 'vg' | 'extIn' | 'extOut' | 'rootRank'>;
    offset: Record<string, Cell>;
    lock: Record<string, Cell>;
    channel: number;
    tight?: boolean;                   // frames hug their content (view.tight)
}

interface Rect { c0: number; r0: number; c1: number; r1: number }
interface Area extends Rect { base: Rect }   // placed rectangle, and the rectangle it would take unmoved
const shifted = (r: Rect, dc: number, dr: number): Rect => ({ c0: r.c0 + dc, r0: r.r0 + dr, c1: r.c1 + dc, r1: r.r1 + dr });
const overlaps = (a: Rect, b: Rect) => a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;

const verticesOf = (b: BoxNode): NodeKey[] => [...b.members, ...b.children.flatMap(verticesOf)];

export function place(inp: PlaceInput): Placement {
    /** Unit a vertex's move and lock are stored under: its key, or `collapsed:<key>` for a collapsed container. */
    const unitOf = (k: NodeKey) => (inp.vg.nodes.get(k)?.collapsed ? collapsedUnit(k) : k);
    const { vg } = inp;
    const P: Placement = {
        blocks: [], frames: [], blockOf: new Map(), pos: new Map(), end: new Map(), port: new Map(), text: new Map(),
        width: 0, height: 0,
    };

    // shift a user move put into each placed vertex (box offsets and vertex offsets, cumulative)
    const moved = new Map<NodeKey, Cell>();
    const addMove = (k: NodeKey, dc: number, dr: number) => { const m = moved.get(k) ?? [0, 0]; moved.set(k, [m[0] + dc, m[1] + dr]); };
    // row a call leaves its caller, unmoved: the port row when the caller has one
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
        // roots ordered by (earliest, latest) outside caller row; each root takes the earliest caller row
        // still free, so a hub caller does not pull every root to its own row
        const crows = new Map<NodeKey, number[]>();
        for (const k of keys) {
            const rows = callerRows(k, keys);
            if (rows.length) crows.set(k, rows);
        }
        const rank = (k: NodeKey) => {
            const r = crows.get(k);
            return r ? r[0] * 1e5 + r[r.length - 1] : 1e12;
        };
        const L = layout({ ...inp.base, vg: sub, extIn, extOut, rootRank: rank });

        const rowsFrom = (t: number) => {
            const map: number[] = [];
            let prev = t - 1;
            L.rows.forEach((r, i) => {
                // an approach row (rule `joint`) stays right above the root it leads into
                const at = r.kind === 'approach' ? L.rows[i + 1] : r;
                const lead = r.kind === 'approach' ? 1 : 0;
                const rows = at?.kind === 'node' && !L.parent.get(at.key) ? crows.get(at.key) : undefined;
                const want = rows?.find((x) => x - lead >= prev + 1);
                prev = Math.max(prev + 1, want !== undefined ? want - lead : -Infinity);
                map[i] = prev;
            });
            return map;
        };
        let rowMap = rowsFrom(top);
        const rectOf = (m: number[]): Rect => ({ c0: col, r0: m[0] ?? top, c1: col + Math.max(0, L.width - 1), r1: m[m.length - 1] ?? top });
        if (auto) {
            for (let guard = 0; guard < 1000; guard++) {
                const hit = avoid.find((a) => overlaps(a, rectOf(rowMap)));
                if (!hit) break;
                top = hit.r1 + 1;
                rowMap = rowsFrom(top);
            }
        }

        // subtree shifts, parents before children (layout rows are in that order)
        const shift = new Map<NodeKey, Cell>();
        const base = (k: NodeKey): Pos => ({ row: rowMap[L.rowOf.get(k)!], col: col + L.rows[L.rowOf.get(k)!].col });
        for (const r of L.rows) {
            if (r.kind !== 'node') continue;
            const k = r.key;
            const p = L.parent.get(k);
            const inherited: Cell = p ? shift.get(p)! : [0, 0];
            const u = unitOf(k);
            const lock = inp.lock[u];
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

        // shifted unlocked subtrees descend until their labels clear the other labels of the block
        const descendants = (k: NodeKey): NodeKey[] => [k, ...(L.children.get(k) ?? []).flatMap(descendants)];
        for (const r of L.rows) {
            const k = r.key;
            if (r.kind !== 'node' || !inp.offset[unitOf(k)] || inp.lock[unitOf(k)]) continue;
            const mine = new Set(descendants(k));
            const others = [...keys].filter((x) => !mine.has(x));
            const clash = () => [...mine].some((m) => {
                const pm = P.pos.get(m)!, em = P.end.get(m)!;
                return others.some((o) => {
                    const po = P.pos.get(o)!, eo = P.end.get(o)!;
                    return po.row === pm.row && po.col - 2 < em + 2 && pm.col - 2 < eo + 2;
                });
            });
            for (let guard = 0; guard < 500 && clash(); guard++) {
                for (const m of mine) shift.set(m, [shift.get(m)![0], shift.get(m)![1] + 1]);
                finalize();
            }
        }

        P.blocks.push(block);
        for (const k of keys) { const sh = shift.get(k)!; if (sh[0] || sh[1]) addMove(k, sh[0], sh[1]); }
        // placed rectangle, and the unmoved one (labels at their computed cells)
        const span = (at: (k: NodeKey) => Pos, portAt: (k: NodeKey) => Pos | undefined): Rect => {
            let rect: Rect = { c0: Infinity, r0: Infinity, c1: -Infinity, r1: -Infinity };
            const grow = (c0: number, r0: number, c1: number, r1: number) => {
                rect = { c0: Math.min(rect.c0, c0), r0: Math.min(rect.r0, r0), c1: Math.max(rect.c1, c1), r1: Math.max(rect.r1, r1) };
            };
            for (const k of keys) { const p = at(k); grow(p.col, p.row, p.col + P.text.get(k)!.length - 1, p.row); }
            for (const k of keys) { const pp = portAt(k); if (pp) grow(pp.col, pp.row, pp.col, pp.row); }
            for (const l of L.lanes) {
                if (!drawn) { grow(col + l.col, rowMap[l.lo], col + l.col, rowMap[l.hi]); continue; }
                // as grid.ts draws it: shifted with its vertices when they share one shift, else routed (no lane)
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
        const cc = box.frame ? c0 + 3 : c0;      // border, two cells: room for an arrival `─> f()` crossing the border
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

        const placed: { i: number; rect: Rect; base: Rect }[] = [];
        // tight: the content alone, without the box's computed corner
        const corner: Rect = { c0: cc, r0: cr, c1: cc, r1: cr };
        let rect: Rect = inp.tight && items.length ? { c0: Infinity, r0: Infinity, c1: -Infinity, r1: -Infinity } : corner;
        let unmoved: Rect = { ...rect };
        for (const i of order) {
            const it = items[i];
            const inside = sets[i];
            // callers of the item placed so far
            const callers: NodeKey[] = [];
            for (const v of inside) for (const e of vg.inc.get(v) ?? []) if (!inside.has(e.from) && P.pos.has(e.from)) callers.push(e.from);
            const sibCallers = placed.filter((p) => callers.some((u) => itemOf.get(u) === p.i));
            // channel: base width plus one column per call entering the item from an earlier sibling
            const entering = new Set<string>();
            for (const v of inside) for (const e of vg.inc.get(v) ?? []) if (sibCallers.some((p) => itemOf.get(e.from) === p.i)) entering.add(v);
            // column, row and stacking from where earlier items would sit unmoved
            const col = sibCallers.length ? Math.max(...sibCallers.map((p) => p.base.c1)) + 1 + inp.channel + entering.size : cc;
            // stacking ignores locked siblings: an unlocked item keeps its place unless it overlaps one
            const stack = placed.filter((p) => !inp.lock[unitOf(p.i)]);
            const below = stack.length ? Math.max(...stack.map((p) => p.base.r1)) + 1 : cr;
            const top = callers.length ? Math.max(cr, Math.min(...callers.map(baseRow))) : (sibCallers.length ? cr : below);
            // what was not moved stays where it was: a sibling box moved by an offset counts where it sits unmoved
            // (settle.ts clears it where it collides); locked siblings and frames stretched by moves inside count as drawn
            const avoid = [...placed.map((p) => (inp.offset[unitOf(p.i)] && !inp.lock[unitOf(p.i)] ? p.base : p.rect)), ...avoidOuter];
            let r: Area;
            if (it.kind === 'block') {
                r = placeBlock(box, col, top, true, avoid);
            } else {
                const unit = boxUnit(it.box.key);
                const lock = inp.lock[unit];
                const off = inp.offset[unit];
                if (lock) r = placeBox(it.box, lock[0], lock[1], []);
                else if (off) {
                    // the offset counts from the row the box takes unmoved (its trial row)
                    const home = Math.max(cr, top - 1);
                    r = placeBox(it.box, col + off[0], home + off[1], []);
                    for (const v of inside) addMove(v, off[0], off[1]);
                    r = { ...r, base: shifted(r.base, -off[0], -off[1]) };
                } else {
                    // trial placement, then descend below overlapped siblings: by the distance from the top of
                    // what was placed (its frame reaches above `rr` when content inside moved up) to below the hit
                    let rr = Math.max(cr, top - 1);
                    const snapshot = snapshotP();
                    r = placeBox(it.box, col, rr, []);
                    for (let guard = 0; guard < 200; guard++) {
                        const hit = avoid.find((a) => overlaps(a, r));
                        if (!hit) break;
                        restoreP(snapshot);
                        rr += Math.max(1, hit.r1 + 1 - r.r0);
                        r = placeBox(it.box, col, rr, []);
                    }
                }
            }
            placed.push({ i, rect: r, base: r.base });
            rect = { c0: Math.min(rect.c0, r.c0), r0: Math.min(rect.r0, r.r0), c1: Math.max(rect.c1, r.c1), r1: Math.max(rect.r1, r.r1) };
            unmoved = { c0: Math.min(unmoved.c0, r.base.c0), r0: Math.min(unmoved.r0, r.base.r0), c1: Math.max(unmoved.c1, r.base.c1), r1: Math.max(unmoved.r1, r.base.r1) };
        }

        if (box.frame) {
            // the frame encloses its content in every direction, also content moved up or left
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

    // placement state snapshots for trial placements of boxes; `moved` included, else every retry adds the moves
    // inside the box again and `baseRow` (caller rows of later blocks) drifts by retries × offset
    const snapshotP = () => ({
        blocks: P.blocks.length, frames: P.frames.length, moved: new Map(moved),
        pos: new Map(P.pos), end: new Map(P.end), port: new Map(P.port), text: new Map(P.text), blockOf: new Map(P.blockOf),
    });
    const restoreP = (s: ReturnType<typeof snapshotP>) => {
        P.blocks.length = s.blocks;
        P.frames.length = s.frames;
        moved.clear();
        for (const [k, m] of s.moved) moved.set(k, m);
        P.pos = s.pos; P.end = s.end; P.port = s.port; P.text = s.text; P.blockOf = s.blockOf;
    };

    const all = placeBox(inp.tree, 0, 0, []);
    // normalize: nothing at negative coordinates (moves may push content up or left)
    let minC = 0, minR = 0;
    for (const p of P.pos.values()) { minC = Math.min(minC, p.col); minR = Math.min(minR, p.row); }
    for (const f of P.frames) { minC = Math.min(minC, f.c0); minR = Math.min(minR, f.r0); }
    if (minC < 0 || minR < 0) {
        const dc = -minC, dr = -minR;
        for (const p of P.pos.values()) { p.col += dc; p.row += dr; }
        for (const [k, e] of P.end) P.end.set(k, e + dc);
        for (const p of P.port.values()) { p.col += dc; p.row += dr; }
        for (const f of P.frames) { f.c0 += dc; f.c1 += dc; f.r0 += dr; f.r1 += dr; }
        for (const b of P.blocks) { b.col0 += dc; b.rowMap = b.rowMap.map((r) => r + dr); }
    }
    let W = Math.max(0, all.c1 + 1), H = Math.max(0, all.r1 + 1);
    for (const [k, p] of P.pos) { W = Math.max(W, P.end.get(k)! + 1); H = Math.max(H, p.row + 1); }
    for (const f of P.frames) { W = Math.max(W, f.c1 + 1); H = Math.max(H, f.r1 + 1); }
    for (const b of P.blocks) for (const l of b.L.lanes) W = Math.max(W, b.col0 + l.col + 1);
    P.width = W;
    P.height = H;
    return P;
}
