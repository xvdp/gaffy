import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHtmlPre, toText } from '../src/core/grid';
import { buildScene, Scene, unitAnchor } from '../src/core/scene';
import { deepMerge, DEFAULT_STYLE, glyphSet, Style } from '../src/core/style';
import { boxUnit, excludedBy, globToRegExp, ViewDoc } from '../src/core/viewdoc';
import { EXP4, fixtureDoc, k, SH, STAR } from './fixtures';

const GOLDEN = join(__dirname, 'golden');
const flat = (o: unknown = {}): Style => deepMerge(DEFAULT_STYLE, { boxes: { enabled: false } }, o);
const boxed = (o: unknown = {}): Style => deepMerge(DEFAULT_STYLE, { boxes: { enabled: true } }, o);

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
  const { grid, placement: P, drawn } = sc;
  // every vertex placed once
  expect(P.pos.size).toBe(sc.vg.nodes.size);
  // labels never overlap edge cells or each other
  expect(grid.conflicts).toBe(0);
  const seen = new Map<number, string>();
  for (const l of grid.labels) {
    for (let c = l.col; c < l.col + l.text.length; c++) {
      const id = l.row * 65536 + c;
      expect(seen.get(id), `${l.text} overlaps ${seen.get(id)}`).toBeUndefined();
      seen.set(id, l.text);
    }
  }
  // every call routed
  expect(grid.unrouted).toBe(0);
  // every call drawn exactly once: one path, or a back tag
  const back = new Set<string>();
  for (const B of P.blocks) for (const [u, vs] of B.L.back) for (const v of vs) back.add(`${u}>${v}`);
  const paths = new Map<string, number>();
  for (const p of grid.paths) paths.set(`${p.from}>${p.to}`, (paths.get(`${p.from}>${p.to}`) ?? 0) + 1);
  for (const e of drawn.edges) {
    const id = `${e.from}>${e.to}`;
    expect((paths.get(id) ?? 0) + (back.has(id) ? 1 : 0), id).toBe(1);
  }
  // frames nest and do not overlap siblings
  for (const f of P.frames) {
    for (const g of P.frames) {
      if (f === g) continue;
      const inside = g.c0 >= f.c0 && g.c1 <= f.c1 && g.r0 >= f.r0 && g.r1 <= f.r1;
      const outside = f.c0 >= g.c0 && f.c1 <= g.c1 && f.r0 >= g.r0 && f.r1 <= g.r1;
      const apart = g.c0 > f.c1 || f.c0 > g.c1 || g.r0 > f.r1 || f.r0 > g.r1;
      expect(inside || outside || apart, `${f.box.label} vs ${g.box.label}`).toBe(true);
    }
  }
}

const text = (sc: Scene, st: Style) => toText(sc.grid, glyphSet(st));

describe('experiment 4: callers of register_twosided_area, boxes off', () => {
  const doc = fixtureDoc(EXP4, { seeds: [k('render.mi_emitters:register_twosided_area')], direction: 'in' });

  it('dfs parent rule (unchanged golden)', () => {
    const sc = buildScene(doc, flat());
    invariants(sc);
    const B = sc.placement.blocks[0];
    const order = B.L.rows.filter((r) => r.kind === 'node').map((r) => r.key.split('#')[1]);
    expect(order.slice(0, 3)).toEqual(['traverse', 'speckle', 'treatments']);
    expect(B.L.parent.get(k('render.harmonics:sh_eval'))).toBe(k('render.harmonics:_projector_solve'));
    expect(B.L.parent.get(k('render.mi_scene:load'))).toBe(k('scripts/mote_paths:layers'));
    golden('exp4_dfs', text(sc, flat()));
  });

  it('nearest parent rule: same tree as dfs on experiment 4', () => {
    const sc = buildScene(doc, flat({ grid: { parentRule: 'nearest' } }));
    invariants(sc);
    expect([...sc.placement.blocks[0].L.parent]).toEqual([...buildScene(doc, flat()).placement.blocks[0].L.parent]);
  });

  it('order callees: callee on top, callers below with └──', () => {
    const d: ViewDoc = { ...doc, view: { ...doc.view, order: 'callees' } };
    const sc = buildScene(d, flat());
    invariants(sc);
    expect(sc.placement.pos.get(k('render.mi_emitters:register_twosided_area'))!.row).toBe(0);
    const t = text(sc, flat());
    expect(t).not.toMatch(/[<>]/);
    golden('exp4_callees', t);
  });

  it('ascii glyphs', () => {
    const st = flat({ edges: { glyphs: 'ascii' } });
    golden('exp4_ascii', text(buildScene(doc, st), st));
  });
});

