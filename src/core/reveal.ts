/** @xvdp
 * Visibility by open sides, VS Code call hierarchy in both directions.
 *
 * `view.open`: open sides per vertex; `down` shows callees, `up` callers, one layer.
 * Visible set: seeds, then breadth-first neighbors on open sides of visible vertices; a seed without entry opens
 * the view's traversal side. Open sides of non-visible vertices persist: reopening a parent restores lower layers.
 * `allowed`: seeds open both sides; vertices revealed via `down` only callees, via `up` only callers.
 * `view.cut`: calls not followed. `pinned`: vertices visible without an opener, both sides allowed, closed unless
 * opened (no traversal side).
 *
 * `revealPaths` (one layer at a time with `between`): every vertex on a seed-to-seed call path of the graph, any
 * number of calls; both sides allowed (markers, neighbor requests that extend paths); open sides add nothing.
 *
 * `revealDepth` (full view): vertices within `up` caller and `down` callee levels, same `allowed`. Level, rule
 * `shortest`: breadth-first distance; rule `longest`: longest path from seeds in the DAG without DFS back edges
 * (dynamic program over a topological order), each vertex within the limit with a predecessor one level up,
 * so the visible set stays connected.
 */
import { NodeKey } from './model';
import { VGraph } from './quotient';
import type { Depth, DepthRule, Direction, OpenSide } from './viewdoc';

export interface Reveal {
    visible: Set<NodeKey>;
    order: NodeKey[];                                                  // breadth-first, seeds first
    opener: Map<NodeKey, { by: NodeKey; side: 'up' | 'down' }>;        // revealing vertex and side
    allowed: Map<NodeKey, OpenSide>;                                   // sides a vertex may open
    level: Map<NodeKey, number>;                                       // call level from seeds
}

const under = (lev: number, lim: Depth) => lim === 'all' || lev < lim;

export const seedSide = (d: Direction): OpenSide => (d === 'out' ? 'down' : d === 'in' ? 'up' : 'both');
export const opens = (s: OpenSide | undefined, side: 'up' | 'down') => s === side || s === 'both';
export const cutKey = (caller: NodeKey, callee: NodeKey) => `${caller}\u0000${callee}`;

/** Open sides ∩ allowed sides. */
export function within(s: OpenSide | undefined, allowed: OpenSide | undefined): OpenSide {
    const up = opens(s, 'up') && opens(allowed, 'up');
    const down = opens(s, 'down') && opens(allowed, 'down');
    return up && down ? 'both' : up ? 'up' : down ? 'down' : 'none';
}

export function reveal(
    vg: VGraph, seeds: readonly NodeKey[], open: Record<NodeKey, OpenSide> | undefined, direction: Direction,
    cut: ReadonlySet<string> = new Set(), pinned: readonly NodeKey[] = [],
): Reveal {
    const visible = new Set<NodeKey>();
    const order: NodeKey[] = [];
    const opener = new Map<NodeKey, { by: NodeKey; side: 'up' | 'down' }>();
    const allowed = new Map<NodeKey, OpenSide>();
    const level = new Map<NodeKey, number>();
    const q: NodeKey[] = [];
    for (const s of [...seeds, ...pinned]) if (vg.nodes.has(s) && !visible.has(s)) { visible.add(s); order.push(s); q.push(s); allowed.set(s, 'both'); level.set(s, 0); }
    const seedSet = new Set(seeds);
    while (q.length) {
        const k = q.shift()!;
        const side = within((open ?? {})[k] ?? (seedSet.has(k) ? seedSide(direction) : undefined), allowed.get(k));
        const take = (n: NodeKey, s: 'up' | 'down') => {
            if (visible.has(n)) return;
            visible.add(n);
            order.push(n);
            opener.set(n, { by: k, side: s });
            allowed.set(n, s);
            level.set(n, level.get(k)! + 1);
            q.push(n);
        };
        if (opens(side, 'down')) {
            for (const e of [...(vg.out.get(k) ?? [])].sort((a, b) => a.line - b.line)) if (!cut.has(cutKey(k, e.to))) take(e.to, 'down');
        }
        if (opens(side, 'up')) {
            for (const e of [...(vg.inc.get(k) ?? [])].sort((a, b) => a.line - b.line)) if (!cut.has(cutKey(e.from, k))) take(e.from, 'up');
        }
    }
    return { visible, order, opener, allowed, level };
}

