import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/rules';
import { buildScene, Scene, unitAnchor } from '../src/core/scene';
import { deepMerge, DEFAULT_STYLE, glyphSet, Style } from '../src/core/style';
import { toText } from '../src/core/grid';
import { dropMovesWithin, parseDoc, ParentRule, ViewDoc } from '../src/core/viewdoc';
import { fixtureDoc, k, KAZOO, MOO, STAR } from './fixtures';
import { invariants } from './invariants';

/** Seeded generator (mulberry32): deterministic test data. */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Pairwise covering array over `n` binary factors: rows in which every pair of factors takes 00, 01, 10 and 11. */
function pairwise(n: number, seed = 7): boolean[][] {
    const r = rng(seed);
    const rows: boolean[][] = [Array(n).fill(false), Array(n).fill(true)];
    const covered = (a: number, b: number, x: boolean, y: boolean) => rows.some((row) => row[a] === x && row[b] === y);
    const missing = () => {
        const out: [number, number, boolean, boolean][] = [];
        for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (const x of [false, true]) for (const y of [false, true]) if (!covered(a, b, x, y)) out.push([a, b, x, y]);
        return out;
    };
    for (let m = missing(); m.length; m = missing()) {
        let best: boolean[] = [], gain = -1;
        for (let t = 0; t < 60; t++) {
            const row = Array.from({ length: n }, () => r() < 0.5);
            const [a, b, x, y] = m[0];
            row[a] = x; row[b] = y;
            const g = m.filter(([p, q, u, v]) => row[p] === u && row[q] === v).length;
            if (g > gain) { gain = g; best = row; }
        }
        rows.push(best);
    }
    return rows;
}

/** Rules whose absence lets labels overlap by design: invariants are not expected without them. */
const GUARDS = new Set(['h15_block_descent', 'h20_unmoved_box_descent', 'h21_moved_function_descent', 'h23_settle', 'h38_frame_overlap']);
const SWITCHABLE = RULES.filter((r) => r.without).map((r) => r.id);
const OFF_ROWS = pairwise(SWITCHABLE.length).map((row) => SWITCHABLE.filter((_, i) => row[i]));

const text = (sc: Scene, st: Style) => toText(sc.grid, glyphSet(st));
const extent = (sc: Scene) => [sc.grid.width, sc.grid.height];

/** Picture within g times the unmoved picture, plus the extent of the moves. */
function bounded(sc: Scene, base: Scene, doc: ViewDoc, g = 3) {
    const moved = Object.values(doc.view.offset).reduce((m, [a, b]) => [Math.max(m[0], Math.abs(a)), Math.max(m[1], Math.abs(b))], [0, 0]);
    const locked = Object.values(doc.view.lock).reduce((m, [a, b]) => [Math.max(m[0], a), Math.max(m[1], b)], [0, 0]);
    const [w0, h0] = extent(base), [w, h] = extent(sc);
    expect(w, 'width').toBeLessThanOrEqual(g * w0 + moved[0] + locked[0] + 40);
    expect(h, 'height').toBeLessThanOrEqual(g * h0 + moved[1] + locked[1] + 20);
}

