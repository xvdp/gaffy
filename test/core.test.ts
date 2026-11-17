import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHtmlPre, toText } from '../src/core/grid';
import { buildScene, Scene } from '../src/core/scene';
import { deepMerge, DEFAULT_STYLE, glyphSet, Style } from '../src/core/style';
import { ViewDoc } from '../src/core/viewdoc';
import { EXP4, fixtureDoc, k, STAR } from './fixtures';

const GOLDEN = join(__dirname, 'golden');
const style = (o: unknown = {}): Style => deepMerge(DEFAULT_STYLE, { container: { kinds: [] } }, o);

/** Compares with test/golden/<name>.txt; writes the file when absent or when UPDATE_GOLDEN is set. */
function golden(name: string, text: string) {
  const f = join(GOLDEN, `${name}.txt`);
  if (!existsSync(f) || process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text + '\n');
  }
  expect(text + '\n').toBe(readFileSync(f, 'utf8'));
}

function invariants(sc: Scene) {
  const { layout: L, vg, grid } = sc;
  // each vertex on exactly one node row
  const nodeRows = L.rows.filter((r) => r.kind === 'node');
  expect(nodeRows.length).toBe(vg.nodes.size);
  expect(new Set(nodeRows.map((r) => r.key)).size).toBe(vg.nodes.size);
  // labels never overlap edge cells
  expect(grid.conflicts).toBe(0);
  // every edge drawn exactly once: tree elbow, lane source, or back tag
  const laneSrc = new Set(L.lanes.flatMap((l) => l.sources.map((s) => `${s.key}>${l.target}`)));
  for (const e of vg.edges) {
    const tree = L.parent.get(e.to) === e.from;
    const lane = laneSrc.has(`${e.from}>${e.to}`);
    const back = (L.back.get(e.from) ?? []).includes(e.to);
    expect([tree, lane, back].filter(Boolean).length, `${e.from} -> ${e.to}`).toBe(1);
    // callers above callees except back edges
    if (!back) expect(L.rowOf.get(e.from)!).toBeLessThan(L.rowOf.get(e.to)!);
  }
  // lanes clear every label they span
  for (const l of L.lanes) for (let r = l.lo; r <= l.hi; r++) expect(l.col).toBeGreaterThan(L.rows[r].end);
}

describe('experiment 4: callers of register_twosided_area', () => {
  const doc = fixtureDoc(EXP4, { seeds: [k('render.mi_emitters:register_twosided_area')], direction: 'in' });

  it('dfs parent rule', () => {
    const sc = buildScene(doc, style());
    invariants(sc);
    const order = sc.layout.rows.filter((r) => r.kind === 'node').map((r) => r.key.split('#')[1]);
    expect(order.slice(0, 3)).toEqual(['traverse', 'speckle', 'treatments']);
    // shared callees once, below all their callers
    expect(sc.layout.parent.get(k(`render.harmonics:sh_eval`))).toBe(k('render.harmonics:_projector_solve'));
    expect(sc.layout.parent.get(k('render.mi_scene:load'))).toBe(k('scripts/mote_paths:layers'));
    golden('exp4_dfs', toText(sc.grid, glyphSet(style())));
  });

  it('nearest parent rule: same tree as dfs on experiment 4', () => {
    const sc = buildScene(doc, style({ grid: { parentRule: 'nearest' } }));
    invariants(sc);
    const dfs = buildScene(doc, style());
    expect([...sc.layout.parent]).toEqual([...dfs.layout.parent]);
  });

  it('relative labels, module brackets', () => {
    const st = deepMerge(DEFAULT_STYLE, { labels: { mode: 'relative' } });
    const sc = buildScene(doc, st);
    invariants(sc);
    expect(sc.layout.brackets.some((b) => b.label === 'render.harmonics')).toBe(true);
    golden('exp4_relative_brackets', toText(sc.grid, glyphSet(st)));
  });

  it('orientation up', () => {
    const d: ViewDoc = { ...doc, view: { ...doc.view, orientation: 'up' } };
    const sc = buildScene(d, style());
    golden('exp4_up', toText(sc.grid, glyphSet(style())));
  });

  it('ascii glyphs', () => {
    const st = style({ edges: { glyphs: 'ascii' } });
    golden('exp4_ascii', toText(buildScene(doc, st).grid, glyphSet(st)));
  });
});

