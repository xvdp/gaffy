/**
 * View build: reach set from the seeds through the provider.
 *
 * Reach: breadth-first, level by level up to `depth` hops. A seed traverses `direction`; a vertex
 * reached through incoming calls keeps traversing incoming calls, one reached through outgoing calls
 * keeps traversing outgoing calls. `expanded` vertices add one level in their own direction.
 * Requests per level run with bounded concurrency.
 */
import * as vscode from 'vscode';
import { GEdge, GNode, isContainer, NodeKey, Subgraph } from '../core/model';
import { Direction, excludedBy, ViewDoc } from '../core/viewdoc';
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
  p: LspProvider, doc: ViewDoc, opts: { maxNodes: number; exclude?: RegExp[]; token?: vscode.CancellationToken },
): Promise<BuildResult> {
  const excluded = excludedBy(doc.view, opts.exclude ?? []);
  const seedSet = new Set(doc.view.seeds);
  const skip = (k: NodeKey) => !seedSet.has(k) && excluded(acc[k]?.path);
  const view = doc.view;
  const known = doc.graph.nodes;
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
      if (skip(dir === 'out' ? e.to : e.from)) continue;   // excluded folder: no edge, no traversal
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

  // drop definitions of excluded folders that only the provider's answers introduced
  for (const k of Object.keys(acc)) if (!isContainer(acc[k]) && skip(k)) delete acc[k];
  return { graph: { nodes: acc, edges: [...edges.values()] }, truncated, missing };
}

/** Document after a build: the new graph replaces the old one; definitions outside the new reach set disappear. */
export function applyBuild(doc: ViewDoc, r: BuildResult): ViewDoc {
  const out: ViewDoc = { ...doc, graph: r.graph, updated: new Date().toISOString() };
  if (r.truncated) out.truncated = true;
  else delete out.truncated;
  return out;
}
