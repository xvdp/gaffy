import { describe, expect, it } from 'vitest';
import { Decision } from '../src/core/explain';
import { pathPairs, unconnected } from '../src/core/paths';
import { buildScene } from '../src/core/scene';
import { extendGraph } from '../src/host/build';
import type { LspProvider } from '../src/host/lsp';
import { DEFAULT_STYLE } from '../src/core/style';
import { ViewDoc, ViewSpec } from '../src/core/viewdoc';
import { fixtureDoc, k } from './fixtures';
import { invariants } from './invariants';

// shoo => magoo => patata => doo; magoo => zoinks, patata => jinkies (siblings off the path); doo => snack (beyond doo)
const PATH: [string, string][] = [
    ['foo.ghoul:shoo', 'foo.ghoul:magoo'],
    ['foo.ghoul:magoo', 'aloo.patata:patata'],
    ['aloo.patata:patata', 'scoobie:doo'],
    ['foo.ghoul:magoo', 'foo.ghoul:zoinks'],
    ['aloo.patata:patata', 'aloo.patata:jinkies'],
    ['scoobie:doo', 'scoobie:snack'],
];
const names = (keys: Iterable<string>) => [...keys].map((x) => x.slice(x.indexOf('#') + 1).split(':').pop()).sort();

describe('a seed added to a view (view.joins)', () => {
    const style = { ...DEFAULT_STYLE, boxes: { ...DEFAULT_STYLE.boxes, enabled: false } };
    const shoo = k('foo.ghoul:shoo'), doo = k('scoobie:doo');

    it('one layer at a time: the joined seed is closed and shows the call path to the other seed, no siblings', () => {
        const doc = fixtureDoc(PATH, { arrange: 'grow', seeds: [shoo, doo], joins: [doo], open: { [shoo]: 'none' } });
        const sc = buildScene(doc, style);
        expect(names(sc.vg.nodes.keys())).toEqual(['doo', 'magoo', 'patata', 'shoo']);
        // markers: siblings and the called beyond the joined seed stay behind `└─>>`
        expect(sc.hasMore(k('foo.ghoul:magoo'), 'down')).toBe(true);
        expect(sc.hasMore(doo, 'down')).toBe(true);
    });

    it('opening a side of the joined seed opens it as any seed', () => {
        const doc = fixtureDoc(PATH, { arrange: 'grow', seeds: [shoo, doo], joins: [doo], open: { [shoo]: 'none', [doo]: 'down' } });
        expect(names(buildScene(doc, style).vg.nodes.keys())).toContain('snack');
    });

    it('full layout: the joined seed stays out of the depth search and brings its paths', () => {
        const doc = fixtureDoc(PATH, { arrange: 'auto', seeds: [shoo, doo], joins: [doo], depthUp: 0, depthDown: 1 });
        expect(names(buildScene(doc, style).vg.nodes.keys())).toEqual(['doo', 'magoo', 'patata', 'shoo']);
    });

    it('a seed without a path to the others shows alone', () => {
        const lone = k('aloo.patata:jinkies');
        const doc = fixtureDoc(PATH, { arrange: 'grow', seeds: [doo, lone], joins: [lone], open: { [doo]: 'none' } });
        expect(names(buildScene(doc, style).vg.nodes.keys())).toEqual(['doo', 'jinkies']);
    });
});

