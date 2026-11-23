/** @xvdp
 * Language-server answers folded into a view's graph, one (definition, direction) pair at a time.
 *
 * Modes: `cacheOnly` uses cached answers and asks no language server (instant); `cached` uses cached
 * answers and asks the language server for the rest; `fresh` asks the language server and refreshes
 * the cache. Requests run with bounded concurrency.
 *
 * Every answer is kept whole: folder filters apply when a view is drawn, so including a folder again
 * needs no language server.
 *
 * No answer is not an empty answer: a definition the language server does not resolve (still
 * analyzing, request failed) keeps the calls the view already holds, and its answer is not cached.
 * An empty answer is doubted when it would drop every stored call of a definition, or when the server
 * answered no call although the definition's text has call sites (`silentOf`): a server still analyzing or
 * loading can answer empty instead of not at all. It counts as no answer until `DOUBTS` such answers in a
 * row, across the view's retries (`doubted`, kept by the view), confirm it.
 */
import * as vscode from 'vscode';
import { GEdge, GNode, isContainer, NodeKey, Subgraph } from '../core/model';
import { Direction, ViewDoc } from '../core/viewdoc';
import { CallCache } from './cache';
import { LspProvider } from './lsp';

export type BuildMode = 'cacheOnly' | 'cached' | 'fresh';
/** Empty answers in a row that replace a definition's stored calls (the view retries after 2 and 4 s). */
const DOUBTS = 3;
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
    clamped: (Pair & { total: number })[];   // answers longer than the call limit: the first calls taken, `total` in the answer
    capped: number;         // pairs not asked: the view holds `maxNodes` definitions
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
    opts: { cache?: CallCache; mode: BuildMode; token?: vscode.CancellationToken;
        progress?: (p: BuildProgress) => void; maxNodes?: number; doubted?: Map<string, number> },
): Promise<Extension> {
    const nodes: Record<NodeKey, GNode> = { ...doc.graph.nodes };
    let edges = doc.graph.edges.slice();
    const explored: Record<NodeKey, Direction> = { ...(doc.explored ?? {}) };
    const stats: BuildProgress = { level: 1, depth: 1, definitions: 0, requests: 0, cached: 0 };
    const mark = (k: NodeKey, d: Dir) => { const q = explored[k]; explored[k] = !q || q === d ? d : 'both'; };
    const defs = () => Object.values(nodes).filter((n) => !isContainer(n)).length;
    let asked = 0;
    const unresolved: Pair[] = [];
    const missed: Pair[] = [];
    const clamped: (Pair & { total: number })[] = [];
    let capped = 0;
    await pool(queries, 6, async ({ key, dir }) => {
        if (opts.token?.isCancellationRequested) return;
        if (opts.mode !== 'cacheOnly' && opts.maxNodes && defs() >= opts.maxNodes) { capped++; return; }
        if (!Object.hasOwn(nodes, key)) return;   // own keys only: `constructor` and kin are not definitions
        let es: GEdge[] | undefined;
        const hit = opts.mode !== 'fresh' ? opts.cache?.get(key, dir) : undefined;
        if (hit) {
            for (const [k, n] of Object.entries(hit.nodes)) if (!Object.hasOwn(nodes, k)) nodes[k] = n;
            es = hit.edges;
            if (hit.clamped) clamped.push({ key, dir, total: hit.clamped });
            stats.cached++;
        } else if (opts.mode === 'cacheOnly') {
            missed.push({ key, dir });
            return;
        } else {
            es = dir === 'out' ? await p.outgoing(key, nodes, opts.token) : await p.incoming(key, nodes, opts.token);
            stats.requests++;
            const total = p.clampOf(key, dir);
            // cancelled: the pair stays unasked (asked again later), not unresolved
            if (!es) { if (!opts.token?.isCancellationRequested) unresolved.push({ key, dir }); opts.progress?.({ ...stats }); return; }
            const id = `${dir}:${key}`;
            const stored = edges.some((e) => (dir === 'out' ? e.from === key : e.to === key));
            const silent = p.silentOf?.(key, dir) ?? false;
            if (!es.length && (stored || silent) && opts.doubted) {
                const n = (opts.doubted.get(id) ?? 0) + 1;
                if (n < DOUBTS) { opts.doubted.set(id, n); unresolved.push({ key, dir }); opts.progress?.({ ...stats }); return; }
            }
            opts.doubted?.delete(id);
            if (total) clamped.push({ key, dir, total });
            opts.cache?.put(key, dir, es, nodes, total);
        }
        asked++;
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
    return { graph: { nodes, edges: [...byPair.values()] }, explored, asked, unresolved, missed, clamped, capped };
}
