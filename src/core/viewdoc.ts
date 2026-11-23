/** @xvdp
 * View document: the content of a `.gaffy` file. One view = seeds, traversal, user overrides, and the
 * last resolved subgraph, so a view opens without a language server.
 *
 * Placement units: a vertex key moves the vertex with its tree descendants; `box:<container key>`
 * moves a namespace box with its content. `offset` holds unlocked moves relative to the computed
 * placement; `lock` holds absolute positions (column, row) of locked units, which the placement of
 * every unlocked unit avoids.
 */
import { ancestors, emptyGraph, GEdge, GNode, NodeKey, Subgraph } from './model';
import type { Curve } from './style';

export type Direction = 'in' | 'out' | 'both';
export type EdgeMode = 'glyph' | 'vector';
export type ParentRule = 'dfs' | 'nearest' | 'joint';
export type Cell = [number, number];        // [column, row]
export type Depth = number | 'all';         // call levels from the seeds; `all`: every level the data holds
export type DepthRule = 'shortest' | 'longest';
export type OpenSide = 'up' | 'down' | 'both' | 'none';

export const ROOTS = '__roots__';
export const boxUnit = (containerKey: string) => `box:${containerKey}`;
/**
 * Unit of a collapsed container's vertex: its moves and locks are its own, so expanding returns to the layout
 * before the collapse (a class is a vertex of its own when expanded too, under its plain key).
 */
export const collapsedUnit = (containerKey: string) => `collapsed:${containerKey}`;

/**
 * Drops the moves and locks of `container` and of everything inside it (its box, the boxes and functions in
 * it, collapsed ones included). Offsets count from the computed place inside the box holding them; when that
 * box dissolves or a new box forms (ungroup, group), the same offsets land at unrelated cells, so the content
 * takes computed places in its new group instead. Moves outside the container stay.
 */
export function dropMovesWithin(doc: ViewDoc, container: NodeKey): void {
    const inside = (k: NodeKey) => k === container || ancestors(doc.graph.nodes, k).includes(container);
    for (const table of [doc.view.offset, doc.view.lock]) {
        for (const u of Object.keys(table)) {
            const key = u.startsWith('box:') ? u.slice(4) : u.startsWith('collapsed:') ? u.slice('collapsed:'.length) : u;
            if (inside(key)) delete table[u];
        }
    }
}

export interface ViewSpec {
    seeds: NodeKey[];
    direction: Direction;                    // sides a seed opens first (one layer at a time); levels a full view starts with
    depth: number;                           // one layer at a time: levels prefetched from the language server
    collapsed: NodeKey[];                    // collapse set K
    hidden: NodeKey[];
    open?: Record<NodeKey, OpenSide>;        // one layer at a time: open sides per vertex
    arrange: 'grow' | 'auto';                // grow: one layer at a time; auto: full, every vertex within depthUp, depthDown
    depthUp: Depth;                          // full: caller levels above the seeds
    depthDown: Depth;                        // full: callee levels below the seeds
    depthRule: DepthRule;                    // full: a vertex's level is its shortest or its longest call path from the seeds
    sibling: Record<NodeKey, NodeKey[]>;     // child order per tree parent; ROOTS orders the top level
    offset: Record<string, Cell>;            // unlocked moves: [Δcolumn, Δrow] per unit
    lock: Record<string, Cell>;              // locked units: absolute [column, row]
    exclude: string[];                       // folders (workspace-relative) left out of the build
    include: string[];                       // folders kept although `gaffy.exclude` matches them
    group: NodeKey[];                        // containers boxed on demand (modules, classes)
    ungroup: NodeKey[];                      // containers whose box is dissolved into the parent box
    boxes?: boolean;                         // overrides style.boxes.enabled
    edges?: EdgeMode;                        // overrides style.edges.mode
    curve?: Curve;                           // overrides style.edges.curve
    parentRule?: ParentRule;                 // overrides style.grid.parentRule
    tight?: boolean;                         // namespace frames hug their content (moved content pulls the frame edges); overrides style.boxes.tight
    static?: boolean;                        // a fixed graph (written by hand or generated): no language-server requests
    tags: Record<NodeKey, string>;
    straight?: string[];                     // calls routed before all others (caller\u0000callee)
    cut?: [NodeKey, NodeKey][];              // one layer at a time: removed calls [caller, callee], not drawn, not followed
}

export interface ViewDoc {
    gaffy: 1;
    name: string;
    view: ViewSpec;
    graph: Subgraph;                         // last build
    explored?: Record<NodeKey, Direction>;   // directions the last build asked the provider for, per vertex
    truncated?: boolean;                     // build stopped at maxNodes
    updated?: string;                        // ISO time of last build
}

