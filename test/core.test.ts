import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHtmlPre, toText } from '../src/core/grid';
import { nodeLabel } from '../src/core/labels';
import { GNode, plain, visible } from '../src/core/model';
import { buildScene, isStub, Scene, unitAnchor, unitMembers } from '../src/core/scene';
import { deepMerge, DEFAULT_STYLE, glyphSet, Style } from '../src/core/style';
import { boxUnit, collapsedUnit, dropMovesWithin, excludedBy, globMatcher, isBuilt, parseDoc, serializeDoc, ViewDoc, ViewSpec } from '../src/core/viewdoc';
import { frontierOf, pinPaths } from '../src/core/scene';
import { Decision } from '../src/core/explain';
import { fixtureDoc, k, KAZOO, MOO, STAR } from './fixtures';
import { invariants } from './invariants';

const GOLDEN = join(__dirname, 'golden');
// goldens pin the tree parent rule: a changed default in DEFAULT_STYLE does not change them
const flat = (o: unknown = {}): Style => deepMerge(DEFAULT_STYLE, { boxes: { enabled: false }, grid: { parentRule: 'dfs' } }, o);
// goldens pin frames that keep their corner (boxes.tight off): their pictures predate tight frames
const boxed = (o: unknown = {}): Style => deepMerge(DEFAULT_STYLE, { boxes: { enabled: true, tight: false }, grid: { parentRule: 'dfs' } }, o);

/** Compares with test/golden/<name>.txt; writes the file when absent or when UPDATE_GOLDEN is set. */
function golden(name: string, text: string) {
    const f = join(GOLDEN, `${name}.txt`);
    if (!existsSync(f) || process.env.UPDATE_GOLDEN) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, text + '\n');
    }
    expect(text + '\n').toBe(readFileSync(f, 'utf8'));
}


const text = (sc: Scene, st: Style) => toText(sc.grid, glyphSet(st));

describe('fixture MOO: callers of flibbity_jibbity_jabby, boxes off', () => {
    const doc = fixtureDoc(MOO, { seeds: [k('moomoo.yo_blinkers:flibbity_jibbity_jabby')], direction: 'in' });

    it('dfs parent rule', () => {
        const sc = buildScene(doc, flat());
        invariants(sc);
        const B = sc.placement.blocks[0];
        const order = B.L.rows.filter((r) => r.kind === 'node').map((r) => r.key.split('#')[1]);
        expect(order.slice(0, 3)).toEqual(['wanderoo', 'flubber', 'tomfoolery']);
        expect(B.L.parent.get(k('moomoo.boogaloos:scoobie'))).toBe(k('moomoo.boogaloos:_jelly_doughnuts'));
        expect(B.L.parent.get(k('moomoo.yo_nudge:shoo'))).toBe(k('scripts/moo_trucks:bonbon'));
        golden('moo_dfs', text(sc, flat()));
    });

    it('nearest parent rule: same tree as dfs on fixture MOO', () => {
        const sc = buildScene(doc, flat({ grid: { parentRule: 'nearest' } }));
        invariants(sc);
        expect([...sc.placement.blocks[0].L.parent]).toEqual([...buildScene(doc, flat()).placement.blocks[0].L.parent]);
    });

    it('ascii glyphs', () => {
        const st = flat({ edges: { glyphs: 'ascii' } });
        golden('moo_ascii', text(buildScene(doc, st), st));
    });
});

describe('fixture MOO with namespace boxes', () => {
    const doc = fixtureDoc(MOO, { seeds: [k('moomoo.yo_blinkers:flibbity_jibbity_jabby')], direction: 'in' });
    it('boxes per package, labels relative to their box', () => {
        const sc = buildScene(doc, boxed());
        invariants(sc);
        const heads = sc.placement.frames.map((f) => f.box.label);
        expect(heads).toContain('moomoo');
        expect(sc.grid.labels.find((l) => l.key === k('moomoo.boogaloos:scoobie'))!.text).toBe('boogaloos.scoobie()');
        golden('moo_boxes', text(sc, boxed()));
    });
});

