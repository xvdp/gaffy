/**
 * Pipeline from a view document to a drawable grid: merge ghosts, quotient, labels, layout, grid,
 * orientation. Runs in the webview for rendering and in the extension host for export.
 */
import { buildGrid, flipGrid, Grid } from './grid';
import { containerLabel, nodeLabel } from './labels';
import { layout, Layout } from './layout';
import { ancestors, GNode, isContainer, mergeGraphs, NodeKey, Status, Subgraph } from './model';
import { quotient, VGraph } from './quotient';
import { Style } from './style';
import { statusOf, ViewDoc } from './viewdoc';

export interface Scene {
  graph: Subgraph;                 // graph ∪ ghosts
  vg: VGraph;
  layout: Layout;
  grid: Grid;
  status: Map<NodeKey, Status>;
  seeds: Set<NodeKey>;
}

export function sortKeyOf(n: GNode | undefined, key: NodeKey): string {
  return `${n?.path ?? ''}\u0000${String(n?.line ?? 0).padStart(9, '0')}\u0000${key}`;
}

export function buildScene(doc: ViewDoc, style: Style): Scene {
  const view = doc.view;
  const graph = mergeGraphs(doc.ghosts, doc.graph);
  const collapsed = new Set(view.collapsed);
  const hidden = new Set(view.hidden);
  const vg = quotient(graph, collapsed, hidden, view.seeds);

  const status = new Map<NodeKey, Status>();
  for (const v of vg.nodes.values()) {
    if (v.collapsed || isContainer(v.node)) continue;
    const s = statusOf(doc, v.key, doc.graph.nodes[v.key]);
    if (s) status.set(v.key, s);
  }

  const labelOpts = { mode: view.labels ?? style.labels.mode, strip: style.labels.strip, parens: style.labels.parens };
  const label = (k: NodeKey, p: NodeKey | null) => {
    const v = vg.nodes.get(k)!;
    let text = nodeLabel(v.node ?? fallbackNode(k), labelOpts, p ? graph.nodes[p] : undefined, v.members, v.collapsed);
    const tag = view.tags[k];
    if (tag) text += ` [${tag}]`;
    const s = status.get(k);
    if (s && style.labels.status) text += ` ${s}`;
    return text;
  };
  const shortName = (k: NodeKey) => {
    const n = graph.nodes[k];
    return n ? `${n.name}${style.labels.parens && !isContainer(n) ? '()' : ''}` : k;
  };
  const kinds = new Set(style.container.kinds);
  const bracketOf = (k: NodeKey) => {
    for (const a of ancestors(graph.nodes, k)) {
      const n = graph.nodes[a];
      if (n && kinds.has(n.kind) && !collapsed.has(a)) return { key: a, label: containerLabel(n, style.labels.strip) };
    }
    return null;
  };

  const L = layout({
    vg,
    seeds: view.seeds,
    order: view.order,
    indent: style.grid.indent,
    laneGap: style.grid.laneGap,
    parentRule: view.parentRule ?? style.grid.parentRule,
    sortKey: (k) => sortKeyOf(graph.nodes[k], k),
    label,
    shortName,
    bracketOf: kinds.size ? bracketOf : undefined,
    minRun: style.container.minRun,
  });
  let grid = buildGrid(L, { arrow: style.edges.arrow });
  if (view.orientation === 'up') grid = flipGrid(grid);
  return { graph, vg, layout: L, grid, status, seeds: new Set(view.seeds) };
}

function fallbackNode(key: NodeKey): GNode {
  return { key, kind: 'other', name: key, qual: key, module: '', parent: null };
}

/** Tree siblings of `key` in display order, and the order-map slot that stores them. */
export function siblingsOf(L: Layout, key: NodeKey): { slot: NodeKey | null; list: NodeKey[] } {
  const p = L.parent.get(key) ?? null;
  return { slot: p, list: p ? L.children.get(p) ?? [] : L.roots };
}
