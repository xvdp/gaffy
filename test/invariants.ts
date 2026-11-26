import { expect } from 'vitest';
import { boxVertices } from '../src/core/boxes';
import { isStub, Scene } from '../src/core/scene';

/**
 * Picture invariants: every vertex placed once; labels overlap neither edge cells nor each other; every call routed
 * and drawn exactly once (one path or a back tag); no label end both receives and sends; orthogonal paths; frames
 * nest, stay apart, or overlap (h38_frame_overlap) with no label inside a frame that does not hold it.
 */
export function invariants(sc: Scene) {
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
    // no label end both receives a call (`f() <──`) and sends one (`f() ──`)
    const intoEnd = new Set(grid.paths.filter((p) => p.arrive === 'W').map((p) => p.to));
    for (const p of grid.paths) expect(p.start === 'E' && intoEnd.has(p.from), `${p.from} sends and receives at its end`).toBe(false);
    // every call drawn exactly once: one path, or a back tag
    const back = new Set<string>();
    for (const B of P.blocks) for (const [u, vs] of B.L.back) for (const v of vs) back.add(`${u}>${v}`);
    const paths = new Map<string, number>();
    for (const p of grid.paths) paths.set(`${p.from}>${p.to}`, (paths.get(`${p.from}>${p.to}`) ?? 0) + 1);
    for (const e of drawn.edges) {
        const id = `${e.from}>${e.to}`;
        expect((paths.get(id) ?? 0) + (back.has(id) ? 1 : 0), id).toBe(1);
    }
    // every call path is orthogonal: each segment horizontal or vertical (a curve style rounds the corners)
    for (const p of grid.paths) {
        for (let i = 1; i < p.pts.length; i++) {
            const [a, b] = [p.pts[i - 1], p.pts[i]];
            expect(a[0] === b[0] || a[1] === b[1], `${p.from} → ${p.to}: diagonal ${a} → ${b}`).toBe(true);
        }
    }
    // frames nest, stay apart, or overlap (h38_frame_overlap) with no label inside a frame that does not hold it
    for (const f of P.frames) {
        for (const g of P.frames) {
            if (f === g) continue;
            const inside = g.c0 >= f.c0 && g.c1 <= f.c1 && g.r0 >= f.r0 && g.r1 <= f.r1;
            const outside = f.c0 >= g.c0 && f.c1 <= g.c1 && f.r0 >= g.r0 && f.r1 <= g.r1;
            const apart = g.c0 > f.c1 || f.c0 > g.c1 || g.r0 > f.r1 || f.r0 > g.r1;
            if (inside || outside || apart) continue;
            const own = new Set(boxVertices(f.box));
            for (const [key, p] of P.pos) {
                if (own.has(key) || isStub(key)) continue;
                const c1 = p.col + P.text.get(key)!.length - 1;
                expect(p.row >= f.r0 && p.row <= f.r1 && c1 >= f.c0 && p.col <= f.c1, `${key} inside ${f.box.label}, which overlaps ${g.box.label}`).toBe(false);
            }
        }
    }
}
