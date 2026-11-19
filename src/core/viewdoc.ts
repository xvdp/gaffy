/**
 * View document: the content of a `.gaffy` file. One view = seeds, traversal, user overrides, and the
 * last resolved subgraph, so a view opens without a language server.
 *
 * Placement units: a vertex key moves the vertex with its tree descendants; `box:<container key>`
 * moves a namespace box with its content. `offset` holds unlocked moves relative to the computed
 * placement; `lock` holds absolute positions (column, row) of locked units, which the placement of
 * every unlocked unit avoids.
 */
import { emptyGraph, NodeKey, Subgraph } from './model';
import type { Curve } from './style';

export type Direction = 'in' | 'out' | 'both';
export type Order = 'callers' | 'callees';
export type EdgeMode = 'glyph' | 'vector';
export type ParentRule = 'dfs' | 'nearest' | 'joint';
export type Cell = [number, number];        // [column, row]
export type FoldSide = 'down' | 'up';       // down: what a vertex calls; up: what calls it
export type OpenSide = 'up' | 'down' | 'both' | 'none';

export const ROOTS = '__roots__';
export const boxUnit = (containerKey: string) => `box:${containerKey}`;

export interface ViewSpec {
  seeds: NodeKey[];
  direction: Direction;
  depth: number;
  expanded: Record<NodeKey, Direction>;   // per-node expansions beyond the depth limit
  collapsed: NodeKey[];                    // collapse set K
  hidden: NodeKey[];
  fold: Record<NodeKey, FoldSide>;         // auto arrangement: folded sides
  open?: Record<NodeKey, OpenSide>;        // open sides per vertex; absent: every vertex visible
  arrange: 'grow' | 'auto';                // grow: one layer per open side; auto: every vertex to the depth limit, with folds
  order: Order;                            // callers: caller above, `└─>` to callee; callees: callee above, `└──` to caller
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
  tags: Record<NodeKey, string>;
  straight?: string[];                     // calls routed before all others (caller\u0000callee, drawn direction)
  cut?: [NodeKey, NodeKey][];              // removed calls [caller, callee]: not drawn, not followed by open sides
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
    seeds: [], direction: 'out', depth: 4, expanded: {}, collapsed: [], hidden: [], fold: {}, order: 'callers',
    sibling: {}, offset: {}, lock: {}, exclude: [], include: [], group: [], ungroup: [], tags: {}, arrange: 'auto',
  };
}

export function emptyDoc(name: string, view: Partial<ViewSpec> = {}): ViewDoc {
  return { gaffy: 1, name, view: { ...defaultView(), ...view }, graph: emptyGraph() };
}

/** Parses a `.gaffy` text; missing fields take defaults; unknown fields are dropped; empty text yields an empty view. */
export function parseDoc(text: string, fallbackName = 'view'): ViewDoc {
  if (!text.trim()) return emptyDoc(fallbackName);
  const raw = JSON.parse(text) as Partial<ViewDoc>;
  const v = (raw.view ?? {}) as Partial<ViewSpec> & Record<string, unknown>;
  const view: ViewSpec = {
    seeds: v.seeds ?? [],
    direction: v.direction ?? 'out',
    depth: v.depth ?? 4,
    expanded: v.expanded ?? {},
    collapsed: v.collapsed ?? [],
    hidden: v.hidden ?? [],
    fold: v.fold ?? Object.fromEntries(((v as { folded?: NodeKey[] }).folded ?? []).map((k) => [k, 'down' as FoldSide])),
    order: v.order === 'callees' ? 'callees' : 'callers',
    sibling: v.sibling ?? {},
    offset: v.offset ?? {},
    lock: v.lock ?? {},
    exclude: v.exclude ?? [],
    include: v.include ?? [],
    group: v.group ?? [],
    ungroup: v.ungroup ?? [],
    arrange: v.arrange === 'grow' ? 'grow' : 'auto',
    tags: v.tags ?? {},
  };
  if (v.open) view.open = v.open;
  if (v.straight?.length) view.straight = v.straight;
  if (Array.isArray(v.cut) && v.cut.length) view.cut = v.cut.filter((c: unknown) => Array.isArray(c) && c.length === 2);
  if (v.boxes !== undefined) view.boxes = v.boxes;
  if (v.edges) view.edges = v.edges;
  if (v.curve) view.curve = v.curve;
  if (v.parentRule) view.parentRule = v.parentRule;
  const doc = emptyDoc(raw.name ?? fallbackName, view);
  doc.graph = { nodes: raw.graph?.nodes ?? {}, edges: raw.graph?.edges ?? [] };
  if (raw.explored) doc.explored = raw.explored;
  if (raw.truncated) doc.truncated = true;
  if (raw.updated) doc.updated = raw.updated;
  return doc;
}

export function serializeDoc(doc: ViewDoc): string {
  return JSON.stringify(doc, null, 1) + '\n';
}

/** Workspace-relative folder filter: `view.exclude` always applies; a glob from `gaffy.exclude` applies unless `view.include` covers the path. */
export function excludedBy(view: ViewSpec, globs: readonly RegExp[]) {
  const under = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith('/') ? dir : dir + '/');
  return (path: string | undefined): boolean => {
    if (!path) return false;
    if (view.exclude.some((d) => under(path, d))) return true;
    if (view.include.some((d) => under(path, d))) return false;
    return globs.some((g) => g.test(path));
  };
}

/** Glob to RegExp over `/`-separated paths: `**` any depth, `*` one segment part, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
