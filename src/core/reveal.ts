/**
 * Visibility by open sides, as in the VS Code call hierarchy, in both directions.
 *
 * Each vertex has open sides (`view.open`): `down` shows what it calls, `up` what calls it, one layer.
 * Visible: the seeds, then breadth-first every neighbor on an open side of a visible vertex. A seed
 * without an entry opens the traversal side of the view. Open sides of vertices that are not visible
 * stay recorded, so reopening a parent restores the layers below it.
 *
 * Direction: a seed may open both sides; a vertex revealed through calls (`down`) opens only its calls,
 * one revealed through callers (`up`) only its callers (`allowed`). The view explores what flows into
 * and out of its seeds; the other callers of a callee belong to another view.
 * Cut calls (`view.cut`) are not followed.
 * Without `view.open` (views from before open sides) every vertex is visible and may open both sides.
 */
import { NodeKey } from './model';
import { VGraph } from './quotient';
import type { Direction, OpenSide } from './viewdoc';

export interface Reveal {
  visible: Set<NodeKey>;
  order: NodeKey[];                                                  // breadth-first, seeds first
  opener: Map<NodeKey, { by: NodeKey; side: 'up' | 'down' }>;        // who revealed a vertex, on which of its sides
  allowed: Map<NodeKey, OpenSide>;                                   // sides a vertex may open
}

export const seedSide = (d: Direction): OpenSide => (d === 'out' ? 'down' : d === 'in' ? 'up' : 'both');
export const opens = (s: OpenSide | undefined, side: 'up' | 'down') => s === side || s === 'both';
export const cutKey = (caller: NodeKey, callee: NodeKey) => `${caller}\u0000${callee}`;

/** Open sides of a vertex limited to the sides it may open. */
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
  if (!open) {
    for (const k of vg.nodes.keys()) { visible.add(k); order.push(k); allowed.set(k, 'both'); }
    return { visible, order, opener, allowed };
  }
  const q: NodeKey[] = [];
  for (const s of seeds) if (vg.nodes.has(s) && !visible.has(s)) { visible.add(s); order.push(s); q.push(s); allowed.set(s, 'both'); }
  const seedSet = new Set(seeds);
  while (q.length) {
    const k = q.shift()!;
    const side = within(open[k] ?? (seedSet.has(k) ? seedSide(direction) : undefined), allowed.get(k));
    const take = (n: NodeKey, s: 'up' | 'down') => {
      if (visible.has(n)) return;
      visible.add(n);
      order.push(n);
      opener.set(n, { by: k, side: s });
      allowed.set(n, s);
      q.push(n);
    };
    if (opens(side, 'down')) {
      for (const e of [...(vg.out.get(k) ?? [])].sort((a, b) => a.line - b.line)) if (!cut.has(cutKey(k, e.to))) take(e.to, 'down');
    }
    if (opens(side, 'up')) {
      for (const e of [...(vg.inc.get(k) ?? [])].sort((a, b) => a.line - b.line)) if (!cut.has(cutKey(e.from, k))) take(e.from, 'up');
    }
  }
  return { visible, order, opener, allowed };
}