describe('addendum 1a: scoobie and its callees', () => {
    const doc = fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out' });

    it('boxes kazoo, moomoo.boogaloos, noodles; noodles right of moomoo.boogaloos (drawing 1c, third)', () => {
        const sc = buildScene(doc, boxed());
        invariants(sc);
        const f = (label: string) => sc.placement.frames.find((x) => x.box.label === label)!;
        expect(f('kazoo')).toBeDefined();
        const rh = f('moomoo.boogaloos'), rt = f('noodles');
        expect(rt.c0).toBeGreaterThan(rh.c1);
        expect(sc.grid.labels.find((l) => l.key === k('kazoo.moomoo.boogaloos:scoobie'))!.text).toBe('scoobie()');
        expect(sc.grid.labels.find((l) => l.key === k('kazoo.noodles.wibbles:mister_magoos'))!.text).toBe('wibbles.mister_magoos()');
        // callee level with its caller: _lasagna() → jumbles.to_wacky() drawn on one row
        expect(sc.placement.pos.get(k('kazoo.noodles.jumbles:to_wacky'))!.row)
            .toBe(sc.placement.pos.get(k('kazoo.moomoo.boogaloos:_lasagna'))!.row);
        golden('kazoo_boxes', text(sc, boxed()));
    });

    it('module boxes and no outer box', () => {
        const st = boxed({ boxes: { modules: true, root: false } });
        const sc = buildScene(doc, st);
        invariants(sc);
        const heads = sc.placement.frames.map((x) => x.box.label).sort();
        expect(heads).toEqual(['doodle', 'jumbles', 'moomoo.boogaloos', 'noodles', 'wibbles']);
        expect(sc.grid.labels.find((l) => l.key === k('kazoo.noodles.wibbles:mister_magoos'))!.text).toBe('mister_magoos()');
        golden('kazoo_module_boxes', text(sc, st));
    });

    it('box offset moves the box; lock pins it; calls re-route', () => {
        const unit = boxUnit(buildScene(doc, boxed()).placement.frames.find((x) => x.box.label === 'noodles')!.box.key);
        const before = unitAnchor(buildScene(doc, boxed()), unit)!;
        const moved = fixtureDoc(KAZOO, { ...doc.view, offset: { [unit]: [6, 3] } });
        const sc = buildScene(moved, boxed());
        invariants(sc);
        const after = unitAnchor(sc, unit)!;
        expect(after[0] - before[0]).toBe(6);
        const locked = fixtureDoc(KAZOO, { ...doc.view, lock: { [unit]: [90, 2] } });
        const sl = buildScene(locked, boxed());
        invariants(sl);
        expect(unitAnchor(sl, unit)).toEqual([90, 2]);
        golden('kazoo_noodles_locked', text(sl, boxed()));
    });

    it('vertex offset carries its subtree; broken elbows re-route', () => {
        const key = k('kazoo.moomoo.boogaloos:scoobie_zoinks_jinkies');
        const base = buildScene(doc, boxed());
        const moved = fixtureDoc(KAZOO, { ...doc.view, offset: { [key]: [12, 1] } });
        const sc = buildScene(moved, boxed());
        invariants(sc);
        const d = (x: string, s: Scene) => s.placement.pos.get(k(x))!;
        expect(d('kazoo.moomoo.boogaloos:_burritos', sc).col - d('kazoo.moomoo.boogaloos:_burritos', base).col).toBe(12);
        // the broken elbow becomes a routed call (net `l:`), not a tree elbow (net `t:`)
        expect(sc.grid.paths.some((p) => p.to === key && p.net.startsWith('l:'))).toBe(true);
    });

    it('tight frames hug content moved right and down; other frames keep their corner', () => {
        const key = k('kazoo.moomoo.boogaloos:scoobie');
        const frameOf = (x: Scene) => x.placement.frames.find((f) => f.box.label === 'moomoo.boogaloos')!;
        const base = frameOf(buildScene(doc, boxed()));
        const moved = (tight: boolean) => fixtureDoc(KAZOO, { ...doc.view, offset: { [key]: [6, 2] }, tight });
        const loose = buildScene(moved(false), boxed());
        const tight = buildScene(moved(true), boxed());
        invariants(loose);
        invariants(tight);
        // the frame keeps its corner: 6 empty columns left of the content, 2 empty rows above it
        expect([frameOf(loose).c0, frameOf(loose).r0]).toEqual([base.c0, base.r0]);
        // tight: the frame moves with its content and keeps its size
        const t = frameOf(tight);
        expect([t.c0 - base.c0, t.r0 - base.r0, t.c1 - t.c0, t.r1 - t.r0]).toEqual([6, 2, base.c1 - base.c0, base.r1 - base.r0]);
        expect(parseDoc(serializeDoc(moved(true)), 'x').view.tight).toBe(true);
    });

    it('a moved box that lands on other content is drawn at the nearest clean spot', () => {
        const unit = boxUnit(buildScene(doc, boxed()).placement.frames.find((x) => x.box.label === 'noodles')!.box.key);
        const d = fixtureDoc(KAZOO, { ...doc.view, offset: { [unit]: [-40, 0] } });
        const foreign = (sc: Scene) => {
            const f = sc.placement.frames.find((x) => x.unit === unit)!;
            const mine = new Set(unitMembers(sc, unit));
            return sc.grid.labels.filter((l) => l.kind === 'node' && !mine.has(l.key) && l.row >= f.r0 && l.row <= f.r1 && l.col + l.text.length > f.c0 && l.col - 2 <= f.c1).length;
        };
        const sc = buildScene(d, boxed());
        invariants(sc);
        expect(foreign(sc)).toBe(0);
        expect(sc.offsets[unit]).not.toEqual([-40, 0]);
        // saved, the settled offsets draw the same picture and settle nothing further
        const saved = fixtureDoc(KAZOO, { ...doc.view, offset: sc.offsets });
        const again = buildScene(saved, boxed());
        expect(again.offsets).toBe(saved.view.offset);
        expect(text(again, boxed())).toBe(text(sc, boxed()));
        // nothing moved: nothing settled
        expect(buildScene(doc, boxed()).offsets).toBe(doc.view.offset);
    });

    it('hidden vertices leave a marker row on their callers, no count', () => {
        const hid = fixtureDoc(KAZOO, { ...doc.view, hidden: ['py:kazoo/noodles/jumbles.py'] });
        const sc = buildScene(hid, boxed());
        invariants(sc);
        expect(sc.hiddenOf.get(k('kazoo.moomoo.boogaloos:scoobie'))!.length).toBe(2);
        expect(sc.grid.labels.find((l) => l.key === k('kazoo.moomoo.boogaloos:scoobie'))!.text).toBe('scoobie()');
        expect(sc.grid.markers.some((m) => m.key === k('kazoo.moomoo.boogaloos:scoobie') && m.side === 'down')).toBe(true);
    });

    it('full: call depths per side, markers beyond them, shortest or longest path', () => {
        const seed = k('kazoo.moomoo.boogaloos:scoobie');
        const at = (d: number, rule: 'shortest' | 'longest' = 'shortest') =>
            buildScene(fixtureDoc(KAZOO, { seeds: [seed], direction: 'out', depthUp: 0, depthDown: d, depthRule: rule }), boxed());
        const one = at(1);
        invariants(one);
        expect(one.vg.nodes.has(k('kazoo.noodles.wibbles:mister_magoos'))).toBe(false);          // two calls away
        expect(one.grid.markers.some((m) => m.key === k('kazoo.moomoo.boogaloos:scoobie_do'))).toBe(true);
        expect(at(2).vg.nodes.has(k('kazoo.noodles.wibbles:mister_magoos'))).toBe(true);
        // _fritter: called by scoobie (level 1) and by hullabaloo_hoot (level 2): longest path puts it at 2
        expect(at(1).vg.nodes.has(k('kazoo.moomoo.boogaloos:_fritter'))).toBe(true);
        expect(at(1, 'longest').vg.nodes.has(k('kazoo.moomoo.boogaloos:_fritter'))).toBe(false);
        expect(at(2, 'longest').rev.level.get(k('kazoo.moomoo.boogaloos:_fritter'))).toBe(2);
    });

    it('grouping on demand: ungroup a package, group a module', () => {
        const rt = 'dir:kazoo/noodles';
        const un = buildScene(fixtureDoc(KAZOO, { ...doc.view, ungroup: [rt] }), boxed());
        invariants(un);
        expect(un.placement.frames.map((f) => f.box.label)).not.toContain('noodles');
        expect(un.grid.labels.find((l) => l.key === k('kazoo.noodles.wibbles:mister_magoos'))!.text).toBe('noodles.wibbles.mister_magoos()');
        const gr = buildScene(fixtureDoc(KAZOO, { ...doc.view, group: ['py:kazoo/noodles/wibbles.py'] }), boxed());
        invariants(gr);
        expect(gr.placement.frames.map((f) => f.box.label)).toContain('wibbles');
        expect(gr.grid.labels.find((l) => l.key === k('kazoo.noodles.wibbles:mister_magoos'))!.text).toBe('mister_magoos()');
    });

});

