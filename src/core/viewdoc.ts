/** @xvdp
 * View document: `.gaffy` file content: seeds, traversal, user overrides, last resolved subgraph (opens without
 * a language server).
 *
 * Placement unit: vertex key (vertex, tree descendants) or `box:<container key>` (namespace box, content).
 * `offset`: unlocked moves from computed placement; `lock`: absolute cells of locked units, avoided by unlocked ones.
 */
import { ancestors, emptyGraph, GEdge, GNode, NodeKey, Subgraph } from './model';
import { parseRules, RuleConfig } from './rules';
import type { Curve } from './style';

export type Direction = 'in' | 'out' | 'both';
export type EdgeMode = 'glyph' | 'vector';
export type ParentRule = 'dfs' | 'nearest' | 'joint';
export type Cell = [number, number];        // [column, row]
export type Depth = number | 'all';         // call levels from seeds; `all`: every level in the data
export type DepthRule = 'shortest' | 'longest';
export type OpenSide = 'up' | 'down' | 'both' | 'none';

export const ROOTS = '__roots__';
export const boxUnit = (containerKey: string) => `box:${containerKey}`;
/**
 * Collapsed container's vertex unit, with own moves and locks: expanding restores the pre-collapse layout.
 * Expanded class: plain key.
 */
export const collapsedUnit = (containerKey: string) => `collapsed:${containerKey}`;

/**
 * Drops moves and locks of `container` and its content (boxes, functions, collapsed units), and moves and locks
 * of the boxes around it (their chain compression, hence their keys, change with the grouping). Offsets are relative
 * to the enclosing box, so after group or ungroup the content returns to computed places. Other moves stay.
 */
export function dropMovesWithin(doc: ViewDoc, container: NodeKey): void {
    const inside = (k: NodeKey) => k === container || ancestors(doc.graph.nodes, k).includes(container);
    // boxes around the container: grouping changes their chain compression, so their keys may change too
    const around = new Set(ancestors(doc.graph.nodes, container));
    for (const table of [doc.view.offset, doc.view.lock]) {
        for (const u of Object.keys(table)) {
            const key = u.startsWith('box:') ? u.slice(4) : u.startsWith('collapsed:') ? u.slice('collapsed:'.length) : u;
            if (inside(key) || (u.startsWith('box:') && around.has(key))) delete table[u];
        }
    }
}

export interface ViewSpec {
    seeds: NodeKey[];
    direction: Direction;                    // grow: sides a seed opens first; auto: initial levels
    depth: number;                           // grow: levels prefetched from the language server
    collapsed: NodeKey[];                    // collapse set K
    hidden: NodeKey[];
    open?: Record<NodeKey, OpenSide>;        // grow: open sides per vertex
    arrange: 'grow' | 'auto';                // grow: one layer at a time; auto: all levels within depthUp, depthDown
    depthUp: Depth;                          // auto: caller levels above seeds
    depthDown: Depth;                        // auto: called levels below seeds
    depthRule: DepthRule;                    // auto: level = shortest or longest call path from seeds
    sibling: Record<NodeKey, NodeKey[]>;     // child order per tree parent; ROOTS: top level
    offset: Record<string, Cell>;            // unlocked moves: [Δcolumn, Δrow] per unit
    lock: Record<string, Cell>;              // locked units: absolute [column, row]
    exclude: string[];                       // workspace-relative folders excluded from build
    include: string[];                       // folders kept despite `gaffy.exclude` match
    group: NodeKey[];                        // containers boxed on demand (modules, classes)
    ungroup: NodeKey[];                      // containers dissolved into parent box
    boxes?: boolean;                         // overrides style.boxes.enabled
    edges?: EdgeMode;                        // overrides style.edges.mode
    curve?: Curve;                           // overrides style.edges.curve
    parentRule?: ParentRule;                 // overrides style.grid.parentRule
    tight?: boolean;                         // frames hug content, moved content included; overrides style.boxes.tight
    static?: boolean;                        // fixed graph (hand-written or generated): no language-server requests
    live?: string;                           // editor session that unfroze the view; any other session opens it frozen
    external?: boolean;                      // external code drawn and asked; default: setting gaffy.includeExternal
    stdlib?: boolean;                        // with external code, the standard library; default: gaffy.includeStandardLibrary
    save?: boolean;                          // file saved after every change, whatever gaffy.autoSave says (script views)
    between?: boolean;                       // drawn: only functions on call paths between seeds (scene.ts `onPaths`)
    pinned?: NodeKey[];                      // grow: functions shown without an opener (the paths left by `between` off)
    joins?: NodeKey[];                       // seeds added to a view: closed until a side opens, drawn with the call paths to the other seeds
    rules?: RuleConfig;                      // rule switches, alternatives, parameters over style.json `rules` (rules.ts)
    pinPaths?: boolean;                      // grow + between: after the first build, the paths pinned, `between` off (giddy)
    tags: Record<NodeKey, string>;
    straight?: string[];                     // calls routed first (caller\u0000called)
    cut?: [NodeKey, NodeKey][];              // grow: removed calls [caller, called], neither drawn nor followed
}

export interface ViewDoc {
    gaffy: 1;
    name: string;
    view: ViewSpec;
    graph: Subgraph;                         // last build
    explored?: Record<NodeKey, Direction>;   // per vertex: directions requested in last build
    truncated?: boolean;                     // build stopped at maxNodes
    updated?: string;                        // ISO time of last build
    commit?: string;                         // short commit hash of the view's project at last build
}