describe('Delete: removed functions, groups and calls leave the view with their islands, and come back through markers', () => {
    const style = { ...DEFAULT_STYLE, boxes: { ...DEFAULT_STYLE.boxes, enabled: true } };
    // shoo => magoo => patata => doo (seeds shoo and doo); shoo => zoinks; magoo => jinkies (a branch below magoo)
    const E: [string, string][] = [
        ['foo.ghoul:shoo', 'foo.ghoul:magoo'], ['foo.ghoul:magoo', 'aloo.patata:patata'], ['aloo.patata:patata', 'scoobie:doo'],
        ['foo.ghoul:shoo', 'foo.ghoul:zoinks'], ['foo.ghoul:magoo', 'foo.ghoul:jinkies'],
    ];
    const shoo = k('foo.ghoul:shoo'), magoo = k('foo.ghoul:magoo'), patata = k('aloo.patata:patata'), doo = k('scoobie:doo');
    const grow = (extra: Partial<ViewSpec> = {}) => fixtureDoc(E, { arrange: 'grow', seeds: [shoo], open: { [shoo]: 'down', [magoo]: 'down' }, ...extra });
    /** As the webview's marker click (restoreHidden): the hidden neighbors of one side, with the hidden ones on their way from the seeds. */
    const restore = (doc: ViewDoc, at: string, side: 'up' | 'down') => {
        const sc = buildScene(doc, style);
        const back = sc.hiddenOn(at, side);
        const show = new Set([...back, ...back.flatMap((b) => sc.hiddenPath(b))]);
        doc.view.hidden = doc.view.hidden.filter((h) => !show.has(h));
        doc.view.cut = (doc.view.cut ?? []).filter(([a, b]) => !(side === 'down' ? a === at && show.has(b) : b === at && show.has(a)));
        return doc;
    };

    it('a removed function takes the functions only it revealed; its caller keeps a marker that brings both back', () => {
        const d = grow({ hidden: [magoo] });
        const sc = buildScene(d, style);
        expect(names(sc.vg.nodes.keys())).toEqual(['shoo', 'zoinks']);
        expect(sc.hiddenOn(shoo, 'down')).toEqual([magoo]);
        invariants(sc);
        expect(names(buildScene(restore(d, shoo, 'down'), style).vg.nodes.keys())).toEqual(['jinkies', 'magoo', 'patata', 'shoo', 'zoinks']);
    });

    it('a removed group (all its functions) and a cut call behave alike', () => {
        const g = grow({ hidden: [magoo, k('foo.ghoul:jinkies'), k('foo.ghoul:zoinks')] });
        const sg = buildScene(g, style);
        expect(names(sg.vg.nodes.keys())).toEqual(['shoo']);
        // one marker click restores one side's hidden neighbors; the next layer's marker the next
        const s1 = buildScene(restore(g, shoo, 'down'), style);
        expect(names(s1.vg.nodes.keys())).toEqual(['magoo', 'patata', 'shoo', 'zoinks']);
        expect(s1.hiddenOn(magoo, 'down')).toEqual([k('foo.ghoul:jinkies')]);
        expect(names(buildScene(restore(g, magoo, 'down'), style).vg.nodes.keys())).toEqual(['jinkies', 'magoo', 'patata', 'shoo', 'zoinks']);
        const c = grow({ cut: [[shoo, magoo]] });
        const sc = buildScene(c, style);
        expect(names(sc.vg.nodes.keys())).toEqual(['shoo', 'zoinks']);
        expect(sc.hiddenOn(shoo, 'down')).toEqual([magoo]);
        expect(names(buildScene(restore(c, shoo, 'down'), style).vg.nodes.keys())).toEqual(['jinkies', 'magoo', 'patata', 'shoo', 'zoinks']);
    });

    it('a removed function on the path to a joined seed breaks the path; the joined seed keeps a marker that restores it', () => {
        const d = grow({ seeds: [shoo, doo], joins: [doo], open: { [shoo]: 'down' }, hidden: [patata] });
        const sc = buildScene(d, style);
        expect(names(sc.vg.nodes.keys())).toEqual(['doo', 'magoo', 'shoo', 'zoinks']);
        expect(sc.paths.size).toBe(0);
        expect(sc.hiddenOn(doo, 'up')).toEqual([patata]);
        const back = buildScene(restore(d, doo, 'up'), style);
        expect(names(back.vg.nodes.keys())).toEqual(['doo', 'magoo', 'patata', 'shoo', 'zoinks']);
        expect(names(back.paths)).toEqual(['magoo', 'patata']);
        invariants(back);
    });
});

describe('paths between seeds: calls asked around the seeds until they connect (core/paths.ts)', () => {
    // doo (joined) -> magoo -> patata -> zoinks -> shoo (the first seed); the view knows doo -> magoo and zoinks -> shoo only
    const E: [string, string][] = [['scoobie:doo', 'foo.ghoul:magoo'], ['foo.ghoul:magoo', 'aloo.patata:patata'], ['aloo.patata:patata', 'foo.ghoul:zoinks'], ['foo.ghoul:zoinks', 'foo.ghoul:shoo'],
        ['foo.ghoul:magoo', 'foo.ghoul:jinkies']];
    const shoo = k('foo.ghoul:shoo'), doo = k('scoobie:doo'), magoo = k('foo.ghoul:magoo'), zoinks = k('foo.ghoul:zoinks');
    const style = { ...DEFAULT_STYLE, boxes: { ...DEFAULT_STYLE.boxes, enabled: false } };
    const full = fixtureDoc(E, {});
    /** Language-server stand-in: every (definition, direction) answered from the full call list. */
    const lsp = {
        outgoing: async (key: string) => full.graph.edges.filter((e) => e.from === key),
        incoming: async (key: string) => full.graph.edges.filter((e) => e.to === key),
        clampOf: () => undefined,
    } as unknown as LspProvider;
    const known = (between: boolean) => {
        const d = fixtureDoc(E, { arrange: 'grow', seeds: [shoo, doo], joins: between ? undefined : [doo], between, open: { [shoo]: 'up' }, depth: 3 });
        d.graph.edges = d.graph.edges.filter((e) => (e.from === doo && e.to === magoo) || (e.from === zoinks && e.to === shoo));
        d.explored = { [shoo]: 'both', [doo]: 'both' };
        return d;
    };
    const fetch = async (d: ViewDoc) => {
        let rounds = 0;
        for (let qs = pathPairs(d); qs.length && rounds < 6; qs = pathPairs(d), rounds++) {
            const r = await extendGraph(lsp, d, qs, { mode: 'fresh' });
            d.graph = r.graph; d.explored = r.explored;
        }
        return rounds;
    };

    for (const between of [false, true]) {
        it(`${between ? 'Paths between seeds only' : 'a joined seed'}: the missing calls are asked, nearest level first; the path is drawn, its siblings are not`, async () => {
            const d = known(between);
            expect(unconnected(d)).toEqual(between ? [shoo, doo] : [doo]);
            expect(names(buildScene(d, style).paths)).toEqual([]);
            const rounds = await fetch(d);
            expect(rounds).toBeGreaterThan(0);
            expect(unconnected(d)).toEqual([]);
            expect(pathPairs(d)).toEqual([]);
            const sc = buildScene(d, style);
            expect(names(sc.paths)).toEqual(['magoo', 'patata', 'zoinks']);
            expect(names(sc.vg.nodes.keys())).not.toContain('jinkies');
        });
    }
});

