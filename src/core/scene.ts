/**
 * Pipeline from a view document to a drawable grid: quotient (collapse, hide), visibility by open
 * sides (reveal.ts), namespace boxes, labels, placement, routing. Runs in the webview for rendering and
 * in the extension host for export.
 *
 * Visibility: arrangement `grow` (one layer at a time), the open sides of each vertex (reveal); arrangement
 * `auto` (full), every vertex within `depthUp` caller and `depthDown` callee levels (revealDepth). Both
 * are laid out by place.ts on every change, caller above callee (`└─>`, `<─┘`); the webview keeps the
 * vertex last acted on at its screen position. A side with neighbors not on screen (closed, beyond the
 * depth, hidden, cut) carries a marker: `>> ` before the label for callers, a marker row `└─>>` as the
 * first tree child for calls. Marker rows are virtual vertices (`stubOf`) of the drawn graph only.
 * Cut calls apply to `grow` only.
 */
import { BoxNode, boxOf, boxTree, boxVertices } from './boxes';
import { buildGrid, Grid } from './grid';
import { nodeLabel } from './labels';
import { Layout } from './layout';
import { GNode, isContainer, NodeKey, Subgraph, visible } from './model';
import { Marker, place, Placement } from './place';
import { induced, quotient, VEdge, VGraph } from './quotient';
import { cutKey, opens, reveal, Reveal, revealDepth } from './reveal';
import { Style } from './style';
import { excludedBy, ViewDoc } from './viewdoc';

export interface Scene {
  graph: Subgraph;
  vg: VGraph;                          // call direction, visible vertices
  drawn: VGraph;                       // graph the layout ran on (reversed under order `callees`)
  tree: BoxNode;
  placement: Placement;
  grid: Grid;
  seeds: Set<NodeKey>;
  hiddenOf: Map<NodeKey, NodeKey[]>;   // hidden callers and callees per visible vertex
  rev: Reveal;                         // visible vertices, who revealed them, sides they may open
  hasMore: (k: NodeKey, side: 'up' | 'down') => boolean;   // neighbors on that side not on screen
  decor: Map<NodeKey, Decor>;          // label parts around the name: disclosure markers, tag, hidden badge
}

/** Label = pre + name + post + badge. */
export interface Decor { pre: string; post: string; badge: string }

/** Marker row of vertex `k` (virtual vertex of the drawn graph). */
const STUB = '\u22efmore:';
export const stubOf = (k: NodeKey) => `${STUB}${k}`;
export const isStub = (k: NodeKey) => k.startsWith(STUB);
export const stubOwner = (k: NodeKey) => k.slice(STUB.length);

/** `vg` without the given calls. */
function dropCalls(vg: VGraph, cut: ReadonlySet<string>): VGraph {
  const edges = vg.edges.filter((e) => !cut.has(cutKey(e.from, e.to)));
  const out = new Map<NodeKey, VEdge[]>(), inc = new Map<NodeKey, VEdge[]>();
  for (const k of vg.nodes.keys()) { out.set(k, []); inc.set(k, []); }
  for (const e of edges) { out.get(e.from)!.push(e); inc.get(e.to)!.push(e); }
  return { ...vg, edges, out, inc };
}

/** `drawn` plus one marker row under each vertex of `owners`: a first child (call line −1). */
function withStubs(drawn: VGraph, owners: NodeKey[], nodes: Record<NodeKey, GNode>): VGraph {
  if (!owners.length) return drawn;
  const g: VGraph = { nodes: new Map(drawn.nodes), edges: [...drawn.edges], out: new Map(drawn.out), inc: new Map(drawn.inc), selfLoops: drawn.selfLoops };
  for (const k of owners) {
    const sk = stubOf(k);
    const owner = nodes[k] ?? fallbackNode(k);
    const node: GNode = { ...owner, key: sk, kind: 'other', name: '', qual: '', hash: undefined };
    nodes[sk] = node;
    g.nodes.set(sk, { key: sk, node, collapsed: false, members: 0, internal: 0 });
    const e: VEdge = { from: k, to: sk, line: -1, count: 1 };
    g.edges.push(e);
    g.out.set(k, [...(g.out.get(k) ?? []), e]);
    g.inc.set(sk, [e]);
    g.out.set(sk, []);
  }
  return g;
}

