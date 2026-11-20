/**
 * Character grid from a placement. Each cell holds, per net, a direction mask (N, S, E, W). A net is
 * one drawn connection set: `t:<parent>` (stem and elbows to tree children) or `l:<target>` (all
 * calls into one vertex: lanes, routed paths, their arrival). Glyph text and vector paths derive
 * from the same masks; `paths` keeps one polyline per call for curved rendering.
 *
 * Drawing order:
 * 1. Labels, namespace frames with headers.
 * 2. Per block: tree elbows and lanes whose vertices share one subtree shift (unmoved relative to each other).
 * 3. Every other call: A* on the grid (Hart, Nilsson, Raphael 1968), the maze routing of Lee (1961).
 *    Step cost 1, bend `bend`, crossing a perpendicular segment of another net `cross`, crossing a frame
 *    border at right angle `border`. Labels, headers, frame corners, arrowheads, and segments of other
 *    nets running along the same axis are blocked; a turn on a cell of another net is blocked. Cells of
 *    the same net, or of calls from the same caller, cost 0.3: calls into one target merge into one trunk.
 *    Departure from the label end (`f() ──`), or at a cost of 2 from under or over the label's first
 *    character (`├─>`, `┌─>`), which keeps a callee moved above its caller readable. Arrival from the left
 *    (`──> f()`) for vertices without a drawn tree elbow, else at the right (`f() <──`).
 *
 * Glyph per cell: one net → box glyph of its mask; several nets → union mask, except a pure crossing
 * (each mask exactly N|S or exactly E|W, both present), which renders `GlyphSet.cross`.
 */
import { NodeKey } from './model';
import { Frame, Placement } from './place';
import { VGraph } from './quotient';
import { E, GlyphSet, N, S, W } from './style';

export interface Mark {
    row: number;
    col: number;
    ch: string;
    net?: string;
    role: 'arrowE' | 'arrowW' | 'frame' | 'marker';
}

export interface LabelSpan {
    row: number;
    col: number;
    text: string;
    key: NodeKey;              // vertex key, or `box:<container key>` for a frame header
    kind: 'node' | 'box';
}

export interface Net {
    kind: 'tree' | 'lane';
    key: NodeKey;              // tree: parent; lane: target
}

export interface EdgePath {
    from: NodeKey;
    to: NodeKey;
    net: string;
    pts: [number, number][];  // [x, y] in cell units: x = column, y = row; centers at +0.5
    cells: number[];           // cell ids from caller to callee, through merged trunks
    start: 'E' | 'S' | 'N';    // initial heading: from the label end, or from under or over its first character
    arrive: 'E' | 'W';         // final heading
    fallback?: boolean;        // no route found: a dashed L drawn over everything, no grid cells
}

export interface Grid {
    width: number;
    height: number;
    cells: Map<number, Map<string, number>>;
    marks: Mark[];
    labels: LabelSpan[];
    nets: Map<string, Net>;
    paths: EdgePath[];
    frames: Frame[];
    roots: Map<string, number>; // per net: lane arrival cell, or top cell of a tree stem (flow direction)
    conflicts: number;         // edge cells inside label spans; 0 by construction
    unrouted: number;          // calls without a route
    failed: [NodeKey, NodeKey][];
    markers: { row: number; col: number; text: string; key: NodeKey; side: 'up' | 'down' }[];
    arrowTo: Map<number, NodeKey>;      // arrowhead cell → the vertex it points at
}

export interface RouteCost { bend: number; cross: number; border: number; adjacent: number }

const STRIDE = 1 << 16;
export const cellId = (r: number, c: number) => r * STRIDE + c;
export const cellRC = (id: number): [number, number] => [Math.floor(id / STRIDE), id % STRIDE];

const DR = [-1, 1, 0, 0];
const DC = [0, 0, 1, -1];
const BIT = [N, S, E, W];
const OPP = [S, N, W, E];
const AXIS_V = N | S, AXIS_H = E | W;
const RELAX_TURN = 40;     // relaxed pass: turning on another net
const RELAX_ALONG = 400;   // relaxed pass: running along another net (ambiguous, last resort)

/** Bend points of a cell path: centers of cells where the direction changes. */
function bends(cells: number[]): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 1; i < cells.length - 1; i++) {
        const [r0, c0] = cellRC(cells[i - 1]), [r1, c1] = cellRC(cells[i]), [r2, c2] = cellRC(cells[i + 1]);
        if ((r1 - r0 !== r2 - r1) || (c1 - c0 !== c2 - c1)) out.push([c1 + 0.5, r1 + 0.5]);
    }
    return out;
}

/**
 * `joint` (tree parent rule `joint`): elbow tails belong to the callee's net, so other calls into the callee
 * can join them; collector lanes enter their target from the left; routed calls arrive from the left
 * whenever the two cells before the label are free (callers' positions do not vote).
 */
