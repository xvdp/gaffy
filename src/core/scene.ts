/** @xvdp
 * View document → drawable grid: quotient (collapse, hide), visibility (reveal.ts), namespace boxes, labels,
 * placement, routing; webview renders, extension host exports.
 *
 * Visibility: `grow`, open sides (reveal); `auto`, `depthUp` caller and `depthDown` callee levels (revealDepth).
 * place.ts lays out both on every change, caller above callee (`└─>`, `<─┘`); webview keeps the last acted-on
 * vertex at its screen position. Marker on a side with off-screen neighbors (closed, beyond depth, hidden, cut): `>> ` label
 * prefix for callers; for calls, marker row `└─>>` as first tree child (virtual vertex `stubOf`, drawn graph only).
 * Cut calls: `grow` only.
 */
import { BoxNode, boxOf, boxTree, boxVertices } from './boxes';
import { buildGrid, Grid } from './grid';
import { nodeLabel } from './labels';
import { Layout } from './layout';
import { ancestors, GNode, isContainer, NodeKey, Subgraph, visible } from './model';
import { Debug, Decision } from './explain';
import { Rules } from './rules';
import { Marker, place, Placement } from './place';
import { settleMoved, Units } from './settle';
import { induced, quotient, VEdge, VGraph } from './quotient';
import { cutKey, opens, pathsThrough, reveal, Reveal, revealDepth, revealPaths, withPinned } from './reveal';
import { Style } from './style';
import { Cell, excludedBy, isStandard, PathTest, ViewDoc } from './viewdoc';

export interface Scene {
    graph: Subgraph;
    vg: VGraph;                          // call direction, visible vertices
    drawn: VGraph;                       // layout input: visible vertices plus marker rows
    tree: BoxNode;
    placement: Placement;
    grid: Grid;
    seeds: Set<NodeKey>;
    hiddenOf: Map<NodeKey, NodeKey[]>;   // hidden callers and callees per visible vertex
    rev: Reveal;                         // visible vertices, openers, allowed sides
    hasMore: (k: NodeKey, side: 'up' | 'down') => boolean;   // off-screen neighbors on side
    hiddenOn: (k: NodeKey, side: 'up' | 'down') => NodeKey[]; // hidden neighbors, cut-call ends on side
    hiddenPath: (k: NodeKey) => NodeKey[];                   // hidden functions on k's path from seeds
    decor: Map<NodeKey, Decor>;          // label affixes: disclosure marker, tag
    offsets: Record<string, Cell>;       // drawn unit moves: view offsets settled off content (settle.ts)
    paths: Set<NodeKey>;                 // drawn functions other than seeds on call paths between two seeds (color `between`)
}

/** Label = pre + name + post. */
export interface Decor { pre: string; post: string }

/** Marker row of `k`: virtual vertex of the drawn graph. */
const STUB = '\u22efmore:';
export const stubOf = (k: NodeKey) => `${STUB}${k}`;
export const isStub = (k: NodeKey) => k.startsWith(STUB);

/** `vg` minus `cut` calls. */
function dropCalls(vg: VGraph, cut: ReadonlySet<string>): VGraph {
    const edges = vg.edges.filter((e) => !cut.has(cutKey(e.from, e.to)));
    const out = new Map<NodeKey, VEdge[]>(), inc = new Map<NodeKey, VEdge[]>();
    for (const k of vg.nodes.keys()) { out.set(k, []); inc.set(k, []); }
    for (const e of edges) { out.get(e.from)!.push(e); inc.get(e.to)!.push(e); }
    return { ...vg, edges, out, inc };
}

/** `drawn` plus a marker row as first child (call line −1) of each `owners` vertex. */
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
 * External code drawn: `external` (installed packages, standard libraries, system headers); of it `standard`
 * (builtins, standard library, `isStandard`). Boolean: both.
 */
export interface Outside { external: boolean; standard: boolean }
const outsideOf = (o: boolean | Outside): Outside => (typeof o === 'boolean' ? { external: o, standard: o } : o);

