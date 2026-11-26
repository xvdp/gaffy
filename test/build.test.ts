import { describe, expect, it } from 'vitest';
import { GEdge, GNode, NodeKey } from '../src/core/model';
import { extendGraph } from '../src/host/build';
import type { LspProvider } from '../src/host/lsp';
import { fixtureDoc, k, MOO } from './fixtures';

type Answer = GEdge[] | undefined;

/**
 * Provider stub: fixed answers per (direction, key); keys absent from the table get `undefined` (no answer).
 * `clamps`: full answer lengths reported by `clampOf` for answers cut at the call limit.
 */
function provider(table: Record<string, Answer>, clamps: Record<string, number> = {}): LspProvider {
    const ask = (dir: string) => async (key: NodeKey, _acc: Record<NodeKey, GNode>) => table[`${dir}:${key}`];
    return { outgoing: ask('out'), incoming: ask('in'), clampOf: (key: NodeKey, dir: string) => clamps[`${dir}:${key}`] } as unknown as LspProvider;
}

const calls = (es: GEdge[], key: NodeKey) => es.filter((e) => e.from === key).map((e) => e.to).sort();

describe('extendGraph merge', () => {
    const doc = fixtureDoc(MOO);
    const root = k('scripts/moo_trucks:wanderoo');
    const before = calls(doc.graph.edges, root);

    it('keeps the calls of a pair without an answer and reports it unresolved', async () => {
        const r = await extendGraph(provider({}), doc, [{ key: root, dir: 'out' }], { mode: 'fresh' });
        expect(calls(r.graph.edges, root)).toEqual(before);
        expect(r.unresolved).toEqual([{ key: root, dir: 'out' }]);
        expect(r.asked).toBe(0);
    });

    it('replaces the calls of a pair with an empty answer', async () => {
        const r = await extendGraph(provider({ [`out:${root}`]: [] }), doc, [{ key: root, dir: 'out' }], { mode: 'fresh' });
        expect(calls(r.graph.edges, root)).toEqual([]);
        expect(r.unresolved).toEqual([]);
        expect(r.explored[root]).toBe('both');
    });

    it('does not record an unanswered direction as explored', async () => {
        const d = { ...doc, explored: {} };
        const r = await extendGraph(provider({}), d, [{ key: root, dir: 'in' }], { mode: 'fresh' });
        expect(r.explored[root]).toBeUndefined();
    });

    it('reports an answer cut at the call limit with its full length', async () => {
        const r = await extendGraph(provider({ [`out:${root}`]: [] }, { [`out:${root}`]: 7000 }), doc, [{ key: root, dir: 'out' }], { mode: 'fresh' });
        expect(r.clamped).toEqual([{ key: root, dir: 'out', total: 7000 }]);
    });

    it('a request cancelled by an urgent task leaves the pair unasked, not unresolved', async () => {
        const token = { isCancellationRequested: false } as { isCancellationRequested: boolean };
        const p = { outgoing: async () => { token.isCancellationRequested = true; return undefined; }, clampOf: () => undefined } as unknown as LspProvider;
        const d = { ...doc, explored: {} };
        const r = await extendGraph(p, d, [{ key: root, dir: 'out' }], { mode: 'fresh', token: token as never });
        expect(r.unresolved).toEqual([]);
        expect(r.explored[root]).toBeUndefined();
    });

    it('a partial answer (binding target unresolved) keeps the stored cross-language call, is retried, never cached', async () => {
        const callee = calls(doc.graph.edges, root)[0];
        const bridged = { ...doc, graph: { ...doc.graph, edges: doc.graph.edges.map((e) => (e.from === root && e.to === callee ? { ...e, via: 'pybind11: ext.cpp:3' } : e)) } };
        const put: string[] = [];
        const cache = { get: () => undefined, put: (key: NodeKey, dir: string) => { put.push(`${dir}:${key}`); } };
        const p = { ...provider({ [`out:${root}`]: [] }), partialOf: (key: NodeKey, dir: string) => key === root && dir === 'out' } as unknown as LspProvider;
        const r = await extendGraph(p, bridged, [{ key: root, dir: 'out' }], { mode: 'fresh', cache: cache as never });
        expect(calls(r.graph.edges, root)).toEqual([callee]);
        expect(r.partial).toEqual([{ key: root, dir: 'out' }]);
        expect(put).toEqual([]);
    });

    it('a call reported by the callee\'s callers stays when the caller\'s calls answer omits it; it goes when neither reports it', async () => {
        // distCUDA2 → knn: the C/C++ server lists distCUDA2 among the callers of knn, and no calls for distCUDA2
        const d = { ...doc, graph: { ...doc.graph, edges: doc.graph.edges.filter((e) => e.from !== root) } };
        const callee = calls(doc.graph.edges, root)[0];
        const e = { from: root, to: callee, line: 3 };
        const r1 = await extendGraph(provider({ [`in:${callee}`]: [e] }), d, [{ key: callee, dir: 'in' }], { mode: 'fresh' });
        expect(r1.graph.edges.find((x) => x.from === root && x.to === callee)?.seen).toBe('in');
        const r2 = await extendGraph(provider({ [`out:${root}`]: [] }), { ...d, graph: r1.graph }, [{ key: root, dir: 'out' }], { mode: 'fresh' });
        expect(r2.graph.edges.find((x) => x.from === root && x.to === callee)?.seen).toBe('in');
        const r3 = await extendGraph(provider({ [`out:${root}`]: [e] }), { ...d, graph: r2.graph }, [{ key: root, dir: 'out' }], { mode: 'fresh' });
        expect(r3.graph.edges.find((x) => x.from === root && x.to === callee)?.seen).toBe('both');
        const r4 = await extendGraph(provider({ [`in:${callee}`]: [], [`out:${root}`]: [] }), { ...d, graph: r3.graph }, [{ key: callee, dir: 'in' }, { key: root, dir: 'out' }], { mode: 'fresh' });
        expect(r4.graph.edges.some((x) => x.from === root && x.to === callee)).toBe(false);
    });

    it('calls of views from before `seen` count as reported by the pair being answered', async () => {
        const r = await extendGraph(provider({ [`out:${root}`]: [] }), doc, [{ key: root, dir: 'out' }], { mode: 'fresh' });
        expect(calls(r.graph.edges, root)).toEqual([]);
    });

    it('counts the pairs not asked at the definition limit', async () => {
        const r = await extendGraph(provider({}), doc, [{ key: root, dir: 'out' }, { key: root, dir: 'in' }], { mode: 'fresh', maxNodes: 1 });
        expect(r.capped).toBe(2);
        expect(r.asked).toBe(0);
    });

    it('an empty answer that drops every stored call counts only when confirmed', async () => {
        const doubted = new Map<string, number>();
        const p = provider({ [`out:${root}`]: [] });
        for (const round of [1, 2]) {
            const r = await extendGraph(p, doc, [{ key: root, dir: 'out' }], { mode: 'fresh', doubted });
            expect(calls(r.graph.edges, root), `round ${round}`).toEqual(before);
            expect(r.unresolved).toEqual([{ key: root, dir: 'out' }]);
        }
        const r3 = await extendGraph(p, doc, [{ key: root, dir: 'out' }], { mode: 'fresh', doubted });
        expect(calls(r3.graph.edges, root)).toEqual([]);
        expect(doubted.size).toBe(0);
        // nothing stored: an empty answer is taken at once
        const leaf = Object.keys(doc.graph.nodes).find((x) => x.includes('#') && !doc.graph.edges.some((e) => e.from === x))!;
        const r4 = await extendGraph(provider({ [`out:${leaf}`]: [] }), doc, [{ key: leaf, dir: 'out' }], { mode: 'fresh', doubted });
        expect(r4.unresolved).toEqual([]);
    });

    it('an empty answer for a body with call sites counts only when confirmed, with nothing stored', async () => {
        const doubted = new Map<string, number>();
        const leaf = Object.keys(doc.graph.nodes).find((x) => x.includes('#') && !doc.graph.edges.some((e) => e.from === x))!;
        const p = { outgoing: async () => [], incoming: async () => [], clampOf: () => undefined, silentOf: () => true } as unknown as LspProvider;
        for (const round of [1, 2]) {
            const r = await extendGraph(p, doc, [{ key: leaf, dir: 'out' }], { mode: 'fresh', doubted });
            expect(r.unresolved, `round ${round}`).toEqual([{ key: leaf, dir: 'out' }]);
            expect(r.explored[leaf], `round ${round}`).not.toBe('out');
        }
        const r3 = await extendGraph(p, doc, [{ key: leaf, dir: 'out' }], { mode: 'fresh', doubted });
        expect(r3.unresolved).toEqual([]);
    });

    it('cacheOnly reports misses without asking', async () => {
        let asked = 0;
        const p = { outgoing: async () => { asked++; return []; }, incoming: async () => { asked++; return []; } } as unknown as LspProvider;
        const r = await extendGraph(p, doc, [{ key: root, dir: 'out' }], { mode: 'cacheOnly' });
        expect(asked).toBe(0);
        expect(r.missed).toEqual([{ key: root, dir: 'out' }]);
        expect(calls(r.graph.edges, root)).toEqual(before);
    });
});
