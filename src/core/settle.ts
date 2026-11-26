/** @xvdp
 * Settling of user-moved units (`view.offset`) that land on new content as the layout grows (side opened, new
 * data, depth change). `settleMoved` returns per colliding unit the nearest clearing offset change.
 *
 * Geometry only: a move by (a, b) shifts the unit's labels and inner frames; unmoved content stays (place.ts, 5).
 * Greedy: least displacement (distance × labels moved) first; ties: boxes first (a frame on a label is the box's
 * doing), then smaller unit; re-measure after each move. A small box moved into a large one leaves it.
 *
 * Collisions of a unit:
 * - label or its two lead cells on another frame's border;
 * - label within 4 cells (`name() ─> next()`) of another label on its row;
 * - another label on or inside its frame;
 * - its frame partly overlapping another, or touching it without a free row or column between (no corridor for
 *   calls; nesting allowed); with h38_frame_overlap on, instead: one of its labels or headers within `margin` of a
 *   frame that does not hold it.
 * Search: Manhattan rings d ≤ `range` (12), vertical first; then straight lines, vertical then horizontal, to
 * `far` (80): overlapping labels are worse than long moves. Never above row 0 or left of column 0 (layout returns
 * such content: no effect). No clean offset: unit stays. Parameters of rule h23_settle (rules.ts): range, far,
 * margin (cells between labels of one row, 4), flag.
 * Cost: O(U² · (range² + far) · M · (L + F)); U colliding units, M labels and frames per unit, L labels, F frames.
 */
import { boxVertices } from './boxes';
import { Rules } from './rules';
import { NodeKey } from './model';
import type { Placement } from './place';
import { ViewDoc } from './viewdoc';

/** Unit queries on a placement (scene.ts): members, placed state, marker-row vertices to skip. */
export interface Units { members: (unit: string) => NodeKey[]; placed: (unit: string) => boolean; stub: (key: NodeKey) => boolean }

interface Span { key: NodeKey; row: number; c0: number; c1: number }
interface Box { unit: string; r0: number; c0: number; r1: number; c1: number; head: number; keys: ReadonlySet<NodeKey> }   // head: header label length; keys: vertices inside

const inside = (a: Box, b: Box) => a.r0 >= b.r0 && a.r1 <= b.r1 && a.c0 >= b.c0 && a.c1 <= b.c1;
const meets = (a: Box, b: Box) => a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
/** Label span, with its two lead cells, touching a frame border. */
const onBorder = (s: Span, f: Box) => {
    const lo = s.c0 - 2;
    if ((s.row === f.r0 || s.row === f.r1) && lo <= f.c1 && s.c1 >= f.c0) return true;
    return s.row > f.r0 && s.row < f.r1 && ((lo <= f.c0 && s.c1 >= f.c0) || (lo <= f.c1 && s.c1 >= f.c1));
};
/** Frame grown by one cell: a routing corridor around it. */
const pad = (b: Box): Box => ({ ...b, r0: b.r0 - 1, c0: b.c0 - 1, r1: b.r1 + 1, c1: b.c1 + 1 });
const within = (s: Span, f: Box) => s.row >= f.r0 && s.row <= f.r1 && s.c1 >= f.c0 && s.c0 - 2 <= f.c1;

