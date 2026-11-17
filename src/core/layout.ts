/**
 * Grid lanes layout. Integer cells (row, col); the SVG view and the ASCII export print the same grid.
 *
 * 1. DFS over the quotient graph from its sources (in-degree 0), then from vertices left unvisited
 *    (cycles without an entry from a source; seeds first). Sources and children are visited in reverse
 *    of their display order (override `order`, then call-site line, then path), so the reverse
 *    postorder lists them in display order.
 * 2. Row order π = reverse DFS postorder. Every non-back edge (u, v) has π(u) < π(v): reverse
 *    postorder is a topological order of the DAG left after removing back edges (CLRS §22.4).
 *    Back edges (u → v with v on the DFS stack) render as `↻` tags on u; self loops as `↻`.
 * 3. Tree parent: rule `dfs`, the DFS discoverer; rule `nearest`, the caller closest above that passes
 *    the stem check. Stem check for parent p of v: every row strictly between p and v starts right of
 *    col(p). Under `dfs` the check always holds: the DFS subtree of p occupies a contiguous block of
 *    rows starting at p (parenthesis theorem, CLRS Thm 22.7) and its members sit at col ≥ col(p) + indent.
 *    col(v) = col(parent) + indent; roots at column 0.
 * 4. Cross edges: edges outside the tree and not back. Edges into one target bundle into one lane,
 *    rows [min source row, target row]. A vertex that is both a lane target and a lane source gets a
 *    port row below it; its outgoing lane connections leave from the port row, so an arrival `<─┘` and a
 *    departure `─┐` never share a row.
 * 5. Lane columns: base = max row end over the lane's rows + 3. Lanes sorted by (span, start) take the
 *    first column ≥ base at distance ≥ laneGap from every placed lane with overlapping rows.
 *    Labels never meet a lane: lane columns exceed the row ends of all rows they span.
 * 6. Brackets: maximal runs of consecutive rows sharing a container, right of all lanes.
 *
 * Cost: O(V + E) for 1, 2, 4; O(V · d) for the stem checks, d = row distance; O(L²) for first fit.
 */
import { NodeKey } from './model';
import { VGraph } from './quotient';
import { ParentRule, ROOTS } from './viewdoc';

export interface LayoutInput {
  vg: VGraph;
  seeds: readonly NodeKey[];
  order: Record<NodeKey, NodeKey[]>;
  indent: number;
  laneGap: number;
  parentRule: ParentRule;
  sortKey: (k: NodeKey) => string;
  label: (k: NodeKey, parent: NodeKey | null) => string;
  shortName: (k: NodeKey) => string;
  bracketOf?: (k: NodeKey) => { key: NodeKey; label: string } | null;
  minRun?: number;
}

export interface Row {
  kind: 'node' | 'port';
  key: NodeKey;
  col: number;
  text: string;
  end: number;           // first column right of the row content
}

export interface Lane {
  target: NodeKey;
  col: number;
  lo: number;
  hi: number;
  sources: { key: NodeKey; row: number; port: boolean }[];
}

export interface Bracket {
  key: NodeKey;
  label: string;
  lo: number;
  hi: number;
  col: number;
}

