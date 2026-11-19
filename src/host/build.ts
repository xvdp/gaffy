/**
 * Language-server answers folded into a view's graph, one (definition, direction) pair at a time.
 *
 * Modes: `cacheOnly` uses cached answers and asks no language server (instant); `cached` uses cached
 * answers and asks the language server for the rest; `fresh` asks the language server and refreshes
 * the cache. Requests run with bounded concurrency.
 *
 * No answer is not an empty answer: a definition the language server does not resolve (still
 * analyzing, request failed) keeps the calls the view already holds, and its answer is not cached.
 */
import * as vscode from 'vscode';
import { GEdge, GNode, isContainer, NodeKey, Subgraph } from '../core/model';
import { Direction, excludedBy, ViewDoc } from '../core/viewdoc';
import { CallCache } from './cache';
import { LspProvider } from './lsp';

export type BuildMode = 'cacheOnly' | 'cached' | 'fresh';
export interface BuildProgress { level: number; depth: number; definitions: number; requests: number; cached: number }

type Dir = 'in' | 'out';

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export type Pair = { key: NodeKey; dir: Dir };
export interface Extension {
  graph: Subgraph;
  explored: Record<NodeKey, Direction>;
  asked: number;          // pairs answered (cache or language server)
  unresolved: Pair[];     // asked, no answer: calls kept, direction not recorded as explored
  missed: Pair[];         // `cacheOnly`: no cached answer, not asked
}

/**
 * Ask for the given (definition, direction) pairs and fold the answers into the view's graph: the
 * calls of a pair are replaced by the answer, new definitions join, explored directions are recorded.
 * A pair without an answer keeps its calls. Modes: `cacheOnly` (cache hits only), `cached` (cache,
 * else the language server), `fresh` (language server).
 * Used by the stable arrangement: one layer at a time, then markers, then prefetch.
 */
export async function extendGraph(
  p: LspProvider, doc: ViewDoc, queries: Pair[],
  opts: { cache?: CallCache; mode: BuildMode; exclude?: RegExp[]; token?: vscode.CancellationToken;
    progress?: (p: BuildProgress) => void; maxNodes?: number },
): Promise<Extension> {
  const excluded = excludedBy(doc.view, opts.exclude ?? []);
  const seeds = new Set(doc.view.seeds);
  const nodes: Record<NodeKey, GNode> = { ...doc.graph.nodes };
  let edges = doc.graph.edges.slice();
  const explored: Record<NodeKey, Direction> = { ...(doc.explored ?? {}) };
  const stats: BuildProgress = { level: 1, depth: 1, definitions: 0, requests: 0, cached: 0 };
  const mark = (k: NodeKey, d: Dir) => { const q = explored[k]; explored[k] = !q || q === d ? d : 'both'; };
  const defs = () => Object.values(nodes).filter((n) => !isContainer(n)).length;
  let asked = 0;
  const unresolved: Pair[] = [];
  const missed: Pair[] = [];
  await pool(queries, 6, async ({ key, dir }) => {
    if (opts.token?.isCancellationRequested) return;
    if (opts.mode !== 'cacheOnly' && opts.maxNodes && defs() >= opts.maxNodes) return;
    if (!nodes[key]) return;
    let es: GEdge[] | undefined;
    const hit = opts.mode !== 'fresh' ? opts.cache?.get(key, dir) : undefined;
    if (hit) {
      for (const [k, n] of Object.entries(hit.nodes)) if (!nodes[k]) nodes[k] = n;
      es = hit.edges;
      stats.cached++;
    } else if (opts.mode === 'cacheOnly') {
      missed.push({ key, dir });
      return;
    } else {
      es = dir === 'out' ? await p.outgoing(key, nodes) : await p.incoming(key, nodes);
      stats.requests++;
      if (!es) { unresolved.push({ key, dir }); opts.progress?.({ ...stats }); return; }
      opts.cache?.put(key, dir, es, nodes);
    }
    asked++;
    es = es.filter((e) => { const other = dir === 'out' ? e.to : e.from; return seeds.has(other) || !excluded(nodes[other]?.path); });
    edges = edges.filter((e) => !(dir === 'out' ? e.from === key : e.to === key)).concat(es);
    mark(key, dir);
    stats.definitions = defs();
    opts.progress?.({ ...stats });
  });
  // one edge per (caller, callee), earliest call line
  const byPair = new Map<string, GEdge>();
  for (const e of edges) {
    const id = `${e.from}\u0000${e.to}`;
    const prev = byPair.get(id);
    if (!prev || (e.line ?? Infinity) < (prev.line ?? Infinity)) byPair.set(id, e);
  }
  return { graph: { nodes, edges: [...byPair.values()] }, explored, asked, unresolved, missed };
}
