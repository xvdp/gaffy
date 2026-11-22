/** @xvdp
 * Namespace boxes: the containment tree restricted to boxable containers, chain-compressed.
 *
 * 1. Boxable kinds: package, folder; module and file too with `modules`.
 * 2. Each visible vertex hangs under the innermost boxable ancestor; containers without visible
 *    content vanish.
 * 3. Chain compression: a box whose content is one child box and no vertex merges with that child
 *    (`src` + `foo` → `src/foo`). Without module boxes, a box whose vertices all come from one
 *    module and which has no child box absorbs that module (`foo` + `goo` → `foo.goo`).
 * 4. The outermost box is drawn only with `root` (otherwise its content moves up to the canvas).
 * 5. Namespace `ns` of a box: dotted package or module name, or folder path. Labels of members and
 *    child boxes are relative to it: `shoo()` in `foo.goo`, `aloo.patata()` in `moo`.
 */
import { ancestors, GNode, NodeKey, visible } from './model';

export interface BoxNode {
    key: string;             // 'root', or the innermost container key of the compressed chain
    label: string;           // header text, relative to the parent box
    ns: string;              // namespace prefix removed from member labels
    members: NodeKey[];      // vertices whose innermost box is this one
    children: BoxNode[];
    frame: boolean;          // drawn with a frame and header
}

export interface BoxOptions {
    enabled: boolean; modules: boolean; root: boolean;
    group?: ReadonlySet<NodeKey>;    // containers boxed on demand
    ungroup?: ReadonlySet<NodeKey>;  // containers never boxed: their content joins the parent box
}

interface Trie {
    chain: GNode[];          // containers merged into this box, outermost first
    children: Map<string, Trie>;
    members: NodeKey[];
    module?: string;         // absorbed module
}

const BOXABLE = new Set(['package', 'folder']);

export function relativeName(name: string, ns: string): string {
    if (!ns) return name;
    if (name === ns) return '';
    for (const sep of ['.', '/']) if (name.startsWith(ns + sep)) return name.slice(ns.length + 1);
    return name;
}

export function boxTree(vertices: Iterable<NodeKey>, nodes: Record<NodeKey, GNode>, opt: BoxOptions): BoxNode {
    const all = [...vertices];
    if (!opt.enabled) return { key: 'root', label: '', ns: '', members: all, children: [], frame: false };
    const boxable = (n: GNode | undefined) =>
        !!n && !opt.ungroup?.has(n.key) &&
        (BOXABLE.has(n.kind) || (opt.modules && (n.kind === 'module' || n.kind === 'file')) || !!opt.group?.has(n.key));

    const root: Trie = { chain: [], children: new Map(), members: [] };
    for (const v of all) {
        const chain = ancestors(nodes, v).map((a) => nodes[a]).filter(boxable).reverse();
        let t = root;
        for (const c of chain) {
            let next = t.children.get(c.key);
            if (!next) t.children.set(c.key, (next = { chain: [c], children: new Map(), members: [] }));
            t = next;
        }
        t.members.push(v);
    }

    const compress = (t: Trie, isRoot: boolean) => {
        while (!isRoot && t.children.size === 1 && t.members.length === 0) {
            const only = t.children.values().next().value!;
            t.chain.push(...only.chain);
            t.children = only.children;
            t.members = only.members;
        }
        for (const c of t.children.values()) compress(c, false);
        // absorb the single module of a box, unless that module is grouped or ungrouped on demand
        if (!isRoot && !opt.modules && t.children.size === 0 && t.members.length && !t.chain.some((c) => opt.group?.has(c.key))) {
            const mods = new Set(t.members.map((m) => nodes[m]?.module));
            if (mods.size === 1) {
                const m = [...mods][0];
                if (m && m !== nsOfChain(t.chain)) t.module = m;
            }
        }
    };
    compress(root, true);

    // without `root`, a single outermost box becomes the unframed canvas
    const top = !opt.root && root.children.size === 1 && root.members.length === 0
        ? root.children.values().next().value! : root;
    const toBox = (t: Trie, parentNs: string): BoxNode => {
        const ns = t.module ?? nsOfChain(t.chain);
        return {
            key: t.chain[t.chain.length - 1].key,
            label: visible(relativeName(ns, parentNs) || chainName(t.chain, t.module)),
            ns,
            members: t.members,
            children: [...t.children.values()].map((c) => toBox(c, ns)),
            frame: true,
        };
    };
    const canvasNs = top === root ? '' : top.module ?? nsOfChain(top.chain);
    return {
        key: 'root', label: '', ns: canvasNs, members: top.members,
        children: [...top.children.values()].map((c) => toBox(c, canvasNs)), frame: false,
    };
}

function nsOfChain(chain: GNode[]): string {
    const last = chain[chain.length - 1];
    return last ? last.module || last.name : '';
}

function chainName(chain: GNode[], module?: string): string {
    const names = chain.map((c) => c.name);
    if (module) names.push(module.split(/[./]/).pop()!);
    return names.join('/');
}

/** Vertex → innermost box. */
export function boxOf(tree: BoxNode): Map<NodeKey, BoxNode> {
    const m = new Map<NodeKey, BoxNode>();
    const walk = (b: BoxNode) => { for (const v of b.members) m.set(v, b); b.children.forEach(walk); };
    walk(tree);
    return m;
}

/** All vertices inside a box, nested boxes included. */
export function boxVertices(b: BoxNode): NodeKey[] {
    return [...b.members, ...b.children.flatMap(boxVertices)];
}
