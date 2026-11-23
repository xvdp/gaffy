/** @xvdp
 * Language-server answers folded into a view's graph per (definition, direction) pair, bounded concurrency.
 * Modes: `cacheOnly` (cache, no server; instant), `cached` (cache, else server), `fresh` (server; cache refreshed).
 * Answers are stored whole; folder filters apply at draw time (re-including a folder needs no server).
 *
 * No answer ≠ empty answer. Unresolved definition (server analyzing, request failed): calls kept, not cached.
 * Doubted empty answer: drops every stored call, or the text has call sites (`silentOf`); a loading server can
 * answer empty instead of not at all. It counts as no answer until `DOUBTS` consecutive ones (`doubted`, held by
 * the view across retries).
 */
import * as vscode from 'vscode';
import { GEdge, GNode, isContainer, NodeKey, Subgraph } from '../core/model';
import { Direction, ViewDoc } from '../core/viewdoc';
import { CallCache } from './cache';
import { LspProvider } from './lsp';

export type BuildMode = 'cacheOnly' | 'cached' | 'fresh';
/** Consecutive empty answers that replace stored calls (view retries at 2 and 4 s). */
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
    unresolved: Pair[];     // asked, unanswered: calls kept, direction not marked explored
    missed: Pair[];         // `cacheOnly`: no cached answer, not asked
    clamped: (Pair & { total: number })[];   // answers over the call limit: first calls kept; `total`: answer length
    capped: number;         // pairs skipped at `maxNodes` definitions
}

/**
 * Folds answers for `queries`: an answer replaces its pair's calls, adds definitions, marks the direction explored;
 * an unanswered pair keeps its calls. Stable arrangement: one layer, then markers, then prefetch.
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
            // cancelled: pair stays unasked (retried later), not unresolved
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
