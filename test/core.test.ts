import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHtmlPre, toText } from '../src/core/grid';
import { buildScene, Scene, unitAnchor } from '../src/core/scene';
import { deepMerge, DEFAULT_STYLE, glyphSet, Style } from '../src/core/style';
import { boxUnit, excludedBy, globToRegExp, ViewDoc } from '../src/core/viewdoc';
import { EXP4, fixtureDoc, k, SH, STAR } from './fixtures';

const GOLDEN = join(__dirname, 'golden');
// goldens pin the tree parent rule: a changed default in DEFAULT_STYLE does not change them
const flat = (o: unknown = {}): Style => deepMerge(DEFAULT_STYLE, { boxes: { enabled: false }, grid: { parentRule: 'dfs' } }, o);
const boxed = (o: unknown = {}): Style => deepMerge(DEFAULT_STYLE, { boxes: { enabled: true }, grid: { parentRule: 'dfs' } }, o);

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
  // every vertex placed once (marker rows of the stable arrangement included)
  expect(P.pos.size).toBe(drawn.nodes.size);
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

  it('dfs parent rule', () => {
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

  it('hidden vertices leave a marker row on their callers, no count', () => {
    const hid = fixtureDoc(SH, { ...doc.view, hidden: ['py:gutai/runtime/interop.py'] });
    const sc = buildScene(hid, boxed());
    invariants(sc);
    expect(sc.hiddenOf.get(k('gutai.render.harmonics:sh_eval'))!.length).toBe(2);
    expect(sc.grid.labels.find((l) => l.key === k('gutai.render.harmonics:sh_eval'))!.text).toBe('sh_eval()');
    expect(sc.grid.markers.some((m) => m.key === k('gutai.render.harmonics:sh_eval') && m.side === 'down')).toBe(true);
  });

  it('full: call depths per side, markers beyond them, shortest or longest path', () => {
    const seed = k('gutai.render.harmonics:sh_eval');
    const at = (d: number, rule: 'shortest' | 'longest' = 'shortest') =>
      buildScene(fixtureDoc(SH, { seeds: [seed], direction: 'out', depthUp: 0, depthDown: d, depthRule: rule }), boxed());
    const one = at(1);
    invariants(one);
    expect(one.vg.nodes.has(k('gutai.runtime.variant:pick_parallel'))).toBe(false);          // two calls away
    expect(one.grid.markers.some((m) => m.key === k('gutai.render.harmonics:sh_eval_mi'))).toBe(true);
    expect(at(2).vg.nodes.has(k('gutai.runtime.variant:pick_parallel'))).toBe(true);
    // _in_type: called by sh_eval (level 1) and by resolve_backend (level 2): longest path puts it at 2
    expect(at(1).vg.nodes.has(k('gutai.render.harmonics:_in_type'))).toBe(true);
    expect(at(1, 'longest').vg.nodes.has(k('gutai.render.harmonics:_in_type'))).toBe(false);
    expect(at(2, 'longest').rev.level.get(k('gutai.render.harmonics:_in_type'))).toBe(2);
  });

  it('grouping on demand: ungroup a package, group a module', () => {
    const rt = 'dir:gutai/runtime';
    const un = buildScene(fixtureDoc(SH, { ...doc.view, ungroup: [rt] }), boxed());
    invariants(un);
    expect(un.placement.frames.map((f) => f.box.label)).not.toContain('runtime');
    expect(un.grid.labels.find((l) => l.key === k('gutai.runtime.variant:pick_parallel'))!.text).toBe('runtime.variant.pick_parallel()');
    const gr = buildScene(fixtureDoc(SH, { ...doc.view, group: ['py:gutai/runtime/variant.py'] }), boxed());
    invariants(gr);
    expect(gr.placement.frames.map((f) => f.box.label)).toContain('variant');
    expect(gr.grid.labels.find((l) => l.key === k('gutai.runtime.variant:pick_parallel'))!.text).toBe('pick_parallel()');
  });

});

