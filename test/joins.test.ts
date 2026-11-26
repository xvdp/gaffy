import { describe, expect, it } from 'vitest';
import { buildScene } from '../src/core/scene';
import { DEFAULT_STYLE } from '../src/core/style';
import { ViewDoc, ViewSpec } from '../src/core/viewdoc';
import { fixtureDoc, k } from './fixtures';
import { invariants } from './invariants';

// shoo → magoo → patata → doo; magoo → zoinks, patata → jinkies (siblings off the path); doo → snack (beyond doo)
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
        // markers: siblings and the callee beyond the joined seed stay behind `└─>>`
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
    // shoo → magoo → patata → doo (seeds shoo and doo); shoo → zoinks; magoo → jinkies (a branch below magoo)
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