export function defaultView(): ViewSpec {
    return {
        seeds: [], direction: 'out', depth: 4, collapsed: [], hidden: [], depthUp: 0, depthDown: 4, depthRule: 'shortest',
        sibling: {}, offset: {}, lock: {}, exclude: [], include: [], group: [], ungroup: [], tags: {}, arrange: 'auto',
    };
}

export function emptyDoc(name: string, view: Partial<ViewSpec> = {}): ViewDoc {
    const v = { ...defaultView(), ...view };
    // missing call depths: sides of `direction`, to `depth`
    if (view.depthUp === undefined) v.depthUp = v.direction !== 'out' ? v.depth : 0;
    if (view.depthDown === undefined) v.depthDown = v.direction !== 'in' ? v.depth : 0;
    return { gaffy: 1, name, view: v, graph: emptyGraph() };
}

/** Offset component and lock cell bounds (cells); layout grid allocation grows with them. */
export const MAX_OFFSET = 1000, MAX_LOCK = 2000;

/**
 * `.gaffy` JSON text => view document; empty text => empty view, missing fields => defaults, unknown fields dropped.
 * Untrusted (cloned repositories): lists keep strings; keyed records drop `__proto__`, `constructor`, `prototype`
 * keys and wrongly typed values; offsets, locks: integer cells in ±MAX_OFFSET, [0, MAX_LOCK]; enumerations keep
 * known values. Migration: per-side depths from `direction`, `depth`.
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
        // legacy full views: depths from direction, depth
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
    const pinned = strs(v.pinned);
    if (pinned.length) view.pinned = pinned;
    const joins = strs(v.joins).filter((k) => view.seeds.includes(k));
    if (joins.length) view.joins = joins;
    const rules = parseRules(v.rules);
    if (rules) view.rules = rules;
    if (v.pinPaths === true) view.pinPaths = true;
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
    if (v.save === true) view.save = true;
    if (v.between === true) view.between = true;
    if (typeof v.live === 'string' && /^[0-9a-f]{8,40}$/.test(v.live)) view.live = v.live;
    if (typeof v.external === 'boolean') view.external = v.external;
    if (typeof v.stdlib === 'boolean') view.stdlib = v.stdlib;
    const doc = emptyDoc(typeof raw.name === 'string' ? raw.name : fallbackName, view);
    /* secure tooling: node keys `<lang>:<path>#<qual>`; prototype keys (JSON `__proto__`) dropped. */
    const nodes = keyed(raw.graph?.nodes, (x) => (x && typeof x === 'object' && typeof (x as GNode).key === 'string' ? x as GNode : undefined));
    const edgeList: GEdge[] = (Array.isArray(raw.graph?.edges) ? raw.graph!.edges.filter((e: unknown) => !!e && typeof (e as GEdge).from === 'string' && typeof (e as GEdge).to === 'string') : [])
        .map((e: GEdge) => (e.seen === undefined || e.seen === 'in' || e.seen === 'out' || e.seen === 'both' ? e : { ...e, seen: undefined }));
    doc.graph = { nodes, edges: edgeList };
    if (raw.explored) doc.explored = keyed(raw.explored, (x) => oneOf(x, ['in', 'out', 'both'] as const));
    if (raw.truncated) doc.truncated = true;
    if (typeof raw.updated === 'string') doc.updated = raw.updated;
    if (typeof raw.commit === 'string' && /^[0-9a-f]{4,40}$/.test(raw.commit)) doc.commit = raw.commit;
    return doc;
}

/** Built: the view holds language-server answers (a new view holds only its seed's records). */
export const isBuilt = (d: ViewDoc) => !!d.updated || Object.keys(d.explored ?? {}).length > 0;

const PROTO = new Set(['__proto__', 'constructor', 'prototype']);

export function serializeDoc(doc: ViewDoc): string {
    return JSON.stringify(doc, null, 1) + '\n';
}

/**
 * Builtin and standard-library paths, keyed by `externalPath` (langs.ts): Python typeshed `stdlib/`, `pythonX.Y/`
 * (nested `site-packages` keys from `site-packages/`), Rust `library/` (core, alloc, std), TypeScript
 * `.../typescript/lib/lib.*.d.ts`, C++ `include/c++/`. External nodes only: workspace folders may share these names.
 */
const STANDARD = /^(stdlib|python\d+(\.\d+)?)\/|^library\/|(^|\/)typescript\/lib\/lib\.[^/]*\.d\.ts$|^include\/c\+\+\//;
export const isStandard = (path: string | undefined): boolean => !!path && STANDARD.test(path);

/** Workspace-relative folder filter: `view.exclude` always; `gaffy.exclude` globs unless `view.include` covers it. */
export function excludedBy(view: ViewSpec, globs: readonly PathTest[]) {
    const under = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith('/') ? dir : dir + '/');
    return (path: string | undefined): boolean => {
        if (!path) return false;
        if (view.exclude.some((d) => under(path, d))) return true;
        if (view.include.some((d) => under(path, d))) return false;
        return globs.some((g) => g.test(path));
    };
}

/** Workspace-relative path test: `globMatcher` result or a RegExp. */
export interface PathTest { test(path: string): boolean }

/**
 * Glob => whole-path test, `/`-separated: `**` any characters, `**` + `/` zero or more segments, `*` within one
 * segment, `?` one non-`/` character, others literal. Reachable-position set per token, no backtracking:
 * O(tokens · path length). Equivalent regex: exponential backtracking in `**` count on near-matches (41 s measured,
 * 8 `**a`, 60 characters); globs come from workspace settings.
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
                    // seg: extend within segment; any: extend anywhere; dirs: stay, or end right after '/'
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
