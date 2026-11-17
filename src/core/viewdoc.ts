/**
 * View document: the content of a `.gaffy` file. One view = seeds, traversal, user overrides, and the
 * last resolved subgraph, so a view opens without a language server and carries the baseline for
 * ADD / MOD / REMOVE tags.
 */
import { emptyGraph, GNode, NodeKey, Status, Subgraph } from './model';

export type Direction = 'in' | 'out' | 'both';
export type Orientation = 'down' | 'up';
export type EdgeMode = 'glyph' | 'vector';
export type LabelMode = 'full' | 'relative';
export type ParentRule = 'dfs' | 'nearest';

export const ROOTS = '__roots__';

export interface ViewSpec {
  seeds: NodeKey[];
  direction: Direction;
  depth: number;
  expanded: Record<NodeKey, Direction>;   // per-node expansions beyond the depth limit
  collapsed: NodeKey[];                    // collapse set K
  hidden: NodeKey[];
  order: Record<NodeKey, NodeKey[]>;       // child order per caller; ROOTS orders the top level
  orientation: Orientation;                // down: callers above callees
  edges?: EdgeMode;                        // overrides style.edges.mode
  labels?: LabelMode;                      // overrides style.labels.mode
  parentRule?: ParentRule;                 // overrides style.grid.parentRule
  tags: Record<NodeKey, string>;
}

export interface ViewDoc {
  gaffy: 1;
  name: string;
  view: ViewSpec;
  graph: Subgraph;                         // last build
  baseline: Record<NodeKey, string>;       // key -> body hash at baseline
  ghosts: Subgraph;                        // definitions removed since baseline, with their last edges
  truncated?: boolean;                     // build stopped at maxNodes
  updated?: string;                        // ISO time of last build
}

export function defaultView(): ViewSpec {
  return {
    seeds: [], direction: 'out', depth: 4, expanded: {}, collapsed: [], hidden: [], order: {},
    orientation: 'down', tags: {},
  };
}

export function emptyDoc(name: string, view: Partial<ViewSpec> = {}): ViewDoc {
  return { gaffy: 1, name, view: { ...defaultView(), ...view }, graph: emptyGraph(), baseline: {}, ghosts: emptyGraph() };
}

/** Parses a `.gaffy` text; missing fields take defaults; an empty text yields an empty view. */
export function parseDoc(text: string, fallbackName = 'view'): ViewDoc {
  if (!text.trim()) return emptyDoc(fallbackName);
  const raw = JSON.parse(text) as Partial<ViewDoc>;
  const doc = emptyDoc(raw.name ?? fallbackName, raw.view ?? {});
  doc.graph = { nodes: raw.graph?.nodes ?? {}, edges: raw.graph?.edges ?? [] };
  doc.ghosts = { nodes: raw.ghosts?.nodes ?? {}, edges: raw.ghosts?.edges ?? [] };
  doc.baseline = raw.baseline ?? {};
  doc.truncated = raw.truncated;
  doc.updated = raw.updated;
  return doc;
}

export function serializeDoc(doc: ViewDoc): string {
  return JSON.stringify(doc, null, 1) + '\n';
}

/** ADD: absent from baseline; MOD: hash differs from baseline; REMOVE: ghost. */
export function statusOf(doc: ViewDoc, key: NodeKey, node: GNode | undefined): Status | undefined {
  if (doc.ghosts.nodes[key] && !doc.graph.nodes[key]) return 'REMOVE';
  if (!node || !Object.keys(doc.baseline).length) return undefined;
  const base = doc.baseline[key];
  if (base === undefined) return 'ADD';
  if (node.hash && base && node.hash !== base) return 'MOD';
  return undefined;
}
