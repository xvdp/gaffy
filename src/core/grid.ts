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
  role: 'arrowE' | 'arrowW' | 'frame';
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
  start: 'E' | 'S' | 'N';    // initial heading: from the label end, or from under or over its first character
  arrive: 'E' | 'W';         // final heading
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
  conflicts: number;         // edge cells inside label spans; 0 by construction
  unrouted: number;          // calls without a route
  failed: [NodeKey, NodeKey][];
}

export interface RouteCost { bend: number; cross: number; border: number }

const STRIDE = 1 << 16;
export const cellId = (r: number, c: number) => r * STRIDE + c;
export const cellRC = (id: number): [number, number] => [Math.floor(id / STRIDE), id % STRIDE];

const DR = [-1, 1, 0, 0];
const DC = [0, 0, 1, -1];
const BIT = [N, S, E, W];
const OPP = [S, N, W, E];
const AXIS_V = N | S, AXIS_H = E | W;
const RELAX = 40;

export function buildGrid(P: Placement, vg: VGraph, opts: { arrow: boolean; cost: RouteCost }): Grid {
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
  const tree = (p: NodeKey) => { const n = `t:${p}`; if (!nets.has(n)) nets.set(n, { kind: 'tree', key: p }); return n; };
  const lane = (t: NodeKey) => { const n = `l:${t}`; if (!nets.has(n)) nets.set(n, { kind: 'lane', key: t }); return n; };

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
  for (const B of P.blocks) {
    const L = B.L;
    for (const [u, vs] of L.back) for (const v of vs) drawn.add(eid(u, v));
    for (const [p, kids] of L.children) {
      const pp = P.pos.get(p)!;
      const ok = kids.filter((c) => {
        if (!same(B.shift.get(p)!, B.shift.get(c)!)) return false;
        const pc = P.pos.get(c)!;
        for (let r = pp.row + 1; r <= pc.row; r++) if (blocked.has(cellId(r, pp.col))) return false;
        for (let cc = pp.col; cc <= pc.col - 2; cc++) if (blocked.has(cellId(pc.row, cc))) return false;
        return true;
      });
      if (!ok.length) continue;
      const net = tree(p);
      const rows = ok.map((c) => P.pos.get(c)!.row);
      const last = Math.max(...rows);
      const childRows = new Set(rows);
      for (let r = pp.row + 1; r <= last; r++) add(r, pp.col, net, N | (r < last ? S : 0) | (childRows.has(r) ? E : 0), p);
      for (const c of ok) {
        const pc = P.pos.get(c)!;
        hline(pc.row, pp.col + 1, pc.col - 3, net, p);
        if (opts.arrow) { add(pc.row, pc.col - 2, net, W, p); mark({ row: pc.row, col: pc.col - 2, ch: '>', net, role: 'arrowE' }); }
        else add(pc.row, pc.col - 2, net, E | W, p);
        drawn.add(eid(p, c));
        elbowInto.add(c);
        paths.push({ from: p, to: c, net, start: 'S', arrive: 'E',
          pts: [[pp.col + 0.5, pp.row + 1], [pp.col + 0.5, pc.row + 0.5], [pc.col - 1, pc.row + 0.5]] });
      }
    }
    for (const ln of L.lanes) {
      const s0 = B.shift.get(ln.target)!;
      if (!ln.sources.every((s) => same(B.shift.get(s.key)!, s0))) continue;
      const col = B.col0 + ln.col + s0[0];
      const tp = P.pos.get(ln.target)!;
      const tEnd = P.end.get(ln.target)!;
      const srcRows = ln.sources.map((s) => (s.port ? P.port.get(s.key)! : P.pos.get(s.key)!).row);
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
      const srcAt = new Map(ln.sources.map((s, i) => [srcRows[i], s.key] as const));
      for (let r = lo; r <= hi; r++) add(r, col, net, (r > lo ? N : 0) | (r < hi ? S : 0) | (srcAt.has(r) || r === hi ? W : 0), srcAt.get(r));
      for (const s of ln.sources) {
        const sp = P.pos.get(s.key)!;
        if (s.port) {
          const pr = P.port.get(s.key)!;
          add(pr.row, pr.col, net, N | E, s.key);
          hline(pr.row, pr.col + 1, col - 1, net, s.key);
          paths.push({ from: s.key, to: ln.target, net, start: 'S', arrive: 'W',
            pts: [[pr.col + 0.5, pr.row], [pr.col + 0.5, pr.row + 0.5], [col + 0.5, pr.row + 0.5], [col + 0.5, hi + 0.5], [tEnd + 1, hi + 0.5]] });
        } else {
          const se = P.end.get(s.key)!;
          hline(sp.row, se + 1, col - 1, net, s.key);
          paths.push({ from: s.key, to: ln.target, net, start: 'E', arrive: 'W',
            pts: [[se + 1, sp.row + 0.5], [col + 0.5, sp.row + 0.5], [col + 0.5, hi + 0.5], [tEnd + 1, hi + 0.5]] });
        }
        drawn.add(eid(s.key, ln.target));
      }
      if (opts.arrow) {
        add(hi, tEnd + 1, net, E);
        mark({ row: hi, col: tEnd + 1, ch: '<', net, role: 'arrowW' });
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
  todo.sort((a, b) => Number(level(b)) - Number(level(a))
    || (level(a) ? dist(a.from, a.to) - dist(b.from, b.to) : dist(b.from, b.to) - dist(a.from, a.to))
    || (a.from + a.to < b.from + b.to ? -1 : 1));

  // arrival side per target, decided before routing; left arrival cells reserved for the target's net
  const leftArrival = new Map<NodeKey, boolean>();
  const reserved = new Map<number, string>();
  for (const e of todo) {
    const v = e.to;
    if (leftArrival.has(v)) continue;
    const pv = P.pos.get(v)!;
    const free = (r: number, c: number) => c >= 0 && !blocked.has(cellId(r, c)) && !border.has(cellId(r, c)) && !cells.has(cellId(r, c)) && !reserved.has(cellId(r, c));
    const left = !elbowInto.has(v) && pv.col >= 2 && free(pv.row, pv.col - 2) && free(pv.row, pv.col - 1);
    leftArrival.set(v, left);
    if (left) { reserved.set(cellId(pv.row, pv.col - 2), `l:${v}`); reserved.set(cellId(pv.row, pv.col - 1), `l:${v}`); }
  }
  // departure cells reserved for their caller: two cells right of the label, or right of the port
  for (const e of todo) {
    const port = P.port.get(e.from);
    const r = port ? port.row : P.pos.get(e.from)!.row;
    const c = port ? port.col + 1 : P.end.get(e.from)! + 1;
    for (const cc of [c, c + 1]) if (!reserved.has(cellId(r, cc))) reserved.set(cellId(r, cc), `src:${e.from}`);
  }

  let width = P.width, height = P.height;
  const RW = P.width + 16, RH = P.height + 6;
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
    const sc = port ? port.col + 1 : P.end.get(u)! + 1;
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

    if (sr < 0 || sr >= RH || sc >= RW || blocked.has(cellId(sr, sc))) { unrouted++; failed.push([u, v]); continue; }
    // start states: label end heading E; under and over the first character heading S and N
    const starts: { id: number; r: number; c: number; d: number; cost: number }[] = [{ id: sid(sr, sc, 2), r: sr, c: sc, d: 2, cost: 0 }];
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
      if (!startDir.has(id) && cells.get(cellId(r, c))?.has(net) && !(r === gr && c === gc)) { goal = id; break; }
      const here = otherNets(cellId(r, c));
      for (let nd = 0; nd < 4; nd++) {
        const sd = startDir.get(id);
        if (sd !== undefined && nd !== sd) continue;    // leave the caller in the start heading
        let turnPenalty = 0;
        if (nd !== d && here && !('sameNet' in here) && here.other) {  // no turn on another net
          if (!relaxed) continue;
          turnPenalty = RELAX;
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
              step += RELAX;
            } else step += opts.cost.cross;
          }
        }
        if (nd !== d) step += opts.cost.bend + turnPenalty;
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
    if (goal < 0) {
      unrouted++;
      failed.push([u, v]);
    } else {
      // reconstruct
      const seq: { r: number; c: number; d: number }[] = [];
      for (let id = goal; id >= 0; id = came[id]) {
        const d = id % 4, cellIx = (id - d) / 4;
        seq.push({ r: Math.floor(cellIx / RW), c: cellIx % RW, d });
        if (startDir.has(id) && came[id] < 0) break;
      }
      seq.reverse();
      const startKind = seq[0].d === 2 ? 'E' : seq[0].d === 1 ? 'S' : 'N';
      const merged = !(seq[seq.length - 1].r === gr && seq[seq.length - 1].c === gc);
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
      paths.push({ from: u, to: v, net, pts, start: startKind === 'E' ? (port ? 'S' : 'E') : startKind, arrive: left ? 'E' : 'W' });
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
  return { width, height, cells, marks, labels, nets, paths, frames: P.frames, conflicts, unrouted, failed };
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
export function charRows(g: Grid, gs: GlyphSet, blankLabels = false): string[][] {
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
    if (m.role === 'frame') {
      // an edge crossing a border: border glyph joins the edge
      const nets = g.cells.get(cellId(m.row, m.col));
      if (nets) {
        let u = 0;
        for (const x of nets.values()) u |= x;
        put(m.row, m.col, gs.mask(u | (m.ch === 'v' ? N | S : E | W)));
      }
    } else put(m.row, m.col, markGlyph(m, gs));
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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