describe('h41: opening the callers of a function in another group', () => {
    // magoo (seed, group aloo.patata) calls doo; callers: shoo (same group), scoobie_doo (group zoinks.jinkies)
    const E: [string, string][] = [['aloo.patata:shoo', 'aloo.patata:magoo'], ['aloo.patata:magoo', 'aloo.patata:doo'], ['zoinks.jinkies:scoobie_doo', 'aloo.patata:magoo']];
    const magoo = k('aloo.patata:magoo'), caller = k('zoinks.jinkies:scoobie_doo');
    const doc = (off: string[] = []) => fixtureDoc(E, { arrange: 'grow', seeds: [magoo], open: { [magoo]: 'both' }, rules: { off } });

    it('the caller group sits above, the called group below it, one indent right of the caller; switched off, side by side', () => {
        const sc = buildScene(doc(), DEFAULT_STYLE);
        invariants(sc);
        const P = sc.placement;
        const fa = P.frames.find((f) => f.unit === 'box:py:zoinks/jinkies.py' || f.box.label.includes('zoinks'))!;
        const fb = P.frames.find((f) => f.box.label.includes('patata'))!;
        expect(fb.r0).toBeGreaterThan(fa.r1);                                       // below
        expect(fb.c0 + 3).toBe(P.pos.get(caller)!.col + 4);                          // content one indent right of the caller
        const side = buildScene(doc(['h41_called_below']), DEFAULT_STYLE).placement;
        const sa = side.frames.find((f) => f.box.label.includes('zoinks'))!, sb = side.frames.find((f) => f.box.label.includes('patata'))!;
        expect(sb.c0).toBeGreaterThan(sa.c1);                                       // right of the caller group
    });

    it('two callers in the caller group: the called group sits right of their label ends; the calls run right, down, in from the left', () => {
        const E2: [string, string][] = [['zoinks.jinkies:scoobie_doo', 'aloo.patata:magoo'], ['zoinks.jinkies:jinkies', 'aloo.patata:magoo'], ['aloo.patata:magoo', 'aloo.patata:doo']];
        const sc = buildScene(fixtureDoc(E2, { arrange: 'grow', seeds: [magoo], open: { [magoo]: 'up' } }), DEFAULT_STYLE);
        invariants(sc);
        const P = sc.placement;
        const fa = P.frames.find((f) => f.box.label.includes('zoinks'))!, fb = P.frames.find((f) => f.box.label.includes('patata'))!;
        expect(fb.r0).toBeGreaterThan(fa.r1);
        const ends = [k('zoinks.jinkies:scoobie_doo'), k('zoinks.jinkies:jinkies')].map((u) => P.end.get(u)!);
        expect(fb.c0).toBeGreaterThan(Math.max(...ends));
        for (const p of sc.grid.paths.filter((x) => x.to === magoo)) expect(p.pts.length - 2, `${p.from} bends`).toBeLessThanOrEqual(3);
    });

    it('candidate search: both plan columns and nearby cells are routed; the cheapest is kept (two callers: the drop column detours)', () => {
        const E2: [string, string][] = [['zoinks.jinkies:scoobie_doo', 'aloo.patata:magoo'], ['zoinks.jinkies:jinkies', 'aloo.patata:magoo'], ['aloo.patata:magoo', 'aloo.patata:doo']];
        const log: Decision[] = [];
        const sc = buildScene(fixtureDoc(E2, { arrange: 'grow', seeds: [magoo], open: { [magoo]: 'up' } }), DEFAULT_STYLE, [], true, { log: (d) => log.push(d) });
        invariants(sc);
        const d = log.find((x) => x.rule === 'h41_called_below' && x.fn === 'buildScene')!;
        const tried = (d.values.tried as string[]).map((t) => { const [cell, cost] = t.split(': '); return { cell, cost: Number(cost) }; });
        expect(tried.length).toBe(6);
        const kept = /\((\d+), (\d+)\) kept/.exec(d.text)!;
        const best = Math.min(...tried.map((t) => t.cost));
        expect(tried.find((t) => t.cell === `${kept[1]},${kept[2]}`)!.cost).toBe(best);
        expect(tried[1].cost).toBeGreaterThan(tried[0].cost);   // the drop column (second) costs more than the label-end plan
        const plain = buildScene(fixtureDoc(E2, { arrange: 'grow', seeds: [magoo], open: { [magoo]: 'up' }, rules: { params: { 'h41_called_below.tries': 1 } } }), DEFAULT_STYLE);
        invariants(plain);
    });
});