export function defaultView(): ViewSpec {
    return {
        seeds: [], direction: 'out', depth: 4, collapsed: [], hidden: [], depthUp: 0, depthDown: 4, depthRule: 'shortest',
        sibling: {}, offset: {}, lock: {}, exclude: [], include: [], group: [], ungroup: [], tags: {}, arrange: 'auto',
    };
}

export function emptyDoc(name: string, view: Partial<ViewSpec> = {}): ViewDoc {
    const v = { ...defaultView(), ...view };
    // call depths not given: the sides of `direction`, to `depth`
    if (view.depthUp === undefined) v.depthUp = v.direction !== 'out' ? v.depth : 0;
    if (view.depthDown === undefined) v.depthDown = v.direction !== 'in' ? v.depth : 0;
    return { gaffy: 1, name, view: v, graph: emptyGraph() };
}

/** Parses a `.gaffy` text; missing fields take defaults; unknown fields are dropped; empty text yields an empty view. */
/** Largest offset component and lock cell (cells) a view file may hold: the grid a layout allocates grows with them. */
export const MAX_OFFSET = 1000, MAX_LOCK = 2000;

/**
 * A view document from its JSON text. Values from the file are checked, not trusted (a view may come from a cloned
 * repository): lists keep strings, keyed records drop the keys `__proto__`, `constructor`, `prototype` and values of
 * the wrong type, offsets and locks are integer cells within ±MAX_OFFSET and [0, MAX_LOCK], enumerations keep known
 * values. Older formats migrate (per-side depths from `direction` and `depth`).
 */
export function parseDoc(text: string, fallbackName = 'view'): ViewDoc {
    if (!text.trim()) return emptyDoc(fallbackName);
    const raw = JSON.parse(text) as Partial<ViewDoc>;
    const v = (raw.view ?? {}) as Partial<ViewSpec> & Record<string, unknown>;
    const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
    const keyed = <T>(x: unknown, ok: (val: unknown) => T | undefined): Record<string, T> => {
        const out: Record<string, T> = {};
        if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
        for (const [k, val] of Object.entries(x)) { const t = PROTO.has(k) ? undefined : ok(val); if (t !== undefined) out[k] = t; }
        return out;
    };
    const int = (n: unknown, lo: number, hi: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : undefined);
    const cell = (lo: number, hi: number) => (x: unknown): Cell | undefined => {
        if (!Array.isArray(x) || x.length !== 2) return undefined;
        const a = int(x[0], lo, hi), b = int(x[1], lo, hi);
        return a === undefined || b === undefined ? undefined : [a, b];
    };
    const oneOf = <T extends string>(x: unknown, vals: readonly T[]): T | undefined => (vals.includes(x as T) ? x as T : undefined);
    const direction = oneOf(v.direction, ['in', 'out', 'both'] as const) ?? 'out';
    const depth = int(v.depth, 0, 1000) ?? 4;
    const level = (d: unknown, on: boolean): Depth => (d === 'all' ? 'all' : int(d, 0, 1000) ?? (on ? depth : 0));
    const view: ViewSpec = {
        seeds: strs(v.seeds),
        direction,
        depth,
        collapsed: strs(v.collapsed),
        hidden: strs(v.hidden),
        // full views before per-side depths: the old direction and depth
        depthUp: level(v.depthUp, direction !== 'out'),
        depthDown: level(v.depthDown, direction !== 'in'),
        depthRule: v.depthRule === 'longest' ? 'longest' : 'shortest',
        sibling: keyed(v.sibling, (x) => (Array.isArray(x) ? strs(x) : undefined)),
        offset: keyed(v.offset, cell(-MAX_OFFSET, MAX_OFFSET)),
        lock: keyed(v.lock, cell(0, MAX_LOCK)),
        exclude: strs(v.exclude),
        include: strs(v.include),
        group: strs(v.group),
        ungroup: strs(v.ungroup),
        arrange: v.arrange === 'grow' ? 'grow' : 'auto',
        tags: keyed(v.tags, (x) => (typeof x === 'string' ? x.slice(0, 80) : undefined)),
    };
    if (v.open) view.open = keyed(v.open, (x) => oneOf(x, ['up', 'down', 'both', 'none'] as const));
    const straight = strs(v.straight);
    if (straight.length) view.straight = straight;
    if (Array.isArray(v.cut)) {
        const cut = v.cut.filter((c: unknown): c is [string, string] => Array.isArray(c) && c.length === 2 && typeof c[0] === 'string' && typeof c[1] === 'string');
        if (cut.length) view.cut = cut;
    }
    if (typeof v.boxes === 'boolean') view.boxes = v.boxes;
    const edges = oneOf(v.edges, ['glyph', 'vector'] as const);
    if (edges) view.edges = edges;
    const curve = oneOf(v.curve, ['orthogonal', 'rounded', 'sigmoid', 'spline'] as const);
    if (curve) view.curve = curve;
    const parentRule = oneOf(v.parentRule, ['dfs', 'nearest', 'joint'] as const);
    if (parentRule) view.parentRule = parentRule;
    if (typeof v.tight === 'boolean') view.tight = v.tight;
    if (v.static === true) view.static = true;
    const doc = emptyDoc(typeof raw.name === 'string' ? raw.name : fallbackName, view);
    /* secure tooling: drop object behaviour altering prototype keys, `<lang>:<path>#<qual>`, e.g. `JSON __proto__`. */
    const nodes = keyed(raw.graph?.nodes, (x) => (x && typeof x === 'object' && typeof (x as GNode).key === 'string' ? x as GNode : undefined));
    const edgeList = Array.isArray(raw.graph?.edges) ? raw.graph!.edges.filter((e: unknown) => !!e && typeof (e as GEdge).from === 'string' && typeof (e as GEdge).to === 'string') : [];
    doc.graph = { nodes, edges: edgeList };
    if (raw.explored) doc.explored = keyed(raw.explored, (x) => oneOf(x, ['in', 'out', 'both'] as const));
    if (raw.truncated) doc.truncated = true;
    if (typeof raw.updated === 'string') doc.updated = raw.updated;
    return doc;
}