export interface Layout {
  rows: Row[];
  rowOf: Map<NodeKey, number>;
  portOf: Map<NodeKey, number>;
  parent: Map<NodeKey, NodeKey | null>;
  children: Map<NodeKey, NodeKey[]>;
  roots: NodeKey[];
  lanes: Lane[];
  back: Map<NodeKey, NodeKey[]>;
  brackets: Bracket[];
  indent: number;
  width: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function layout(inp: LayoutInput): Layout {
  const { vg } = inp;
  const indent = Math.max(3, inp.indent | 0);
  const laneGap = Math.max(1, inp.laneGap | 0);
  const keys = [...vg.nodes.keys()];

  // ---- ordering -------------------------------------------------------------------------------
  const idx = (list: readonly NodeKey[] | undefined) => new Map((list ?? []).map((k, i) => [k, i] as const));
  const rootIdx = idx(inp.order[ROOTS]);
  const seedIdx = idx(inp.seeds);
  const sk = new Map(keys.map((k) => [k, inp.sortKey(k)] as const));
  const big = Number.MAX_SAFE_INTEGER;
  const rootCmp = (a: NodeKey, b: NodeKey) =>
    (rootIdx.get(a) ?? big) - (rootIdx.get(b) ?? big) ||
    (seedIdx.get(a) ?? big) - (seedIdx.get(b) ?? big) ||
    cmp(sk.get(a)!, sk.get(b)!);

  const childOrder = new Map<NodeKey, NodeKey[]>();
  const orderedOut = (u: NodeKey): NodeKey[] => {
    let r = childOrder.get(u);
    if (!r) {
      const o = idx(inp.order[u]);
      r = [...vg.out.get(u)!]
        .sort((a, b) => (o.get(a.to) ?? big) - (o.get(b.to) ?? big) || a.line - b.line || cmp(sk.get(a.to)!, sk.get(b.to)!))
        .map((e) => e.to);
      childOrder.set(u, r);
    }
    return r;
  };

  // ---- 1. DFS ---------------------------------------------------------------------------------
  const state = new Map<NodeKey, number>();       // 0 white, 1 gray, 2 black
  const dfsParent = new Map<NodeKey, NodeKey | null>();
  const post: NodeKey[] = [];
  const back = new Map<NodeKey, NodeKey[]>();
  const backSet = new Set<string>();
  const visit = (root: NodeKey) => {
    if (state.get(root)) return;
    state.set(root, 1);
    dfsParent.set(root, null);
    const stack = [{ u: root, kids: [...orderedOut(root)].reverse(), i: 0 }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (f.i < f.kids.length) {
        const v = f.kids[f.i++];
        const s = state.get(v) ?? 0;
        if (s === 0) {
          state.set(v, 1);
          dfsParent.set(v, f.u);
          stack.push({ u: v, kids: [...orderedOut(v)].reverse(), i: 0 });
        } else if (s === 1) {
          if (!back.has(f.u)) back.set(f.u, []);
          back.get(f.u)!.push(v);
          backSet.add(`${f.u}\u0000${v}`);
        }
      } else {
        state.set(f.u, 2);
        post.push(f.u);
        stack.pop();
      }
    }
  };
  const sources = keys.filter((k) => vg.inc.get(k)!.length === 0).sort(rootCmp);
  for (let i = sources.length - 1; i >= 0; i--) visit(sources[i]);
  // cycles without an entry from a source: seeds first, so a seed roots its cycle; blocks of later
  // roots land above earlier ones (topological order forces it)
  for (const k of keys.filter((k) => !state.get(k)).sort(rootCmp)) visit(k);

  const order = post.reverse();
  const nodeRow0 = new Map(order.map((k, i) => [k, i] as const));   // rows before port insertion

  // ---- 3. tree parents and columns ------------------------------------------------------------
  const parent = new Map<NodeKey, NodeKey | null>();
  const col = new Map<NodeKey, number>();
  const stemOk = (p: NodeKey, v: NodeKey) => {
    const cp = col.get(p)!;
    for (let r = nodeRow0.get(p)! + 1; r < nodeRow0.get(v)!; r++) if (col.get(order[r])! <= cp) return false;
    return true;
  };
  for (const v of order) {
    const callers = vg.inc.get(v)!
      .map((e) => e.from)
      .filter((u) => !backSet.has(`${u}\u0000${v}`) && nodeRow0.get(u)! < nodeRow0.get(v)!);
    const dp = dfsParent.get(v) ?? null;
    const cands: NodeKey[] = inp.parentRule === 'nearest'
      ? [...callers].sort((a, b) => nodeRow0.get(b)! - nodeRow0.get(a)!)
      : dp ? [dp] : [];
    if (inp.parentRule === 'nearest' && dp && !cands.includes(dp)) cands.push(dp);
    const p = cands.find((c) => stemOk(c, v)) ?? null;
    parent.set(v, p);
    if (p) col.set(v, col.get(p)! + indent);
    else if (callers.length) {
      const near = callers.reduce((a, b) => (nodeRow0.get(a)! > nodeRow0.get(b)! ? a : b));
      col.set(v, col.get(near)! + indent);
    } else col.set(v, 0);
  }

  // ---- 4. cross edges, ports ------------------------------------------------------------------
  const crossIn = new Map<NodeKey, NodeKey[]>();
  const crossOut = new Set<NodeKey>();
  for (const e of vg.edges) {
    if (parent.get(e.to) === e.from || backSet.has(`${e.from}\u0000${e.to}`)) continue;
    if (!crossIn.has(e.to)) crossIn.set(e.to, []);
    crossIn.get(e.to)!.push(e.from);
    crossOut.add(e.from);
  }

  const rows: Row[] = [];
  const rowOf = new Map<NodeKey, number>();
  const portOf = new Map<NodeKey, number>();
  for (const k of order) {
    const tags = [
      vg.selfLoops.has(k) ? ' ↻' : '',
      ...(back.get(k) ?? []).map((t) => ` ↻ ${inp.shortName(t)}`),
    ].join('');
    const text = inp.label(k, parent.get(k) ?? null) + tags;
    const c = col.get(k)!;
    rowOf.set(k, rows.length);
    rows.push({ kind: 'node', key: k, col: c, text, end: c + text.length });
    if (crossIn.has(k) && crossOut.has(k)) {
      portOf.set(k, rows.length);
      rows.push({ kind: 'port', key: k, col: c, text: '', end: c + 1 });
    }
  }

  const children = new Map<NodeKey, NodeKey[]>();
  for (const k of order) children.set(k, []);
  for (const k of order) {
    const p = parent.get(k);
    if (p) children.get(p)!.push(k);
  }
  const roots = order.filter((k) => !parent.get(k));

  // ---- 5. lanes -------------------------------------------------------------------------------
  const lanes: Lane[] = [];
  for (const [t, srcs] of crossIn) {
    const sources = srcs.map((u) => {
      const port = portOf.get(u);
      return { key: u, row: port ?? rowOf.get(u)!, port: port !== undefined };
    });
    const lo = Math.min(...sources.map((s) => s.row));
    const hi = rowOf.get(t)!;
    lanes.push({ target: t, col: 0, lo, hi, sources });
  }
  lanes.sort((a, b) => a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo || cmp(sk.get(a.target)!, sk.get(b.target)!));
  const placed: Lane[] = [];
  for (const lane of lanes) {
    let base = 0;
    for (let r = lane.lo; r <= lane.hi; r++) base = Math.max(base, rows[r].end + 3);
    let c = base;
    for (let moved = true; moved;) {
      moved = false;
      for (const p of placed) {
        if (p.lo <= lane.hi && lane.lo <= p.hi && Math.abs(c - p.col) < laneGap) {
          c = p.col + laneGap;
          moved = true;
        }
      }
    }
    lane.col = c;
    placed.push(lane);
  }

  // ---- 6. brackets ----------------------------------------------------------------------------
  let right = 0;
  for (const r of rows) right = Math.max(right, r.end);
  for (const l of lanes) right = Math.max(right, l.col + 1);
  const brackets: Bracket[] = [];
  let width = right;
  if (inp.bracketOf) {
    const minRun = Math.max(1, inp.minRun ?? 2);
    const bcol = right + 2;
    let cur: { key: NodeKey; label: string; lo: number; hi: number; n: number } | null = null;
    const flush = () => {
      if (cur && cur.n >= minRun) {
        brackets.push({ key: cur.key, label: cur.label, lo: cur.lo, hi: cur.hi, col: bcol });
        width = Math.max(width, bcol + 2 + cur.label.length);
      }
      cur = null;
    };
    const memo = new Map<NodeKey, { key: NodeKey; label: string } | null>();
    rows.forEach((row, r) => {
      if (!memo.has(row.key)) memo.set(row.key, inp.bracketOf!(row.key));
      const b = memo.get(row.key)!;
      if (b && cur && cur.key === b.key) {
        cur.hi = r;
        if (row.kind === 'node') cur.n++;
      } else {
        flush();
        if (b) cur = { key: b.key, label: b.label, lo: r, hi: r, n: row.kind === 'node' ? 1 : 0 };
      }
    });
    flush();
  }

  return { rows, rowOf, portOf, parent, children, roots, lanes, back, brackets, indent, width };
}
