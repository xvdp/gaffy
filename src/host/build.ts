/** @xvdp
 * Language-server answers folded into a view's graph per (definition, direction) pair, bounded concurrency.
 * Modes: `cacheOnly` (cache, no server; instant), `cached` (cache, else server), `fresh` (server; cache refreshed).
 * Answers are stored whole; folder filters apply at draw time (re-including a folder needs no server).
 *
 * No answer ≠ empty answer. Unresolved definition (server analyzing, request failed): calls kept, not cached.
 * A call belongs to two pairs: (caller, out) and (called, in); `GEdge.seen` records which answers reported it. An
 * answer replaces the calls of its pair except those an answer of the other pair reported: servers answer the two
 * directions apart and not alike (the C/C++ server lists a CUDA host function as caller of `knn` and no calls for that
 * function), so one direction's silence does not refute the other's report. A call goes when neither reports it;
 * calls from views without `seen` count as reported by the pair being answered only.
 * Partial answer (a binding target unresolved past bridges.ts MISSES, `partialOf`): applied with the pair's stored
 * cross-language calls kept, not cached, retried with the unresolved pairs: a link found once stays, and a cache
 * never holds an answer without a link the C/C++ server could not resolve yet.
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
    partial: Pair[];        // answered without an unresolved binding link: applied, stored links kept, not cached
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
    const partial: Pair[] = [];
    const missed: Pair[] = [];
    const clamped: (Pair & { total: number })[] = [];
    let capped = 0;
    await pool(queries, 6, async ({ key, dir }) => {
        if (opts.token?.isCancellationRequested) return;
        if (opts.mode !== 'cacheOnly' && opts.maxNodes && defs() >= opts.maxNodes) { capped++; return; }
        if (!Object.hasOwn(nodes, key)) return;   // own keys only: `constructor` and kin are not definitions
        let es: GEdge[] | undefined;
        const other: 'in' | 'out' = dir === 'out' ? 'in' : 'out';
        const mine = (e: GEdge) => (dir === 'out' ? e.from === key : e.to === key);
        const otherSaw = (e: GEdge) => e.seen === other || e.seen === 'both';
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
            // calls of the pair only this pair reported: an empty answer would drop them
            const stored = edges.some((e) => mine(e) && !otherSaw(e));
            const silent = p.silentOf?.(key, dir) ?? false;
            if (!es.length && (stored || silent) && opts.doubted) {
                const n = (opts.doubted.get(id) ?? 0) + 1;
                if (n < DOUBTS) { opts.doubted.set(id, n); unresolved.push({ key, dir }); opts.progress?.({ ...stats }); return; }
            }
            opts.doubted?.delete(id);
            if (total) clamped.push({ key, dir, total });
            if (p.partialOf?.(key, dir)) {
                const kept = edges.filter((e) => e.via && (dir === 'out' ? e.from === key : e.to === key) && !es!.some((x) => x.from === e.from && x.to === e.to));
                es = es.concat(kept);
                partial.push({ key, dir });
            } else opts.cache?.put(key, dir, es, nodes, total);
        }
        asked++;
        const now = new Set(es.map((e) => `${e.from}\u0000${e.to}`));
        const before = new Map(edges.filter(mine).map((e) => [`${e.from}\u0000${e.to}`, e]));
        // the pair's calls missing from the answer stay when the other pair reported them, as the other pair's only
        const kept = [...before.values()].filter((e) => !now.has(`${e.from}\u0000${e.to}`) && otherSaw(e)).map((e) => ({ ...e, seen: other }));
        const saw = (e: GEdge): GEdge['seen'] => { const b = before.get(`${e.from}\u0000${e.to}`); return b && otherSaw(b) ? 'both' : dir; };
        edges = edges.filter((e) => !mine(e)).concat(kept, es.map((e) => ({ ...e, seen: saw(e) })));
        mark(key, dir);
        stats.definitions = defs();
        opts.progress?.({ ...stats });
    });
    // one edge per (caller, called), earliest call line
    const byPair = new Map<string, GEdge>();
    const join = (a: GEdge['seen'], b: GEdge['seen']): GEdge['seen'] => (a === b ? a : !a ? b : !b ? a : 'both');
    for (const e of edges) {
        const id = `${e.from}\u0000${e.to}`;
        const prev = byPair.get(id);
        if (!prev || (e.line ?? Infinity) < (prev.line ?? Infinity)) byPair.set(id, prev ? { ...e, seen: join(e.seen, prev.seen) } : e);
        else byPair.set(id, { ...prev, seen: join(e.seen, prev.seen) });
    }
    return { graph: { nodes, edges: [...byPair.values()] }, explored, asked, unresolved, partial, missed, clamped, capped };
}
