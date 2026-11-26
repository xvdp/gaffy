import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Grid, gridCost } from '../src/core/grid';
import { RuleConfig } from '../src/core/rules';
import { buildScene } from '../src/core/scene';
import { DEFAULT_STYLE, E, N, S, W } from '../src/core/style';
import { parseDoc } from '../src/core/viewdoc';
import { invariants } from './invariants';

// gaffy's own bindings.ts and its callers: 26 functions, 55 calls, the redundant crossings of describe() (rules-plan.md)
const view = parseDoc(readFileSync('test/data/bindings.gaffy', 'utf8'), 'bindings');
const scene = (rules: RuleConfig = {}) => {
    const doc = structuredClone(view);
    doc.view.rules = rules;
    return buildScene(doc, DEFAULT_STYLE, [], { external: true, standard: true });
};
/** Cells where two calls cross at right angles. */
const crossings = (g: Grid) => {
    let n = 0;
    for (const [, nets] of g.cells) {
        if (nets.size < 2) continue;
        let v = false, h = false, o = false;
        for (const m of nets.values()) { if (m === (N | S)) v = true; else if (m === (E | W)) h = true; else o = true; }
        if (v && h && !o) n++;
    }
    return n;
};

describe('edge rules on the bindings view', () => {
    const base = scene();                                               // default order: `row`
    const longest = scene({ alt: { h25_routing_order: 'longest' } });

    it('routing order: `row` (default) 23 crossing cells, `longest` 53 (measured 2026-11-25)', () => {
        invariants(base);
        invariants(longest);
        expect(crossings(base.grid)).toBeLessThanOrEqual(23);
        expect(crossings(longest.grid)).toBeLessThanOrEqual(53);
        expect(crossings(base.grid)).toBeLessThan(crossings(longest.grid));
    });

    it('one edge log record per drawn call; received crossings add up to the crossings between calls', () => {
        const g = base.grid;
        expect(g.routes.length).toBe(g.paths.length);
        const routed = g.routes.filter((r) => r.kind === 'routed');
        expect(routed.every((r) => r.order !== undefined && r.arrival && r.cost !== undefined && r.steps! > 0)).toBe(true);
        expect(new Set(routed.map((r) => r.order)).size).toBe(routed.length);
        for (const r of g.routes) expect(r.by.length).toBe(r.received);
        // a call crossed by a later call: the later one is routed after it
        const order = new Map(g.routes.map((r) => [`${r.from}>${r.to}`, r.order ?? -1]));
        for (const r of g.routes) for (const b of r.by) expect(order.get(b.replace('\u0000', '>'))!).toBeGreaterThan(r.order ?? -1);
    });

    it('h25 `row`: routing order follows caller rows, top to bottom', () => {
        const rows = base.grid.routes.filter((r) => r.kind === 'routed').sort((a, b) => a.order! - b.order!)
            .map((r) => (base.placement.port.get(r.from) ?? base.placement.pos.get(r.from)!).row);
        expect(rows).toEqual([...rows].sort((a, b) => a - b));
    });

    it('h39 reroute: rounds keep only cost drops; the most crossed caller (describe) routes after the others', () => {
        const sc = scene({ alt: { h25_routing_order: 'longest' }, params: { 'h39_reroute.rounds': 3 } });
        invariants(sc);
        expect(sc.grid.reroutes).toBeGreaterThan(0);
        expect(gridCost(sc.grid)).toBeLessThan(gridCost(longest.grid));
        expect(crossings(sc.grid)).toBeLessThan(crossings(longest.grid));
        const d = sc.grid.routes.filter((r) => r.from.endsWith('#describe') && r.kind === 'routed');
        expect(d.every((r) => r.round > 0)).toBe(true);
    });

    it('h40 lookahead and the admissible estimate route every call; the picture keeps its invariants', () => {
        for (const params of [{ 'h40_lookahead.weight': 0.5 }, { 'h29_route_cost.estimate': 0.3 }] as Record<string, number>[]) {
            const sc = scene({ params });
            invariants(sc);
        }
    });

    it('h24 off: every call routed by search, none drawn as elbow or lane', () => {
        const sc = scene({ off: ['h24_tree_lines_first'] });
        invariants(sc);
        expect(sc.grid.routes.every((r) => r.kind === 'routed')).toBe(true);
    });
});