describe('experiment 4 with namespace boxes', () => {
  const doc = fixtureDoc(EXP4, { seeds: [k('render.mi_emitters:register_twosided_area')], direction: 'in' });
  it('boxes per package, labels relative to their box', () => {
    const sc = buildScene(doc, boxed());
    invariants(sc);
    const heads = sc.placement.frames.map((f) => f.box.label);
    expect(heads).toContain('render');
    expect(sc.grid.labels.find((l) => l.key === k('render.harmonics:sh_eval'))!.text).toBe('harmonics.sh_eval()');
    golden('exp4_boxes', text(sc, boxed()));
  });
});

describe('addendum 1a: sh_eval and its callees', () => {
  const doc = fixtureDoc(SH, { seeds: [k('gutai.render.harmonics:sh_eval')], direction: 'out' });

  it('boxes gutai, render.harmonics, runtime; runtime right of render.harmonics (drawing 1c, third)', () => {
    const sc = buildScene(doc, boxed());
    invariants(sc);
    const f = (label: string) => sc.placement.frames.find((x) => x.box.label === label)!;
    expect(f('gutai')).toBeDefined();
    const rh = f('render.harmonics'), rt = f('runtime');
    expect(rt.c0).toBeGreaterThan(rh.c1);
    expect(sc.grid.labels.find((l) => l.key === k('gutai.render.harmonics:sh_eval'))!.text).toBe('sh_eval()');
    expect(sc.grid.labels.find((l) => l.key === k('gutai.runtime.variant:pick_parallel'))!.text).toBe('variant.pick_parallel()');
    // callee level with its caller: _stacked() → interop.to_torch() drawn on one row
    expect(sc.placement.pos.get(k('gutai.runtime.interop:to_torch'))!.row)
      .toBe(sc.placement.pos.get(k('gutai.render.harmonics:_stacked'))!.row);
    golden('sh_boxes', text(sc, boxed()));
  });

  it('module boxes and no outer box', () => {
    const st = boxed({ boxes: { modules: true, root: false } });
    const sc = buildScene(doc, st);
    invariants(sc);
    const heads = sc.placement.frames.map((x) => x.box.label).sort();
    expect(heads).toEqual(['device', 'interop', 'render.harmonics', 'runtime', 'variant']);
    expect(sc.grid.labels.find((l) => l.key === k('gutai.runtime.variant:pick_parallel'))!.text).toBe('pick_parallel()');
    golden('sh_module_boxes', text(sc, st));
  });

  it('box offset moves the box; lock pins it; calls re-route', () => {
    const unit = boxUnit(buildScene(doc, boxed()).placement.frames.find((x) => x.box.label === 'runtime')!.box.key);
    const before = unitAnchor(buildScene(doc, boxed()), unit)!;
    const moved = fixtureDoc(SH, { ...doc.view, offset: { [unit]: [6, 3] } });
    const sc = buildScene(moved, boxed());
    invariants(sc);
    const after = unitAnchor(sc, unit)!;
    expect(after[0] - before[0]).toBe(6);
    const locked = fixtureDoc(SH, { ...doc.view, lock: { [unit]: [90, 2] } });
    const sl = buildScene(locked, boxed());
    invariants(sl);
    expect(unitAnchor(sl, unit)).toEqual([90, 2]);
    golden('sh_runtime_locked', text(sl, boxed()));
  });

  it('vertex offset carries its subtree; broken elbows re-route', () => {
    const key = k('gutai.render.harmonics:sh_eval_torch_compiled');
    const base = buildScene(doc, boxed());
    const moved = fixtureDoc(SH, { ...doc.view, offset: { [key]: [12, 1] } });
    const sc = buildScene(moved, boxed());
    invariants(sc);
    const d = (x: string, s: Scene) => s.placement.pos.get(k(x))!;
    expect(d('gutai.render.harmonics:_compiled', sc).col - d('gutai.render.harmonics:_compiled', base).col).toBe(12);
    // the broken elbow becomes a routed call (net `l:`), not a tree elbow (net `t:`)
    expect(sc.grid.paths.some((p) => p.to === key && p.net.startsWith('l:'))).toBe(true);
  });

  it('hidden vertices leave a +n badge on their neighbors', () => {
    const hid = fixtureDoc(SH, { ...doc.view, hidden: ['py:gutai/runtime/interop.py'] });
    const sc = buildScene(hid, boxed());
    invariants(sc);
    expect(sc.hiddenOf.get(k('gutai.render.harmonics:sh_eval'))!.length).toBe(2);
    expect(sc.grid.labels.find((l) => l.key === k('gutai.render.harmonics:sh_eval'))!.text).toBe('sh_eval() +2');
  });

  it('fold hides what only the folded vertex reaches; shared callees stay', () => {
    const torch = k('gutai.render.harmonics:sh_eval_torch_compiled');
    const cols = k('gutai.render.harmonics:_from_columns');
    const sc = buildScene(fixtureDoc(SH, { ...doc.view, folded: [torch, cols] }), boxed());
    invariants(sc);
    expect(sc.folds.get(torch)!.map((x) => x.split('#')[1]).sort()).toEqual(['_compiled', '_poly_table', '_torch_order']);
    expect(sc.folds.get(cols)!.map((x) => x.split('#')[1])).toEqual(['_stacked']);
    expect(sc.vg.nodes.has(k('gutai.render.harmonics:_tensorxf'))).toBe(true);     // also called by _wrapped_mi
    expect(sc.vg.nodes.has(k('gutai.runtime.interop:to_torch'))).toBe(true);        // also called by sh_eval
    expect(sc.grid.labels.find((l) => l.key === torch)!.text).toBe('sh_eval_torch_compiled() ▸3');
    expect(sc.hiddenOf.size).toBe(0);                                               // folded is not hidden
  });

  it('callees order with boxes', () => {
    const sc = buildScene(fixtureDoc(SH, { ...doc.view, order: 'callees' }), boxed());
    invariants(sc);
    expect(text(sc, boxed())).not.toMatch(/[<>]/);
  });
});

