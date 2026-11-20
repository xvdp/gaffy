/**
 * Grid lanes layout. Integer cells (row, col); the SVG view and the ASCII export print the same grid.
 *
 * 1. DFS over the quotient graph from its sources (in-degree 0), then from vertices left unvisited
 *    (cycles without an entry from a source; seeds first). Sources and children are visited in reverse
 *    of their display order (override `sibling`, then call-site line, then path), so the reverse
 *    postorder lists them in display order.
 * 2. Row order π = reverse DFS postorder. Every non-back edge (u, v) has π(u) < π(v): reverse
 *    postorder is a topological order of the DAG left after removing back edges (CLRS §22.4).
 *    Back edges (u → v with v on the DFS stack) render as `↻` tags on u; self loops as `↻`.
 * 3. Tree parent: rule `dfs`, the DFS discoverer; rule `nearest`, the caller closest above that passes
 *    the stem check. Stem check for parent p of v: every row strictly between p and v starts right of
 *    col(p). Under `dfs` the check always holds: the DFS subtree of p occupies a contiguous block of
 *    rows starting at p (parenthesis theorem, CLRS Thm 22.7) and its members sit at col ≥ col(p) + indent.
 *    col(v) = col(parent) + indent; roots at column 0.
 *    Rule `joint` (no caller privileged when several call one function), for v with ≥ 2 callers in the block:
 *    merge: the callers are p and u, u a tree child of p on the row right above v; v becomes p's child one
 *    indent further right, so u's stem drops into v's elbow (`├───┴─> v()`).
 *    collector: otherwise v takes no tree parent; an approach row above v carries its lane back left to
 *    a collector column one indent left of v, and every call enters v from the left (`┌──┘`, `└─> v()`).
 *    Else as `dfs`.
 * 4. Cross edges: edges outside the tree and not back. Edges into one target bundle into one lane,
 *    rows [min source row, target row]. A vertex that is both a lane target and a lane source gets a
 *    port row below it; its outgoing lane connections leave from the port row, so an arrival `<─┘` and a
 *    departure `─┐` never share a row.
 * 5. Lane columns: base = max row end over the lane's rows + 3. Lanes sorted by (span, start) take the
 *    first column ≥ base at distance ≥ laneGap from every placed lane with overlapping rows.
 *    Labels never meet a lane: lane columns exceed the row ends of all rows they span.
 *
 * Inside namespace boxes the layout runs once per block (the direct members of one box). Calls that
 * leave or enter the block count for port rows (`extIn`, `extOut`); `rootRank` orders the block's
 * roots by the rows of their callers outside the block, so rows can line up with those callers.
 *
 * Cost: O(V + E) for 1, 2, 4; O(V · d) for the stem checks, d = row distance; O(L²) for first fit.
 */
import { NodeKey } from './model';
import { VGraph } from './quotient';
import { ParentRule, ROOTS } from './viewdoc';

export interface LayoutInput {
    vg: VGraph;
    seeds: readonly NodeKey[];
    sibling: Record<NodeKey, NodeKey[]>;   // child order override per tree parent; ROOTS for the top level
    indent: number;
    laneGap: number;
    parentRule: ParentRule;
    sortKey: (k: NodeKey) => string;
    label: (k: NodeKey, parent: NodeKey | null) => string;
    shortName: (k: NodeKey) => string;
    extIn?: ReadonlySet<NodeKey>;          // vertices called from outside this block
    extOut?: ReadonlySet<NodeKey>;         // vertices calling outside this block
    rootRank?: (k: NodeKey) => number;     // primary root order, ascending
}

export interface Row {
    kind: 'node' | 'port' | 'approach';
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
    left?: { col: number; row: number };   // rule `joint`, collector: column left of the target, approach row above it
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
    merges: Set<string>;   // rule `joint`: calls `caller\u0000callee` drawn by a stem into the callee's elbow
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
    const rootIdx = idx(inp.sibling[ROOTS]);
    const seedIdx = idx(inp.seeds);
    const sk = new Map(keys.map((k) => [k, inp.sortKey(k)] as const));
    const big = Number.MAX_SAFE_INTEGER;
    const rank = inp.rootRank ?? (() => 0);
    const rootCmp = (a: NodeKey, b: NodeKey) =>
        (rootIdx.get(a) ?? big) - (rootIdx.get(b) ?? big) ||
        rank(a) - rank(b) ||
        (seedIdx.get(a) ?? big) - (seedIdx.get(b) ?? big) ||
        cmp(sk.get(a)!, sk.get(b)!);