export function buildGrid(P: Placement, vg: VGraph, opts: { arrow: boolean; cost: RouteCost; first?: string[]; joint?: boolean }): Grid {
    const cells = new Map<number, Map<string, number>>();
    const srcOf = new Map<number, Set<NodeKey>>();
    const marks: Mark[] = [];
    const markAt = new Set<number>();
    const nets = new Map<string, Net>();
    const paths: EdgePath[] = [];
    const add = (r: number, c: number, net: string, m: number, src?: NodeKey) => {
        const id = cellId(r, c);
        let cell = cells.get(id);
        if (!cell) cells.set(id, (cell = new Map()));
        cell.set(net, (cell.get(net) ?? 0) | m);
        if (src !== undefined) {
            let s = srcOf.get(id);
            if (!s) srcOf.set(id, (s = new Set()));
            s.add(src);
        }
    };
    const hline = (r: number, c0: number, c1: number, net: string, src?: NodeKey) => {
        for (let c = c0; c <= c1; c++) add(r, c, net, E | W, src);
    };
    const mark = (m: Mark) => { marks.push(m); if (m.role !== 'frame') markAt.add(cellId(m.row, m.col)); };
    const arrowTo = new Map<number, NodeKey>();
    const tree = (p: NodeKey) => { const n = `t:${p}`; if (!nets.has(n)) nets.set(n, { kind: 'tree', key: p }); return n; };
    const lane = (t: NodeKey) => { const n = `l:${t}`; if (!nets.has(n)) nets.set(n, { kind: 'lane', key: t }); return n; };
    const roots = new Map<string, number>();
    const row = (r: number, c0: number, c1: number) => { const o: number[] = []; for (let c = c0; c1 >= c0 ? c <= c1 : c >= c1; c += c1 >= c0 ? 1 : -1) o.push(cellId(r, c)); return o; };
    const colCells = (c: number, r0: number, r1: number) => { const o: number[] = []; for (let r = r0; r1 >= r0 ? r <= r1 : r >= r1; r += r1 >= r0 ? 1 : -1) o.push(cellId(r, c)); return o; };

    // ---- 1. labels and frames -------------------------------------------------------------------------
    const labels: LabelSpan[] = [];
    const blocked = new Set<number>();
    for (const [k, p] of P.pos) {
        const text = P.text.get(k)!;
        labels.push({ row: p.row, col: p.col, text, key: k, kind: 'node' });
        for (let c = p.col; c < p.col + text.length; c++) blocked.add(cellId(p.row, c));
    }
    // one free cell on each side of a label: no line touches a label except at its arrival and departure cells
    const pad = new Set<number>();
    for (const [k, p] of P.pos) { pad.add(cellId(p.row, p.col - 1)); pad.add(cellId(p.row, P.end.get(k)!)); }
    const border = new Map<number, 'v' | 'h'>();
    for (const f of P.frames) {
        const head = ` ${f.box.label} `;
        for (let c = f.c0; c <= f.c1; c++) {
            for (const r of [f.r0, f.r1]) {
                const corner = c === f.c0 || c === f.c1;
                const inHead = r === f.r0 && c >= f.c0 + 2 && c < f.c0 + 2 + head.length;
                if (corner) {
                    mark({ row: r, col: c, ch: r === f.r0 ? (c === f.c0 ? 'tl' : 'tr') : (c === f.c0 ? 'bl' : 'br'), role: 'frame' });
                    blocked.add(cellId(r, c));
                } else if (inHead) blocked.add(cellId(r, c));
                else { mark({ row: r, col: c, ch: 'h', role: 'frame' }); border.set(cellId(r, c), 'h'); }
            }
        }
        for (let r = f.r0 + 1; r < f.r1; r++) {
            for (const c of [f.c0, f.c1]) { mark({ row: r, col: c, ch: 'v', role: 'frame' }); border.set(cellId(r, c), 'v'); }
        }
        labels.push({ row: f.r0, col: f.c0 + 3, text: f.box.label, key: f.unit, kind: 'box' });
    }

    // ---- 2. tree elbows and lanes per block ------------------------------------------------------------
    const drawn = new Set<string>();
    const eid = (a: NodeKey, b: NodeKey) => `${a}\u0000${b}`;
    const elbowInto = new Set<NodeKey>();
    const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
    /** Stem under p and elbows to the children whose stem column and elbow row cross no label. */
    const elbows = (p: NodeKey, kids: NodeKey[], keep: (c: NodeKey) => boolean) => {
        const pp = P.pos.get(p)!;
        const ok = kids.filter((c) => {
            if (!keep(c)) return false;
            const pc = P.pos.get(c)!;
            for (let r = pp.row + 1; r <= pc.row; r++) if (blocked.has(cellId(r, pp.col))) return false;
            for (let cc = pp.col; cc <= pc.col - 2; cc++) if (blocked.has(cellId(pc.row, cc))) return false;
            return true;
        });
        if (!ok.length) return;
        const net = tree(p);
        roots.set(net, cellId(pp.row + 1, pp.col));
        const rows = ok.map((c) => P.pos.get(c)!.row);
        const last = Math.max(...rows);
        const childRows = new Set(rows);
        for (let r = pp.row + 1; r <= last; r++) add(r, pp.col, net, N | (r < last ? S : 0) | (childRows.has(r) ? E : 0), p);
        for (const c of ok) {
            const pc = P.pos.get(c)!;
            // joint: the tail after the stem belongs to the callee's net, where its other calls may join
            const tn = opts.joint ? lane(c) : net;
            hline(pc.row, pp.col + 1, pc.col - 3, tn, p);
            if (opts.arrow) { add(pc.row, pc.col - 2, tn, W, p); mark({ row: pc.row, col: pc.col - 2, ch: '>', net: tn, role: 'arrowE' }); }
            else add(pc.row, pc.col - 2, tn, E | W, p);
            if (tn !== net && !roots.has(tn)) roots.set(tn, cellId(pc.row, pc.col - 2));
            arrowTo.set(cellId(pc.row, pc.col - 2), c);
            drawn.add(eid(p, c));
            elbowInto.add(c);
            paths.push({ from: p, to: c, net: tn, start: 'S', arrive: 'E',
                pts: [[pp.col + 0.5, pp.row + 1], [pp.col + 0.5, pc.row + 0.5], [pc.col - 1, pc.row + 0.5]],
                cells: [...colCells(pp.col, pp.row + 1, pc.row), ...row(pc.row, pp.col + 1, pc.col - 2)] });
        }
    };
    /**
     * Collector lane (rule `joint`): down the lane column to the approach row above the target, back left
     * to the collector column, down into the target's row, and in from the left.
     */
    const leftLane = (ln: Placement['blocks'][number]['L']['lanes'][number], B: Placement['blocks'][number], col: number, srcRows: number[]) => {
        const s0 = B.shift.get(ln.target)!;
        const tp = P.pos.get(ln.target)!;
        const via = B.rowMap[ln.left!.row] + s0[1];
        const cc = B.col0 + ln.left!.col + s0[0];
        const lo = Math.min(...srcRows);
        if (via !== tp.row - 1 || cc > tp.col - 3) return;
        const free = (r: number, c: number) => !blocked.has(cellId(r, c));
        for (let r = lo; r <= via; r++) if (!free(r, col)) return;
        for (const [i, s] of ln.sources.entries()) {
            const from = s.port ? P.port.get(s.key)!.col : P.end.get(s.key)! + 1;
            for (let c = from; c < col; c++) if (!free(srcRows[i], c)) return;
        }
        for (let c = cc; c < col; c++) if (!free(via, c)) return;
        for (let c = cc; c <= tp.col - 2; c++) if (!free(tp.row, c)) return;
        const net = lane(ln.target);
        roots.set(net, cellId(tp.row, tp.col - 2));
        const srcAt = new Map(ln.sources.map((s, i) => [srcRows[i], s.key] as const));
        for (let r = lo; r <= via; r++) add(r, col, net, (r > lo ? N : 0) | (r < via ? S : 0) | (srcAt.has(r) || r === via ? W : 0), srcAt.get(r));
        hline(via, cc + 1, col - 1, net);
        add(via, cc, net, E | S);
        add(tp.row, cc, net, N | E);
        hline(tp.row, cc + 1, tp.col - 3, net);
        if (opts.arrow) { add(tp.row, tp.col - 2, net, W); mark({ row: tp.row, col: tp.col - 2, ch: '>', net, role: 'arrowE' }); }
        else add(tp.row, tp.col - 2, net, E | W);
        arrowTo.set(cellId(tp.row, tp.col - 2), ln.target);
        const tail = (r: number) => [...colCells(col, r, via), ...row(via, col - 1, cc), cellId(tp.row, cc), ...row(tp.row, cc + 1, tp.col - 2)];
        const tailPts: [number, number][] = [[col + 0.5, via + 0.5], [cc + 0.5, via + 0.5], [cc + 0.5, tp.row + 0.5], [tp.col - 1, tp.row + 0.5]];
        for (const [i, s] of ln.sources.entries()) {
            const r = srcRows[i];
            if (s.port) {
                const pr = P.port.get(s.key)!;
                add(pr.row, pr.col, net, N | E, s.key);
                hline(pr.row, pr.col + 1, col - 1, net, s.key);
                paths.push({ from: s.key, to: ln.target, net, start: 'S', arrive: 'E',
                    pts: [[pr.col + 0.5, pr.row], [pr.col + 0.5, pr.row + 0.5], [col + 0.5, pr.row + 0.5], ...tailPts], cells: [...row(pr.row, pr.col, col - 1), ...tail(r)] });
            } else {
                const se = P.end.get(s.key)!;
                hline(r, se + 1, col - 1, net, s.key);
                paths.push({ from: s.key, to: ln.target, net, start: 'E', arrive: 'E',
                    pts: [[se + 1, r + 0.5], [col + 0.5, r + 0.5], ...tailPts], cells: [...row(r, se + 1, col - 1), ...tail(r)] });
            }
            drawn.add(eid(s.key, ln.target));
        }
    };

    // markers of the stable placement: obstacles for the router, clickable in the webview
    const markers = P.markers ?? [];
    for (const m of markers) {
        for (let i = 0; i < m.text.length; i++) {
            marks.push({ row: m.row, col: m.col + i, ch: m.text[i], role: 'marker' });
            blocked.add(cellId(m.row, m.col + i));
        }
    }
    for (const [p, kids] of P.elbows ?? []) elbows(p, kids, () => true);
    for (const B of P.blocks) {
        const L = B.L;
        for (const [u, vs] of L.back) for (const v of vs) drawn.add(eid(u, v));
        for (const [p, kids] of L.children) elbows(p, kids, (c) => same(B.shift.get(p)!, B.shift.get(c)!));
        for (const ln of L.lanes) {
            const s0 = B.shift.get(ln.target)!;
            if (!ln.sources.every((s) => same(B.shift.get(s.key)!, s0))) continue;
            const col = B.col0 + ln.col + s0[0];
            const tp = P.pos.get(ln.target)!;
            const tEnd = P.end.get(ln.target)!;
            const srcRows = ln.sources.map((s) => (s.port ? P.port.get(s.key)! : P.pos.get(s.key)!).row);
            if (ln.left) { leftLane(ln, B, col, srcRows); continue; }
            const lo = Math.min(...srcRows), hi = tp.row;
            // a lane crossing a moved label is routed instead
            let clear = true;
            for (let r = lo; r <= hi && clear; r++) if (blocked.has(cellId(r, col))) clear = false;
            for (const s of ln.sources) {
                const from = s.port ? P.port.get(s.key)!.col : P.end.get(s.key)! + 1;
                const row = (s.port ? P.port.get(s.key)! : P.pos.get(s.key)!).row;
                for (let c = from; c < col && clear; c++) if (blocked.has(cellId(row, c))) clear = false;
            }
            for (let c = tEnd + 1; c < col && clear; c++) if (blocked.has(cellId(hi, c))) clear = false;
            if (!clear) continue;
            const net = lane(ln.target);
            roots.set(net, cellId(hi, tEnd + 1));
            const tail = (r: number) => [...colCells(col, r, hi), ...row(hi, col - 1, tEnd + 1)];
            const srcAt = new Map(ln.sources.map((s, i) => [srcRows[i], s.key] as const));
            for (let r = lo; r <= hi; r++) add(r, col, net, (r > lo ? N : 0) | (r < hi ? S : 0) | (srcAt.has(r) || r === hi ? W : 0), srcAt.get(r));
            for (const s of ln.sources) {
                const sp = P.pos.get(s.key)!;
                if (s.port) {
                    const pr = P.port.get(s.key)!;
                    add(pr.row, pr.col, net, N | E, s.key);
                    hline(pr.row, pr.col + 1, col - 1, net, s.key);
                    paths.push({ from: s.key, to: ln.target, net, start: 'S', arrive: 'W',
                        pts: [[pr.col + 0.5, pr.row], [pr.col + 0.5, pr.row + 0.5], [col + 0.5, pr.row + 0.5], [col + 0.5, hi + 0.5], [tEnd + 1, hi + 0.5]],
                        cells: [...row(pr.row, pr.col, col - 1), ...tail(pr.row)] });
                } else {
                    const se = P.end.get(s.key)!;
                    hline(sp.row, se + 1, col - 1, net, s.key);
                    paths.push({ from: s.key, to: ln.target, net, start: 'E', arrive: 'W',
                        pts: [[se + 1, sp.row + 0.5], [col + 0.5, sp.row + 0.5], [col + 0.5, hi + 0.5], [tEnd + 1, hi + 0.5]],
                        cells: [...row(sp.row, se + 1, col - 1), ...tail(sp.row)] });
                }
                drawn.add(eid(s.key, ln.target));
            }
            if (opts.arrow) {
                add(hi, tEnd + 1, net, E);
                mark({ row: hi, col: tEnd + 1, ch: '<', net, role: 'arrowW' });
                arrowTo.set(cellId(hi, tEnd + 1), ln.target);
                hline(hi, tEnd + 2, col - 1, net);
            } else hline(hi, tEnd + 1, col - 1, net);
        }
    }

    // ---- 3. routed calls ------------------------------------------------------------------------------
    const todo = vg.edges.filter((e) => !drawn.has(eid(e.from, e.to)) && P.pos.has(e.from) && P.pos.has(e.to));
    const dist = (a: NodeKey, b: NodeKey) => {
        const pa = P.pos.get(a)!, pb = P.pos.get(b)!;
        return Math.abs(pa.row - pb.row) + Math.abs(pa.col - pb.col);
    };
    // level calls first (straight arrows), shortest first; then the rest, longest first
    const departRow = (k: NodeKey) => (P.port.get(k) ?? P.pos.get(k)!).row;
    const level = (e: { from: NodeKey; to: NodeKey }) => departRow(e.from) === P.pos.get(e.to)!.row;
    const first = new Set(opts.first ?? []);
    const pri = (e: { from: NodeKey; to: NodeKey }) => (first.has(`${e.from}\u0000${e.to}`) ? 1 : 0);
    todo.sort((a, b) => pri(b) - pri(a) || Number(level(b)) - Number(level(a))
        || (level(a) ? dist(a.from, a.to) - dist(b.from, b.to) : dist(b.from, b.to) - dist(a.from, a.to))
        || (a.from + a.to < b.from + b.to ? -1 : 1));

    // arrival side per target, decided before routing; left arrival cells reserved for the target's net
    // callers mostly left of the target arrive from the left (`──> f()`), callers right of it at its end (`f() <──`)
    const leftArrival = new Map<NodeKey, boolean>();
    const reserved = new Map<number, string>();
    const votes = new Map<NodeKey, number>();
    for (const e of todo) votes.set(e.to, (votes.get(e.to) ?? 0) + (P.pos.get(e.from)!.col < P.pos.get(e.to)!.col ? 1 : -1));
    // a vertex that sends calls from its label end keeps that end: calls into it arrive from the left
    const departs = new Set<NodeKey>(todo.map((e) => e.from));
    for (const [id, own] of srcOf) { const [r, c] = cellRC(id); for (const u of own) { const p = P.pos.get(u); if (p && p.row === r && c === P.end.get(u)! + 1) departs.add(u); } }
    for (const e of todo) {
        const v = e.to;
        if (leftArrival.has(v)) continue;
        const pv = P.pos.get(v)!;
        const free = (r: number, c: number) => c >= 0 && !blocked.has(cellId(r, c)) && !border.has(cellId(r, c)) && !cells.has(cellId(r, c)) && !reserved.has(cellId(r, c));
        // a collector lane or a joint elbow already enters from the left: join it
        const own = !!cells.get(cellId(pv.row, pv.col - 2))?.has(`l:${v}`) && !elbowInto.has(v);
        const left = own || (!elbowInto.has(v) && (opts.joint || votes.get(v)! >= 0 || departs.has(v)) && pv.col >= 2 && free(pv.row, pv.col - 2) && free(pv.row, pv.col - 1));
        leftArrival.set(v, left);
        if (left && !own) { reserved.set(cellId(pv.row, pv.col - 2), `l:${v}`); reserved.set(cellId(pv.row, pv.col - 1), `l:${v}`); }
    }
    // departure cells reserved for their caller: two cells right of the label, or right of the port
    for (const e of todo) {
        const port = P.port.get(e.from);
        const r = port ? port.row : P.pos.get(e.from)!.row;
        const c = port ? port.col + 1 : P.end.get(e.from)! + 1;
        for (const cc of [c, c + 1]) if (!reserved.has(cellId(r, cc))) reserved.set(cellId(r, cc), `src:${e.from}`);
    }

    let width = P.width, height = P.height;
    const RW = P.width + 16, RH = P.height + 12;
    const size = RW * RH * 4;
    const g = new Float64Array(size).fill(Infinity);
    const came = new Int32Array(size).fill(-1);
    const touched: number[] = [];
    let unrouted = 0;
    const failed: [NodeKey, NodeKey][] = [];

    for (const e of todo) {
        const net = lane(e.to);
        const u = e.from, v = e.to;
        const pu = P.pos.get(u)!, pv = P.pos.get(v)!;
        const port = P.port.get(u);
        const sr = port ? port.row : pu.row;
        let sc = port ? port.col + 1 : P.end.get(u)! + 1;
        while (!port && blocked.has(cellId(sr, sc))) sc++;   // leave after a marker at the label end
        const vEnd = P.end.get(v)!;
        const left = leftArrival.get(v)!;
        const gr = pv.row, gc = left ? pv.col - 2 : vEnd + 1;
        const gdir = left ? 2 : 3;   // arrive heading E (from the west) or W (from the east)

        const sid = (r: number, c: number, d: number) => ((r * RW) + c) * 4 + d;
        const hf: number[] = [];     // binary heap: priorities
        const hi: number[] = [];     // binary heap: state ids
        const swap = (a: number, b: number) => {
            [hf[a], hf[b]] = [hf[b], hf[a]];
            [hi[a], hi[b]] = [hi[b], hi[a]];
        };
        const push = (f: number, id: number) => {
            hf.push(f); hi.push(id);
            for (let i = hf.length - 1; i > 0;) {
                const p = (i - 1) >> 1;
                if (hf[p] <= hf[i]) break;
                swap(p, i);
                i = p;
            }
        };
        const pop = (): number => {
            const top = hi[0];
            const lf = hf.pop()!, li = hi.pop()!;
            if (hf.length) {
                hf[0] = lf; hi[0] = li;
                for (let i = 0; ;) {
                    const l = 2 * i + 1, r = l + 1;
                    let m = i;
                    if (l < hf.length && hf[l] < hf[m]) m = l;
                    if (r < hf.length && hf[r] < hf[m]) m = r;
                    if (m === i) break;
                    swap(m, i);
                    i = m;
                }
            }
            return top;
        };
        const otherNets = (id: number) => {
            const cell = cells.get(id);
            if (!cell) return null;
            const owners = srcOf.get(id);
            const shared = !!owners && owners.size === 1 && owners.has(u);
            let other = 0, both = false, any = false;
            for (const [n, m] of cell) {
                if (n === net || shared) continue;
                any = true;
                other |= m;
                if ((m & AXIS_V) && (m & AXIS_H)) both = true;
            }
            return any ? { other, both } : { other: 0, both: false, sameNet: true };
        };
        const h = (r: number, c: number) => Math.abs(r - gr) + Math.abs(c - gc);

        // no route: the call still shows, as a dashed L from the caller to the callee's arrival side, with its arrowhead
        const fallback = () => {
            unrouted++;
            failed.push([u, v]);
            const tip = left ? pv.col - 1 : P.end.get(v)! + 1, xm = left ? pv.col - 1.5 : P.end.get(v)! + 1.5;
            const pts: [number, number][] = sr === pv.row ? [[sc, sr + 0.5], [tip, pv.row + 0.5]]
                : [[sc, sr + 0.5], [xm, sr + 0.5], [xm, pv.row + 0.5], [tip, pv.row + 0.5]];
            paths.push({ from: u, to: v, net, pts, cells: [], start: 'E', arrive: left ? 'E' : 'W', fallback: true });
        };
        if (sr < 0 || sr >= RH || sc >= RW || blocked.has(cellId(sr, sc))) { fallback(); continue; }
        // start states: label end heading E; under and over the first character heading S and N
        // a caller that receives calls at its right end prefers to send from under or over its name;
        // its label end stays a costly fallback
        const starts: { id: number; r: number; c: number; d: number; cost: number }[] =
            [{ id: sid(sr, sc, 2), r: sr, c: sc, d: 2, cost: !port && leftArrival.get(u) === false ? 20 : 0 }];
        if (!port) {
            for (const [r, d] of [[pu.row + 1, 1], [pu.row - 1, 0]] as const) {
                const id = cellId(r, pu.col);
                const rsv = reserved.get(id);
                if (r >= 0 && r < RH && !blocked.has(id) && !pad.has(id) && !markAt.has(id) && !border.has(id) && (rsv === undefined || rsv === `src:${u}`)) {
                    starts.push({ id: sid(r, pu.col, d), r, c: pu.col, d, cost: 2 });
                }
            }
        }
        const startDir = new Map(starts.map((s) => [s.id, s.d] as const));
        let goal = -1;
        // a stem that starts on a trunk of this net alone joins it there (`├───┴─>`: the caller sits right above)
        const onNet = starts.find((s) => s.d !== 2 && cells.get(cellId(s.r, s.c))?.has(net) && cells.get(cellId(s.r, s.c))!.size === 1);
        if (onNet) { goal = onNet.id; g[onNet.id] = 0; touched.push(onNet.id); }
        // the arrival cell already drawn for this net (collector lane): reaching it is a merge
        const drawnGoal = !!cells.get(cellId(gr, gc))?.has(net);
        // pass 0 strict; pass 1 relaxed: running along or turning on another net costs RELAX instead of being blocked
        for (let pass = 0; pass < 2 && goal < 0; pass++) {
        const relaxed = pass === 1;
        for (const t of touched) { g[t] = Infinity; came[t] = -1; }
        touched.length = 0;
        hf.length = 0; hi.length = 0;
        for (const s of starts) { g[s.id] = s.cost; touched.push(s.id); push(s.cost + h(s.r, s.c), s.id); }
        let expansions = 0;
        while (hf.length && expansions < 400000) {
            const id = pop();
            expansions++;
            const d = id % 4, cellIx = (id - d) / 4;
            const r = Math.floor(cellIx / RW), c = cellIx % RW;
            const gcur = g[id];
            if (r === gr && c === gc && d === gdir) { goal = id; break; }
            // merge into an existing trunk of the same net
            // merge only where the trunk of this net runs alone: a merge on a line other calls share is ambiguous
            const here0 = cells.get(cellId(r, c));
            if (!startDir.has(id) && here0?.has(net) && here0.size === 1 && !(r === gr && c === gc)) { goal = id; break; }
            const here = otherNets(cellId(r, c));
            for (let nd = 0; nd < 4; nd++) {
                const sd = startDir.get(id);
                if (sd !== undefined && nd !== sd) continue;    // leave the caller in the start heading
                let turnPenalty = 0;
                if (nd !== d && here && !('sameNet' in here) && here.other) {  // no turn on another net
                    if (!relaxed) continue;
                    turnPenalty = RELAX_TURN;
                }
                if ((d === 0 && nd === 1) || (d === 1 && nd === 0) || (d === 2 && nd === 3) || (d === 3 && nd === 2)) continue;
                const nr = r + DR[nd], nc = c + DC[nd];
                if (nr < 0 || nr >= RH || nc < 0 || nc >= RW) continue;
                const nid = cellId(nr, nc);
                const atGoal = nr === gr && nc === gc;
                if (blocked.has(nid) || pad.has(nid)) continue;
                if (!atGoal && markAt.has(nid)) continue;
                const rsv = reserved.get(nid);
                if (rsv !== undefined && rsv !== net && rsv !== `src:${u}` && !relaxed) continue;
                let step = 1;
                const b = border.get(nid);
                if (b) {
                    if ((b === 'v' && nd < 2) || (b === 'h' && nd >= 2)) continue;
                    step += opts.cost.border;
                }
                const o = otherNets(nid);
                if (o) {
                    if ('sameNet' in o) step = 0.3;
                    else {
                        const along = nd < 2 ? AXIS_V : AXIS_H;
                        if (o.both || (o.other & along)) {
                            if (!relaxed) continue;
                            step += RELAX_ALONG;
                        } else step += opts.cost.cross;
                    }
                }
                if (nd !== d) step += opts.cost.bend + turnPenalty;
                // spacing: a vertical run in the column next to an unrelated vertical line reads as one thick line;
                // horizontal runs on adjacent rows are a row apart and stay free
                const side = nd < 2 ? [cellId(nr, nc - 1), cellId(nr, nc + 1)] : [];
                const along = AXIS_V;
                for (const sc2 of side) {
                    const sm = cells.get(sc2);
                    if (!sm) continue;
                    const own = srcOf.get(sc2);
                    if (own && own.size === 1 && own.has(u)) continue;
                    for (const [n2, m2] of sm) if (n2 !== net && (m2 & along)) { step += opts.cost.adjacent; break; }
                }
                const ns = sid(nr, nc, nd);
                const ng = gcur + step;
                if (ng < g[ns]) {
                    if (g[ns] === Infinity) touched.push(ns);
                    g[ns] = ng;
                    came[ns] = id;
                    push(ng + h(nr, nc), ns);
                }
            }
        }

        }
        if (goal < 0) fallback();
        else {
            // reconstruct
            const seq: { r: number; c: number; d: number }[] = [];
            for (let id = goal; id >= 0; id = came[id]) {
                const d = id % 4, cellIx = (id - d) / 4;
                seq.push({ r: Math.floor(cellIx / RW), c: cellIx % RW, d });
                if (startDir.has(id) && came[id] < 0) break;
            }
            seq.reverse();
            const startKind = seq[0].d === 2 ? 'E' : seq[0].d === 1 ? 'S' : 'N';
            const merged = drawnGoal || !(seq[seq.length - 1].r === gr && seq[seq.length - 1].c === gc);
            if (startKind === 'E') {
                add(sr, sc, net, port ? W : W | E, u);
                if (port) add(port.row, port.col, net, N | E, u);
            } else add(seq[0].r, seq[0].c, net, startKind === 'S' ? N : S, u);   // touch the label edge
            for (let i = 1; i < seq.length; i++) {
                const a = seq[i - 1], b = seq[i];
                const nd = b.d;
                add(a.r, a.c, net, BIT[nd], u);
                add(b.r, b.c, net, OPP[nd], u);
            }
            if (!merged && opts.arrow) {
                mark({ row: gr, col: gc, ch: left ? '>' : '<', net, role: left ? 'arrowE' : 'arrowW' });
                arrowTo.set(cellId(gr, gc), v);
            } else if (!merged) add(gr, gc, net, left ? E : W);
            // polyline through bends
            const pts: [number, number][] = [];
            if (startKind === 'E') {
                pts.push(port ? [port.col + 0.5, port.row] : [sc, sr + 0.5]);
                if (port) pts.push([port.col + 0.5, port.row + 0.5]);
            } else pts.push([pu.col + 0.5, startKind === 'S' ? pu.row + 1 : pu.row]);
            for (let i = 1; i < seq.length - 1; i++) if (seq[i + 1].d !== seq[i].d) pts.push([seq[i].c + 0.5, seq[i].r + 0.5]);
            const lastC = seq[seq.length - 1];
            pts.push(merged ? [lastC.c + 0.5, lastC.r + 0.5] : [left ? gc + 1 : gc, gr + 0.5]);
            let own = (port && startKind === 'E' ? [cellId(port.row, port.col)] : []).concat(seq.map((x) => cellId(x.r, x.c)));
            let end = pts[pts.length - 1];
            let arrive: 'E' | 'W' = left ? 'E' : 'W';
            if (merged) {
                // continue along the trunk this call joined, to the callee, arriving as that trunk does
                const j = own[own.length - 1];
                const host = paths.find((q) => q.to === v && q.net === net && q.cells.includes(j));
                if (host) {
                    own = own.concat(host.cells.slice(host.cells.indexOf(j) + 1));
                    end = host.pts[host.pts.length - 1];
                    arrive = host.arrive;
                }
            } else if (!roots.has(net)) roots.set(net, cellId(gr, gc));
            // the cell the start point leaves from precedes the path, so a turn at its first cell (a stem merging
            // where it starts, `├───┴─>`) is a bend too
            const pre = startKind === 'E' ? (port ? undefined : cellId(sr, sc - 1)) : cellId(pu.row, pu.col);
            const full: [number, number][] = [pts[0], ...(startKind === 'E' && port ? [pts[1]] : []), ...bends(pre === undefined ? own : [pre, ...own]), end];
            paths.push({ from: u, to: v, net, pts: full, cells: own, start: startKind === 'E' ? (port ? 'S' : 'E') : startKind, arrive });
            for (const s of seq) { width = Math.max(width, s.c + 1); height = Math.max(height, s.r + 1); }
        }
        for (const t of touched) { g[t] = Infinity; came[t] = -1; }
        touched.length = 0;
    }

    let conflicts = 0;
    for (const l of labels) {
        if (l.kind !== 'node') continue;
        for (let c = l.col; c < l.col + l.text.length; c++) if (cells.has(cellId(l.row, c))) conflicts++;
    }
    return { width, height, cells, marks, labels, nets, paths, frames: P.frames, roots, conflicts, unrouted, failed, markers, arrowTo };
}

