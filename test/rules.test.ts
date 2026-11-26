import { describe, expect, it } from 'vitest';
import { mergeRules, parseRules, RULES, Rules } from '../src/core/rules';
import { buildScene, rulesOf } from '../src/core/scene';
import { boundedStyle, DEFAULT_STYLE, deepMerge, glyphSet, userDefaults, userStyle } from '../src/core/style';
import { toText } from '../src/core/grid';
import { parseDoc, serializeDoc } from '../src/core/viewdoc';
import { boxVertices } from '../src/core/boxes';
import { fixtureDoc, k, KAZOO } from './fixtures';

describe('rule registry and configuration', () => {
    it('every rule has a unique id, a stage, a title, a text; parameters lie in their range', () => {
        expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
        for (const r of RULES) {
            expect(r.title && r.text && r.stage, r.id).toBeTruthy();
            for (const [n, p] of Object.entries(r.params ?? {})) expect(p.min <= p.value && p.value <= p.max, `${r.id}.${n}`).toBe(true);
            if (r.alternatives) expect(Object.hasOwn(r.alternatives.choices, r.alternatives.default), r.id).toBe(true);
        }
    });

    it('file data: unknown rules, choices and parameters dropped, numbers clamped, prototype keys ignored', () => {
        const c = parseRules(JSON.parse('{"off": ["h23_settle", "h01_first_revealer", "nope", 3], "alt": {"h25_routing_order": "row", "h12_lane_packing": "sideways", "__proto__": "x"},'
            + ' "params": {"h23_settle.range": 1000, "h29_route_cost.cross": "6", "nope.x": 1, "h29_route_cost.bend": 5}}'));
        expect(c).toEqual({ off: ['h23_settle'], alt: { h25_routing_order: 'row' }, params: { 'h23_settle.range': 40, 'h29_route_cost.bend': 5 } });
        expect(parseRules('off')).toBeUndefined();
        expect(parseRules({})).toBeUndefined();
    });

    it('layers: registry, view, override; the last off list wins, params and alternatives merge', () => {
        const R = new Rules([{ off: ['h23_settle'], params: { 'h29_route_cost.cross': 9 } }, { off: [], alt: { h25_routing_order: 'shortest' } }]);
        expect(R.on('h23_settle')).toBe(true);
        expect(R.p('h29_route_cost', 'cross')).toBe(9);
        expect(R.p('h29_route_cost', 'bend')).toBe(3);
        expect(R.alt('h25_routing_order')).toBe('shortest');
        expect(new Rules().alt('h25_routing_order')).toBe('row');
        expect(R.alt('h12_lane_packing')).toBe('shortest');
        expect(mergeRules({ off: ['a'], params: { x: 1 } }, { params: { y: 2 } })).toEqual({ off: ['a'], params: { x: 1, y: 2 } });
    });

    it('a view saves its rules and reads them back', () => {
        const doc = fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], rules: { off: ['h17_item_column'], params: { 'h23_settle.range': 6 } } });
        const back = parseDoc(serializeDoc(doc), 'view');
        expect(back.view.rules).toEqual({ off: ['h17_item_column'], params: { 'h23_settle.range': 6 } });
        const R = rulesOf(DEFAULT_STYLE, back.view);
        expect(R.on('h17_item_column')).toBe(false);
        expect(R.p('h23_settle', 'range')).toBe(6);
    });

    it('style.json and gaffy.style: appearance keys only; keys Options or the Rules panel set are ignored and named', () => {
        const { style, ignored } = userStyle({ font: { size: 15 }, colors: { edge: 'red' }, edges: { mode: 'glyph', width: 2, tension: 0.3 }, boxes: { tight: false, fill: 'hue' },
            grid: { indent: 8 }, route: { cross: 20 }, rules: { off: ['h23_settle'] }, view: { arrange: 'auto', traverse: 'both' } });
        expect(style).toEqual({ font: { size: 15 }, colors: { edge: 'red' }, edges: { width: 2, tension: 0.3 }, boxes: { fill: 'hue' }, view: { traverse: 'both' } });
        expect(ignored.sort()).toEqual(['boxes.tight', 'edges.mode', 'grid', 'route', 'rules', 'view.arrange']);
        const st = boundedStyle(deepMerge(DEFAULT_STYLE, style));
        expect(st.grid.indent).toBe(DEFAULT_STYLE.grid.indent);
        expect(st.edges.mode).toBe(DEFAULT_STYLE.edges.mode);
        expect(Object.keys(userDefaults()).sort()).toEqual(['boxes', 'colors', 'edges', 'font', 'labels', 'view']);
    });

    it('a switched-off rule in the view changes the picture as the explain override does', () => {
        const style = boundedStyle(deepMerge(DEFAULT_STYLE, { boxes: { tight: false } }));
        const seeds = [k('kazoo.moomoo.boogaloos:scoobie')];
        const viaView = buildScene(fixtureDoc(KAZOO, { seeds, rules: { off: ['h17_item_column'] } }), style);
        const viaDebug = buildScene(fixtureDoc(KAZOO, { seeds }), style, [], true, { rules: { off: ['h17_item_column'] } });
        const full = buildScene(fixtureDoc(KAZOO, { seeds }), style);
        const t = (sc: typeof full) => toText(sc.grid, glyphSet(style));
        expect(t(viaView)).toBe(t(viaDebug));
        expect(t(viaView)).not.toBe(t(full));
    });
});