/**
 * Functions and classes in excluded folders (view folders, `gaffy.exclude` globs), external code unless `external`
 * (`gaffy.includeExternal`), standard library unless `standard` (`gaffy.includeStandardLibrary`). Off screen
 * without markers; calls kept, so re-inclusion restores them.
 */
function excludedKeys(doc: ViewDoc, exclude: readonly PathTest[], external: boolean | Outside = true): Set<NodeKey> {
    const ex = excludedBy(doc.view, exclude);
    const o = outsideOf(external);
    const seeds = new Set(doc.view.seeds);
    // classes included: a constructor call draws the class as a vertex
    return new Set(Object.values(doc.graph.nodes)
        .filter((n) => (n.kind === 'class' || !isContainer(n)) && !seeds.has(n.key)
            && (ex(n.path) || (!!n.external && (!o.external || (!o.standard && isStandard(n.path))))))
        .map((n) => n.key));
}

/** Rule context of a view: registry defaults, the view's `rules` (Rules panel), `debug.rules`. */
export function rulesOf(_style: Style, view: ViewDoc['view'], debug?: Debug): Rules {
    return new Rules([view.rules, debug?.rules]);
}

/** `debug`: decision log, and a rule configuration over the view's (explain.ts). */
export function buildScene(doc: ViewDoc, style: Style, exclude: readonly PathTest[] = [], external: boolean | Outside = true, debug?: Debug): Scene {
    const view = doc.view;
    const R = rulesOf(style, view, debug);
    const graph = doc.graph;
    const collapsed = new Set(view.collapsed);
    const hidden = new Set(view.hidden);
    const out = excludedKeys(doc, exclude, external);
    const vq = quotient(graph, collapsed, new Set([...hidden, ...out]), view.seeds);
    const grows = view.arrange === 'grow';
    const cut = new Set(grows ? (view.cut ?? []).map(([a, b]) => cutKey(a, b)) : []);
    const rev = revealView(vq, doc);
    // `between`, full view: drawn are the revealed functions on seed-to-seed call paths; fetching and markers use
    // all revealed. One layer at a time: the reveal is the paths (revealPaths)
    const keep = view.between && !grows ? onPaths(vq, rev.visible, seedsIn(vq, doc)) : rev.visible;
    let vg = keep.size < vq.nodes.size ? induced(vq, keep) : vq;
    if (cut.size) vg = dropCalls(vg, cut);
    // marker: allowed side with an off-screen neighbor (closed, beyond depth, hidden, cut)
    const full = hidden.size ? quotient(graph, collapsed, out, view.seeds) : vq;
    const hasMore = (k: NodeKey, side: 'up' | 'down') => opens(rev.allowed.get(k), side) &&
        (side === 'down' ? full.out.get(k) ?? [] : full.inc.get(k) ?? [])
            .some((e) => !rev.visible.has(side === 'down' ? e.to : e.from) || cut.has(cutKey(e.from, e.to)));
    // hidden neighbors and cut calls, both sides, any allowed side; marker restores them with hidden functions
    // on their path from seeds (`hiddenPath`: reveal hiding nothing)
    const hiddenOn = (k: NodeKey, side: 'up' | 'down'): NodeKey[] => {
        if (!hidden.size && !cut.size) return [];
        const es = (side === 'down' ? full.out.get(k) : full.inc.get(k)) ?? [];
        const far = (e: VEdge) => (side === 'down' ? e.to : e.from);
        return [...new Set(es.filter((e) => hidden.has(far(e)) || cut.has(cutKey(e.from, e.to))).map(far))];
    };
    const fullRev = hidden.size ? revealView(full, doc) : rev;
    const hiddenPath = (k: NodeKey): NodeKey[] => {
        const out: NodeKey[] = [];
        for (let o = fullRev.opener.get(k); o; o = fullRev.opener.get(o.by)) if (hidden.has(o.by)) out.push(o.by);
        return out;
    };
    const marked = (k: NodeKey, side: 'up' | 'down') => hasMore(k, side) || hiddenOn(k, side).length > 0;
    const owners = [...vg.nodes.keys()].filter((k) => marked(k, 'down'));
    const nodesX: Record<NodeKey, GNode> = { ...graph.nodes };
    const drawn = withStubs(vg, owners, nodesX);

    // hidden neighbors: diff against the quotient hiding nothing
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
    // `>> ` label prefix: off-screen callers, hidden ones included; no counts
    const decor = new Map<NodeKey, Decor>();
    for (const k of vg.nodes.keys()) {
        const tag = view.tags[k];
        decor.set(k, { pre: marked(k, 'up') ? '>> ' : '', post: tag ? ` [${tag}]` : '' });
    }
    const label = (k: NodeKey) => {
        if (isStub(k)) return '';
        const v = vg.nodes.get(k)!;
        const d = decor.get(k)!;
        return visible(d.pre + nodeLabel(v.node ?? fallbackNode(k), labelOpts, boxes.get(k)?.ns ?? '', v.members, v.collapsed) + d.post);
    };
    const shortName = (k: NodeKey) => {
        if (isStub(k)) return '';
        const n = graph.nodes[k];
        return visible(n ? `${n.name}${style.labels.parens && !isContainer(n) ? '()' : ''}` : k);
    };

    // decision log: the last placement's decisions, then every settle move (explain.ts)
    let placeLog: Decision[] = [];
    const settleLog: Decision[] = [];
    const placeRules = R.withLog(debug?.log && ((d) => placeLog.push(d)));
    const settleRules = R.withLog(debug?.log && ((d) => settleLog.push(d)));
    const placeWith = (offset: Record<string, Cell>) => { placeLog = []; return place({
        vg: drawn,
        tree,
        base: {
            seeds: seedsIn(vq, doc),
            sibling: view.sibling,
            indent: R.p('h10_dfs_nearest_parent', 'indent'),
            laneGap: R.p('h12_lane_packing', 'gap'),
            rules: R,
            parentRule: view.parentRule ?? style.grid.parentRule,
            sortKey: (k) => (isStub(k) ? '' : sortKeyOf(graph.nodes[k], k)),
            label,
            shortName,
        },
        offset,
        lock: view.lock,
        tight: view.tight ?? style.boxes.tight,
        rules: placeRules,
    }); };
    // moved units overlapped by grown content: nearest clean offset (settle.ts); ≤ 3 rounds, since the next
    // placement may differ from the measured one; webview saves these offsets
    let offsets = view.offset;
    let placement: Placement = placeWith(offsets);
    for (let round = 0; round < R.p('h23_settle', 'rounds'); round++) {
        const moves = settleMoved(placement, { ...doc, view: { ...view, offset: offsets } }, unitsOn(tree, placement, vg), settleRules, round);
        if (!moves.length) break;
        offsets = { ...offsets };
        for (const [u, a, b] of moves) { const o = offsets[u] ?? [0, 0]; offsets[u] = [o[0] + a, o[1] + b]; }
        placement = placeWith(offsets);
    }
    if (debug?.log) for (const d of [...placeLog, ...settleLog]) debug.log(d);
    // marker rows: tree elbow `└─`, arrowhead, then `>` in the label padding cell
    const markers: Marker[] = [];
    for (const k of owners) {
        const p = placement.pos.get(stubOf(k));
        if (p) markers.push({ row: p.row, col: p.col - 1, text: '>', key: k, side: 'down' });
    }
    if (markers.length) placement.markers = markers;
    // implicit and cross-language calls keep their grid style (text: dotted, dash-dot)
    const kindOf = new Map(graph.edges.filter((e) => e.via || e.implicit).map((e) => [`${e.from}\u0000${e.to}`, e.via ? 'bridge' as const : 'implicit' as const]));
    const grid = buildGrid(placement, drawn, {
        kind: (a, b) => kindOf.get(`${a}\u0000${b}`),
        arrow: style.edges.arrow,
        first: view.straight,
        joint: (view.parentRule ?? style.grid.parentRule) === 'joint',
        rules: R.withLog(debug?.log),
    });
    const drawnSeeds = seedsIn(vq, doc).filter((s) => vg.nodes.has(s));
    const paths = drawnSeeds.length > 1 ? onPaths(vg, new Set(vg.nodes.keys()), drawnSeeds) : new Set<NodeKey>();
    for (const s of drawnSeeds) paths.delete(s);
    return { graph, vg, drawn, tree, placement, grid, seeds: new Set([...view.seeds, ...seedsIn(vq, doc)]), hiddenOf, decor, rev, hasMore, hiddenOn, hiddenPath, offsets, paths };
}