describe('one layer at a time: open sides, direction, markers, removal', () => {
    const seed = k('kazoo.moomoo.boogaloos:scoobie');
    const base = () => fixtureDoc(KAZOO, { seeds: [seed], direction: 'out', arrange: 'grow', open: {} });
    const name = (x: string) => x.split('#')[1];
    const marked = (sc: Scene) => new Set(sc.grid.markers.map((m) => `${name(m.key)}:${m.side}`));

    it('a new view shows the seed and one layer; marker rows only where more exists', () => {
        const sc = buildScene(base(), boxed());
        invariants(sc);
        const names = [...sc.vg.nodes.keys()].map(name).sort();
        expect(names).toEqual(['_cheese_puffs', '_donut_holes', '_fritter', '_pizza_roll', 'hullabaloo_hoot', 'scoobie', 'scoobie_do',
            'scoobie_zoinks_jinkies', 'to_magoo', 'to_wacky'].sort());
        expect(marked(sc).has('scoobie_do:down')).toBe(true);        // calls mister_magoos, abba_dabba_doo, _gummy_bears
        expect(marked(sc).has('_fritter:down')).toBe(false);         // calls nothing
        expect(sc.decor.get(k('kazoo.moomoo.boogaloos:_fritter'))!.pre).toBe('');   // revealed through calls: no callers side
        const t = text(sc, boxed({ edges: { mode: 'glyph' } }));
        expect(t).toMatch(/[└├]─>>/);
        expect(t).not.toMatch(/[▾▴◂▸]/);
        golden('grow_one_layer', t);
    });

    it('a vertex revealed through calls never opens its callers', () => {
        const d = base();
        d.view.open = { [k('kazoo.noodles.jumbles:to_wacky')]: 'both', [k('kazoo.moomoo.boogaloos:scoobie_do')]: 'down' };
        const sc = buildScene(d, boxed());
        invariants(sc);
        expect(sc.vg.nodes.has(k('kazoo.noodles.wibbles:mister_magoos'))).toBe(true);
        expect(sc.vg.nodes.has(k('kazoo.moomoo.boogaloos:_lasagna'))).toBe(false);   // a caller of to_wacky only
        expect(sc.rev.allowed.get(k('kazoo.noodles.jumbles:to_wacky'))).toBe('down');
    });

    it('a cut call or a hidden callee leaves a marker row under the caller', () => {
        const d = base();
        d.view.cut = [[seed, k('kazoo.noodles.jumbles:to_magoo')]];
        const s1 = buildScene(d, boxed());
        invariants(s1);
        expect(s1.vg.nodes.has(k('kazoo.noodles.jumbles:to_magoo'))).toBe(false);
        expect(marked(s1).has('scoobie:down')).toBe(true);
        const d2 = base();
        d2.view.hidden = [k('kazoo.moomoo.boogaloos:_fritter')];
        const s2 = buildScene(d2, boxed());
        invariants(s2);
        expect(marked(s2).has('scoobie:down')).toBe(true);
        const s0 = buildScene(base(), boxed());
        expect(marked(s0).has('scoobie:down')).toBe(false);
    });
});

describe('folder filters apply when drawing', () => {
    it('an excluded folder leaves the picture without markers; included again it is back, no new data', () => {
        const doc = fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out' });
        const rt = (sc: Scene) => [...sc.vg.nodes.keys()].filter((x) => x.includes('/noodles/')).length;
        const all = buildScene(doc, boxed());
        const out = buildScene(doc, boxed(), [globMatcher('**/noodles/**')]);
        invariants(out);
        expect(rt(all)).toBeGreaterThan(0);
        expect(rt(out)).toBe(0);
        expect(out.grid.markers.some((m) => m.key === k('kazoo.moomoo.boogaloos:scoobie'))).toBe(false);
        const back = structuredClone(doc);
        back.view.include = ['kazoo/noodles'];
        expect(rt(buildScene(back, boxed(), [globMatcher('**/noodles/**')]))).toBe(rt(all));
    });

    it('external code is off screen unless shown (gaffy.includeExternal)', () => {
        const doc = fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out' });
        for (const n of Object.values(doc.graph.nodes)) if (n.path?.includes('/noodles/')) n.external = true;
        const rt = (sc: Scene) => [...sc.vg.nodes.keys()].filter((x) => x.includes('/noodles/')).length;
        expect(rt(buildScene(doc, boxed(), [], true))).toBeGreaterThan(0);
        const off = buildScene(doc, boxed(), [], false);
        invariants(off);
        expect(rt(off)).toBe(0);
    });
});

describe('tree parent rule joint: shared functions take one path, from the left', () => {
    const S = 'kazoo.moomoo.boogaloos:scoobie';
    const MANY: [string, string][] = [
        ['kazoo.foo.dingus:_bingo', S], ['kazoo.foo.poke_wiggle:zippity_bingo', S], ['kazoo.goof.moonbeams:_pip_foo', S],
        ['kazoo.moomoo.b_zapper:woo_woo_woo', S], ['kazoo.moomoo.b_zapper:pip', S], ['kazoo.moomoo.boogaloos:boogie', S],
        ['kazoo.moomoo.boogaloos:alakazam', S], ['kazoo.moomoo.boogaloos:cowabunga_doo', S],
        [S, 'kazoo.moomoo.boogaloos:hullabaloo_hoot'], [S, 'kazoo.moomoo.boogaloos:_fritter'], ['kazoo.moomoo.boogaloos:hullabaloo_hoot', 'kazoo.moomoo.boogaloos:_fritter'],
        [S, 'kazoo.noodles.jumbles:to_wacky'], [S, 'kazoo.moomoo.boogaloos:_pizza_roll'], [S, 'kazoo.moomoo.boogaloos:scoobie_do'],
        ['kazoo.moomoo.boogaloos:_pizza_roll', 'kazoo.moomoo.boogaloos:scoobie_do'], ['kazoo.boop.fizzwizzle:scoobie_snackie', S],
    ];
    const joint = (o: unknown = {}) => boxed(deepMerge({ grid: { parentRule: 'joint' } } as never, o));

    it('a caller right above merges into the elbow; many callers join one collector entering from the left', () => {
        const sc = buildScene(fixtureDoc(MANY, { seeds: [k(S)], direction: 'both' }), joint());
        invariants(sc);
        const t = text(sc, joint({ edges: { mode: 'glyph' } }));
        expect(t).toMatch(/├───┴─> boogaloos\._fritter\(\)/);
        expect(t).toMatch(/└───┴─> boogaloos\.scoobie_do\(\)/);
        expect(t).toMatch(/┴─> boogaloos\.scoobie\(\)/);
        expect(t).not.toMatch(/scoobie\(\) </);                    // nothing arrives at the label end
        golden('joint_many', t);
    });

    it('the KAZOO example stays routed and conflict free', () => {
        const sc = buildScene(fixtureDoc(KAZOO, { seeds: [k(S)], direction: 'out' }), joint());
        invariants(sc);
        golden('joint_kazoo', text(sc, joint({ edges: { mode: 'glyph' } })));
    });
});

