/** @xvdp
 * Visibility by open sides, VS Code call hierarchy in both directions.
 *
 * `view.open`: open sides per vertex; `down` shows callees, `up` callers, one layer.
 * Visible set: seeds, then breadth-first neighbors on open sides of visible vertices; a seed without entry opens
 * the view's traversal side. Open sides of non-visible vertices persist: reopening a parent restores lower layers.
 * `allowed`: seeds open both sides; vertices revealed via `down` only callees, via `up` only callers.
 * `view.cut`: calls not followed.
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
    cut: ReadonlySet<string> = new Set(),
): Reveal {
    const visible = new Set<NodeKey>();
    const order: NodeKey[] = [];
    const opener = new Map<NodeKey, { by: NodeKey; side: 'up' | 'down' }>();
    const allowed = new Map<NodeKey, OpenSide>();
    const level = new Map<NodeKey, number>();
    const q: NodeKey[] = [];
    for (const s of seeds) if (vg.nodes.has(s) && !visible.has(s)) { visible.add(s); order.push(s); q.push(s); allowed.set(s, 'both'); level.set(s, 0); }
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
