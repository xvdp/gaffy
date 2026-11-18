import { describe, expect, it } from 'vitest';
import { GEdge, GNode, NodeKey } from '../src/core/model';
import { extendGraph } from '../src/host/build';
import type { LspProvider } from '../src/host/lsp';
import { EXP4, fixtureDoc, k } from './fixtures';

type Answer = GEdge[] | undefined;

/** Provider stub: fixed answers per (direction, key); keys absent from the table get `undefined` (no answer). */
function provider(table: Record<string, Answer>): LspProvider {
  const ask = (dir: string) => async (key: NodeKey, _acc: Record<NodeKey, GNode>) => table[`${dir}:${key}`];
  return { outgoing: ask('out'), incoming: ask('in') } as unknown as LspProvider;
}

const calls = (es: GEdge[], key: NodeKey) => es.filter((e) => e.from === key).map((e) => e.to).sort();

describe('extendGraph merge', () => {
  const doc = fixtureDoc(EXP4);
  const root = k('scripts/mote_paths:traverse');
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

  it('cacheOnly reports misses without asking', async () => {
    let asked = 0;
    const p = { outgoing: async () => { asked++; return []; }, incoming: async () => { asked++; return []; } } as unknown as LspProvider;
    const r = await extendGraph(p, doc, [{ key: root, dir: 'out' }], { mode: 'cacheOnly' });
    expect(asked).toBe(0);
    expect(r.missed).toEqual([{ key: root, dir: 'out' }]);
    expect(calls(r.graph.edges, root)).toEqual(before);
  });
});