export function sortKeyOf(n: GNode | undefined, key: NodeKey): string {
  return `${n?.path ?? ''}\u0000${String(n?.line ?? 0).padStart(9, '0')}\u0000${key}`;
}

/**
 * Functions of excluded folders (view folders, `gaffy.exclude` globs), and external code unless `external`
 * (`gaffy.includeExternal`): off screen like hidden ones, but without markers, and back as soon as the
 * folder is included again (their calls stay in the data).
 */
function excludedKeys(doc: ViewDoc, exclude: readonly RegExp[], external = true): Set<NodeKey> {
  const ex = excludedBy(doc.view, exclude);
  const seeds = new Set(doc.view.seeds);
  return new Set(Object.values(doc.graph.nodes)
    .filter((n) => !isContainer(n) && !seeds.has(n.key) && (ex(n.path) || (!external && n.external))).map((n) => n.key));
}

export function buildScene(doc: ViewDoc, style: Style, exclude: readonly RegExp[] = [], external = true): Scene {
  const view = doc.view;
  const graph = doc.graph;
  const collapsed = new Set(view.collapsed);
  const hidden = new Set(view.hidden);
  const out = excludedKeys(doc, exclude, external);
  const vq = quotient(graph, collapsed, new Set([...hidden, ...out]), view.seeds);
  const grows = view.arrange === 'grow';
  const cut = new Set(grows ? (view.cut ?? []).map(([a, b]) => cutKey(a, b)) : []);
  const rev = revealView(vq, doc);
  const keep = rev.visible;
  let vg = keep.size < vq.nodes.size ? induced(vq, keep) : vq;
  if (cut.size) vg = dropCalls(vg, cut);
  // a side the vertex may open with a neighbor off screen (closed side, beyond the depth, hidden, cut call) shows a marker
  const full = hidden.size ? quotient(graph, collapsed, out, view.seeds) : vq;
  const hasMore = (k: NodeKey, side: 'up' | 'down') => opens(rev.allowed.get(k), side) &&
    (side === 'down' ? full.out.get(k) ?? [] : full.inc.get(k) ?? [])
      .some((e) => !keep.has(side === 'down' ? e.to : e.from) || cut.has(cutKey(e.from, e.to)));
  const owners = [...vg.nodes.keys()].filter((k) => hasMore(k, 'down'));
  const nodesX: Record<NodeKey, GNode> = { ...graph.nodes };
  const drawn = withStubs(vg, owners, nodesX);

  // hidden neighbors: compare with the quotient that hides nothing
  const hiddenOf = new Map<NodeKey, NodeKey[]>();
  if (hidden.size) {
    for (const k of vg.nodes.keys()) {
      const nb = new Set<NodeKey>();
      for (const e of full.out.get(k) ?? []) if (!vq.nodes.has(e.to)) nb.add(e.to);
      for (const e of full.inc.get(k) ?? []) if (!vq.nodes.has(e.from)) nb.add(e.from);
      if (nb.size) hiddenOf.set(k, [...nb]);
    }
  }

  const tree = boxTree(drawn.nodes.keys(), nodesX, {
    ...style.boxes, enabled: view.boxes ?? style.boxes.enabled, group: new Set(view.group), ungroup: new Set(view.ungroup),
  });
  const boxes = boxOf(tree);
  const labelOpts = { strip: style.labels.strip, parens: style.labels.parens };
  // `>> ` before a label: callers off screen; markers stand for hidden neighbors too, no counts
  const decor = new Map<NodeKey, Decor>();
  for (const k of vg.nodes.keys()) {
    const tag = view.tags[k];
    decor.set(k, { pre: hasMore(k, 'up') ? '>> ' : '', post: tag ? ` [${tag}]` : '', badge: '' });
  }
  const label = (k: NodeKey) => {
    if (isStub(k)) return '';
    const v = vg.nodes.get(k)!;
    const d = decor.get(k)!;
    return visible(d.pre + nodeLabel(v.node ?? fallbackNode(k), labelOpts, boxes.get(k)?.ns ?? '', v.members, v.collapsed) + d.post + d.badge);
  };
  const shortName = (k: NodeKey) => {
    if (isStub(k)) return '';
    const n = graph.nodes[k];
    return visible(n ? `${n.name}${style.labels.parens && !isContainer(n) ? '()' : ''}` : k);
  };

  const placement: Placement = place({
    vg: drawn,
    tree,
    base: {
      seeds: view.seeds,
      sibling: view.sibling,
      indent: style.grid.indent,
      laneGap: style.grid.laneGap,
      parentRule: view.parentRule ?? style.grid.parentRule,
      sortKey: (k) => (isStub(k) ? '' : sortKeyOf(graph.nodes[k], k)),
      label,
      shortName,
    },
    offset: view.offset,
    lock: view.lock,
    channel: style.route.channel,
  });
  // marker rows: the `└─` of the tree elbow and its arrowhead, then `>` in the label's padding cell
  const markers: Marker[] = [];
  for (const k of owners) {
    const p = placement.pos.get(stubOf(k));
    if (p) markers.push({ row: p.row, col: p.col - 1, text: '>', key: k, side: 'down' });
  }
  if (markers.length) placement.markers = markers;
  const grid = buildGrid(placement, drawn, {
    arrow: style.edges.arrow,
    first: view.straight,
    joint: (view.parentRule ?? style.grid.parentRule) === 'joint',
    cost: { bend: style.route.bend, cross: style.route.cross, border: style.route.border, adjacent: style.route.adjacent },
  });
  return { graph, vg, drawn, tree, placement, grid, seeds: new Set(view.seeds), hiddenOf, decor, rev, hasMore };
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

/** Visible vertices of a view over its quotient: open sides without cut calls (grow), or the call depths (auto). */
function revealView(vq: VGraph, doc: ViewDoc): Reveal {
  const v = doc.view;
  if (v.arrange !== 'grow') return revealDepth(vq, v.seeds, v.depthUp, v.depthDown, v.depthRule);
  return reveal(vq, v.seeds, v.open ?? {}, v.direction, new Set((v.cut ?? []).map(([a, b]) => cutKey(a, b))));
}

function revealOf(doc: ViewDoc, exclude: readonly RegExp[], external: boolean): Reveal {
  const v = doc.view;
  return revealView(quotient(doc.graph, new Set(v.collapsed), new Set([...v.hidden, ...excludedKeys(doc, exclude, external)]), v.seeds), doc);
}

/** Definitions on screen; containers excluded. */
export function visibleOf(doc: ViewDoc, exclude: readonly RegExp[] = [], external = true): NodeKey[] {
  return [...revealOf(doc, exclude, external).visible].filter((k) => !isContainer(doc.graph.nodes[k]));
}

/** Directions each definition on screen may open: seeds both, others the side that revealed them. */
export function frontierOf(doc: ViewDoc, exclude: readonly RegExp[] = [], external = true): { key: NodeKey; dir: 'in' | 'out' }[] {
  const rev = revealOf(doc, exclude, external);
  return [...rev.visible].filter((k) => !isContainer(doc.graph.nodes[k])).flatMap((key) => {
    const a = rev.allowed.get(key);
    return [...(opens(a, 'up') ? ['in' as const] : []), ...(opens(a, 'down') ? ['out' as const] : [])].map((dir) => ({ key, dir }));
  });
}
