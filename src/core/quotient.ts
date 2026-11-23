/** @xvdp
 * Collapse as quotient graph.
 *
 * K ⊆ containers: collapse set. ρ_K(x): outermost ancestor of x in K, else x. H: hidden set; x dropped if
 * x or an ancestor ∈ H.
 * G_K = (V_K, E_K), V_K = {ρ(v)}, E_K = {(ρ(u), ρ(v), w) : ρ(u) ≠ ρ(v)}, w = mapped edge count.
 * Edges within a collapsed container: its `internal` count. V: edge endpoints and seeds; containers enter V_K
 * only as representatives.
 */
import { ancestors, GNode, NodeKey, Subgraph } from './model';

export interface VNode {
    key: NodeKey;
    node: GNode;
    collapsed: boolean;      // collapsed-container representative
    members: number;         // definitions mapped here
    internal: number;        // calls among collapsed-container members
}

export interface VEdge {
    from: NodeKey;
    to: NodeKey;
    line: number;            // min call-site line of mapped edges
    count: number;           // w
}

export interface VGraph {
    nodes: Map<NodeKey, VNode>;
    edges: VEdge[];
    out: Map<NodeKey, VEdge[]>;
    inc: Map<NodeKey, VEdge[]>;
    selfLoops: Set<NodeKey>;  // direct recursion
}

export function representative(
    nodes: Record<NodeKey, GNode>, key: NodeKey, collapsed: ReadonlySet<NodeKey>, hidden: ReadonlySet<NodeKey>,
): NodeKey | null {
    if (hidden.has(key)) return null;
    let rep = key;
    for (const a of ancestors(nodes, key)) {
        if (hidden.has(a)) return null;
        if (collapsed.has(a)) rep = a;     // outward walk: last hit = outermost
    }
    return rep;
}

export function quotient(
    g: Subgraph, collapsed: ReadonlySet<NodeKey>, hidden: ReadonlySet<NodeKey>, seeds: readonly NodeKey[] = [],
): VGraph {
    const rho = new Map<NodeKey, NodeKey | null>();
    const rep = (k: NodeKey) => {
        let r = rho.get(k);
        if (r === undefined) {
            r = g.nodes[k] ? representative(g.nodes, k, collapsed, hidden) : null;
            rho.set(k, r);
        }
        return r;
    };

    const nodes = new Map<NodeKey, VNode>();
    const memberSets = new Map<NodeKey, Set<NodeKey>>();
    const touch = (k: NodeKey): NodeKey | null => {
        const r = rep(k);
        if (r === null) return null;
        if (!nodes.has(r)) {
            nodes.set(r, { key: r, node: g.nodes[r], collapsed: r !== k || collapsed.has(r), members: 0, internal: 0 });
            memberSets.set(r, new Set());
        }
        memberSets.get(r)!.add(k);
        return r;
    };

    for (const s of seeds) if (g.nodes[s]) touch(s);

    const agg = new Map<string, VEdge>();
    const selfLoops = new Set<NodeKey>();
    for (const e of g.edges) {
        const a = touch(e.from);
        const b = touch(e.to);
        if (a === null || b === null) continue;
        if (a === b) {
            if (e.from === e.to) selfLoops.add(a);
            else nodes.get(a)!.internal++;
            continue;
        }
        const id = `${a}\u0000${b}`;
        const line = e.line ?? Number.MAX_SAFE_INTEGER;
        const prev = agg.get(id);
        if (prev) {
            prev.count++;
            prev.line = Math.min(prev.line, line);
        } else {
            agg.set(id, { from: a, to: b, line, count: 1 });
        }
    }
    for (const [k, v] of nodes) v.members = memberSets.get(k)!.size;

    const edges = [...agg.values()];
    const out = new Map<NodeKey, VEdge[]>();
    const inc = new Map<NodeKey, VEdge[]>();
    for (const k of nodes.keys()) { out.set(k, []); inc.set(k, []); }
    for (const e of edges) { out.get(e.from)!.push(e); inc.get(e.to)!.push(e); }
    return { nodes, edges, out, inc, selfLoops };
}

/** Subgraph induced by `keys`. */
export function induced(vg: VGraph, keys: ReadonlySet<NodeKey>): VGraph {
    const nodes = new Map([...vg.nodes].filter(([k]) => keys.has(k)));
    const edges = vg.edges.filter((e) => keys.has(e.from) && keys.has(e.to));
    const out = new Map<NodeKey, VEdge[]>();
    const inc = new Map<NodeKey, VEdge[]>();
    for (const k of nodes.keys()) { out.set(k, []); inc.set(k, []); }
    for (const e of edges) { out.get(e.from)!.push(e); inc.get(e.to)!.push(e); }
    return { nodes, edges, out, inc, selfLoops: new Set([...vg.selfLoops].filter((k) => keys.has(k))) };
}
