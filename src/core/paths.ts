/** @xvdp
 * Calls to fetch for the call paths between seeds (scene.ts revealView): a joined seed (`view.joins`), or with
 * `between` every seed, needs a path to another seed in the stored calls. Breadth-first levels from every seed over
 * the stored calls, calls downward (`out`) and callers upward (`in`), at most `view.depth` levels; the next pairs to
 * ask are the unasked ones of the nearest level. Empty when every such seed connects, or the levels hold no unasked
 * pair: the host asks, stores the answers, and calls again (host/editor.ts `pathData`).
 */
import { isContainer, NodeKey } from './model';
import { ViewDoc } from './viewdoc';

export interface PathPair { key: NodeKey; dir: 'in' | 'out' }

/** Seeds that must connect (joined, or all with `between`) and have no call path to another seed in the data. */
export function unconnected(doc: ViewDoc): NodeKey[] {
    const v = doc.view;
    const must = v.between ? v.seeds : (v.joins ?? []);
    if (!must.length || v.seeds.length < 2) return [];
    const out = new Map<NodeKey, NodeKey[]>(), inc = new Map<NodeKey, NodeKey[]>();
    for (const e of doc.graph.edges) { out.set(e.from, [...(out.get(e.from) ?? []), e.to]); inc.set(e.to, [...(inc.get(e.to) ?? []), e.from]); }
    const reach = (s: NodeKey, next: Map<NodeKey, NodeKey[]>) => {
        const seen = new Set([s]), stack = [s];
        while (stack.length) for (const n of next.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
        return seen;
    };
    return must.filter((s) => {
        const others = v.seeds.filter((o) => o !== s);
        const down = reach(s, out), up = reach(s, inc);
        return !others.some((o) => down.has(o) || up.has(o));
    });
}

/** Unasked (definition, direction) pairs of the nearest breadth-first level around the seeds; [] when nothing is due. */
export function pathPairs(doc: ViewDoc): PathPair[] {
    if (!unconnected(doc).length) return [];
    const ex = doc.explored ?? {};
    const asked = (k: NodeKey, dir: 'in' | 'out') => ex[k] === dir || ex[k] === 'both';
    const next = new Map<string, NodeKey[]>();
    for (const e of doc.graph.edges) {
        next.set(`out\u0000${e.from}`, [...(next.get(`out\u0000${e.from}`) ?? []), e.to]);
        next.set(`in\u0000${e.to}`, [...(next.get(`in\u0000${e.to}`) ?? []), e.from]);
    }
    const definition = (k: NodeKey) => Object.hasOwn(doc.graph.nodes, k) && (!isContainer(doc.graph.nodes[k]) || doc.graph.nodes[k].kind === 'class');
    let best = Infinity;
    const due: PathPair[] = [];
    for (const s of doc.view.seeds) {
        for (const dir of ['out', 'in'] as const) {
            let front = [s];
            const seen = new Set(front);
            for (let level = 0; level < Math.max(1, doc.view.depth) && front.length && level <= best; level++) {
                const open = front.filter((k) => definition(k) && !asked(k, dir));
                if (open.length) {
                    if (level < best) { best = level; due.length = 0; }
                    for (const k of open) if (!due.some((p) => p.key === k && p.dir === dir)) due.push({ key: k, dir });
                    break;
                }
                front = [...new Set(front.flatMap((k) => next.get(`${dir}\u0000${k}`) ?? []))].filter((k) => !seen.has(k) && (seen.add(k), true));
            }
        }
    }
    return due;
}
