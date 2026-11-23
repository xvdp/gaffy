/** @xvdp 
 * Trace records (trace.ts) without VS Code: testable; format read by `tools/gaffy-trace.mjs`.
**/
import { ViewDoc } from '../core/viewdoc';

export interface Cause { event?: string; target?: string; cell?: [number, number]; fn?: string; args?: unknown }
export type Moved = [string, [number, number] | null, [number, number] | null][];

const str = (x: unknown, n = 200) => (typeof x === 'string' ? x.slice(0, n) : undefined);
const cellOf = (x: unknown): [number, number] | null =>
    (Array.isArray(x) && x.length === 2 && Number.isInteger(x[0]) && Number.isInteger(x[1]) ? [x[0], x[1]] : null);

/**
 * Type checks on webview cause and moved cells (the webview renders outside data): strings ≤ 200 characters
 * (`event` 80), cells integer pairs, `args` if its JSON is < 2000 characters, ≤ 2000 moved entries.
 */
export function checkedCause(cause: unknown, moved: unknown): { cause: Cause; moved?: Moved } | undefined {
    if (!cause || typeof cause !== 'object') return undefined;
    const c = cause as Record<string, unknown>;
    let args: unknown;
    try { args = c.args !== undefined && JSON.stringify(c.args).length < 2000 ? c.args : undefined; } catch { args = undefined; }
    const out: Cause = { event: str(c.event, 80), target: str(c.target), cell: cellOf(c.cell) ?? undefined, fn: str(c.fn), args };
    const m = Array.isArray(moved)
        ? moved.slice(0, 2000).filter((e): e is unknown[] => Array.isArray(e) && e.length === 3 && typeof e[0] === 'string')
            .map((e) => [str(e[0])!, cellOf(e[1]), cellOf(e[2])] as Moved[number])
        : undefined;
    return { cause: out, moved: m };
}

/** Changed view fields: objects per key, arrays as added/removed, else a pair. */
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

/** Trace record (trace.ts): change from `before` to `now`, and its cause. */
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
