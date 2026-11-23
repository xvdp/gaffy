/** @xvdp
 * Graph model shared by extension host and webview.
 *
 * Compound graph: call multigraph G = (V, E) over definitions; containment tree T (`parent`) over definitions
 * and containers (class, module, file, package, folder).
 * Keys, line-free (stable under moves): `<lang>:<relpath>#<qualname>` definition, `<lang>:<relpath>` file,
 * `dir:<reldir>` folder.
 */

export type NodeKey = string;

export type Kind =
    | 'function' | 'method' | 'class'
    | 'module' | 'file' | 'package' | 'folder'
    | 'other';

export const CONTAINER_KINDS: ReadonlySet<Kind> = new Set<Kind>(['class', 'module', 'file', 'package', 'folder']);

export interface GNode {
    key: NodeKey;
    kind: Kind;
    name: string;            // short name: "magoo"
    qual: string;            // qualified name in file: "scoobie.do"; "" for containers
    module: string;          // display module: "foo.goo", "scripts/moo_tools"
    parent: NodeKey | null;  // innermost container
    uri?: string;            // file URI
    path?: string;           // workspace-relative file path
    line?: number;           // name line, 0-based
    character?: number;      // name column, 0-based
    hash?: string;           // body hash, whitespace-invariant
    detail?: string;
    external?: boolean;
}

export interface GEdge {
    from: NodeKey;           // caller
    to: NodeKey;             // callee
    line?: number;           // first call-site line in caller, 0-based; sibling order
    via?: string;            // cross-language binding (pybind11, nanobind, torch, slangpy, slangtorch) and binding site
    implicit?: 'construction' | 'instance call';   // runtime call without call expression (host/implicit.ts)
}

export interface Subgraph {
    nodes: Record<NodeKey, GNode>;
    edges: GEdge[];
}

export const emptyGraph = (): Subgraph => ({ nodes: {}, edges: [] });

export function isContainer(n: GNode | undefined): boolean {
    return !!n && CONTAINER_KINDS.has(n.kind);
}

/** Proper ancestors of `key`, innermost first. */
export function ancestors(nodes: Record<NodeKey, GNode>, key: NodeKey): NodeKey[] {
    const out: NodeKey[] = [];
    const seen = new Set<NodeKey>([key]);
    let p = nodes[key]?.parent ?? null;
    while (p && !seen.has(p)) {
        out.push(p);
        seen.add(p);
        p = nodes[p]?.parent ?? null;
    }
    return out;
}

/** Graph union: later node records win; edges deduplicated by (from, to). */
export function mergeGraphs(...gs: Subgraph[]): Subgraph {
    const nodes: Record<NodeKey, GNode> = {};
    const edges = new Map<string, GEdge>();
    for (const g of gs) {
        Object.assign(nodes, g.nodes);
        for (const e of g.edges) {
            const id = `${e.from}\u0000${e.to}`;
            const prev = edges.get(id);
            if (!prev || (e.line ?? Infinity) < (prev.line ?? Infinity)) edges.set(id, e);
        }
    }
    return { nodes, edges: [...edges.values()] };
}

/** FNV-1a 32-bit over UTF-16 code units, hex; change detection, not cryptographic. */
export function fnv1a(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** Body hash, whitespace-invariant. */
export function bodyHash(text: string): string {
    return fnv1a(text.replace(/\s+/g, ' ').trim());
}

/**
 * Security tooling: Trojan Source characters (CVE-2021-42574) in language-server and view-file text shown as `\u{…}`:
 * C0/C1 controls, zero-width, joiners, bidirectional embeddings, overrides, isolates, byte-order mark.
 */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
export const visible = (s: string) => s.replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

/**
 * VS Code notification and progress text from untrusted names, paths, errors: `visible`, `](` split, since
 * notifications render `[label](command:…|file:…|https:…)` as links.
 */
export const plain = (s: string) => visible(s).replace(/\]\(/g, '] (');