describe('example (*)', () => {
  const seeds = [k('fit.surfel:linear_harmonics'), k('scripts/mote_paths:streamed')];

  it('expanded (unchanged golden)', () => {
    const sc = buildScene(fixtureDoc(STAR, { seeds }), flat());
    invariants(sc);
    golden('star_expanded', text(sc, flat()));
  });

  it('render.harmonics collapsed: quotient', () => {
    const sc = buildScene(fixtureDoc(STAR, { seeds, collapsed: ['py:render/harmonics.py'] }), flat());
    invariants(sc);
    const h = sc.vg.nodes.get('py:render/harmonics.py')!;
    expect(h.collapsed).toBe(true);
    expect(h.members).toBe(6);
    expect(h.internal).toBe(5);
    expect(sc.vg.nodes.size).toBe(4);
    expect(sc.vg.edges.map((e) => `${e.from.split(/[#/]/).pop()}>${e.to.split(/[#/]/).pop()}`).sort())
      .toEqual(['harmonics.py>Pass.compile', 'linear_harmonics>harmonics.py', 'streamed>harmonics.py']);
    golden('star_collapsed', text(sc, flat()));
  });

  it('html export links labels', () => {
    const sc = buildScene(fixtureDoc(STAR, { seeds, collapsed: ['py:render/harmonics.py'] }), flat());
    const html = toHtmlPre(sc.grid, glyphSet(flat()), (key) => `../../${key.split('#')[0].slice(3)}`);
    expect(html).toContain('<a href="../../fit/surfel.py">fit.surfel.linear_harmonics()</a>');
    expect(html).toContain('&lt;');
  });
});

