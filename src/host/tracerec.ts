/** @xvdp 
 * Trace records (trace.ts), without VS Code: testable, and the format `tools/gaffy-trace.mjs` reads.
**/
import { ViewDoc } from '../core/viewdoc';

export interface Cause { event?: string; target?: string; cell?: [number, number]; fn?: string; args?: unknown }
export type Moved = [string, [number, number] | null, [number, number] | null][];

/** Changed fields of two views: objects per key, arrays as added and removed, other values as a pair. */
export function viewDiff(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const x = a[f], y = b[f];
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
        if (Array.isArray(x) || Array.isArray(y)) {
            const xs = new Set(((x ?? []) as unknown[]).map((v) => JSON.stringify(v)));
            const ys = new Set(((y ?? []) as unknown[]).map((v) => JSON.stringify(v)));
            out[f] = { added: [...ys].filter((v) => !xs.has(v)).map((v) => JSON.parse(v)), removed: [...xs].filter((v) => !ys.has(v)).map((v) => JSON.parse(v)) };
        } else if (x && y && typeof x === 'object' && typeof y === 'object') {
            const o: Record<string, unknown> = {};
            const xo = x as Record<string, unknown>, yo = y as Record<string, unknown>;
            for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)])) {
                if (JSON.stringify(xo[k]) !== JSON.stringify(yo[k])) o[k] = [xo[k] ?? null, yo[k] ?? null];
            }
            out[f] = o;
        } else out[f] = [x ?? null, y ?? null];
    }
    return out;
}

/** One trace record (trace.ts): what changed from `before` to `now`, and why. */
export function traceRecord(before: ViewDoc | undefined, now: ViewDoc, cause: Cause, moved: Moved | undefined, view: string, seq: number, t = new Date()) {
    const changed = before ? viewDiff(before.view as unknown as Record<string, unknown>, now.view as unknown as Record<string, unknown>) : {};
    const nodes = (d?: ViewDoc) => new Set(Object.keys(d?.graph.nodes ?? {}));
    const edges = (d?: ViewDoc) => new Set((d?.graph.edges ?? []).map((e) => `${e.from}\u0000${e.to}`));
    const count = (a: Set<string>, b: Set<string>) => [[...b].filter((x) => !a.has(x)).length, [...a].filter((x) => !b.has(x)).length];
    const [na, nr] = count(nodes(before), nodes(now)), [ea, er] = count(edges(before), edges(now));
    return {
        t: t.toISOString(), view, seq, cause, changed,
        ...(na || nr || ea || er ? { graph: { nodes: [na, nr], edges: [ea, er] } } : {}),
        ...(moved?.length ? { moved } : {}),
    };
}