function fallbackNode(key: NodeKey): GNode {
    return { key, kind: 'other', name: key, qual: key, module: '', parent: null };
}

/** Tree siblings of `key` in block display order, and their override slot. */
export function siblingsOf(sc: Scene, key: NodeKey): { slot: NodeKey | null; list: NodeKey[] } {
    const L: Layout | undefined = sc.placement.blockOf.get(key)?.L;
    if (!L) return { slot: null, list: [] };
    const p = L.parent.get(key) ?? null;
    return { slot: p, list: p ? L.children.get(p) ?? [] : L.roots };
}

/** Vertices of `unit`: vertex and tree descendants, or box content. */
export function unitMembers(sc: Pick<Scene, 'tree' | 'placement'>, unit: string): NodeKey[] {
    if (unit.startsWith('collapsed:')) return unitMembers(sc, unit.slice('collapsed:'.length));
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

/** Units on a placement, for settle.ts. */
export const unitsOn = (tree: BoxNode, placement: Placement, vg: VGraph): Units => ({
    members: (u) => unitMembers({ tree, placement }, u), placed: (u) => !!unitAnchor({ placement, vg }, u), stub: isStub,
});

/**
 * Unit anchor cell: box frame corner or vertex label start. Container vertex unit: `collapsed:<key>` while
 * collapsed, `<key>` while expanded, never both.
 */
export function unitAnchor(sc: Pick<Scene, 'placement' | 'vg'>, unit: string): [number, number] | undefined {
    if (unit.startsWith('box:')) {
        const f = sc.placement.frames.find((x) => x.unit === unit);
        return f ? [f.c0, f.r0] : undefined;
    }
    const shut = unit.startsWith('collapsed:');
    const key = shut ? unit.slice('collapsed:'.length) : unit;
    if (!!sc.vg.nodes.get(key)?.collapsed !== shut) return undefined;
    const p = sc.placement.pos.get(key);
    return p ? [p.col, p.row] : undefined;
}

/** Seed representatives in a quotient: the seed, or its collapsed container (keeps a reveal origin). */
export function seedsIn(vq: VGraph, doc: ViewDoc): NodeKey[] {
    const out: NodeKey[] = [];
    for (const s of doc.view.seeds) {
        const r = vq.nodes.has(s) ? s : ancestors(doc.graph.nodes, s).find((a) => vq.nodes.get(a)?.collapsed);
        if (r && !out.includes(r)) out.push(r);
    }
    return out;
}

/**
 * Vertices on call paths between seeds within `shown`: reached from a seed along calls and reaching a seed along
 * calls (forward and backward search, O(V + E)), plus the seeds. A path of length L between two seeds lies within
 * the reveal when the callee depth covers it from one end or the caller depth from the other.
 */
export function onPaths(vg: VGraph, shown: ReadonlySet<NodeKey>, seeds: readonly NodeKey[]): Set<NodeKey> {
    const start = seeds.filter((s) => shown.has(s));
    const walk = (next: (k: NodeKey) => NodeKey[]) => {
        const seen = new Set(start);
        const stack = [...start];
        while (stack.length) {
            for (const n of next(stack.pop()!)) if (shown.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
        }
        return seen;
    };
    const from = walk((k) => (vg.out.get(k) ?? []).map((e) => e.to));
    const to = walk((k) => (vg.inc.get(k) ?? []).map((e) => e.from));
    const seedSet = new Set(start);
    return new Set([...shown].filter((k) => seedSet.has(k) || (from.has(k) && to.has(k))));
}

/**
 * Visible vertices over the quotient: open sides minus cut calls (grow), or call depths (auto). Joined seeds
 * (`view.joins`, seeds added to a view): closed until a side opens (grow), outside the depth search (auto), drawn
 * with the vertices on call paths to the other seeds (`pathsThrough`), pinned.
 */
function revealView(vq: VGraph, doc: ViewDoc): Reveal {
    const v = doc.view;
    const seeds = seedsIn(vq, doc);
    const joined = v.joins?.length ? seedsIn(vq, { ...doc, view: { ...v, seeds: v.joins } }) : [];
    const cut = new Set((v.cut ?? []).map(([a, b]) => cutKey(a, b)));
    const paths = () => joined.flatMap((j) => [j, ...pathsThrough(vq, j, seeds, cut)]);
    if (v.arrange !== 'grow') {
        const depthSeeds = seeds.filter((s) => !joined.includes(s));
        return withPinned(revealDepth(vq, depthSeeds, v.depthUp, v.depthDown, v.depthRule), paths());
    }
    if (v.between) return revealPaths(vq, seeds, cut);
    const open = { ...Object.fromEntries(joined.map((j) => [j, 'none' as const])), ...(v.open ?? {}) };
    return reveal(vq, seeds, open, v.direction, cut, [...(v.pinned ?? []), ...paths()]);
}

function revealOf(doc: ViewDoc, exclude: readonly PathTest[], external: boolean | Outside): Reveal {
    const v = doc.view;
    return revealView(quotient(doc.graph, new Set(v.collapsed), new Set([...v.hidden, ...excludedKeys(doc, exclude, external)]), v.seeds), doc);
}

/**
 * Paths between seeds only, turned off one layer at a time: the paths on screen stay (`pinned`), every seed side
 * closed, so nothing opens by itself; `between` and `pinPaths` dropped.
 */
export function pinPaths(doc: ViewDoc, exclude: readonly PathTest[] = [], external: boolean | Outside = true): void {
    const shown = revealOf(doc, exclude, external).visible;
    const seeds = new Set(doc.view.seeds);
    doc.view.pinned = [...shown].filter((k) => !seeds.has(k));
    doc.view.open = Object.fromEntries(doc.view.seeds.map((s) => [s, 'none' as const]));
    delete doc.view.between;
    delete doc.view.pinPaths;
}

/** Vertices with call requests: definitions, classes (construction runs `__init__`, implicit.ts). */
const asked = (n: GNode | undefined) => !isContainer(n) || n?.kind === 'class';

/** Definitions and classes on screen. */
export function visibleOf(doc: ViewDoc, exclude: readonly PathTest[] = [], external: boolean | Outside = true): NodeKey[] {
    return [...revealOf(doc, exclude, external).visible].filter((k) => asked(doc.graph.nodes[k]));
}

/** Openable directions per on-screen definition: seeds both, others their revealing side. */
export function frontierOf(doc: ViewDoc, exclude: readonly PathTest[] = [], external: boolean | Outside = true): { key: NodeKey; dir: 'in' | 'out' }[] {
    const rev = revealOf(doc, exclude, external);
    return [...rev.visible].filter((k) => asked(doc.graph.nodes[k])).flatMap((key) => {
        const a = rev.allowed.get(key);
        return [...(opens(a, 'up') ? ['in' as const] : []), ...(opens(a, 'down') ? ['out' as const] : [])].map((dir) => ({ key, dir }));
    });
}