describe('parent rules', () => {
  // q calls u then v; u calls v. DFS visits v first from q; u lands between q and v.
  const doc = fixtureDoc([['m:q', 'm:u'], ['m:q', 'm:v'], ['m:u', 'm:v']], { seeds: [k('m:q')] });

  it('dfs: v under q, u → v through a lane', () => {
    const sc = buildScene(doc, flat());
    invariants(sc);
    expect(sc.placement.blocks[0].L.parent.get(k('m:v'))).toBe(k('m:q'));
    golden('rule_dfs', text(sc, flat()));
  });

  it('nearest: v under u, q → v through a lane', () => {
    const sc = buildScene(doc, flat({ grid: { parentRule: 'nearest' } }));
    invariants(sc);
    expect(sc.placement.blocks[0].L.parent.get(k('m:v'))).toBe(k('m:u'));
    golden('rule_nearest', text(sc, flat()));
  });
});

describe('moves', () => {
  it('callee dragged above its caller: arrow leaves over the caller, ┌─>', () => {
    const doc = fixtureDoc([['m:func', 'm:nextfunc'], ['m:func', 'm:other']], { seeds: [k('m:func')], offset: { [k('m:nextfunc')]: [0, -3] } });
    const sc = buildScene(doc, flat());
    invariants(sc);
    const p = sc.grid.paths.find((x) => x.to === k('m:nextfunc'))!;
    expect(p.start).toBe('N');
    expect(sc.placement.pos.get(k('m:nextfunc'))!.row).toBeLessThan(sc.placement.pos.get(k('m:func'))!.row);
    golden('move_above', text(sc, flat()));
  });

  it('a frame grows to enclose content moved up and left', () => {
    const doc = fixtureDoc(SH, { seeds: [k('gutai.render.harmonics:sh_eval')], direction: 'out',
      offset: { [k('gutai.runtime.variant:pick_parallel')]: [-30, -4] } });
    const sc = buildScene(doc, boxed());
    invariants(sc);
    const p = sc.placement.pos.get(k('gutai.runtime.variant:pick_parallel'))!;
    const rt = sc.placement.frames.find((f) => f.box.label === 'runtime')!;
    expect(rt.c0).toBeLessThan(p.col);
    expect(rt.r0).toBeLessThan(p.row);
  });
});

describe('cycles', () => {
  it('back edges become tags, self loops ↻', () => {
    const doc = fixtureDoc([['m:a', 'm:b'], ['m:b', 'm:c'], ['m:c', 'm:a'], ['m:c', 'm:c'], ['m:b', 'm:d']],
      { seeds: [k('m:a')] });
    const sc = buildScene(doc, flat());
    invariants(sc);
    expect(text(sc, flat())).toContain('m.c() ↻ ↻ a()');
  });
});

describe('folder filters', () => {
  it('glob and view lists', () => {
    const tests = globToRegExp('**/tests/**');
    expect(tests.test('gutai/tests/test_a.py')).toBe(true);
    expect(tests.test('tests/test_a.py')).toBe(true);
    expect(tests.test('gutai/src/a.py')).toBe(false);
    expect(globToRegExp('**/test_*.py').test('a/b/test_x.py')).toBe(true);
    const doc = fixtureDoc([], { exclude: ['gutai/scripts'], include: ['gutai/tests'] });
    const ex = excludedBy(doc.view, [tests]);
    expect(ex('gutai/scripts/run.py')).toBe(true);
    expect(ex('gutai/tests/test_a.py')).toBe(false);
    expect(ex('other/tests/test_a.py')).toBe(true);
    expect(ex('gutai/src/a.py')).toBe(false);
  });
});
