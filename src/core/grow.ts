/**
 * Stable placement ("grow"): every vertex keeps the cell it got when it first appeared (`view.place`);
 * opening a side places only the newly revealed vertices, in free space next to the vertex that
 * revealed them. Nothing already on screen moves.
 *
 * New vertex n revealed by o:
 *   same namespace box as o: below o when n is a callee and callers sit on top (or a caller and callees
 *   sit on top), one indent to the right; otherwise above o, one indent to the left. Rows continue after
 *   the last vertex o revealed on that side; when that row is taken, beside the labels that take it.
 *   other box, with members on screen: that box's leftmost column, first free row from o's row down.
 *   other box, empty: right of the outermost box around o that does not hold n, on o's row.
 *   A cell is taken when the label cells [col - 2, end + 2) are free, n lands in no frame of a box it
 *   does not belong to, and the frames of n's boxes, grown by n, swallow no foreign vertex and cross no
 *   unrelated frame; otherwise the search walks on row by row, then shifts right.
 *   Unplaced seeds start at (0, 0), or below everything placed.
 * Tree elbows: the revealing relation when the child sits one indent right of and below its parent.
 * Markers on closed sides with hidden neighbors: `└─>` under the vertex for the side placed below,
 * `>` before the name for the side placed above. No counts.
 * Coordinates may go negative; the result is shifted to non-negative cells and `origin` reports the
 * shift, so the renderer keeps stored cells at fixed screen positions.
 */
import { BoxNode } from './boxes';
import { NodeKey } from './model';
import { Frame, Marker, Placement } from './place';
import { opens, Reveal } from './reveal';
import { boxUnit, Cell, OpenSide, Order } from './viewdoc';

export type { Marker };

export interface GrowInput {
  rev: Reveal;
  text: Map<NodeKey, string>;
  place: Record<NodeKey, Cell>;
  open: Record<NodeKey, OpenSide>;
  seedOpen: (k: NodeKey) => OpenSide | undefined;
  hasMore: (k: NodeKey, side: 'up' | 'down') => boolean;
  indent: number;
  order: Order;
  tree: BoxNode;
}

export interface GrowResult {
  placement: Placement;
  added: Record<NodeKey, Cell>;      // cells assigned in this pass, to persist
  origin: Cell;                      // shift from stored cells to grid cells
}