/** Offset changes `[unit, dc, dr]` clearing colliding moved units; empty if none collide. */
export function settleMoved(P: Placement, doc: ViewDoc, units: Units, R: Rules = new Rules(), round = 0): [string, number, number][] {
    if (!R.on('h23_settle')) return [];
    const RANGE = R.p('h23_settle', 'range'), FAR = R.p('h23_settle', 'far'), GAP = R.p('h23_settle', 'margin');
    const spans: Span[] = [...P.pos].filter(([k]) => !units.stub(k) && P.text.has(k))
        .map(([key, p]) => ({ key, row: p.row, c0: p.col, c1: p.col + P.text.get(key)!.length - 1 }));
    const boxes: Box[] = P.frames.map((f) => ({ unit: f.unit, r0: f.r0, c0: f.c0, r1: f.r1, c1: f.c1, head: f.box.label.length, keys: new Set(boxVertices(f.box)) }));
    // h38: frames may overlap; a label or header inside a frame that does not hold it collides instead
    const soft = R.on('h38_frame_overlap'), m38 = R.p('h38_frame_overlap', 'margin');
    const inFrame = (sp: Span, f: Box) => sp.row >= f.r0 - m38 && sp.row <= f.r1 + m38 && sp.c1 >= f.c0 - m38 && sp.c0 - 2 <= f.c1 + m38;
    const moved = Object.keys(doc.view.offset).filter((u) => !doc.view.lock[u] && units.placed(u))
        .map((u) => {
            const keys = new Set(units.members(u));
            const self = boxes.find((b) => b.unit === u);
            return { u, keys, mine: spans.filter((s) => keys.has(s.key)), own: self ? boxes.filter((b) => b === self || inside(b, self)) : [] };
        });
    type Unit = (typeof moved)[number];
    const hits = (x: Unit, a: number, d: number) => {
        const others = spans.filter((s) => !x.keys.has(s.key));
        const fixed = boxes.filter((b) => !x.own.includes(b));
        const foreign = soft ? fixed.filter((f) => ![...x.keys].some((k) => f.keys.has(k))) : [];
        let n = 0;
        for (const s0 of x.mine) {
            const s = { ...s0, row: s0.row + d, c0: s0.c0 + a, c1: s0.c1 + a };
            if (fixed.some((f) => onBorder(s, f))) n++;
            if (foreign.some((f) => inFrame(s, f))) n++;
            if (others.some((o) => o.row === s.row && (o.c0 < s.c0 ? s.c0 - o.c1 - 1 : o.c0 - s.c1 - 1) < GAP)) n++;
        }
        for (const b0 of x.own) {
            const b = { ...b0, r0: b0.r0 + d, r1: b0.r1 + d, c0: b0.c0 + a, c1: b0.c1 + a };
            if (others.some((o) => within(o, b))) n++;
            if (!soft && fixed.some((f) => meets(pad(b), f) && !inside(b, f) && !inside(f, b))) n++;
            if (soft && foreign.some((f) => inFrame({ key: b.unit, row: b.r0, c0: b.c0 + 4, c1: b.c0 + 3 + b.head }, f))) n++;
        }
        return n;
    };
    const nearest = (x: Unit): [number, number] | undefined => {
        const top = Math.min(...x.mine.map((s) => s.row), ...x.own.map((b) => b.r0));
        const left = Math.min(...x.mine.map((s) => s.c0 - 2), ...x.own.map((b) => b.c0));
        const ok = (a: number, d: number) => top + d >= 0 && left + a >= 0 && !hits(x, a, d);
        for (let dist = 1; dist <= RANGE; dist++) {
            // vertical first, then growing horizontal share
            for (let h = 0; h <= dist; h++) {
                for (const [a, d] of [[h, dist - h], [h, -(dist - h)], [-h, dist - h], [-h, -(dist - h)]] as const) {
                    if (ok(a, d)) return [a, d];
                }
            }
        }
        for (let dist = RANGE + 1; dist <= FAR; dist++) {
            for (const [a, d] of [[0, dist], [0, -dist], [dist, 0], [-dist, 0]] as const) if (ok(a, d)) return [a, d];
        }
        return undefined;
    };
    const moves: [string, number, number][] = [];
    let todo = moved.filter((x) => hits(x, 0, 0));
    while (todo.length) {
        // least displacement first: move distance × labels moved (small units yield)
        const cost = (r: { x: Unit; to?: [number, number] }) => (Math.abs(r.to![0]) + Math.abs(r.to![1])) * Math.max(1, r.x.mine.length);
        const ranked = todo.map((x) => ({ x, to: nearest(x) })).filter((r) => r.to)
            .sort((p, q) => cost(p) - cost(q)
                || Number(!p.x.u.startsWith('box:')) - Number(!q.x.u.startsWith('box:')) || p.x.keys.size - q.x.keys.size);
        if (!ranked.length) break;
        const { x, to } = ranked[0];
        const [a, d] = to!;
        moves.push([x.u, a, d]);
        R.note({ rule: 'h23_settle', fn: 'settleMoved', unit: x.u, text: `offset ${JSON.stringify(doc.view.offset[x.u])} + (${a}, ${d}): clear of other content`,
            values: { round, collisions: hits(x, 0, 0), cost: cost(ranked[0]), waiting: ranked.length - 1 },
            ...(Math.abs(a) + Math.abs(d) >= R.p('h23_settle', 'flag') ? { flag: `moved ${Math.abs(a) + Math.abs(d)} cells` } : {}) });
        for (const s of x.mine) { s.row += d; s.c0 += a; s.c1 += a; }
        for (const b of x.own) { b.r0 += d; b.r1 += d; b.c0 += a; b.c1 += a; }
        todo = todo.filter((y) => y !== x && hits(y, 0, 0));
    }
    return moves;
}