describe('rule matrix (T-a, T-b)', () => {
    const fixtures: [string, () => ViewDoc][] = [
        ['kazoo', () => fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out' })],
        ['moo', () => fixtureDoc(MOO, { seeds: [k('scripts/moo_trucks:wanderoo')], direction: 'out' })],
        ['star', () => fixtureDoc(STAR, { seeds: [k('fit.surfel:linear_harmonics')], direction: 'out' })],
    ];
    const styles: [string, Style][] = [];
    for (const [bn, boxes] of [['off', { enabled: false }], ['packages', { enabled: true, modules: false }], ['modules', { enabled: true, modules: true }]] as const) {
        for (const tight of [true, false]) styles.push([`${bn}${tight ? ' tight' : ''}`, deepMerge(DEFAULT_STYLE, { boxes: { ...boxes, tight } })]);
    }
    const moves = (d: ViewDoc, sc: Scene) => {
        const f = sc.placement.frames.find((x) => x.unit !== 'box:' && sc.placement.frames.length > 1);
        if (f) d.view.offset[f.unit] = [4, -3];
        // lock where drawn, as the webview's Lock Position does
        const v = [...sc.placement.pos.keys()].reverse().find((x) => !x.startsWith('⋯') && d.graph.nodes[x] && unitAnchor(sc, x));
        if (v) d.view.lock[v] = unitAnchor(sc, v)!;
    };

    // GAFFY_MATRIX=1 (npm run test:matrix): every fixture, style and parent rule (about 3 minutes); else a subset
    const full = process.env.GAFFY_MATRIX === '1';
    it(`every configuration builds, stays bounded and deterministic; with the guard rules on, the invariants hold (${OFF_ROWS.length} switch rows${full ? ', full' : ', subset'})`, () => {
        let runs = 0;
        for (const [, mk] of full ? fixtures : fixtures.slice(0, 2)) {
            for (const [, st] of full ? styles : [styles[2]]) {
                for (const parentRule of (full ? ['dfs', 'nearest', 'joint'] : ['dfs', 'joint']) as ParentRule[]) {
                    for (const off of OFF_ROWS) {
                        for (const moved of [false, true]) {
                            const d = mk();
                            d.view.parentRule = parentRule;
                            const base = buildScene(d, st);
                            if (moved) moves(d, base);
                            d.view.rules = { off };
                            const sc = buildScene(d, st);
                            runs++;
                            bounded(sc, base, d);
                            if (!off.some((r) => GUARDS.has(r))) invariants(sc);
                            if (full || moved) expect(text(buildScene(d, st), st)).toBe(text(sc, st));
                        }
                    }
                }
            }
        }
        expect(runs).toBeGreaterThan(full ? 500 : 60);
    }, 600_000);

    it('settle reaches a fixed point: the settled offsets settle no further', () => {
        for (const [name, mk] of fixtures) {
            for (const [sn, st] of styles) {
                const d = mk();
                const base = buildScene(d, st);
                moves(d, base);
                const sc = buildScene(d, st);
                const d2 = structuredClone(d);
                d2.view.offset = structuredClone(sc.offsets);
                const sc2 = buildScene(d2, st);
                expect(sc2.offsets, `${name} ${sn}`).toEqual(d2.view.offset);
                expect(text(sc2, st), `${name} ${sn}`).toBe(text(sc, st));
            }
        }
    });
});

describe('grouping changes (T-c)', () => {
    const st = deepMerge(DEFAULT_STYLE, { boxes: { enabled: true, modules: false } });
    const containers = (d: ViewDoc) => Object.values(d.graph.nodes).filter((n) => n.kind === 'module' || n.kind === 'folder' || n.kind === 'package').map((n) => n.key);
    /** Moves and locks name units that exist: a frame, a placed vertex, a collapsed vertex. */
    const noLooseEnds = (sc: Scene, d: ViewDoc) => {
        for (const u of [...Object.keys(d.view.offset), ...Object.keys(d.view.lock)]) {
            const placed = !!unitAnchor(sc, u) || sc.placement.pos.has(u);
            expect(placed || !u.startsWith('box:'), `${u} names no group on screen`).toBe(true);
        }
    };

    it('group, ungroup and reset grouping drop the moves inside the container; no move names a missing group; no explosion', () => {
        for (const edges of [KAZOO, MOO]) {
            const mk = () => fixtureDoc(edges, { seeds: [k(edges[0][0])], direction: 'out' });
            const d0 = mk();
            const base = buildScene(d0, st);
            for (const c of containers(d0)) {
                for (const op of ['group', 'ungroup'] as const) {
                    const d = mk();
                    for (const f of base.placement.frames) d.view.offset[f.unit] = [3, 2];
                    d.view[op] = [c];
                    dropMovesWithin(d, c);
                    const sc = buildScene(d, st);
                    noLooseEnds(sc, d);
                    bounded(sc, base, d);
                    invariants(sc);
                    // reset grouping
                    d.view.group = []; d.view.ungroup = [];
                    dropMovesWithin(d, c);
                    const back = buildScene(d, st);
                    noLooseEnds(back, d);
                    invariants(back);
                }
            }
        }
    });
});

describe('random operation sequences (T-d)', () => {
    const view = parseDoc(readFileSync('test/data/runaway.gaffy', 'utf8'), 'runaway');
    const st = DEFAULT_STYLE;
    /** As the webview: the settled offsets saved after each change, at most 3 saves in a row. */
    const settled = (d: ViewDoc) => {
        let sc = buildScene(d, st, [], true);
        for (let i = 0; i < 3 && sc.offsets !== d.view.offset; i++) { d.view.offset = structuredClone(sc.offsets); sc = buildScene(d, st, [], true); }
        return sc;
    };

    // seed 2 (open, rules-plan.md): a function moved inside a group moved by an offset lands on a locked label of
    // the group; settle does not clear it within 3 saves. `it.fails` turns red once it is fixed.
    for (const seed of [1, 2, 3, 4, 5]) {
        (seed === 2 ? it.fails : it)(`seed ${seed}: 25 operations (open, close, drag, lock, unlock, group, ungroup, collapse, expand, hide); invariants, bounded jumps`, () => {
            const r = rng(seed);
            const d = structuredClone(view);
            let sc = settled(d);
            const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(r() * xs.length)] : undefined);
            const log: string[] = [];
            for (let step = 0; step < 25; step++) {
                const keys = [...sc.vg.nodes.keys()];
                const frames = sc.placement.frames.map((f) => f.unit);
                const op = pick(['open', 'close', 'drag', 'dragBox', 'lock', 'unlock', 'group', 'ungroup', 'collapse', 'expand', 'hide'])!;
                expect(keys.length, `seed ${seed}, step ${step}: nothing on screen after ${log.slice(-3).join(' · ')}`).toBeGreaterThan(0);
                const key = pick(keys)!;
                const before = sc;
                switch (op) {
                    case 'open': if (d.view.arrange === 'grow') d.view.open = { ...(d.view.open ?? {}), [key]: pick(['up', 'down', 'both'] as const)! }; break;
                    case 'close': if (d.view.arrange === 'grow') d.view.open = { ...(d.view.open ?? {}), [key]: 'none' }; break;
                    case 'drag': { const o = d.view.offset[key] ?? [0, 0]; d.view.offset[key] = [o[0] + Math.round(r() * 20 - 10), o[1] + Math.round(r() * 12 - 6)]; break; }
                    case 'dragBox': { const u = pick(frames); if (u) { const o = d.view.offset[u] ?? [0, 0]; d.view.offset[u] = [o[0] + Math.round(r() * 30 - 15), o[1] + Math.round(r() * 16 - 8)]; } break; }
                    case 'lock': { const at = unitAnchor(sc, key); if (at) { d.view.lock[key] = at; delete d.view.offset[key]; } break; }
                    case 'unlock': delete d.view.lock[pick(Object.keys(d.view.lock)) ?? '']; break;
                    case 'group': { const n = d.graph.nodes[key]; if (n?.parent) { d.view.group = [...d.view.group, n.parent]; dropMovesWithin(d, n.parent); } break; }
                    case 'ungroup': { const c = pick(d.view.group); if (c) { d.view.group = d.view.group.filter((x) => x !== c); dropMovesWithin(d, c); } break; }
                    case 'collapse': { const n = d.graph.nodes[key]; if (n?.parent && !d.view.seeds.includes(key)) d.view.collapsed = [...d.view.collapsed, n.parent]; break; }
                    case 'expand': d.view.collapsed = d.view.collapsed.slice(1); break;
                    // as the webview's hide: seeds and the vertices standing for them stay
                    case 'hide': if (!sc.seeds.has(key)) d.view.hidden = [...d.view.hidden, key]; break;
                }
                log.push(`${op} ${key.slice(key.indexOf('#') + 1)}`);
                sc = settled(d);
                const where = `seed ${seed}, step ${step}: ${log.slice(-3).join(' · ')}`;
                expect(sc.grid.unrouted, where).toBe(0);
                // bounded growth per operation: an explosion multiplies the picture
                expect(sc.grid.height, where).toBeLessThanOrEqual(3 * before.grid.height + 40);
                expect(sc.grid.width, where).toBeLessThanOrEqual(3 * before.grid.width + 60);
            }
            invariants(sc);
        });
    }
});