export function grow(inp: GrowInput): GrowResult {
  const { rev, text } = inp;
  const indent = Math.max(3, inp.indent | 0);
  const at = new Map<NodeKey, Cell>();
  const added: Record<NodeKey, Cell> = {};
  const rows = new Map<number, [number, number][]>();
  const occupy = (r: number, c0: number, c1: number) => {
    let a = rows.get(r);
    if (!a) rows.set(r, (a = []));
    a.push([c0, c1]);
  };
  const free = (r: number, c0: number, c1: number) => !(rows.get(r) ?? []).some(([a, b]) => a < c1 && c0 < b);
  const len = (k: NodeKey) => text.get(k)?.length ?? 1;
  const put = (k: NodeKey, c: number, r: number) => { at.set(k, [c, r]); occupy(r, c - 2, c + len(k) + 2); };

  for (const k of rev.order) { const p = inp.place[k]; if (p) put(k, p[0], p[1]); }

  // namespace boxes: chain of framed boxes per vertex, innermost first
  const boxes: BoxNode[] = [];
  const chain = new Map<NodeKey, BoxNode[]>();
  const members = new Map<BoxNode, Set<NodeKey>>();
  const walk = (b: BoxNode, up: BoxNode[]) => {
    const here = b.frame ? [b, ...up] : up;
    if (b.frame) { boxes.push(b); members.set(b, new Set()); }
    for (const m of b.members) { chain.set(m, here); for (const a of here) members.get(a)!.add(m); }
    for (const c of b.children) walk(c, here);
  };
  walk(inp.tree, []);
  const related = (a: BoxNode, b: BoxNode) => a === b || [...members.get(a)!].some((m) => members.get(b)!.has(m)) &&
    (isSub(members.get(a)!, members.get(b)!) || isSub(members.get(b)!, members.get(a)!));
  type Rect = [number, number, number, number];
  const frameRect = (b: BoxNode, extra?: [NodeKey, number, number]): Rect | undefined => {
    let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
    const take = (k: NodeKey, c: number, r: number) => { c0 = Math.min(c0, c); r0 = Math.min(r0, r); c1 = Math.max(c1, c + len(k)); r1 = Math.max(r1, r); };
    for (const m of members.get(b)!) { const p = at.get(m); if (p) take(m, p[0], p[1]); }
    if (extra && members.get(b)!.has(extra[0])) take(...extra);
    if (c0 === Infinity) return undefined;
    return [c0 - 3, r0 - 1, Math.max(c1 + 2, c0 - 3 + b.label.length + 5), r1 + 1];
  };
  const cross = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const ok = (k: NodeKey, c: number, r: number) => {
    if (!free(r, c - 2, c + len(k) + 2)) return false;
    const mine = chain.get(k) ?? [];
    const span: Rect = [c, r, c + len(k), r];
    for (const b of boxes) {
      if (mine.includes(b)) continue;
      const f = frameRect(b);
      if (f && cross(span, f)) return false;
    }
    for (const b of mine) {
      const f = frameRect(b, [k, c, r])!;
      for (const [v, p] of at) if (!members.get(b)!.has(v) && cross([p[0], p[1], p[0] + len(v), p[1]], f)) return false;
      for (const b2 of boxes) {
        if (related(b, b2)) continue;
        const f2 = frameRect(b2);
        if (f2 && cross(f, f2)) return false;
      }
    }
    return true;
  };
  const search = (k: NodeKey, c: number, r: number, step: 1 | -1): [number, number] => {
    for (let shift = 0; shift < 40; shift++) {
      for (let i = 0; i < 300; i++) if (ok(k, c + shift * 4, r + i * step)) return [c + shift * 4, r + i * step];
    }
    return [c, r];
  };

  const lastBelow = new Map<NodeKey, number>(), lastAbove = new Map<NodeKey, number>();
  const lastBelowKey = new Map<NodeKey, NodeKey>();
  // the side placed below a vertex carries a `└─>` marker when closed with hidden neighbors
  const belowSide: 'up' | 'down' = inp.order === 'callers' ? 'down' : 'up';
  const stubBelow = (k: NodeKey) => !opens(inp.open[k] ?? inp.seedOpen(k), belowSide) && inp.hasMore(k, belowSide);
  for (const k of rev.order) {
    if (at.has(k)) continue;
    const o = rev.opener.get(k);
    let cell: [number, number];
    if (!o || !at.get(o.by)) {
      const r = at.size ? Math.max(...[...at.values()].map((v) => v[1])) + 2 : 0;
      cell = search(k, 0, r, 1);
    } else {
      const [oc, or] = at.get(o.by)!;
      const below = (o.side === 'down') === (inp.order === 'callers');
      const bk = (chain.get(k) ?? [])[0], bo = (chain.get(o.by) ?? [])[0];
      if (bk === bo) {
        const c = below ? oc + indent : oc - indent;
        // a sibling with hidden calls keeps the row under it for its `└─>`
        const prev = below ? lastBelowKey.get(o.by) : undefined;
        const gap = prev && stubBelow(prev) ? 1 : 0;
        const r = below ? (lastBelow.get(o.by) ?? or) + 1 + gap : (lastAbove.get(o.by) ?? or) - 1;
        // free within a few rows of o, else beside the labels that occupy those rows
        const near = (cc: number) => (ok(k, cc, r) ? r : undefined);
        let rr = near(c);
        let cc = c;
        if (rr === undefined) {
          let right = c;
          for (let i = 0; i < 4; i++) for (const [a, b] of rows.get(r + i * (below ? 1 : -1)) ?? []) if (b > c - 2) right = Math.max(right, b + 2);
          cc = right;
        }
        cell = rr !== undefined ? [cc, rr] : search(k, cc, r, below ? 1 : -1);
        (below ? lastBelow : lastAbove).set(o.by, cell[1]);
        if (below) lastBelowKey.set(o.by, k);
      } else {
        const placed = [...(members.get(bk) ?? [])].filter((m) => at.has(m));
        if (bk && placed.length) {
          // the box's left column, from the caller's row down: the call draws level when the row is free
          const c = Math.min(...placed.map((m) => at.get(m)![0]));
          cell = search(k, c, or, 1);
        } else {
          // a new box area: right of the outermost box around o that does not hold k
          const outer = [...(chain.get(o.by) ?? [])].reverse().find((b) => !members.get(b)!.has(k));
          const f = outer ? frameRect(outer) : undefined;
          const c = f ? f[2] + 4 + 3 : oc + len(o.by) + 6;
          cell = search(k, c, or, 1);
        }
      }
    }
    put(k, cell[0], cell[1]);
    added[k] = cell;
  }

  // tree elbows from the revealing relation
  const elbows = new Map<NodeKey, NodeKey[]>();
  for (const [n, o] of rev.opener) {
    const caller = o.side === 'down' ? o.by : n, callee = o.side === 'down' ? n : o.by;
    const parent = inp.order === 'callers' ? caller : callee, child = parent === caller ? callee : caller;
    const p = at.get(parent), q = at.get(child);
    if (p && q && q[0] === p[0] + indent && q[1] > p[1]) {
      if (!elbows.has(parent)) elbows.set(parent, []);
      elbows.get(parent)!.push(child);
    }
  }
  const elbowChild = new Set([...elbows.values()].flat());

  // markers on closed sides with hidden neighbors
  const markers: Marker[] = [];
  for (const k of rev.order) {
    const [c, r] = at.get(k)!;
    const side = inp.open[k] ?? inp.seedOpen(k);
    for (const s of ['down', 'up'] as const) {
      if (opens(side, s) || !inp.hasMore(k, s)) continue;
      const below = (s === 'down') === (inp.order === 'callers');
      if (below) {
        const rr = inp.order === 'callers' ? r + 1 : r + 1;
        if (free(rr, c, c + 3)) { markers.push({ row: rr, col: c, text: '└─>', key: k, side: s }); occupy(rr, c, c + 3); }
        else markers.push({ row: r, col: c + len(k) + 1, text: '─>', key: k, side: s });
      } else if (!elbowChild.has(k)) {
        markers.push({ row: r, col: c - 2, text: '>', key: k, side: s });
      }
    }
  }

  // frames: bounding boxes of members, their markers, and nested frames
  const frames: Frame[] = [];
  const markersOf = new Map<NodeKey, Marker[]>();
  for (const m of markers) { if (!markersOf.has(m.key)) markersOf.set(m.key, []); markersOf.get(m.key)!.push(m); }
  const pos = (k: NodeKey) => at.get(k);
  const frameOf = (b: BoxNode): [number, number, number, number] | undefined => {
    let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
    for (const m of b.members) {
      const p = pos(m);
      if (!p) continue;
      c0 = Math.min(c0, p[0]); r0 = Math.min(r0, p[1]); c1 = Math.max(c1, p[0] + len(m)); r1 = Math.max(r1, p[1]);
      for (const mk of markersOf.get(m) ?? []) {
        c0 = Math.min(c0, mk.col); r0 = Math.min(r0, mk.row); c1 = Math.max(c1, mk.col + mk.text.length); r1 = Math.max(r1, mk.row);
      }
    }
    for (const ch of b.children) {
      const f = frameOf(ch);
      if (!f) continue;
      c0 = Math.min(c0, f[0]); r0 = Math.min(r0, f[1]); c1 = Math.max(c1, f[2]); r1 = Math.max(r1, f[3]);
    }
    if (c0 === Infinity) return undefined;
    if (!b.frame) return [c0, r0, c1, r1];
    const f: [number, number, number, number] = [c0 - 3, r0 - 1, Math.max(c1 + 2, c0 - 3 + b.label.length + 5), r1 + 1];
    frames.push({ box: b, unit: boxUnit(b.key), c0: f[0], r0: f[1], c1: f[2], r1: f[3] });
    return f;
  };
  frameOf(inp.tree);

  // shift to non-negative cells, one cell of margin
  let minC = 0, minR = 0;
  for (const [c, r] of at.values()) { minC = Math.min(minC, c - 3); minR = Math.min(minR, r - 1); }
  for (const m of markers) { minC = Math.min(minC, m.col); minR = Math.min(minR, m.row); }
  for (const f of frames) { minC = Math.min(minC, f.c0); minR = Math.min(minR, f.r0); }
  const dc = -minC, dr = -minR;

  const P: Placement = {
    blocks: [], frames: [], blockOf: new Map(), pos: new Map(), end: new Map(), port: new Map(), text: new Map(),
    width: 0, height: 0, elbows, markers: [],
  };
  let W = 0, H = 0;
  for (const [k, [c, r]] of at) {
    P.pos.set(k, { col: c + dc, row: r + dr });
    P.end.set(k, c + dc + len(k));
    P.text.set(k, text.get(k) ?? k);
    W = Math.max(W, c + dc + len(k) + 3); H = Math.max(H, r + dr + 2);
  }
  for (const f of frames) {
    P.frames.push({ ...f, c0: f.c0 + dc, c1: f.c1 + dc, r0: f.r0 + dr, r1: f.r1 + dr });
    W = Math.max(W, f.c1 + dc + 1); H = Math.max(H, f.r1 + dr + 1);
  }
  for (const m of markers) {
    P.markers!.push({ ...m, row: m.row + dr, col: m.col + dc });
    W = Math.max(W, m.col + dc + m.text.length + 1); H = Math.max(H, m.row + dr + 1);
  }
  P.width = W;
  P.height = H;
  return { placement: P, added, origin: [dc, dr] };
}

function isSub<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