describe('h38 frame overlap', () => {
    // aloo calls zoinks and wibble: two callee boxes; zoinks moved around aloo's frame
    const E: [string, string][] = [['aloo.patata:scoobie_jinkies_zoinks', 'zoinks.jinkies:shoo'], ['aloo.patata:scoobie_jinkies_zoinks', 'wibble.wobble:magoo'],
        ['aloo.patata:scoobie_jinkies_zoinks', 'aloo.patata:doo'], ['zoinks.jinkies:shoo', 'zoinks.jinkies:doo_be_doo_be_doo']];
    const unit = 'box:dir:zoinks';
    const style = boundedStyle(deepMerge(DEFAULT_STYLE, { boxes: { tight: true } }));
    const doc = (offset: Record<string, [number, number]>, off: string[] = []) =>
        fixtureDoc(E, { seeds: [k('aloo.patata:scoobie_jinkies_zoinks')], direction: 'out', offset, rules: { off } });
    const frame = (sc: ReturnType<typeof buildScene>, u: string) => sc.placement.frames.find((f) => f.unit === u)!;
    const cross = (a: { c0: number; r0: number; c1: number; r1: number }, b: typeof a) =>
        a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1
        && !(a.c0 >= b.c0 && a.c1 <= b.c1 && a.r0 >= b.r0 && a.r1 <= b.r1) && !(b.c0 >= a.c0 && b.c1 <= a.c1 && b.r0 >= a.r0 && b.r1 <= a.r1);
    // labels and headers never inside a frame that does not hold them
    const labelsOutsideForeignFrames = (sc: ReturnType<typeof buildScene>) => {
        for (const f of sc.placement.frames) {
            const own = new Set(boxVertices(f.box));
            for (const [key, p] of sc.placement.pos) {
                if (own.has(key) || key.startsWith('⋯')) continue;
                const c1 = p.col + sc.placement.text.get(key)!.length - 1;
                expect(p.row >= f.r0 && p.row <= f.r1 && c1 >= f.c0 && p.col <= f.c1, `${key} inside ${f.unit}`).toBe(false);
            }
        }
    };

    it('a moved group may overlap another frame where neither frame holds the other\'s labels; switched off, it settles apart', () => {
        const s0 = buildScene(doc({}), style);
        const a = frame(s0, 'box:dir:aloo'), z = frame(s0, unit);
        let found: [number, number] | undefined;
        for (let dr = -12; dr <= 12 && !found; dr++) {
            for (let dc = -40; dc <= 40 && !found; dc++) {
                const at = { c0: z.c0 + dc, r0: z.r0 + dr, c1: z.c1 + dc, r1: z.r1 + dr };
                if (!cross(at, a)) continue;
                const sc = buildScene(doc({ [unit]: [dc, dr] }), style);
                if (sc.offsets[unit]?.[0] === dc && sc.offsets[unit]?.[1] === dr && cross(frame(sc, unit), frame(sc, 'box:dir:aloo'))) found = [dc, dr];
            }
        }
        expect(found).toBeDefined();
        const on = buildScene(doc({ [unit]: found! }), style);
        labelsOutsideForeignFrames(on);
        expect(on.grid.unrouted).toBe(0);
        const off = buildScene(doc({ [unit]: found! }, ['h38_frame_overlap']), style);
        expect(off.offsets[unit]).not.toEqual(found);
        expect(cross(frame(off, unit), frame(off, 'box:dir:aloo'))).toBe(false);
    });
});
