/** @xvdp
 * Character grid from a placement. Cell: direction mask (N, S, E, W) per net; net: `t:<parent>` (tree stem and
 * elbows) or `l:<target>` (calls into one vertex). Glyph text and vector paths share the masks; `paths`: one
 * polyline per call.
 *
 * Drawing order:
 * 1. Labels; namespace frames with headers.
 * 2. Per block: tree elbows and lanes of vertices sharing one subtree shift.
 * 3. Other calls: A* (Hart, Nilsson, Raphael 1968), grid maze routing (Lee 1961). Costs: step 1, `bend`,
 *    `cross` (another net's perpendicular segment), `border` (frame border at right angle); 0.3 on own net or
 *    caller cells (merging into a trunk). Blocked: labels, headers, frame corners, arrowheads, running along or
 *    turning on another net. Departure: label end (`f() ──`), or at cost 2 below or above the first character
 *    (`├─>`, `┌─>`; callee above caller). Arrival: left (`──> f()`) without a drawn tree elbow, else right (`f() <──`).
 *
 * Cell glyph: one net → its mask glyph; several → union mask, or `GlyphSet.cross` for a pure crossing (masks
 * N|S and E|W only). Straight cells of implicit-only or cross-language-only calls (`Grid.kinds`) →
 * `GlyphSet.kinds`: dotted, or dash and dot alternating by cell.
 */
import { NodeKey } from './model';
import { Frame, Placement } from './place';
import { VGraph } from './quotient';
import { Rules } from './rules';
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
    cells: number[];           // cell ids, caller to callee, through merged trunks
    start: 'E' | 'S' | 'N';    // initial heading: label end, below or above its first character
    arrive: 'E' | 'W';         // final heading
    fallback?: boolean;        // no route: dashed L on top, no grid cells
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
    arrowTo: Map<number, NodeKey>;      // arrowhead cell → target
    kinds: Map<number, CallKind>;       // cells of one call kind only (`bridge` where both meet)
    routes: RouteRecord[];              // one record per drawn call: how it was routed (edge log, h39 reroute)
    reroutes: number;                   // h39 rounds kept
}

/**
 * Edge log record of one call. `kind`: tree elbow, lane, routed (A*), fallback (dashed); `order`: routing position
 * (routed calls); `arrival`: why its callee receives left or at its end; `pass`: 0 strict, 1 relaxed; cost parts at
 * routing time: `steps` (cells), `bends`, `paid` (crossings of earlier lines), `borders`, `relaxed` (penalties of the
 * relaxed pass), `cost` (A* total); `received`: crossings by calls routed after it, `by` their calls; `round`: the
 * h39 reroute round that routed it last (0: first routing).
 */
export interface RouteRecord {
    from: NodeKey; to: NodeKey; net: string;
    kind: 'elbow' | 'lane' | 'routed' | 'fallback';
    order?: number; start?: 'E' | 'S' | 'N'; arrive?: 'E' | 'W'; arrival?: string; pass?: number;
    cost?: number; steps?: number; bends?: number; paid?: number; borders?: number; relaxed?: number;
    received: number; by: string[]; round: number;
}

export interface RouteCost { bend: number; cross: number; border: number; adjacent: number }

/** implicit: runtime call without a call expression; bridge: cross-language call (GEdge.via). */
export type CallKind = 'implicit' | 'bridge';

const STRIDE = 1 << 16;
/** Max cells routed by search: 4 headings × 12 bytes per cell = 48 MB; view files bound moves to ±1000 cells. */
const MAX_CELLS = 1_000_000;
export const cellId = (r: number, c: number) => r * STRIDE + c;
export const cellRC = (id: number): [number, number] => [Math.floor(id / STRIDE), id % STRIDE];

const DR = [-1, 1, 0, 0];
const DC = [0, 0, 1, -1];
const BIT = [N, S, E, W];
const OPP = [S, N, W, E];
const AXIS_V = N | S, AXIS_H = E | W;

