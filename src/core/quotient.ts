/**
 * Collapse as quotient graph.
 *
 * Collapse set K ⊆ containers. Representative ρ_K(x): the outermost ancestor of x in K, or x itself
 * when no ancestor is collapsed. Hidden set H: x is dropped when x or any ancestor lies in H.
 * Quotient G_K = (V_K, E_K), V_K = {ρ(v)}, E_K = {(ρ(u), ρ(v), w) : ρ(u) ≠ ρ(v)}, w = number of
 * edges mapped to the pair. Edges inside one collapsed container are counted on that container.
 * Vertices are edge endpoints and seeds; containers enter V_K only as representatives.
 */
import { ancestors, GNode, NodeKey, Subgraph } from './model';

export interface VNode {
  key: NodeKey;
  node: GNode;
  collapsed: boolean;      // representative of a collapsed container
  members: number;         // definitions mapped to this vertex
  internal: number;        // calls between members of a collapsed container
}

export interface VEdge {
  from: NodeKey;
  to: NodeKey;
  line: number;            // minimum call-site line over the mapped edges
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
    if (collapsed.has(a)) rep = a;     // walking outward: the last hit is the outermost
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
