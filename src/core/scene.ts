/**
 * Pipeline from a view document to a drawable grid: quotient, namespace boxes, labels, placement,
 * routing. Runs in the webview for rendering and in the extension host for export.
 *
 * Order `callers`: layout of the call graph; caller above callee, `└─>` and `<─┘` arrows.
 * Order `callees`: layout of the reversed graph; callee above its callers, `└──` connectors without
 * arrowheads, as in the VS Code call hierarchy view. Call direction itself never changes.
 */
import { BoxNode, boxOf, boxTree, boxVertices } from './boxes';
import { buildGrid, Grid } from './grid';
import { nodeLabel } from './labels';
import { Layout } from './layout';
import { GNode, isContainer, NodeKey, Subgraph } from './model';
import { place, Placement } from './place';
import { foldOut, induced, quotient, reversed, VGraph } from './quotient';
import { Style } from './style';
import { ViewDoc } from './viewdoc';

export interface Scene {
  graph: Subgraph;
  vg: VGraph;                          // call direction, visible vertices
  drawn: VGraph;                       // graph the layout ran on (reversed under order `callees`)
  tree: BoxNode;
  placement: Placement;
  grid: Grid;
  seeds: Set<NodeKey>;
  hiddenOf: Map<NodeKey, NodeKey[]>;   // hidden callers and callees per visible vertex
  folds: Map<NodeKey, NodeKey[]>;      // folded vertex → vertices folded away
  decor: Map<NodeKey, Decor>;          // label parts around the name: disclosure markers, tag, hidden badge
}

/** Label = pre + name + post + badge. */
export interface Decor { pre: string; post: string; badge: string }

export function sortKeyOf(n: GNode | undefined, key: NodeKey): string {
  return `${n?.path ?? ''}\u0000${String(n?.line ?? 0).padStart(9, '0')}\u0000${key}`;
}