describe('example (*)', () => {
  const seeds = [k('fit.surfel:linear_harmonics'), k('scripts/mote_paths:streamed')];

  it('expanded', () => {
    const sc = buildScene(fixtureDoc(STAR, { seeds }), style());
    invariants(sc);
    golden('star_expanded', toText(sc.grid, glyphSet(style())));
  });

  it('render.harmonics collapsed: quotient', () => {
    const sc = buildScene(fixtureDoc(STAR, { seeds, collapsed: ['py:render/harmonics.py'] }), style());
    invariants(sc);
    const h = sc.vg.nodes.get('py:render/harmonics.py')!;
    expect(h.collapsed).toBe(true);
    expect(h.members).toBe(6);
    expect(h.internal).toBe(5);
    expect(sc.vg.nodes.size).toBe(4);
    expect(sc.vg.edges.map((e) => `${e.from.split(/[#/]/).pop()}>${e.to.split(/[#/]/).pop()}`).sort())
      .toEqual(['harmonics.py>Pass.compile', 'linear_harmonics>harmonics.py', 'streamed>harmonics.py']);
    golden('star_collapsed', toText(sc.grid, glyphSet(style())));
  });

  it('html export links labels', () => {
    const sc = buildScene(fixtureDoc(STAR, { seeds, collapsed: ['py:render/harmonics.py'] }), style());
    const html = toHtmlPre(sc.grid, glyphSet(style()), (key) => `../../${key.split('#')[0].slice(3)}`);
    expect(html).toContain('<a href="../../fit/surfel.py">fit.surfel.linear_harmonics()</a>');
    expect(html).toContain('&lt;');
  });
});

describe('parent rules', () => {
  // q calls u then v; u calls v. DFS visits v first from q; u lands between q and v.
  const doc = fixtureDoc([['m:q', 'm:u'], ['m:q', 'm:v'], ['m:u', 'm:v']], { seeds: [k('m:q')] });

  it('dfs: v under q, u → v through a lane', () => {
    const sc = buildScene(doc, style());
    invariants(sc);
    expect(sc.layout.parent.get(k('m:v'))).toBe(k('m:q'));
    golden('rule_dfs', toText(sc.grid, glyphSet(style())));
  });

  it('nearest: v under u, q → v through a lane', () => {
    const sc = buildScene(doc, style({ grid: { parentRule: 'nearest' } }));
    invariants(sc);
    expect(sc.layout.parent.get(k('m:v'))).toBe(k('m:u'));
    golden('rule_nearest', toText(sc.grid, glyphSet(style())));
  });
});

describe('cycles and status', () => {
  it('back edges become tags, self loops ↻', () => {
    const doc = fixtureDoc([['m:a', 'm:b'], ['m:b', 'm:c'], ['m:c', 'm:a'], ['m:c', 'm:c'], ['m:b', 'm:d']],
      { seeds: [k('m:a')] });
    const sc = buildScene(doc, style());
    invariants(sc);
    const text = toText(sc.grid, glyphSet(style()));
    expect(text).toContain('m.c() ↻ ↻ a()');
  });

  it('ADD, MOD, REMOVE against baseline', () => {
    const doc = fixtureDoc([['m:a', 'm:b'], ['m:a', 'm:c']], { seeds: [k('m:a')] });
    doc.baseline = { [k('m:a')]: 'h0', [k('m:b')]: 'old' };
    doc.ghosts = { nodes: { [k('m:z')]: { ...doc.graph.nodes[k('m:c')], key: k('m:z'), name: 'z', qual: 'z' } },
      edges: [{ from: k('m:a'), to: k('m:z'), line: 9 }] };
    const sc = buildScene(doc, style());
    invariants(sc);
    expect(sc.status.get(k('m:b'))).toBe('MOD');
    expect(sc.status.get(k('m:c'))).toBe('ADD');
    expect(sc.status.get(k('m:z'))).toBe('REMOVE');
    expect(sc.status.has(k('m:a'))).toBe(false);
  });
});
