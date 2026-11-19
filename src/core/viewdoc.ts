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
export type EdgeMode = 'glyph' | 'vector';
export type ParentRule = 'dfs' | 'nearest' | 'joint';
export type Cell = [number, number];        // [column, row]
export type Depth = number | 'all';         // call levels from the seeds; `all`: every level the data holds
export type DepthRule = 'shortest' | 'longest';
export type OpenSide = 'up' | 'down' | 'both' | 'none';

export const ROOTS = '__roots__';
export const boxUnit = (containerKey: string) => `box:${containerKey}`;

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
export function parseDoc(text: string, fallbackName = 'view'): ViewDoc {
  if (!text.trim()) return emptyDoc(fallbackName);
  const raw = JSON.parse(text) as Partial<ViewDoc>;
  const v = (raw.view ?? {}) as Partial<ViewSpec> & Record<string, unknown>;
  const direction = v.direction ?? 'out';
  const depth = v.depth ?? 4;
  const level = (d: unknown, on: boolean): Depth => (d === 'all' || (typeof d === 'number' && d >= 0) ? d as Depth : on ? depth : 0);
  const view: ViewSpec = {
    seeds: v.seeds ?? [],
    direction,
    depth,
    collapsed: v.collapsed ?? [],
    hidden: v.hidden ?? [],
    // full views before per-side depths: the old direction and depth
    depthUp: level(v.depthUp, direction !== 'out'),
    depthDown: level(v.depthDown, direction !== 'in'),
    depthRule: v.depthRule === 'longest' ? 'longest' : 'shortest',
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
  // node keys are `<lang>:<path>#<qual>`; a key naming an object's prototype is not one, and is dropped
  const nodes = Object.fromEntries(Object.entries(raw.graph?.nodes ?? {}).filter(([key]) => !PROTO.has(key)));
  doc.graph = { nodes, edges: Array.isArray(raw.graph?.edges) ? raw.graph!.edges : [] };
  if (raw.explored) doc.explored = raw.explored;
  if (raw.truncated) doc.truncated = true;
  if (raw.updated) doc.updated = raw.updated;
  return doc;
}

const PROTO = new Set(['__proto__', 'constructor', 'prototype']);

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