export function cellGlyph(nets: Map<string, number>, gs: GlyphSet): string {
    if (nets.size === 1) return gs.mask(nets.values().next().value!);
    let union = 0;
    let vert = false, horiz = false, other = false;
    for (const m of nets.values()) {
        union |= m;
        if (m === (N | S)) vert = true;
        else if (m === (E | W)) horiz = true;
        else other = true;
    }
    if (vert && horiz && !other) return gs.cross;
    return gs.mask(union);
}

function markGlyph(m: Mark, gs: GlyphSet): string {
    if (m.role !== 'frame') return m.ch;
    switch (m.ch) {
        case 'tl': return gs.frame.tl;
        case 'tr': return gs.frame.tr;
        case 'bl': return gs.frame.bl;
        case 'br': return gs.frame.br;
        case 'h': return gs.frame.h;
        default: return gs.frame.v;
    }
}

/** Character matrix with labels; `blankLabels` leaves label cells empty (SVG draws labels apart). */
export function charRows(g: Grid, gs: GlyphSet, blankLabels = false, withMarkers = true): string[][] {
    const rows = Array.from({ length: g.height }, () => Array<string>(g.width).fill(' '));
    const put = (r: number, c: number, ch: string) => {
        if (r < 0 || r >= g.height || c < 0) return;
        while (rows[r].length <= c) rows[r].push(' ');
        rows[r][c] = ch;
    };
    for (const m of g.marks) if (m.role === 'frame') put(m.row, m.col, markGlyph(m, gs));
    for (const [id, nets] of g.cells) {
        const [r, c] = cellRC(id);
        put(r, c, cellGlyph(nets, gs));
    }
    for (const m of g.marks) {
        // a call crossing a frame border keeps its own glyph: the frame breaks, the call stays continuous
        if (m.role !== 'frame' && (withMarkers || m.role !== 'marker')) put(m.row, m.col, markGlyph(m, gs));
    }
    for (const l of g.labels) {
        const text = l.kind === 'box' ? ` ${l.text} ` : l.text;
        const c0 = l.kind === 'box' ? l.col - 1 : l.col;
        for (let i = 0; i < text.length; i++) put(l.row, c0 + i, blankLabels ? ' ' : text[i]);
    }
    return rows;
}