/** Bend points of a cell path: centers of direction-change cells. */
function bends(cells: number[]): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 1; i < cells.length - 1; i++) {
        const [r0, c0] = cellRC(cells[i - 1]), [r1, c1] = cellRC(cells[i]), [r2, c2] = cellRC(cells[i + 1]);
        if ((r1 - r0 !== r2 - r1) || (c1 - c0 !== c2 - c1)) out.push([c1 + 0.5, r1 + 0.5]);
    }                                                                                                                                                                       
    return out;
}

/**
 * `joint` (tree parent rule): elbow tails in the callee's net, open to its other calls; collector lanes enter from
 * the left; routed calls arrive left when the two cells before the label are free (no caller vote).
 */
export interface GridOpts { arrow: boolean; cost?: Partial<RouteCost>; first?: string[]; joint?: boolean; kind?: (from: NodeKey, to: NodeKey) => CallKind | undefined; rules?: Rules }

/**
 * Grid of a placement; h39_reroute: after the first routing, calls that later calls crossed at least `min` times,
 * and the earlier call of each braid (two calls crossing each other twice), are candidates; per attempt the
 * candidates of one caller (most received crossings first) are routed again after the others; the attempt is kept
 * when the total route cost (`gridCost`) drops, else the next caller is tried (`tries` per round, `rounds` rounds).
 */
export function buildGrid(P: Placement, vg: VGraph, opts: GridOpts): Grid {
    const R = opts.rules ?? new Rules();
    let best = gridOnce(P, vg, opts, R, new Map(), 0);
    const rounds = R.p('h39_reroute', 'rounds'), min = R.p('h39_reroute', 'min');
    let last = new Map<string, number>();
    for (let round = 1; round <= rounds; round++) {
        const braid = new Set<string>();
        for (const r of best.routes) {
            const n = new Map<string, number>();
            for (const b of r.by) n.set(b, (n.get(b) ?? 0) + 1);
            if ([...n.values()].some((x) => x >= 2)) braid.add(eid(r.from, r.to));
        }
        const pick = best.routes.filter((r) => r.kind === 'routed' && (r.received >= min || braid.has(eid(r.from, r.to))));
        // one caller's calls per attempt, most received crossings first; up to `tries` attempts per round
        const byCaller = new Map<NodeKey, RouteRecord[]>();
        for (const r of pick) byCaller.set(r.from, [...(byCaller.get(r.from) ?? []), r]);
        const groups = [...byCaller.values()].sort((a, b) => b.reduce((x, r) => x + r.received, 0) - a.reduce((x, r) => x + r.received, 0));
        let kept = false;
        for (const group of groups.slice(0, R.p('h39_reroute', 'tries'))) {
            const next = new Map(last);
            for (const r of group.sort((a, b) => b.received - a.received)) { next.delete(eid(r.from, r.to)); next.set(eid(r.from, r.to), next.size); }
            const g = gridOnce(P, vg, opts, R, next, round);
            const before = gridCost(best, R), after = gridCost(g, R);
            R.note({ rule: 'h39_reroute', fn: 'buildGrid', unit: `round ${round}`, text: `calls of ${group[0].from.slice(group[0].from.indexOf('#') + 1)} routed after the others: cost ${before.toFixed(0)} → ${after.toFixed(0)}${after < before ? ', kept' : ', dropped'}`,
                values: { calls: group.slice(0, 12).map((r) => `${r.to.slice(r.to.indexOf('#') + 1)} (${r.received} received)`) } });
            if (after < before) { best = { ...g, reroutes: round }; last = next; kept = true; break; }
        }
        if (!kept) break;
    }
    return best;
}

const eid = (a: NodeKey, b: NodeKey) => `${a}\u0000${b}`;

/** Total route cost of a grid: routed cells, bends and crossing cells at h29 costs; unrouted calls 1000 each. */
export function gridCost(g: Grid, R: Rules = new Rules()): number {
    let cells = 0, bends = 0, cross = 0;
    for (const p of g.paths) { cells += p.cells.length; bends += Math.max(0, p.pts.length - 2); }
    for (const [, nets] of g.cells) {
        if (nets.size < 2) continue;
        let v = false, h = false, o = false;
        for (const m of nets.values()) { if (m === (N | S)) v = true; else if (m === (E | W)) h = true; else o = true; }
        if (v && h && !o) cross++;
    }
    return cells + R.p('h29_route_cost', 'bend') * bends + R.p('h29_route_cost', 'cross') * cross + 1000 * g.unrouted;
}