const PROTO = new Set(['__proto__', 'constructor', 'prototype']);

export function serializeDoc(doc: ViewDoc): string {
    return JSON.stringify(doc, null, 1) + '\n';
}

/**
 * Paths of a language's own builtins and standard library, as `externalPath` (langs.ts) keys files outside
 * the workspace: Python typeshed `stdlib/` and `pythonX.Y/` (a `site-packages` inside it keys from
 * `site-packages/`), Rust `library/` (core, alloc, std), TypeScript `…/typescript/lib/lib.*.d.ts`, C++
 * `include/c++/`. Meaningful for external nodes only: a workspace folder may carry such a name.
 */
const STANDARD = /^(stdlib|python\d+(\.\d+)?)\/|^library\/|(^|\/)typescript\/lib\/lib\.[^/]*\.d\.ts$|^include\/c\+\+\//;
export const isStandard = (path: string | undefined): boolean => !!path && STANDARD.test(path);

/** Workspace-relative folder filter: `view.exclude` always applies; a glob from `gaffy.exclude` applies unless `view.include` covers the path. */
export function excludedBy(view: ViewSpec, globs: readonly PathTest[]) {
    const under = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith('/') ? dir : dir + '/');
    return (path: string | undefined): boolean => {
        if (!path) return false;
        if (view.exclude.some((d) => under(path, d))) return true;
        if (view.include.some((d) => under(path, d))) return false;
        return globs.some((g) => g.test(path));
    };
}

/** A test on workspace-relative paths: what `globMatcher` returns; a RegExp has the same method. */
export interface PathTest { test(path: string): boolean }

/**
 * Glob over `/`-separated paths → a path test: `**` any characters, `**` + `/` zero or more whole segments, `*` any
 * characters of one segment, `?` one character of a segment, other characters literal; the whole path must match.
 * Matching advances the set of reachable path positions token by token, without backtracking: O(tokens · path
 * length). The equivalent regular expression backtracks exponentially in the number of `**` on paths that nearly
 * match (41 s measured for 8 `**a` against 60 characters), and globs come from workspace settings.
 */
export function globMatcher(glob: string): PathTest {
    type Tok = { k: 'lit'; c: string } | { k: 'one' | 'seg' | 'any' | 'dirs' };
    const toks: Tok[] = [];
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            i++;
            if (glob[i + 1] === '/') { i++; toks.push({ k: 'dirs' }); } else toks.push({ k: 'any' });
        } else if (c === '*') toks.push({ k: 'seg' });
        else if (c === '?') toks.push({ k: 'one' });
        else toks.push({ k: 'lit', c });
    }
    return {
        test(path: string): boolean {
            const n = path.length;
            let at = new Uint8Array(n + 1);
            at[0] = 1;
            for (const t of toks) {
                const nx = new Uint8Array(n + 1);
                if (t.k === 'lit' || t.k === 'one') {
                    for (let i = 0; i < n; i++) if (at[i] && (t.k === 'lit' ? path[i] === t.c : path[i] !== '/')) nx[i + 1] = 1;
                } else {
                    // seg: extend within the segment; any: extend over everything; dirs: stay, or end right after a '/'
                    let seen = 0;
                    for (let j = 0; j <= n; j++) {
                        if (t.k === 'seg') nx[j] = at[j] || (j > 0 && nx[j - 1] && path[j - 1] !== '/') ? 1 : 0;
                        else if (t.k === 'any') nx[j] = at[j] || (j > 0 && nx[j - 1]) ? 1 : 0;
                        else { nx[j] = at[j] || (seen && j > 0 && path[j - 1] === '/') ? 1 : 0; }
                        if (at[j]) seen = 1;
                    }
                }
                at = nx;
            }
            return at[n] === 1;
        },
    };
}