export function toText(g: Grid, gs: GlyphSet): string {
    return charRows(g, gs).map((r) => r.join('').trimEnd()).join('\n');
}

/* secure tooling: HTML export: attributes escape " and '*/
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** `<pre>` body with vertex labels wrapped in links; `href` returns undefined for unlinked labels. */
export function toHtmlPre(g: Grid, gs: GlyphSet, href: (key: NodeKey) => string | undefined): string {
    const rows = charRows(g, gs, true);
    const byRow = new Map<number, LabelSpan[]>();
    for (const l of g.labels) {
        if (!byRow.has(l.row)) byRow.set(l.row, []);
        byRow.get(l.row)!.push(l);
    }
    const out: string[] = [];
    rows.forEach((chars, r) => {
        const spans = (byRow.get(r) ?? []).sort((a, b) => a.col - b.col);
        let line = '';
        let c = 0;
        for (const s of spans) {
            const text = s.kind === 'box' ? ` ${s.text} ` : s.text;
            const c0 = s.kind === 'box' ? s.col - 1 : s.col;
            line += esc(chars.slice(c, c0).join(''));
            const h = s.kind === 'node' ? href(s.key) : undefined;
            line += h ? `<a href="${esc(h)}">${esc(text)}</a>` : esc(text);
            c = c0 + text.length;
        }
        line += esc(chars.slice(c).join('').trimEnd());
        out.push(line.trimEnd());
    });
    return out.join('\n');
}