describe('example (*)', () => {
    const seeds = [k('foo.wobble:jiggly_boogaloos'), k('scripts/moo_trucks:moonwalk')];

    it('expanded (unchanged golden)', () => {
        const sc = buildScene(fixtureDoc(STAR, { seeds }), flat());
        invariants(sc);
        golden('star_expanded', text(sc, flat()));
    });

    it('moomoo.boogaloos collapsed: quotient', () => {
        const sc = buildScene(fixtureDoc(STAR, { seeds, collapsed: ['py:moomoo/boogaloos.py'] }), flat());
        invariants(sc);
        const h = sc.vg.nodes.get('py:moomoo/boogaloos.py')!;
        expect(h.collapsed).toBe(true);
        expect(h.members).toBe(6);
        expect(h.internal).toBe(5);
        expect(sc.vg.nodes.size).toBe(4);
        expect(sc.vg.edges.map((e) => `${e.from.split(/[#/]/).pop()}>${e.to.split(/[#/]/).pop()}`).sort())
            .toEqual(['boogaloos.py>Pogo.splotch', 'jiggly_boogaloos>boogaloos.py', 'moonwalk>boogaloos.py']);
        golden('star_collapsed', text(sc, flat()));
    });

    it('html export links labels', () => {
        const sc = buildScene(fixtureDoc(STAR, { seeds, collapsed: ['py:moomoo/boogaloos.py'] }), flat());
        const html = toHtmlPre(sc.grid, glyphSet(flat()), (key) => `../../${key.split('#')[0].slice(3)}`);
        expect(html).toContain('<a href="../../foo/wobble.py">foo.wobble.jiggly_boogaloos()</a>');
        expect(html).toContain('&lt;');
        // seeds bold, inside their link
        const bold = toHtmlPre(sc.grid, glyphSet(flat()), () => 'x', (key) => key === seeds[0]);
        expect(bold.match(/<b>/g)?.length).toBe(1);
        expect(bold).toMatch(/<a href="x"><b>[^<]+<\/b><\/a>/);
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
        const doc = fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out',
            offset: { [k('kazoo.noodles.wibbles:mister_magoos')]: [-30, -4] } });
        const sc = buildScene(doc, boxed());
        invariants(sc);
        const p = sc.placement.pos.get(k('kazoo.noodles.wibbles:mister_magoos'))!;
        const rt = sc.placement.frames.find((f) => f.box.label === 'noodles')!;
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
    // the regular expression globs compiled to before (exponential backtracking): the reference for matching
    const globRegex = (glob: string) => {
        let re = '';
        for (let i = 0; i < glob.length; i++) {
            const c = glob[i];
            if (c === '*') {
                if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; } else re += '[^/]*';
            } else if (c === '?') re += '[^/]';
            else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
        return new RegExp(`^${re}$`);
    };

    it('globMatcher matches as the regular expression does, in linear time', () => {
        const globs = ['**/tests/**', '**/test_*.py', 'src/*', 'src/**', '*.py', 'a?c/**', '**', '**/', 'x/**/y.py', '**/a/**/b', 'stdlib', '*/*/x', '**a**b'];
        const paths = ['', 'a', 'src', 'src/a.py', 'src/a/b.py', 'tests/x', 'k/tests/t.py', 'a/b/test_x.py', 'abc/d', 'x/y.py', 'x/m/n/y.py', 'q/a/r/b', 'stdlib', 'p/q/x', 'zab', 'a/b'];
        for (const g of globs) for (const p of paths) expect(globMatcher(g).test(p), `${g} ~ ${p}`).toBe(globRegex(g).test(p));
        const t0 = performance.now();
        expect(globMatcher('**a'.repeat(10) + 'b').test('a'.repeat(100))).toBe(false);
        expect(performance.now() - t0).toBeLessThan(100);
    });

    it('glob and view lists', () => {
        const tests = globMatcher('**/tests/**');
        expect(tests.test('kazoo/tests/test_a.py')).toBe(true);
        expect(tests.test('tests/test_a.py')).toBe(true);
        expect(tests.test('kazoo/src/a.py')).toBe(false);
        expect(globMatcher('**/test_*.py').test('a/b/test_x.py')).toBe(true);
        const doc = fixtureDoc([], { exclude: ['kazoo/scripts'], include: ['kazoo/tests'] });
        const ex = excludedBy(doc.view, [tests]);
        expect(ex('kazoo/scripts/run.py')).toBe(true);
        expect(ex('kazoo/tests/test_a.py')).toBe(false);
        expect(ex('other/tests/test_a.py')).toBe(true);
        expect(ex('kazoo/src/a.py')).toBe(false);
    });
});

describe('hostile data from language servers and view files', () => {
    it('labels show bidirectional, invisible and control characters as escapes', () => {
        // U+202E (right-to-left override) shows `fn_txt.exe` as `fn_exe.txt`; U+200B is zero-width
        const n: GNode = { key: 'py:a.py#fn', kind: 'function', name: 'fn', qual: 'fn_\u202etxt.exe\u200b', module: 'a', parent: null };
        expect(nodeLabel(n, { strip: [], parens: false })).toBe('a.fn_\\u{202e}txt.exe\\u{200b}');
        expect(visible(visible('x\u2066y\u0007'))).toBe('x\\u{2066}y\\u{7}');
        expect(visible('héllo wörld · └─>> 名前')).toBe('héllo wörld · └─>> 名前');
    });
    it('notification text forms no link', () => {
        expect(plain('gaffy: [Fix](command:workbench.action.terminal.sendSequence)')).toBe('gaffy: [Fix] (command:workbench.action.terminal.sendSequence)');
    });
    it('view files: node keys naming a prototype are dropped, edges must be a list', () => {
        const d = parseDoc('{"gaffy":1,"name":"v","view":{"seeds":[]},"graph":{"nodes":{"__proto__":{"polluted":1},"constructor":{"key":"constructor"},"py:a.py#f":{"key":"py:a.py#f"}},"edges":{"length":1}}}');
        expect(Object.getPrototypeOf(d.graph.nodes)).toBe(Object.prototype);
        expect(Object.keys(d.graph.nodes)).toEqual(['py:a.py#f']);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(d.graph.edges).toEqual([]);
    });
    it('html export: a quote in a link stays inside its attribute', () => {
        const sc = buildScene(fixtureDoc(STAR, { seeds: [k('foo.wobble:jiggly_boogaloos')] }), flat());
        const html = toHtmlPre(sc.grid, glyphSet(flat()), () => 'x" onclick="y');
        expect(html).toContain('href="x&quot; onclick=&quot;y"');
        expect(html).not.toContain('onclick="');
    });
});

