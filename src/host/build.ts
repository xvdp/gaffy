/**
 * View build: reach set from the seeds through the provider, then reconciliation with the previous
 * build (ghosts for removed definitions, baseline on first build).
 *
 * Reach: breadth-first, level by level up to `depth` hops. A seed traverses `direction`; a vertex
 * reached through incoming calls keeps traversing incoming calls, one reached through outgoing calls
 * keeps traversing outgoing calls. `expanded` vertices add one level in their own direction.
 * Requests per level run with bounded concurrency.
 */
import * as vscode from 'vscode';
import { GEdge, GNode, isContainer, mergeGraphs, NodeKey, Subgraph } from '../core/model';
import { Direction, ViewDoc } from '../core/viewdoc';
import { LspProvider } from './lsp';

type Dir = 'in' | 'out';
const dirsOf = (d: Direction): Dir[] => (d === 'both' ? ['in', 'out'] : [d]);

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export interface BuildResult {
  graph: Subgraph;
  truncated: boolean;
  missing: NodeKey[];
}

export async function buildGraph(
  p: LspProvider, doc: ViewDoc, opts: { maxNodes: number; token?: vscode.CancellationToken },
): Promise<BuildResult> {
  const view = doc.view;
  const known = mergeGraphs(doc.ghosts, doc.graph).nodes;
  const acc: Record<NodeKey, GNode> = {};
  const edges = new Map<string, GEdge>();
  const queried = new Set<string>();
  const defs = () => Object.values(acc).filter((n) => !isContainer(n)).length;
  const missing: NodeKey[] = [];
  let truncated = false;

  // seeds: re-resolve by key, carry their records so the provider can find them
  for (const s of view.seeds) {
    const node = known[s] ?? acc[s];
    const it = await p.item(s, node);
    if (!it) { missing.push(s); continue; }
    await p.describe(it, acc);
  }

  const query = async (key: NodeKey, dir: Dir, next: { key: NodeKey; dir: Dir }[]) => {
    const id = `${dir}:${key}`;
    if (queried.has(id) || opts.token?.isCancellationRequested) return;
    queried.add(id);
    if (!acc[key] && known[key]) acc[key] = known[key];
    const es = dir === 'out' ? await p.outgoing(key, acc) : await p.incoming(key, acc);
    for (const e of es) {
      const eid = `${e.from}\u0000${e.to}`;
      const prev = edges.get(eid);
      if (!prev || (e.line ?? Infinity) < (prev.line ?? Infinity)) edges.set(eid, e);
      next.push({ key: dir === 'out' ? e.to : e.from, dir });
    }
  };

  let frontier = view.seeds.filter((s) => acc[s]).flatMap((s) => dirsOf(view.direction).map((dir) => ({ key: s, dir })));
  for (let d = 0; d < view.depth && frontier.length; d++) {
    const next: { key: NodeKey; dir: Dir }[] = [];
    await pool(frontier, 6, ({ key, dir }) => query(key, dir, next));
    if (defs() >= opts.maxNodes) { truncated = true; break; }
    const seen = new Set<string>();
    frontier = next.filter((f) => !seen.has(`${f.dir}:${f.key}`) && seen.add(`${f.dir}:${f.key}`));
  }
  const extra = Object.entries(view.expanded).filter(([k]) => acc[k] || known[k]);
  await pool(extra.flatMap(([key, d]) => dirsOf(d).map((dir) => ({ key, dir }))), 6,
    ({ key, dir }) => query(key, dir, []));

  return { graph: { nodes: acc, edges: [...edges.values()] }, truncated, missing };
}

/** New document state after a build: ghosts for baseline definitions that disappeared. */
export function reconcile(doc: ViewDoc, r: BuildResult): ViewDoc {
  const prev = mergeGraphs(doc.ghosts, doc.graph);
  const live = r.graph;
  const baseline = Object.keys(doc.baseline).length ? doc.baseline : Object.fromEntries(
    Object.values(live.nodes).filter((n) => !isContainer(n)).map((n) => [n.key, n.hash ?? '']));

  const ghostNodes: Record<NodeKey, GNode> = {};
  for (const n of Object.values(prev.nodes)) {
    if (isContainer(n) || live.nodes[n.key] || baseline[n.key] === undefined) continue;
    ghostNodes[n.key] = n;
    for (let a = n.parent; a && !live.nodes[a] && !ghostNodes[a] && prev.nodes[a]; a = prev.nodes[a].parent) {
      ghostNodes[a] = prev.nodes[a];
    }
  }
  const alive = (k: NodeKey) => !!live.nodes[k] || !!ghostNodes[k];
  const ghostEdges = prev.edges.filter((e) =>
    (ghostNodes[e.from] || ghostNodes[e.to]) && alive(e.from) && alive(e.to));

  return {
    ...doc,
    graph: live,
    ghosts: { nodes: ghostNodes, edges: ghostEdges },
    baseline,
    truncated: r.truncated || undefined,
    updated: new Date().toISOString(),
  };
}