export function buildScene(doc: ViewDoc, style: Style): Scene {
  const view = doc.view;
  const graph = doc.graph;
  const collapsed = new Set(view.collapsed);
  const hidden = new Set(view.hidden);
  const vq = quotient(graph, collapsed, hidden, view.seeds);
  const dq = view.order === 'callees' ? reversed(vq) : vq;
  // folds act in call direction: side `down` hides what only this vertex calls, `up` what only calls it
  const sides = Object.entries(view.fold);
  const down = foldOut(vq, sides.filter(([, s]) => s === 'down').map(([k]) => k), view.seeds);
  const up = foldOut(reversed(vq), sides.filter(([, s]) => s === 'up').map(([k]) => k), view.seeds);
  const folds = new Map<NodeKey, NodeKey[]>([...down, ...up]);
  const gone = new Set([...folds.values()].flat());
  const keep = new Set([...vq.nodes.keys()].filter((k) => !gone.has(k)));
  const vg = gone.size ? induced(vq, keep) : vq;
  const drawn = gone.size ? induced(dq, keep) : dq;

  // hidden neighbors: compare with the quotient that hides nothing
  const hiddenOf = new Map<NodeKey, NodeKey[]>();
  if (hidden.size) {
    const full = quotient(graph, collapsed, new Set(), view.seeds);
    for (const k of vg.nodes.keys()) {
      const nb = new Set<NodeKey>();
      // hidden, not folded: compare with the quotient before folding
      for (const e of full.out.get(k) ?? []) if (!vq.nodes.has(e.to)) nb.add(e.to);
      for (const e of full.inc.get(k) ?? []) if (!vq.nodes.has(e.from)) nb.add(e.from);
      if (nb.size) hiddenOf.set(k, [...nb]);
    }
  }

  const tree = boxTree(vg.nodes.keys(), graph.nodes, {
    ...style.boxes, enabled: view.boxes ?? style.boxes.enabled, group: new Set(view.group), ungroup: new Set(view.ungroup),
  });
  const boxes = boxOf(tree);
  const labelOpts = { strip: style.labels.strip, parens: style.labels.parens };
  // disclosure markers: `◂` before a label, its callers are closed; `▸` after it, its calls are closed.
  // Closed: folded on that side (with the folded count), or not yet asked from the provider with
  // nothing shown on that side (a frontier vertex).
  const explored = doc.explored ?? {};
  const asked = (k: NodeKey, d: 'in' | 'out') => explored[k] === d || explored[k] === 'both';
  const decor = new Map<NodeKey, Decor>();
  for (const k of vg.nodes.keys()) {
    const v = vg.nodes.get(k)!;
    const f = folds.get(k);
    const side = view.fold[k];
    let pre = '', post = '';
    if (side === 'up') pre = `◂${f!.length} `;
    else if (!v.collapsed && !(vg.inc.get(k) ?? []).length && !asked(k, 'in') && (view.direction !== 'out' || vq.nodes.has(k) && view.seeds.includes(k))) pre = '◂ ';
    if (side === 'down') post = ` ▸${f!.length}`;
    else if (!v.collapsed && !(vg.out.get(k) ?? []).length && !asked(k, 'out') && (view.direction !== 'in' || view.seeds.includes(k))) post = ' ▸';
    const tag = view.tags[k];
    const h = hiddenOf.get(k);
    decor.set(k, { pre, post: (tag ? ` [${tag}]` : '') + post, badge: h ? ` +${h.length}` : '' });
  }
  const label = (k: NodeKey) => {
    const v = vg.nodes.get(k)!;
    const d = decor.get(k)!;
    return d.pre + nodeLabel(v.node ?? fallbackNode(k), labelOpts, boxes.get(k)?.ns ?? '', v.members, v.collapsed) + d.post + d.badge;
  };
  const shortName = (k: NodeKey) => {
    const n = graph.nodes[k];
    return n ? `${n.name}${style.labels.parens && !isContainer(n) ? '()' : ''}` : k;
  };

  const placement = place({
    vg: drawn,
    tree,
    base: {
      seeds: view.seeds,
      sibling: view.sibling,
      indent: style.grid.indent,
      laneGap: style.grid.laneGap,
      parentRule: view.parentRule ?? style.grid.parentRule,
      sortKey: (k) => sortKeyOf(graph.nodes[k], k),
      label,
      shortName,
    },
    offset: view.offset,
    lock: view.lock,
    channel: style.route.channel,
  });
  const grid = buildGrid(placement, drawn, {
    arrow: style.edges.arrow && view.order !== 'callees',
    cost: { bend: style.route.bend, cross: style.route.cross, border: style.route.border, adjacent: style.route.adjacent },
  });
  return { graph, vg, drawn, tree, placement, grid, seeds: new Set(view.seeds), hiddenOf, folds, decor };
}

function fallbackNode(key: NodeKey): GNode {
  return { key, kind: 'other', name: key, qual: key, module: '', parent: null };
}

/** Tree siblings of `key` in display order inside its block, and the override slot that stores them. */
export function siblingsOf(sc: Scene, key: NodeKey): { slot: NodeKey | null; list: NodeKey[] } {
  const L: Layout | undefined = sc.placement.blockOf.get(key)?.L;
  if (!L) return { slot: null, list: [] };
  const p = L.parent.get(key) ?? null;
  return { slot: p, list: p ? L.children.get(p) ?? [] : L.roots };
}

/** Vertices moved together with unit `unit`: a vertex and its tree descendants, or a box's content. */
export function unitMembers(sc: Scene, unit: string): NodeKey[] {
  if (unit.startsWith('box:')) {
    const key = unit.slice(4);
    const find = (b: BoxNode): BoxNode | undefined => (b.key === key ? b : b.children.map(find).find(Boolean));
    const b = find(sc.tree);
    return b ? boxVertices(b) : [];
  }
  const L = sc.placement.blockOf.get(unit)?.L;
  if (!L) return [unit];
  const walk = (k: NodeKey): NodeKey[] => [k, ...(L.children.get(k) ?? []).flatMap(walk)];
  return walk(unit);
}

/** Anchor cell of a unit: frame corner of a box, label start of a vertex. */
export function unitAnchor(sc: Scene, unit: string): [number, number] | undefined {
  if (unit.startsWith('box:')) {
    const f = sc.placement.frames.find((x) => x.unit === unit);
    return f ? [f.c0, f.r0] : undefined;
  }
  const p = sc.placement.pos.get(unit);
  return p ? [p.col, p.row] : undefined;
}