/** One routing of a placement; `last`: calls routed after all others, in this order (h39 reroute). */
function gridOnce(P: Placement, vg: VGraph, opts: GridOpts, R: Rules, last: ReadonlyMap<string, number>, round: number): Grid {
    const cost: RouteCost = {
        bend: opts.cost?.bend ?? R.p('h29_route_cost', 'bend'), cross: opts.cost?.cross ?? R.p('h29_route_cost', 'cross'),
        border: opts.cost?.border ?? R.p('h29_route_cost', 'border'), adjacent: opts.cost?.adjacent ?? R.p('h29_route_cost', 'adjacent'),
    };
    const OWN = R.p('h29_route_cost', 'bundle'), RELAX_TURN = R.p('h29_route_cost', 'relaxTurn'), RELAX_ALONG = R.p('h29_route_cost', 'relaxAlong');
    const STEPS = R.p('h29_route_cost', 'steps'), EST = R.p('h29_route_cost', 'estimate'), UNDER = R.p('h28_departure_point', 'under');
    const cells = new Map<number, Map<string, number>>();
    const srcOf = new Map<number, Set<NodeKey>>();
    const marks: Mark[] = [];
    const markAt = new Set<number>();
    const nets = new Map<string, Net>();
    const paths: EdgePath[] = [];
    // S1: routing area, nets per cell (occN) and static obstacles (obs) as typed arrays: the search reads the Maps
    // only for cells that hold lines
    const RW = P.width + 16, RH = P.height + 12;
    const routable = RW * RH <= MAX_CELLS;
    const occN = new Uint8Array(routable ? RW * RH : 0);
    const inArea = (r: number, c: number) => r >= 0 && r < RH && c >= 0 && c < RW;
    const add = (r: number, c: number, net: string, m: number, src?: NodeKey) => {
        const id = cellId(r, c);
        let cell = cells.get(id);
        if (!cell) cells.set(id, (cell = new Map()));
        if (!cell.has(net) && routable && inArea(r, c) && occN[r * RW + c] < 255) occN[r * RW + c]++;
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
    let obs: Uint8Array | undefined;   // filled before routing: 1 label or blocked, 2 label padding, 4 mark, 8 border |, 16 border ─
    const mark = (m: Mark) => {
        marks.push(m);
        if (m.role === 'frame') return;
        markAt.add(cellId(m.row, m.col));
        if (obs && inArea(m.row, m.col)) obs[m.row * RW + m.col] |= 4;
    };
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
    // one free cell each side of a label: lines touch it only at arrival and departure
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
    const drawnKind = new Map<string, 'elbow' | 'lane'>();   // edge log: calls drawn before routing
    const elbowInto = new Set<NodeKey>();
    const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
    /** Stem under p, elbows to children whose stem column and elbow row cross no label. */
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
            // joint: tail in the callee's net, open to its other calls
            const tn = opts.joint ? lane(c) : net;
            hline(pc.row, pp.col + 1, pc.col - 3, tn, p);
            if (opts.arrow) { add(pc.row, pc.col - 2, tn, W, p); mark({ row: pc.row, col: pc.col - 2, ch: '>', net: tn, role: 'arrowE' }); }
            else add(pc.row, pc.col - 2, tn, E | W, p);
            if (tn !== net && !roots.has(tn)) roots.set(tn, cellId(pc.row, pc.col - 2));
            arrowTo.set(cellId(pc.row, pc.col - 2), c);
            drawn.add(eid(p, c));
            drawnKind.set(eid(p, c), 'elbow');
            elbowInto.add(c);
            paths.push({ from: p, to: c, net: tn, start: 'S', arrive: 'E',
                pts: [[pp.col + 0.5, pp.row + 1], [pp.col + 0.5, pc.row + 0.5], [pc.col - 1, pc.row + 0.5]],
                cells: [...colCells(pp.col, pp.row + 1, pc.row), ...row(pc.row, pp.col + 1, pc.col - 2)] });
        }
    };
    /** Collector lane (rule `joint`): down to the approach row, left to the collector column, down, in from left. */
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

    // stable-placement markers: router obstacles, clickable
    const markers = P.markers ?? [];
    for (const m of markers) {
        for (let i = 0; i < m.text.length; i++) {
            marks.push({ row: m.row, col: m.col + i, ch: m.text[i], role: 'marker' });
            blocked.add(cellId(m.row, m.col + i));
        }
    }
    // h24: tree elbows and lanes first; off: every call routed
    for (const [p, kids] of R.on('h24_tree_lines_first') ? P.elbows ?? [] : []) elbows(p, kids, () => true);
    for (const B of R.on('h24_tree_lines_first') ? P.blocks : []) {
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
    // level calls (straight) shortest first, then the rest longest first
    const departRow = (k: NodeKey) => (P.port.get(k) ?? P.pos.get(k)!).row;
    const level = (e: { from: NodeKey; to: NodeKey }) => departRow(e.from) === P.pos.get(e.to)!.row;
    const first = new Set(opts.first ?? []);
    const pri = (e: { from: NodeKey; to: NodeKey }) => (first.has(`${e.from}\u0000${e.to}`) ? 1 : 0);
    // h25 alternatives: `longest` (level calls shortest first, then longest first), `shortest`, `row` (top to bottom)
    const order = R.alt('h25_routing_order');
    const rowOf = (k: NodeKey) => P.pos.get(k)!.row, colOf = (k: NodeKey) => P.pos.get(k)!.col;
    const lastOf = (e: { from: NodeKey; to: NodeKey }) => last.get(eid(e.from, e.to)) ?? -1;
    todo.sort((a, b) => pri(b) - pri(a) || lastOf(a) - lastOf(b)
        || (order === 'row' ? departRow(a.from) - departRow(b.from) || colOf(a.from) - colOf(b.from) || rowOf(a.to) - rowOf(b.to)
            : Number(level(b)) - Number(level(a))
                || (level(a) || order === 'shortest' ? dist(a.from, a.to) - dist(b.from, b.to) : dist(b.from, b.to) - dist(a.from, a.to)))
        || (a.from + a.to < b.from + b.to ? -1 : 1));

    // arrival side per target by caller majority: left (`──> f()`) or end (`f() <──`); left cells reserved
    const leftArrival = new Map<NodeKey, boolean>();
    const arrivalWhy = new Map<NodeKey, string>();
    const reserved = new Map<number, string>();
    const votes = new Map<NodeKey, number>();
    for (const e of todo) votes.set(e.to, (votes.get(e.to) ?? 0) + (P.pos.get(e.from)!.col < P.pos.get(e.to)!.col ? 1 : -1));
    // a vertex sending from its label end keeps that end: arrivals from the left
    const departs = new Set<NodeKey>(todo.map((e) => e.from));
    for (const [id, own] of srcOf) { const [r, c] = cellRC(id); for (const u of own) { const p = P.pos.get(u); if (p && p.row === r && c === P.end.get(u)! + 1) departs.add(u); } }
    for (const e of todo) {
        const v = e.to;
        if (leftArrival.has(v)) continue;
        const pv = P.pos.get(v)!;
        const free = (r: number, c: number) => c >= 0 && !blocked.has(cellId(r, c)) && !border.has(cellId(r, c)) && !cells.has(cellId(r, c)) && !reserved.has(cellId(r, c));
        // collector lane or joint elbow already enters left: join it
        const own = !!cells.get(cellId(pv.row, pv.col - 2))?.has(`l:${v}`) && !elbowInto.has(v);
        // a vertex sending from its label end receives left even when those cells are taken (dashed fallback):
        // its end never carries calls in and out
        const sends = departs.has(v) && !elbowInto.has(v);
        // a left arrival needs an approach cell before its two cells: free, or a frame border with a cell before it
        // (content three cells right of the outermost border at column 0 has none)
        const a3 = cellId(pv.row, pv.col - 3);
        const approach = pv.col >= 3 && !blocked.has(a3) && (!border.has(a3) || (pv.col >= 4 && !blocked.has(cellId(pv.row, pv.col - 4))));
        const left = own || (sends && approach) || (!elbowInto.has(v) && (opts.joint || votes.get(v)! >= 0) && approach && free(pv.row, pv.col - 2) && free(pv.row, pv.col - 1));
        leftArrival.set(v, left);
        arrivalWhy.set(v, own ? 'left: joins the lane or elbow entering from the left' : sends && left ? 'left: the function sends from its label end'
            : !approach && !elbowInto.has(v) ? 'end: no cell to approach the left side'
            : left ? (opts.joint ? 'left: joint parent rule' : 'left: callers mostly left, two cells free') : elbowInto.has(v) ? 'end: a tree elbow enters from the left' : 'end: callers mostly right, or the left cells taken');
        if (left && !own) { reserved.set(cellId(pv.row, pv.col - 2), `l:${v}`); reserved.set(cellId(pv.row, pv.col - 1), `l:${v}`); }
    }
    // h27: departure cells reserved for the caller: two cells after the label or port
    for (const e of R.on('h27_departure_reservation') ? todo : []) {
        const port = P.port.get(e.from);
        const r = port ? port.row : P.pos.get(e.from)!.row;
        const c = port ? port.col + 1 : P.end.get(e.from)! + 1;
        for (const cc of [c, c + 1]) if (!reserved.has(cellId(r, cc))) reserved.set(cellId(r, cc), `src:${e.from}`);
    }

    let width = P.width, height = P.height;
    // 12 bytes per (cell, heading); beyond MAX_CELLS every call draws as fallback
    if (routable) {
        obs = new Uint8Array(RW * RH);
        const put = (id: number, bit: number) => { const [r, c] = cellRC(id); if (inArea(r, c)) obs![r * RW + c] |= bit; };
        for (const id of blocked) put(id, 1);
        for (const id of pad) put(id, 2);
        for (const id of markAt) put(id, 4);
        for (const [id, b] of border) put(id, b === 'v' ? 8 : 16);
        for (const id of reserved.keys()) put(id, 32);
    }
    const size = routable ? RW * RH * 4 : 0;
    const g = new Float64Array(size).fill(Infinity);
    const came = new Int32Array(size).fill(-1);
    const touched: number[] = [];
    let unrouted = 0;
    const failed: [NodeKey, NodeKey][] = [];
    const routes: RouteRecord[] = [];
    // h40 lookahead: per cell, the calls not routed yet whose bounding box holds it
    const LOOK = routable ? R.p('h40_lookahead', 'weight') : 0;
    const pending = LOOK > 0 ? new Float32Array(RW * RH) : undefined;
    const boxOf = (e: { from: NodeKey; to: NodeKey }) => {
        const a = P.pos.get(e.from)!, b = P.pos.get(e.to)!;
        return [Math.max(0, Math.min(a.row, b.row)), Math.min(RH - 1, Math.max(a.row, b.row)), Math.max(0, Math.min(a.col, b.col)), Math.min(RW - 1, Math.max(P.end.get(e.from)!, b.col))];
    };
    const addBox = (e: { from: NodeKey; to: NodeKey }, w: number) => {
        if (!pending) return;
        const [r0, r1, c0, c1] = boxOf(e);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) pending[r * RW + c] += w;
    };
    for (const e of todo) addBox(e, 1);

    for (const [order, e] of todo.entries()) {
        const net = lane(e.to);
        const u = e.from, v = e.to;
        addBox(e, -1);
        let pass = 0;
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
            const f = hf[a]; hf[a] = hf[b]; hf[b] = f;
            const x = hi[a]; hi[a] = hi[b]; hi[b] = x;
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
        const srcKey = `src:${u}`;
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
        // estimate: Manhattan distance × `estimate` (≤ OWN: admissible, cheapest routes; 1: faster, may miss them)
        const h = (r: number, c: number) => EST * (Math.abs(r - gr) + Math.abs(c - gc));

        // no route: dashed L to the callee's arrival side, with arrowhead
        const fallback = () => {
            unrouted++;
            failed.push([u, v]);
            const tip = left ? pv.col - 1 : P.end.get(v)! + 1, xm = left ? pv.col - 1.5 : P.end.get(v)! + 1.5;
            const pts: [number, number][] = sr === pv.row ? [[sc, sr + 0.5], [tip, pv.row + 0.5]]
                : [[sc, sr + 0.5], [xm, sr + 0.5], [xm, pv.row + 0.5], [tip, pv.row + 0.5]];
            paths.push({ from: u, to: v, net, pts, cells: [], start: 'E', arrive: left ? 'E' : 'W', fallback: true });
            routes.push({ from: u, to: v, net, kind: 'fallback', order, arrival: arrivalWhy.get(v), received: 0, by: [], round: last.has(eid(u, v)) ? round : 0 });
        };
        if (!routable || sr < 0 || sr >= RH || sc >= RW || blocked.has(cellId(sr, sc))) { fallback(); continue; }
        // start states: label end heading E; below / above the first character heading S / N.
        // A caller receiving at its right end sends only from below or above its name
        const starts: { id: number; r: number; c: number; d: number; cost: number }[] =
            !port && leftArrival.get(u) === false ? [] : [{ id: sid(sr, sc, 2), r: sr, c: sc, d: 2, cost: 0 }];
        if (!port) {
            for (const [r, d] of [[pu.row + 1, 1], [pu.row - 1, 0]] as const) {
                const id = cellId(r, pu.col);
                const rsv = reserved.get(id);
                if (r >= 0 && r < RH && !blocked.has(id) && !pad.has(id) && !markAt.has(id) && !border.has(id) && (rsv === undefined || rsv === `src:${u}`)) {
                    starts.push({ id: sid(r, pu.col, d), r, c: pu.col, d, cost: UNDER });
                }
            }
        }
        if (!starts.length) { fallback(); continue; }
        const startDir = new Map(starts.map((s) => [s.id, s.d] as const));
        let goal = -1;
        // a stem starting on a trunk of this net alone joins it (`├───┴─>`: caller directly above)
        const onNet = starts.find((s) => s.d !== 2 && cells.get(cellId(s.r, s.c))?.has(net) && cells.get(cellId(s.r, s.c))!.size === 1);
        if (onNet) { goal = onNet.id; g[onNet.id] = 0; touched.push(onNet.id); }
        // arrival cell already drawn for this net (collector lane): reaching it merges
        const drawnGoal = !!cells.get(cellId(gr, gc))?.has(net);
        // pass 0 strict; pass 1: running along or turning on another net costs RELAX_* instead of blocking
        for (pass = 0; pass < 2 && goal < 0; pass++) {
        const relaxed = pass === 1;
        for (const t of touched) { g[t] = Infinity; came[t] = -1; }
        touched.length = 0;
        hf.length = 0; hi.length = 0;
        for (const s of starts) { g[s.id] = s.cost; touched.push(s.id); push(s.cost + h(s.r, s.c), s.id); }
        let expansions = 0;
        while (hf.length && expansions < STEPS) {
            const id = pop();
            expansions++;
            const d = id % 4, cellIx = (id - d) / 4;
            const r = Math.floor(cellIx / RW), c = cellIx % RW;
            const gcur = g[id];
            if (r === gr && c === gc && d === gdir) { goal = id; break; }
            // merge into a trunk of this net only where it runs alone (shared lines: ambiguous)
            const occupied = occN[r * RW + c] > 0;
            const here0 = occupied ? cells.get(cellId(r, c)) : undefined;
            const sd = startDir.get(id);
            if (sd === undefined && here0?.has(net) && here0.size === 1 && !(r === gr && c === gc)) { goal = id; break; }
            const here = occupied ? otherNets(cellId(r, c)) : null;
            for (let nd = 0; nd < 4; nd++) {
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
                const ni = nr * RW + nc;
                const ob = obs![ni];
                const atGoal = nr === gr && nc === gc;
                if (ob & 3) continue;                       // label or blocked, label padding
                if (!atGoal && (ob & 4)) continue;          // marker or arrowhead
                const rsv = ob & 32 ? reserved.get(nid) : undefined;
                if (rsv !== undefined && rsv !== net && rsv !== srcKey && !relaxed) continue;
                let step = 1;
                if (ob & 24) {                              // frame border: crossed at right angles only
                    if (((ob & 8) && nd < 2) || ((ob & 16) && nd >= 2)) continue;
                    step += cost.border;
                }
                const o = occN[ni] ? otherNets(nid) : null;
                if (o) {
                    if ('sameNet' in o) step = OWN;
                    else {
                        const along = nd < 2 ? AXIS_V : AXIS_H;
                        if (o.both || (o.other & along)) {
                            if (!relaxed) continue;
                            step += RELAX_ALONG;
                        } else step += cost.cross;
                    }
                }
                if (nd !== d) step += cost.bend + turnPenalty;
                if (pending) step += LOOK * pending[nr * RW + nc];
                // spacing: vertical runs beside unrelated vertical lines cost `adjacent` (read as one thick line);
                // horizontal runs on adjacent rows read apart
                if (nd < 2) {
                    for (let c2 = nc - 1; c2 <= nc + 1; c2 += 2) {
                        if (c2 < 0 || c2 >= RW || !occN[nr * RW + c2]) continue;
                        const sc2 = cellId(nr, c2);
                        const sm = cells.get(sc2)!;
                        const own = srcOf.get(sc2);
                        if (own && own.size === 1 && own.has(u)) continue;
                        for (const [n2, m2] of sm) if (n2 !== net && (m2 & AXIS_V)) { step += cost.adjacent; break; }
                    }
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
            // cost parts before this call's cells join the grid (edge log)
            let bendsN = 0, paid = 0, borders = 0;
            for (let i = 1; i < seq.length; i++) {
                if (seq[i].d !== seq[i - 1].d) bendsN++;
                const id = cellId(seq[i].r, seq[i].c);
                if (border.has(id)) borders++;
                const o = otherNets(id);
                if (o && !('sameNet' in o) && !o.both && !(o.other & (seq[i].d < 2 ? AXIS_V : AXIS_H))) paid++;
            }
            const goalCost = g[goal];
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
                // follow the joined trunk to the callee; arrive as the trunk does
                const j = own[own.length - 1];
                const host = paths.find((q) => q.to === v && q.net === net && q.cells.includes(j));
                if (host) {
                    own = own.concat(host.cells.slice(host.cells.indexOf(j) + 1));
                    end = host.pts[host.pts.length - 1];
                    arrive = host.arrive;
                }
            } else if (!roots.has(net)) roots.set(net, cellId(gr, gc));
            // start cell precedes the path: a turn at the first cell (stem merging, `├───┴─>`) is a bend
            const pre = startKind === 'E' ? (port ? undefined : cellId(sr, sc - 1)) : cellId(pu.row, pu.col);
            const full: [number, number][] = [pts[0], ...(startKind === 'E' && port ? [pts[1]] : []), ...bends(pre === undefined ? own : [pre, ...own]), end];
            paths.push({ from: u, to: v, net, pts: full, cells: own, start: startKind === 'E' ? (port ? 'S' : 'E') : startKind, arrive });
            const relaxedPass = pass > 1;   // the loop leaves with pass one past the pass that found the goal
            routes.push({ from: u, to: v, net, kind: 'routed', order, start: startKind, arrive, arrival: arrivalWhy.get(v), pass: relaxedPass ? 1 : 0,
                cost: goalCost, steps: seq.length, bends: bendsN, paid, borders, relaxed: relaxedPass ? Math.max(0, goalCost - seq.length - bendsN * cost.bend - paid * cost.cross - borders * cost.border) : 0,
                received: 0, by: [], round: last.has(eid(u, v)) ? round : 0 });
            for (const s of seq) { width = Math.max(width, s.c + 1); height = Math.max(height, s.r + 1); }
        }
        for (const t of touched) { g[t] = Infinity; came[t] = -1; }
        touched.length = 0;
    }

    // elbows and lanes (drawn before routing), then crossings each call received from calls routed after it
    const routedIx = new Map(routes.map((r, i) => [eid(r.from, r.to), i]));
    for (const p of paths) if (!routedIx.has(eid(p.from, p.to))) routes.push({ from: p.from, to: p.to, net: p.net, kind: drawnKind.get(eid(p.from, p.to)) ?? 'lane', received: 0, by: [], round: 0 });
    const ranks = new Map(routes.map((r) => [eid(r.from, r.to), r.order ?? -1]));
    const rank = (p: EdgePath) => ranks.get(eid(p.from, p.to)) ?? -1;
    const through = new Map<number, EdgePath[]>();
    for (const p of paths) for (const id of p.cells) { let l = through.get(id); if (!l) through.set(id, (l = [])); if (!l.includes(p)) l.push(p); }
    const recOf = new Map(routes.map((r) => [eid(r.from, r.to), r]));
    for (const [id, ps] of through) {
        const nets = cells.get(id);
        if (!nets || nets.size < 2 || ps.length < 2) continue;
        for (const a of ps) {
            const ma = nets.get(a.net)!;
            if (ma !== (N | S) && ma !== (E | W)) continue;
            for (const b of ps) {
                if (b.net === a.net || nets.get(b.net) !== ((N | S) + (E | W) - ma) || rank(b) <= rank(a)) continue;
                const r = recOf.get(eid(a.from, a.to))!;
                r.received++;
                r.by.push(eid(b.from, b.to));
            }
        }
    }

    let conflicts = 0;
    for (const l of labels) {
        if (l.kind !== 'node') continue;
        for (let c = l.col; c < l.col + l.text.length; c++) if (cells.has(cellId(l.row, c))) conflicts++;
    }
    // cells of implicit-only or cross-language-only calls; one plain call makes a cell plain
    const kinds = new Map<number, CallKind>();
    if (opts.kind && R.on('h36_call_kind_style')) {
        const plain = new Set<number>();
        for (const p of paths) {
            if (p.fallback) continue;
            const k = opts.kind(p.from, p.to);
            for (const id of p.cells) {
                if (!k) plain.add(id);
                else kinds.set(id, kinds.get(id) === 'bridge' ? 'bridge' : k);
            }
        }
        for (const id of plain) kinds.delete(id);
    }
    return { width, height, cells, marks, labels, nets, paths, frames: P.frames, roots, conflicts, unrouted, failed, markers, arrowTo, kinds, routes, reroutes: 0 };
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

/** Straight call cell by call kind: dotted (implicit), dash and dot by cell parity (bridge). */
function kindGlyph(glyph: string, kind: CallKind, r: number, c: number, gs: GlyphSet): string {
    const k = gs.kinds;
    if (glyph === gs.mask(E | W)) return kind === 'implicit' ? k.implicit.h : k.bridge.h[c % 2];
    if (glyph === gs.mask(N | S)) return kind === 'implicit' ? k.implicit.v : k.bridge.v[r % 2];
    return glyph;
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

/** Character matrix with labels; `blankLabels`: empty label cells (SVG draws labels). */
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
        const glyph = cellGlyph(nets, gs);
        const kind = g.kinds?.get(id);
        put(r, c, kind ? kindGlyph(glyph, kind, r, c, gs) : glyph);
    }
    for (const m of g.marks) {
        // a call crossing a frame border keeps its glyph: frame breaks, call continues
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

/** `<pre>` body; vertex labels as links (`href` undefined: no link); `bold` labels (seeds) in `<b>`. */
export function toHtmlPre(g: Grid, gs: GlyphSet, href: (key: NodeKey) => string | undefined, bold: (key: NodeKey) => boolean = () => false): string {
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
            const shown = s.kind === 'node' && bold(s.key) ? `<b>${esc(text)}</b>` : esc(text);
            line += h ? `<a href="${esc(h)}">${shown}</a>` : shown;
            c = c0 + text.length;
        }
        line += esc(chars.slice(c).join('').trimEnd());
        out.push(line.trimEnd());
    });
    return out.join('\n');
}
