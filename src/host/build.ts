/**
 * View build: reach set from the seeds through the provider and the call cache.
 *
 * Modes: `cacheOnly` uses cached answers, else the calls already in the view file, and asks no
 * language server (instant); `cached` uses cached answers and asks the language server for the rest; `fresh` asks the
 * language server for every definition and refreshes the cache.
 *
 * No answer is not an empty answer: a definition the language server does not resolve (still
 * analyzing, request failed) keeps the calls the view already holds, and its answer is not cached.
 *
 * Reach: breadth-first, level by level up to `depth` hops. A seed traverses `direction`; a vertex
 * reached through incoming calls keeps traversing incoming calls, one reached through outgoing calls
 * keeps traversing outgoing calls. `expanded` vertices add one level in their own direction.
 * Requests per level run with bounded concurrency.
 */
import * as vscode from 'vscode';
import { GEdge, GNode, isContainer, NodeKey, Subgraph } from '../core/model';
import { Direction, excludedBy, ViewDoc } from '../core/viewdoc';
import { CallCache } from './cache';
import { LspProvider } from './lsp';

export type BuildMode = 'cacheOnly' | 'cached' | 'fresh';
export interface BuildProgress { level: number; depth: number; definitions: number; requests: number; cached: number }

type Dir = 'in' | 'out';
const dirsOf = (d: Direction): Dir[] => (d === 'both' ? ['in', 'out'] : [d]);

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export interface BuildResult {
  graph: Subgraph;
  explored: Record<NodeKey, Direction>;   // directions answered per vertex
  truncated: boolean;
  missing: NodeKey[];                     // seeds without a record
  unresolved: number;                     // (definition, direction) pairs without an answer
}

export async function buildGraph(
  p: LspProvider, doc: ViewDoc,
  opts: {
    maxNodes: number; exclude?: RegExp[]; token?: vscode.CancellationToken;
    cache?: CallCache; mode?: BuildMode; progress?: (p: BuildProgress) => void;
  },
): Promise<BuildResult> {
  const mode = opts.mode ?? 'cached';
  const stats: BuildProgress = { level: 0, depth: doc.view.depth, definitions: 0, requests: 0, cached: 0 };
  const report = () => { stats.definitions = defs(); opts.progress?.({ ...stats }); };
  const excluded = excludedBy(doc.view, opts.exclude ?? []);
  const seedSet = new Set(doc.view.seeds);
  const skip = (k: NodeKey) => !seedSet.has(k) && excluded(acc[k]?.path);
  const view = doc.view;
  const known = doc.graph.nodes;
  const acc: Record<NodeKey, GNode> = {};
  const edges = new Map<string, GEdge>();
  const queried = new Set<string>();
  const explored: Record<NodeKey, Direction> = {};
  const mark = (k: NodeKey, d: Dir) => { const p = explored[k]; explored[k] = !p || p === d ? d : 'both'; };
  const priorAsked = (k: NodeKey, d: Dir) => doc.explored?.[k] === d || doc.explored?.[k] === 'both';
  const defs = () => Object.values(acc).filter((n) => !isContainer(n)).length;
  const missing: NodeKey[] = [];
  let unresolved = 0;
  let truncated = false;

  const withContainers = (k: NodeKey, from: (k: NodeKey) => GNode | undefined) => {
    for (let n = from(k); n && !acc[n.key]; n = n.parent ? from(n.parent) : undefined) acc[n.key] = n;
  };
  // seeds: known records first (no language server); `fresh` re-resolves them by key, else keeps the known record
  for (const s of view.seeds) {
    const node = known[s] ?? opts.cache?.node(s);
    const keep = () => withContainers(s, (k) => known[k] ?? opts.cache?.node(k));
    if (node && mode !== 'fresh') { keep(); continue; }
    if (mode === 'cacheOnly') { if (!node) missing.push(s); continue; }
    const it = await p.item(s, node).catch(() => undefined);
    if (it) await p.describe(it, acc);
    else if (node) keep();
    else missing.push(s);
  }
  report();

  const query = async (key: NodeKey, dir: Dir, next: { key: NodeKey; dir: Dir }[]) => {
    const id = `${dir}:${key}`;
    if (queried.has(id) || opts.token?.isCancellationRequested) return;
    queried.add(id);
    if (!acc[key] && known[key]) acc[key] = known[key];
    let es: GEdge[] | undefined;
    // the view's own graph is a cache too: its calls of this definition
    const own = () => {
      const r = doc.graph.edges.filter((e) => (dir === 'out' ? e.from === key : e.to === key));
      for (const e of r) for (const k of [e.from, e.to]) withContainers(k, (x) => known[x]);
      if (priorAsked(key, dir)) mark(key, dir);
      return r;
    };
    const hit = mode !== 'fresh' ? opts.cache?.get(key, dir) : undefined;
    if (hit) {
      for (const [k, n] of Object.entries(hit.nodes)) if (!acc[k]) acc[k] = n;
      es = hit.edges;
      stats.cached++;
      mark(key, dir);
    } else if (mode === 'cacheOnly') {
      es = own();
      stats.cached++;
    } else {
      const answer = dir === 'out' ? await p.outgoing(key, acc) : await p.incoming(key, acc);
      stats.requests++;
      if (answer) {
        es = answer;
        opts.cache?.put(key, dir, es, acc);
        mark(key, dir);
      } else {
        es = own();
        unresolved++;
      }
    }
    report();
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
    stats.level = d + 1;
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
  return { graph: { nodes: acc, edges: [...edges.values()] }, explored, truncated, missing, unresolved };
}

/** Document after a build: the new graph replaces the old one; definitions outside the new reach set disappear. */
export function applyBuild(doc: ViewDoc, r: BuildResult): ViewDoc {
  const out: ViewDoc = { ...doc, graph: r.graph, explored: r.explored, updated: new Date().toISOString() };
  if (r.truncated) out.truncated = true;
  else delete out.truncated;
  return out;
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