    const childOrder = new Map<NodeKey, NodeKey[]>();
    const orderedOut = (u: NodeKey): NodeKey[] => {
        let r = childOrder.get(u);
        if (!r) {
            const o = idx(inp.sibling[u]);
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
    const joint = inp.parentRule === 'joint';
    const dfsKids = new Map<NodeKey, NodeKey[]>();
    for (const v of order) { const d = dfsParent.get(v); if (d) { if (!dfsKids.has(d)) dfsKids.set(d, []); dfsKids.get(d)!.push(v); } }
    const merges = new Set<string>();
    const collector = new Map<NodeKey, number>();   // rule `joint`: target → collector column
    for (const v of order) {
        const callers = vg.inc.get(v)!
            .map((e) => e.from)
            .filter((u) => !backSet.has(`${u}\u0000${v}`) && nodeRow0.get(u)! < nodeRow0.get(v)!);
        const dp = dfsParent.get(v) ?? null;
        if (joint && callers.length >= 2) {
            const [a, b] = callers;
            const pair = callers.length === 2 ? (parent.get(b) === a ? [a, b] : parent.get(a) === b ? [b, a] : undefined) : undefined;
            if (pair && nodeRow0.get(pair[1])! === nodeRow0.get(v)! - 1 && stemOk(pair[0], v)) {
                parent.set(v, pair[0]);
                col.set(v, col.get(pair[0])! + 2 * indent);
                merges.add(`${pair[1]}\u0000${v}`);
                continue;
            }
            // the DFS parent's trunk continues below v when it has later children: keep the collector off its column
            const later = !!dp && dfsKids.get(dp)!.some((c) => nodeRow0.get(c)! > nodeRow0.get(v)!);
            const c = dp ? col.get(dp)! + (later ? 2 : 1) * indent : Math.min(...callers.map((u) => col.get(u)!)) + indent;
            parent.set(v, null);
            col.set(v, c);
            collector.set(v, c - indent);
            continue;
        }
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
        if (parent.get(e.to) === e.from || backSet.has(`${e.from}\u0000${e.to}`) || merges.has(`${e.from}\u0000${e.to}`)) continue;
        if (!crossIn.has(e.to)) crossIn.set(e.to, []);
        crossIn.get(e.to)!.push(e.from);
        crossOut.add(e.from);
    }

    const rows: Row[] = [];
    const rowOf = new Map<NodeKey, number>();
    const portOf = new Map<NodeKey, number>();
    const approachOf = new Map<NodeKey, number>();
    for (const k of order) {
        const cc = collector.get(k);
        if (cc !== undefined && crossIn.has(k)) {
            approachOf.set(k, rows.length);
            rows.push({ kind: 'approach', key: k, col: cc, text: '', end: cc + 1 });
        }
        const tags = [
            vg.selfLoops.has(k) ? ' ↻' : '',
            ...(back.get(k) ?? []).map((t) => ` ↻ ${inp.shortName(t)}`),
        ].join('');
        const text = inp.label(k, parent.get(k) ?? null) + tags;
        const c = col.get(k)!;
        rowOf.set(k, rows.length);
        rows.push({ kind: 'node', key: k, col: c, text, end: c + text.length });
        // arrivals land at the right end unless the vertex is a block root (then from the left)
        const inRight = (crossIn.has(k) && !approachOf.has(k)) || (!!inp.extIn?.has(k) && !!parent.get(k));
        if (inRight && (crossOut.has(k) || !!inp.extOut?.has(k))) {
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
        const via = approachOf.get(t);
        lanes.push({ target: t, col: 0, lo, hi, sources, ...(via !== undefined ? { left: { col: collector.get(t)!, row: via } } : {}) });
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

    let width = 0;
    for (const r of rows) width = Math.max(width, r.end);
    for (const l of lanes) width = Math.max(width, l.col + 1);

    return { rows, rowOf, portOf, parent, children, roots, lanes, back, merges, indent, width };
}