describe('one layer at a time: open sides, direction, markers, removal', () => {
  const seed = k('gutai.render.harmonics:sh_eval');
  const base = () => fixtureDoc(SH, { seeds: [seed], direction: 'out', arrange: 'grow', open: {} });
  const name = (x: string) => x.split('#')[1];
  const marked = (sc: Scene) => new Set(sc.grid.markers.map((m) => `${name(m.key)}:${m.side}`));

  it('a new view shows the seed and one layer; marker rows only where more exists', () => {
    const sc = buildScene(base(), boxed());
    invariants(sc);
    const names = [...sc.vg.nodes.keys()].map(name).sort();
    expect(names).toEqual(['_from_columns', '_from_tensor', '_in_type', '_wrapped_mi', 'resolve_backend', 'sh_eval', 'sh_eval_mi',
      'sh_eval_torch_compiled', 'to_drjit', 'to_torch'].sort());
    expect(marked(sc).has('sh_eval_mi:down')).toBe(true);        // calls pick_parallel, assert_variant, _order_check
    expect(marked(sc).has('_in_type:down')).toBe(false);         // calls nothing
    expect(sc.decor.get(k('gutai.render.harmonics:_in_type'))!.pre).toBe('');   // revealed through calls: no callers side
    const t = text(sc, boxed({ edges: { mode: 'glyph' } }));
    expect(t).toMatch(/[└├]─>>/);
    expect(t).not.toMatch(/[▾▴◂▸]/);
    golden('grow_one_layer', t);
  });

  it('a vertex revealed through calls never opens its callers', () => {
    const d = base();
    d.view.open = { [k('gutai.runtime.interop:to_torch')]: 'both', [k('gutai.render.harmonics:sh_eval_mi')]: 'down' };
    const sc = buildScene(d, boxed());
    invariants(sc);
    expect(sc.vg.nodes.has(k('gutai.runtime.variant:pick_parallel'))).toBe(true);
    expect(sc.vg.nodes.has(k('gutai.render.harmonics:_stacked'))).toBe(false);   // a caller of to_torch only
    expect(sc.rev.allowed.get(k('gutai.runtime.interop:to_torch'))).toBe('down');
  });

  it('a cut call or a hidden callee leaves a marker row under the caller', () => {
    const d = base();
    d.view.cut = [[seed, k('gutai.runtime.interop:to_drjit')]];
    const s1 = buildScene(d, boxed());
    invariants(s1);
    expect(s1.vg.nodes.has(k('gutai.runtime.interop:to_drjit'))).toBe(false);
    expect(marked(s1).has('sh_eval:down')).toBe(true);
    const d2 = base();
    d2.view.hidden = [k('gutai.render.harmonics:_in_type')];
    const s2 = buildScene(d2, boxed());
    invariants(s2);
    expect(marked(s2).has('sh_eval:down')).toBe(true);
    expect(s2.decor.get(seed)!.badge).toBe('');                  // no count in this arrangement
    const s0 = buildScene(base(), boxed());
    expect(marked(s0).has('sh_eval:down')).toBe(false);
  });
});

describe('folder filters apply when drawing', () => {
  it('an excluded folder leaves the picture without markers; included again it is back, no new data', () => {
    const doc = fixtureDoc(SH, { seeds: [k('gutai.render.harmonics:sh_eval')], direction: 'out' });
    const rt = (sc: Scene) => [...sc.vg.nodes.keys()].filter((x) => x.includes('/runtime/')).length;
    const all = buildScene(doc, boxed());
    const out = buildScene(doc, boxed(), [globToRegExp('**/runtime/**')]);
    invariants(out);
    expect(rt(all)).toBeGreaterThan(0);
    expect(rt(out)).toBe(0);
    expect(out.grid.markers.some((m) => m.key === k('gutai.render.harmonics:sh_eval'))).toBe(false);
    const back = structuredClone(doc);
    back.view.include = ['gutai/runtime'];
    expect(rt(buildScene(back, boxed(), [globToRegExp('**/runtime/**')]))).toBe(rt(all));
  });

  it('external code is off screen unless shown (gaffy.includeExternal)', () => {
    const doc = fixtureDoc(SH, { seeds: [k('gutai.render.harmonics:sh_eval')], direction: 'out' });
    for (const n of Object.values(doc.graph.nodes)) if (n.path?.includes('/runtime/')) n.external = true;
    const rt = (sc: Scene) => [...sc.vg.nodes.keys()].filter((x) => x.includes('/runtime/')).length;
    expect(rt(buildScene(doc, boxed(), [], true))).toBeGreaterThan(0);
    const off = buildScene(doc, boxed(), [], false);
    invariants(off);
    expect(rt(off)).toBe(0);
  });
});

describe('tree parent rule joint: shared functions take one path, from the left', () => {
  const S = 'gutai.render.harmonics:sh_eval';
  const MANY: [string, string][] = [
    ['gutai.fit.design:_basis', S], ['gutai.fit.probe_field:angular_basis', S], ['gutai.gett.materials:_sky_fit', S],
    ['gutai.render.g_raster:view_colors', S], ['gutai.render.g_raster:sky', S], ['gutai.render.harmonics:fit_sh', S],
    ['gutai.render.harmonics:evaluate', S], ['gutai.render.harmonics:irradiance_sh', S],
    [S, 'gutai.render.harmonics:resolve_backend'], [S, 'gutai.render.harmonics:_in_type'], ['gutai.render.harmonics:resolve_backend', 'gutai.render.harmonics:_in_type'],
    [S, 'gutai.runtime.interop:to_torch'], [S, 'gutai.render.harmonics:_wrapped_mi'], [S, 'gutai.render.harmonics:sh_eval_mi'],
    ['gutai.render.harmonics:_wrapped_mi', 'gutai.render.harmonics:sh_eval_mi'], ['gutai.cost.frameworks:sh_eval_mitsuba', S],
  ];
  const joint = (o: unknown = {}) => boxed(deepMerge({ grid: { parentRule: 'joint' } } as never, o));

  it('a caller right above merges into the elbow; many callers join one collector entering from the left', () => {
    const sc = buildScene(fixtureDoc(MANY, { seeds: [k(S)], direction: 'both' }), joint());
    invariants(sc);
    const t = text(sc, joint({ edges: { mode: 'glyph' } }));
    expect(t).toMatch(/├───┴─> harmonics\._in_type\(\)/);
    expect(t).toMatch(/└───┴─> harmonics\.sh_eval_mi\(\)/);
    expect(t).toMatch(/┴─> harmonics\.sh_eval\(\)/);
    expect(t).not.toMatch(/sh_eval\(\) </);                    // nothing arrives at the label end
    golden('joint_many', t);
  });

  it('the SH example stays routed and conflict free', () => {
    const sc = buildScene(fixtureDoc(SH, { seeds: [k(S)], direction: 'out' }), joint());
    invariants(sc);
    golden('joint_sh', text(sc, joint({ edges: { mode: 'glyph' } })));
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