export function revealDepth(vg: VGraph, seeds: readonly NodeKey[], up: Depth, down: Depth, rule: DepthRule): Reveal {
    const roots = seeds.filter((s) => vg.nodes.has(s));
    const seedSet = new Set(roots);
    const next = (k: NodeKey, side: 'up' | 'down') =>
        [...((side === 'down' ? vg.out.get(k) : vg.inc.get(k)) ?? [])].sort((a, b) => a.line - b.line).map((e) => (side === 'down' ? e.to : e.from));
    const visible = new Set<NodeKey>(roots);
    const order = [...roots];
    const opener = new Map<NodeKey, { by: NodeKey; side: 'up' | 'down' }>();
    const allowed = new Map<NodeKey, OpenSide>(roots.map((s) => [s, 'both'] as const));
    const level = new Map<NodeKey, number>(roots.map((s) => [s, 0] as const));
    if (rule === 'shortest') {
        const q = [...roots];
        while (q.length) {
            const k = q.shift()!;
            for (const side of ['down', 'up'] as const) {
                if (!(allowed.get(k) === 'both' || allowed.get(k) === side) || !under(level.get(k)!, side === 'down' ? down : up)) continue;
                for (const n of next(k, side)) {
                    if (visible.has(n)) continue;
                    visible.add(n); order.push(n);
                    opener.set(n, { by: k, side }); allowed.set(n, side); level.set(n, level.get(k)! + 1);
                    q.push(n);
                }
            }
        }
        return { visible, order, opener, allowed, level };
    }
    // longest: per side, reverse DFS postorder from seeds = topological order without back edges
    for (const side of ['down', 'up'] as const) {
        const lim = side === 'down' ? down : up;
        if (lim === 0) continue;
        const state = new Map<NodeKey, number>();
        const back = new Set<string>();
        const post: NodeKey[] = [];
        for (const s of roots) {
            if (state.get(s)) continue;
            state.set(s, 1);
            const stack = [{ u: s, kids: next(s, side), i: 0 }];
            while (stack.length) {
                const f = stack[stack.length - 1];
                if (f.i < f.kids.length) {
                    const n = f.kids[f.i++];
                    const st = state.get(n) ?? 0;
                    if (st === 1) back.add(`${f.u}\u0000${n}`);
                    else if (st === 0) { state.set(n, 1); stack.push({ u: n, kids: next(n, side), i: 0 }); }
                } else { state.set(f.u, 2); post.push(f.u); stack.pop(); }
            }
        }
        const dist = new Map<NodeKey, number>(roots.map((s) => [s, 0] as const));
        const by = new Map<NodeKey, NodeKey>();
        for (const k of post.reverse()) {
            const d = dist.get(k);
            if (d === undefined) continue;
            for (const n of next(k, side)) {
                if (seedSet.has(n) || back.has(`${k}\u0000${n}`)) continue;
                if ((dist.get(n) ?? -1) < d + 1) { dist.set(n, d + 1); by.set(n, k); }
            }
        }
        for (const [n, d] of [...dist].sort((a, b) => a[1] - b[1])) {
            if (seedSet.has(n) || visible.has(n) || !(lim === 'all' || d <= lim)) continue;
            visible.add(n); order.push(n);
            opener.set(n, { by: by.get(n)!, side }); allowed.set(n, side); level.set(n, d);
        }
    }
    return { visible, order, opener, allowed, level };
}

/**
 * Vertices on call paths between seeds, any length: reachable from a seed and reaching a seed (`cut` calls not
 * followed); seeds always. Levels: breadth-first call distance from the seeds within the paths, both directions.
 */
export function revealPaths(vg: VGraph, seeds: readonly NodeKey[], cut: ReadonlySet<string> = new Set()): Reveal {
    const start = seeds.filter((s) => vg.nodes.has(s));
    const walk = (down: boolean) => {
        const seen = new Set(start);
        const stack = [...start];
        while (stack.length) {
            const k = stack.pop()!;
            for (const e of (down ? vg.out.get(k) : vg.inc.get(k)) ?? []) {
                const n = down ? e.to : e.from;
                if (!seen.has(n) && !cut.has(cutKey(e.from, e.to))) { seen.add(n); stack.push(n); }
            }
        }
        return seen;
    };
    const from = walk(true), to = walk(false);
    const visible = new Set([...start, ...[...from].filter((k) => to.has(k))]);
    const level = new Map<NodeKey, number>(start.map((s) => [s, 0] as const));
    const order = [...start];
    for (let i = 0; i < order.length; i++) {
        const k = order[i];
        for (const n of [...(vg.out.get(k) ?? []).map((e) => e.to), ...(vg.inc.get(k) ?? []).map((e) => e.from)]) {
            if (visible.has(n) && !level.has(n)) { level.set(n, level.get(k)! + 1); order.push(n); }
        }
    }
    for (const k of visible) if (!level.has(k)) { level.set(k, 0); order.push(k); }
    return { visible, order, opener: new Map(), allowed: new Map([...visible].map((k) => [k, 'both' as const])), level };
}

/**
 * Vertices on call paths between `from` and the vertices of `to`, either direction, any length, `from` and `to`
 * excluded: reached from `from` and reaching `to`, or reached from `to` and reaching `from` (`cut` calls not
 * followed). O(V + E).
 */
export function pathsThrough(vg: VGraph, from: NodeKey, to: readonly NodeKey[], cut: ReadonlySet<string> = new Set()): Set<NodeKey> {
    const ends = to.filter((t) => t !== from && vg.nodes.has(t));
    if (!vg.nodes.has(from) || !ends.length) return new Set();
    const walk = (start: readonly NodeKey[], down: boolean) => {
        const seen = new Set(start);
        const stack = [...start];
        while (stack.length) {
            const k = stack.pop()!;
            for (const e of (down ? vg.out.get(k) : vg.inc.get(k)) ?? []) {
                const n = down ? e.to : e.from;
                if (!seen.has(n) && !cut.has(cutKey(e.from, e.to))) { seen.add(n); stack.push(n); }
            }
        }
        return seen;
    };
    const fwd = walk([from], true), bwd = walk([from], false);
    const toFwd = walk(ends, true), toBwd = walk(ends, false);
    const out = new Set<NodeKey>();
    for (const k of fwd) if (toBwd.has(k)) out.add(k);
    for (const k of bwd) if (toFwd.has(k)) out.add(k);
    out.delete(from);
    for (const t of ends) out.delete(t);
    return out;
}

/** `rev` plus `keys` as pinned vertices: visible, both sides allowed, level 0, no opener. */
export function withPinned(rev: Reveal, keys: Iterable<NodeKey>): Reveal {
    for (const k of keys) {
        if (rev.visible.has(k)) continue;
        rev.visible.add(k); rev.order.push(k); rev.allowed.set(k, 'both'); rev.level.set(k, 0);
    }
    return rev;
}