describe('external code and the standard library', () => {
    // a workspace function calling a builtin class and function (typeshed `stdlib`), a torch function
    // (`site-packages`) and a workspace function in a folder that happens to be named `library`
    const node = (key: string, kind: GNode['kind'], external: boolean, parent: string | null = null): GNode =>
        ({ key, kind, name: key.split(/[#.]/).pop()!, qual: key.split('#')[1] ?? '', module: 'm', parent, path: key.slice(3).split('#')[0], external });
    const doc = () => {
        const d = parseDoc(JSON.stringify({ gaffy: 1, name: 'x', view: { seeds: ['py:a.py#f'], arrange: 'auto', depthUp: 0, depthDown: 1 } }), 'x');
        d.graph.nodes = Object.fromEntries([
            node('py:a.py#f', 'function', false),
            node('py:stdlib/builtins.pyi#int', 'class', true),
            node('py:stdlib/builtins.pyi#len', 'function', true),
            node('py:site-packages/torch/functional.py#norm', 'function', true),
            node('py:library/x.py#g', 'function', false),
        ].map((n) => [n.key, n]));
        d.graph.edges = ['py:stdlib/builtins.pyi#int', 'py:stdlib/builtins.pyi#len', 'py:site-packages/torch/functional.py#norm', 'py:library/x.py#g']
            .map((to, i) => ({ from: 'py:a.py#f', to, line: i }));
        return d;
    };
    // drawn vertices (classes included, which `visibleOf` leaves to their members)
    const shown = (d: ViewDoc, o: Parameters<typeof buildScene>[3]) => [...buildScene(d, flat(), [], o).vg.nodes.keys()]
        .filter((k) => k.includes('#')).map((k) => k.split('#')[1]).sort();
    it('the standard library stays off screen unless asked for; installed packages and workspace code show', () => {
        expect(shown(doc(), { external: true, standard: false })).toEqual(['f', 'g', 'norm']);
        expect(shown(doc(), { external: true, standard: true })).toEqual(['f', 'g', 'int', 'len', 'norm']);
        expect(shown(doc(), { external: false, standard: true })).toEqual(['f', 'g']);
        expect(shown(doc(), true)).toEqual(['f', 'g', 'int', 'len', 'norm']);
    });
    it('a folder filter hides classes too (a constructor call draws the class)', () => {
        const d = doc();
        d.view.exclude = ['stdlib'];
        expect(shown(d, true)).toEqual(['f', 'g', 'norm']);
    });
});

describe('classes', () => {
    it('a constructed class is asked for its calls (construction runs __init__)', () => {
        const d = parseDoc(JSON.stringify({ gaffy: 1, name: 'x', view: { seeds: ['py:foo.py#magoo'], arrange: 'auto', depthUp: 0, depthDown: 2 } }), 'x');
        const n = (key: string, kind: GNode['kind'], parent: string | null): GNode => ({ key, kind, name: key.split(/[#.]/).pop()!, qual: key.split('#')[1] ?? '', module: 'foo', parent, path: 'foo.py' });
        d.graph.nodes = Object.fromEntries([
            n('py:foo.py', 'module', null), n('py:foo.py#magoo', 'function', 'py:foo.py'),
            n('py:foo.py#Scoobie', 'class', 'py:foo.py'), n('py:foo.py#Scoobie.__init__', 'method', 'py:foo.py#Scoobie'),
        ].map((x) => [x.key, x]));
        d.graph.edges = [{ from: 'py:foo.py#magoo', to: 'py:foo.py#Scoobie', line: 3 },
            { from: 'py:foo.py#Scoobie', to: 'py:foo.py#Scoobie.__init__', implicit: 'construction' }];
        expect(frontierOf(d).filter((q) => q.dir === 'out').map((q) => q.key.split('#')[1]).sort()).toEqual(['Scoobie', 'Scoobie.__init__', 'magoo']);
        const sc = buildScene(d, flat());
        invariants(sc);
        expect(sc.grid.paths.some((p) => p.from === 'py:foo.py#Scoobie' && p.to === 'py:foo.py#Scoobie.__init__')).toBe(true);
    });
});

describe('collapse around a seed', () => {
    it('collapsing the class, module or folder of a seed keeps the collapsed container on screen as the seed', () => {
        const N = (key: string, kind: GNode['kind'], parent: string | null): GNode => ({ key, kind, name: key.split(/[#./]/).pop()!, qual: key.split('#')[1] ?? '', module: 'foo', parent, path: 'foo/goo.py' });
        const d = parseDoc(JSON.stringify({ gaffy: 1, name: 'c', view: { seeds: ['py:foo/goo.py#Shoo.__init__'], arrange: 'grow', direction: 'in' } }), 'c');
        d.graph.nodes = Object.fromEntries([N('dir:foo', 'folder', null), N('py:foo/goo.py', 'module', 'dir:foo'), N('py:foo/goo.py#Shoo', 'class', 'py:foo/goo.py'),
            N('py:foo/goo.py#Shoo.__init__', 'method', 'py:foo/goo.py#Shoo'), N('py:moo.py', 'module', null), N('py:moo.py#magoo', 'function', 'py:moo.py')].map((x) => [x.key, x]));
        d.graph.edges = [{ from: 'py:moo.py#magoo', to: 'py:foo/goo.py#Shoo.__init__', line: 1 }];
        for (const c of ['py:foo/goo.py#Shoo', 'py:foo/goo.py', 'dir:foo']) {
            d.view.collapsed = [c];
            const sc = buildScene(d, flat());
            invariants(sc);
            expect(sc.vg.nodes.has(c), c).toBe(true);
            expect(sc.seeds.has(c), c).toBe(true);
            expect(sc.vg.nodes.has('py:moo.py#magoo'), `${c}: the caller of the seed is shown`).toBe(true);
        }
        d.view.collapsed = [];
        expect(buildScene(d, flat()).vg.nodes.has('py:foo/goo.py#Shoo.__init__')).toBe(true);
    });

    it('a collapsed container moves as collapsed:<key>; expanding returns to the layout before the collapse', () => {
        const N = (key: string, kind: GNode['kind'], parent: string | null): GNode => ({ key, kind, name: key.split(/[#./]/).pop()!, qual: key.split('#')[1] ?? '', module: 'foo', parent, path: 'foo/goo.py' });
        const d = parseDoc(JSON.stringify({ gaffy: 1, name: 'c', view: { seeds: ['py:moo.py#magoo'], arrange: 'grow', direction: 'out' } }), 'c');
        d.graph.nodes = Object.fromEntries([N('py:foo/goo.py', 'module', null), N('py:foo/goo.py#Shoo', 'class', 'py:foo/goo.py'),
            N('py:foo/goo.py#Shoo.__init__', 'method', 'py:foo/goo.py#Shoo'), N('py:foo/goo.py#Shoo.do', 'method', 'py:foo/goo.py#Shoo'),
            N('py:moo.py', 'module', null), N('py:moo.py#magoo', 'function', 'py:moo.py')].map((x) => [x.key, x]));
        d.graph.edges = [{ from: 'py:moo.py#magoo', to: 'py:foo/goo.py#Shoo.__init__', line: 1 }, { from: 'py:moo.py#magoo', to: 'py:foo/goo.py#Shoo.do', line: 2 }];
        for (const style of [flat(), deepMerge(DEFAULT_STYLE, { grid: { parentRule: 'dfs' } })]) {
            for (const c of ['py:foo/goo.py#Shoo', 'py:foo/goo.py']) {
                d.view.collapsed = []; d.view.offset = {}; d.view.lock = {};
                const before = buildScene(d, style).placement.pos;
                d.view.collapsed = [c];
                const still = buildScene(d, style).placement.pos.get(c)!;
                d.view.offset = { [collapsedUnit(c)]: [6, 3] };
                const sc = buildScene(d, style);
                invariants(sc);
                expect(unitMembers(sc, collapsedUnit(c))).toEqual([c]);
                expect(unitAnchor(sc, collapsedUnit(c)), `${c}: placed as collapsed:<key> while collapsed`).toBeDefined();
                expect(unitAnchor(sc, c), `${c}: not placed under its plain key while collapsed`).toBeUndefined();
                expect(sc.placement.pos.get(c), `${c}: the move applies while collapsed`).not.toEqual(still);
                d.view.collapsed = [];
                const open = buildScene(d, style);
                if (open.vg.nodes.has(c)) expect(unitAnchor(open, c)).toBeDefined();
                expect(unitAnchor(open, collapsedUnit(c)), `${c}: collapsed:<key> is not placed while expanded`).toBeUndefined();
                const after = open.placement.pos;
                expect([...after].map(([k0, p]) => [k0, p.row, p.col]), `${c}: expanded as before`).toEqual([...before].map(([k0, p]) => [k0, p.row, p.col]));
            }
        }
    });
});

describe('hidden functions leave markers', () => {
    // magoo → shoo → scoobie, and boo → scoobie; seed magoo
    const n = (q: string): GNode => ({ key: `py:foo.py#${q}`, kind: 'function', name: q, qual: q, module: 'foo', parent: 'py:foo.py', path: 'foo.py' });
    const doc = (view: object) => {
        const d = parseDoc(JSON.stringify({ gaffy: 1, name: 'h', view: { seeds: ['py:foo.py#magoo'], ...view } }), 'h');
        d.graph.nodes = Object.fromEntries([{ key: 'py:foo.py', kind: 'module', name: 'foo', qual: '', module: 'foo', parent: null, path: 'foo.py' } as GNode,
            ...['magoo', 'shoo', 'scoobie', 'boo'].map(n)].map((x) => [x.key, x]));
        d.graph.edges = [['magoo', 'shoo'], ['shoo', 'scoobie'], ['boo', 'scoobie'], ['magoo', 'boo']].map(([a, b], i) => ({ from: `py:foo.py#${a}`, to: `py:foo.py#${b}`, line: i }));
        return d;
    };
    const K = (q: string) => `py:foo.py#${q}`;
    it('full layout: the function that showed a hidden group gets its marker, and knows the way back', () => {
        const sc = buildScene(doc({ arrange: 'auto', direction: 'out', depthUp: 0, depthDown: 'all', hidden: [K('shoo'), K('scoobie')] }), flat());
        invariants(sc);
        expect(sc.hiddenOn(K('magoo'), 'down')).toEqual([K('shoo')]);
        expect(sc.drawn.nodes.has(`\u22efmore:${K('magoo')}`)).toBe(true);
        expect(sc.hiddenPath(K('scoobie'))).toEqual([K('shoo')]);
    });
    it('one layer at a time: hidden callers of a callee show `>> `, though the callee opens only its calls', () => {
        const d = doc({ arrange: 'grow', direction: 'out', open: { [K('magoo')]: 'down', [K('shoo')]: 'down' }, hidden: [K('boo')] });
        const sc = buildScene(d, flat());
        invariants(sc);
        expect(sc.rev.allowed.get(K('scoobie'))).toBe('down');
        expect(sc.hiddenOn(K('scoobie'), 'up')).toEqual([K('boo')]);
        expect(sc.decor.get(K('scoobie'))!.pre).toBe('>> ');
    });
});

describe('style merge', () => {
    it('keys naming a prototype are ignored', () => {
        const evil = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": {"x": 1}, "grid": {"indent": 6}}');
        const st = deepMerge(DEFAULT_STYLE, evil) as unknown as Record<string, unknown>;
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(st.polluted).toBeUndefined();
        expect((st.grid as { indent: number }).indent).toBe(6);
    });
});

describe('view documents', () => {
    it('a static view keeps its flag through save and load; an ordinary view has none', () => {
        const d = parseDoc(JSON.stringify({ gaffy: 1, name: 's', view: { seeds: [], static: true } }), 's');
        expect(parseDoc(serializeDoc(d), 's').view.static).toBe(true);
        expect(parseDoc(JSON.stringify({ gaffy: 1, name: 'o', view: { seeds: [], static: 'yes' } }), 'o').view.static).toBeUndefined();
    });
    it('a full view from before per-side call depths takes them from its direction and depth; removed options drop', () => {
        const old = parseDoc(JSON.stringify({ gaffy: 1, name: 'v', view: { seeds: ['k'], direction: 'in', depth: 3, arrange: 'auto', order: 'callees', fold: { k: 'down' }, expanded: { k: 'in' } }, graph: { nodes: {}, edges: [] } }));
        expect([old.view.depthUp, old.view.depthDown, old.view.depthRule]).toEqual([3, 0, 'shortest']);
        const text = serializeDoc(old);
        expect(text).not.toMatch(/"order"|"fold"|"expanded"/);
        const both = parseDoc(JSON.stringify({ gaffy: 1, name: 'v', view: { seeds: [], direction: 'both', depth: 2, depthUp: 'all' }, graph: { nodes: {}, edges: [] } }));
        expect([both.view.depthUp, both.view.depthDown]).toEqual(['all', 2]);
    });
    it('removed calls keep only [caller, callee] pairs', () => {
        const d = parseDoc(JSON.stringify({ gaffy: 1, name: 'v', view: { seeds: [], cut: [['a', 'b'], ['bad'], 'x'] }, graph: { nodes: {}, edges: [] } }));
        expect(d.view.cut).toEqual([['a', 'b']]);
    });
});

describe('moves leave the rest in place', () => {
    it('moving the first box (the one every other box is placed from) moves only that box', () => {
        const seed = k('kazoo.moomoo.boogaloos:scoobie');
        const base = fixtureDoc(KAZOO, { seeds: [seed], direction: 'out' });
        const s0 = buildScene(base, boxed());
        const moved = structuredClone(base);
        moved.view.offset[boxUnit('dir:kazoo/moomoo')] = [6, 3];   // the box labelled moomoo.boogaloos
        const s1 = buildScene(moved, boxed());
        invariants(s1);
        const at = (sc: Scene, x: string) => sc.placement.pos.get(k(x))!;
        // the moved box's function shifts by the move
        expect(at(s1, 'kazoo.moomoo.boogaloos:scoobie').col - at(s0, 'kazoo.moomoo.boogaloos:scoobie').col).toBe(6);
        expect(at(s1, 'kazoo.moomoo.boogaloos:scoobie').row - at(s0, 'kazoo.moomoo.boogaloos:scoobie').row).toBe(3);
        // a box it calls stays where it was
        expect(at(s1, 'kazoo.noodles.wibbles:mister_magoos')).toEqual(at(s0, 'kazoo.noodles.wibbles:mister_magoos'));
    });
});

describe('moved boxes move whole', () => {
    // aloo calls zoinks and wibble: two callee boxes stacked right of it, zoinks above wibble
    const E: [string, string][] = [['aloo.patata:scoobie', 'zoinks.jinkies:shoo'], ['aloo.patata:scoobie', 'wibble.wobble:magoo'], ['zoinks.jinkies:shoo', 'zoinks.jinkies:doo']];
    const unit = boxUnit('dir:zoinks');
    const view = (offset: Record<string, [number, number]>) => fixtureDoc(E, { seeds: [k('aloo.patata:scoobie')], direction: 'out', offset });
    // position relative to the caller, which does not move
    const rel = (sc: Scene, x: string) => {
        const p = sc.placement.pos.get(k(x))!, o = sc.placement.pos.get(k('aloo.patata:scoobie'))!;
        return [p.col - o.col, p.row - o.row];
    };

    it('a box moved above its caller row moves by the offset; the box stacked below it stays', () => {
        const s0 = buildScene(view({}), boxed());
        const s1 = buildScene(view({ [unit]: [0, -3] }), boxed());
        invariants(s1);
        for (const x of ['zoinks.jinkies:shoo', 'zoinks.jinkies:doo']) expect(rel(s1, x)).toEqual([rel(s0, x)[0], rel(s0, x)[1] - 3]);
        expect(rel(s1, 'wibble.wobble:magoo')).toEqual(rel(s0, 'wibble.wobble:magoo'));
    });

    it('a moved box touching another frame settles one cell away: a corridor for calls', () => {
        const s0 = buildScene(view({}), boxed());
        const f = (sc: Scene, u: string) => sc.placement.frames.find((x) => x.unit === u)!;
        const a = f(s0, boxUnit('dir:aloo')), z = f(s0, unit);
        // zoinks under aloo, its top row on the row below aloo's bottom border
        const off: [number, number] = [1 - z.c0, a.r1 + 1 - z.r0];
        const sc = buildScene(view({ [unit]: off }), boxed());
        invariants(sc);
        expect(sc.offsets[unit]).toEqual([off[0], off[1] + 1]);
        expect(f(sc, unit).r0 - f(sc, boxUnit('dir:aloo')).r1).toBe(2);
    });
});

describe('what the language server is asked', () => {
    it('seeds both directions; a function shown as a call only its calls; as a caller only its callers', () => {
        const seed = k('kazoo.noodles.jumbles:to_wacky');
        const d = fixtureDoc(KAZOO, { seeds: [seed], direction: 'both', arrange: 'grow', open: {} });
        const pairs = new Set(frontierOf(d).map((p) => `${p.dir}:${p.key.split('#')[1]}`));
        expect(pairs.has('in:to_wacky') && pairs.has('out:to_wacky')).toBe(true);
        expect(pairs.has('in:scoobie')).toBe(true);           // shown as a caller
        expect(pairs.has('out:scoobie')).toBe(false);
    });
});

describe('moves stay local', () => {
    // test/data/runaway.gaffy: a view reduced from one where dragging a box made the picture thousands of rows tall
    // (names made up). An unmoved box descending below a moved sibling made no progress while a box inside it was
    // moved up, and every retry re-added the moves inside it, so the caller rows of later blocks drifted.
    it('an unmoved box descends below a moved sibling without drift', () => {
        const doc = parseDoc(readFileSync(join(__dirname, 'data', 'runaway.gaffy'), 'utf8'), 'runaway');
        const unmoved = structuredClone(doc);
        unmoved.view.offset = {};
        const sc = buildScene(doc, DEFAULT_STYLE, [], true);
        invariants(sc);
        expect(sc.placement.height).toBeLessThan(buildScene(unmoved, DEFAULT_STYLE, [], true).placement.height + 60);
    });
});

describe('grouping changes drop the moves inside', () => {
    // offsets count from the computed place inside their box: with the box dissolved they would land elsewhere
    it('ungroup: moves and locks inside the container go, moves outside stay', () => {
        const doc = fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out' });
        const box = 'dir:kazoo/noodles';
        const inner = k('kazoo.noodles.wibbles:mister_magoos'), outer = k('kazoo.moomoo.boogaloos:scoobie');
        doc.view.offset = { [boxUnit(box)]: [5, 9], [inner]: [3, -4], [outer]: [2, 0], [collapsedUnit('py:kazoo/noodles/wibbles.py')]: [1, 1] };
        doc.view.lock = { [inner]: [40, 3] };
        doc.view.ungroup = [box];
        dropMovesWithin(doc, box);
        expect(doc.view.offset).toEqual({ [outer]: [2, 0] });
        expect(doc.view.lock).toEqual({});
        invariants(buildScene(doc, boxed()));
    });
});

describe('call kinds on the grid', () => {
    // implicit calls dotted, calls across languages dash and dot: in the text export as in the vector styles
    it('cells only implicit or only bridged calls pass take the kind glyphs; the picture is otherwise the same', () => {
        const doc = fixtureDoc(STAR, { seeds: [k('foo.wobble:jiggly_boogaloos'), k('scripts/moo_trucks:moonwalk')], direction: 'out' });
        const plain = toText(buildScene(doc, flat()).grid, glyphSet(flat()));
        const marked = structuredClone(doc);
        marked.graph.edges = marked.graph.edges.map((e, i) => (i === 0 ? { ...e, implicit: 'construction' as const } : i === 1 ? { ...e, via: 'pybind11: m.def' } : e));
        const sc = buildScene(marked, flat());
        invariants(sc);
        const text = toText(sc.grid, glyphSet(flat()));
        expect(new Set(sc.grid.kinds.values())).toEqual(new Set(['implicit', 'bridge']));
        expect(/[┈┊]/.test(text) && text.includes('·')).toBe(true);
        // the same cells, plain glyphs in place of the kind glyphs
        expect(text.replace(/┈/g, '─').replace(/┊/g, '│').split('\n').map((l, r) => [...l].map((ch, c) => (ch === '·' ? plain.split('\n')[r][c] : ch)).join('')).join('\n')).toBe(plain);
        // a kind cell carries calls of that kind only
        const kindOf = (p: { from: string; to: string }) => marked.graph.edges.find((e) => e.from === p.from && e.to === p.to);
        for (const [id] of sc.grid.kinds) for (const p of sc.grid.paths.filter((q) => q.cells.includes(id))) expect(kindOf(p)?.implicit || kindOf(p)?.via).toBeTruthy();
    });
});

describe('view files are data', () => {
    // a view may come from a cloned repository: field types, special keys and sizes are checked when parsing
    it('parseDoc keeps known values, drops special keys and wrong types, bounds moves and locks', () => {
        const text = JSON.stringify({
            gaffy: 1, name: 'v', view: {
                seeds: ['py:a.py#f', 3], offset: { 'py:a.py#f': [5e6, -2.6], constructor: [1, 1], bad: [1, 'x'] }, lock: { 'py:a.py#g': [20000, -5] },
                open: { 'py:a.py#f': 'up', 'py:a.py#g': 'sideways', __proto__: 'up' }, tags: { 'py:a.py#f': 7 }, edges: 'wobbly', depthUp: 1e9,
            },
            explored: { 'py:a.py#f': 'in', x: 'everywhere' }, graph: { nodes: { 'py:a.py#f': { key: 'py:a.py#f' }, y: 5 }, edges: [{ from: 'a', to: 'b' }, { from: 1 }] },
        });
        const d = parseDoc(text);
        expect(d.view.seeds).toEqual(['py:a.py#f']);
        expect(d.view.offset).toEqual({ 'py:a.py#f': [1000, -3] });
        expect(Object.hasOwn(d.view.offset, 'constructor')).toBe(false);
        expect(d.view.lock).toEqual({ 'py:a.py#g': [2000, 0] });
        expect(d.view.open).toEqual({ 'py:a.py#f': 'up' });
        expect(d.view.tags).toEqual({});
        expect(d.view.edges).toBeUndefined();
        expect(d.view.depthUp).toBe(1000);
        expect(d.explored).toEqual({ 'py:a.py#f': 'in' });
        expect(Object.keys(d.graph.nodes)).toEqual(['py:a.py#f']);
        expect(d.graph.edges).toEqual([{ from: 'a', to: 'b' }]);
    });

    it('save, live, external, stdlib, commit: kept when well formed', () => {
        const d = parseDoc(JSON.stringify({ gaffy: 1, commit: 'abc1234', view: { save: true, live: '0123abcd4567ef89', external: true, stdlib: false } }));
        expect([d.view.save, d.view.live, d.view.external, d.view.stdlib, d.commit]).toEqual([true, '0123abcd4567ef89', true, false, 'abc1234']);
        const e = parseDoc(JSON.stringify({ gaffy: 1, commit: '$(rm -rf /)', view: { save: 'yes', live: '../x', external: 'on', frozen: { at: '2026' } } }));
        expect([e.view.save, e.view.live, e.view.external, e.commit]).toEqual([undefined, undefined, undefined, undefined]);
        expect('frozen' in e.view).toBe(false);
    });

    it('a lock at the bound lays out without routing a huge grid', () => {
        const doc = fixtureDoc(MOO, { seeds: [k('moomoo.yo_blinkers:flibbity_jibbity_jabby')], direction: 'in' });
        doc.view.lock = { [k('moomoo.yo_blinkers:flibbity_jibbity_jabby')]: [2000, 2000] };
        const t0 = performance.now();
        const sc = buildScene(doc, flat());
        expect(performance.now() - t0).toBeLessThan(3000);
        expect(sc.placement.height).toBeGreaterThan(2000);
    });
});

describe('only paths between seeds', () => {
    // a → b → c with seeds a and c; d (called by a) and e (calling c) lie on no seed-to-seed path
    const edges: [string, string][] = [['m:a', 'm:b'], ['m:b', 'm:c'], ['m:a', 'm:d'], ['m:e', 'm:c']];
    const doc = (between: boolean) => fixtureDoc(edges, { seeds: [k('m:a'), k('m:c')], direction: 'both', arrange: 'auto', depthUp: 'all', depthDown: 'all', ...(between ? { between } : {}) });
    const names = (sc: Scene) => [...sc.vg.nodes.keys()].filter((x) => !x.startsWith('⋯')).map((x) => x.split('#').pop()).sort();

    it('between draws the seeds and the functions on call paths from one to another', () => {
        expect(names(buildScene(doc(false), flat()))).toEqual(['a', 'b', 'c', 'd', 'e']);
        const sc = buildScene(doc(true), flat());
        invariants(sc);
        expect(names(sc)).toEqual(['a', 'b', 'c']);
    });

    it('parseDoc keeps between: true only', () => {
        expect(parseDoc(JSON.stringify({ gaffy: 1, view: { between: true } })).view.between).toBe(true);
        expect(parseDoc(JSON.stringify({ gaffy: 1, view: { between: 1 } })).view.between).toBeUndefined();
    });

    // a → b → f → g → c: a path of four calls; one layer at a time opens nothing
    const long: [string, string][] = [['m:a', 'm:b'], ['m:b', 'm:f'], ['m:f', 'm:g'], ['m:g', 'm:c'], ['m:a', 'm:d'], ['m:e', 'm:c']];
    const grow = (v: Partial<ViewSpec>) => fixtureDoc(long, { seeds: [k('m:a'), k('m:c')], direction: 'both', arrange: 'grow', open: {}, ...v });

    it('one layer at a time: between draws paths of any length, with markers on the paths', () => {
        const sc = buildScene(grow({ between: true }), flat());
        invariants(sc);
        expect(names(sc)).toEqual(['a', 'b', 'c', 'f', 'g']);
        expect(sc.hasMore(k('m:a'), 'down')).toBe(true);          // d: off the paths
        expect([...sc.paths].map((x) => x.split('#').pop()).sort()).toEqual(['b', 'f', 'g']);
    });

    it('pinPaths: the paths of the graph pinned, seeds closed, between off (giddy views after the first build)', () => {
        const d = grow({ between: true, pinPaths: true });
        pinPaths(d);
        expect([d.view.between, d.view.pinPaths]).toEqual([undefined, undefined]);
        expect(d.view.pinned!.map((x) => x.split('#').pop()).sort()).toEqual(['b', 'f', 'g']);
        expect(d.view.open).toEqual({ [k('m:a')]: 'none', [k('m:c')]: 'none' });
        expect(names(buildScene(d, flat()))).toEqual(['a', 'b', 'c', 'f', 'g']);
        expect(parseDoc(serializeDoc(grow({ pinPaths: true }))).view.pinPaths).toBe(true);
    });

    it('isBuilt: language-server answers, not the seed records of a new view', () => {
        const d = grow({});
        expect(isBuilt({ ...d, explored: {}, updated: undefined })).toBe(false);
        expect(isBuilt({ ...d, explored: { [k('m:a')]: 'out' } })).toBe(true);
        expect(isBuilt({ ...d, explored: {}, updated: '2026-11-24T00:00:00Z' })).toBe(true);
    });

    it('one layer at a time, between off: pinned paths stay, closed seeds open nothing', () => {
        const pinned = [k('m:b'), k('m:f'), k('m:g')];
        const sc = buildScene(grow({ pinned, open: { [k('m:a')]: 'none', [k('m:c')]: 'none' } }), flat());
        invariants(sc);
        expect(names(sc)).toEqual(['a', 'b', 'c', 'f', 'g']);
        expect(parseDoc(serializeDoc(grow({ pinned }))).view.pinned).toEqual(pinned);
        // the seeds' traversal side, without pins: one layer around each seed
        expect(names(buildScene(grow({}), flat()))).toEqual(['a', 'b', 'c', 'd', 'e', 'g']);
    });
});

describe('layout decisions (explain.ts)', () => {
    const doc = () => fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out' });
    const run = (d: ViewDoc, off: string[] = []) => {
        const log: Decision[] = [];
        return { sc: buildScene(d, boxed(), [], true, { rules: { off }, log: (x) => log.push(x) }), log };
    };

    it('logs the decisions of the drawn placement once, settle moves after', () => {
        const { sc, log } = run(doc());
        expect(text(sc, boxed())).toBe(text(buildScene(doc(), boxed()), boxed()));     // logging changes nothing
        const rules = new Set(log.map((x) => x.rule));
        for (const r of ['h16_item_order', 'h17_item_column', 'h18_item_row']) expect(rules.has(r)).toBe(true);
        // one h17 per item: no decisions of discarded trial placements
        const cols = log.filter((x) => x.rule === 'h17_item_column').map((x) => x.unit);
        expect(new Set(cols).size).toBe(cols.length);
        const unit = boxUnit(sc.placement.frames.find((f) => f.box.label === 'noodles')!.box.key);
        const moved = run(fixtureDoc(KAZOO, { ...doc().view, offset: { [unit]: [-40, 0] } })).log;
        const settle = moved.filter((x) => x.rule === 'h23_settle');
        expect(settle.length).toBeGreaterThan(0);
        expect(moved.indexOf(settle[0])).toBeGreaterThan(moved.findIndex((x) => x.rule === 'h19_lock_and_box_offset'));
    });

    it('a switched-off rule changes the placement; settle off keeps the offset', () => {
        const unit = boxUnit(buildScene(doc(), boxed()).placement.frames.find((f) => f.box.label === 'noodles')!.box.key);
        const d = fixtureDoc(KAZOO, { ...doc().view, offset: { [unit]: [-40, 0] } });
        expect(run(d).sc.offsets[unit]).not.toEqual([-40, 0]);
        expect(run(d, ['h23_settle']).sc.offsets[unit]).toEqual([-40, 0]);
        expect(text(run(doc(), ['h18_item_row']).sc, boxed())).not.toBe(text(run(doc()).sc, boxed()));
    });
});
