/**
 * Graph data model shared by the extension host and the webview.
 *
 * Call multigraph G = (V, E) over definitions, paired with a containment tree T over definitions and
 * containers (class, module or file, package or folder): a compound graph. `parent` encodes T.
 * Keys exclude line numbers: `<lang>:<relpath>#<qualname>` for definitions, `<lang>:<relpath>` for
 * files, `dir:<reldir>` for folders. Edits that move a definition keep its key.
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
  name: string;            // short name: "projector"
  qual: string;            // qualified name inside its file: "Pass.compile"; "" for containers
  module: string;          // display module: "render.harmonics", "scripts/mote_paths"
  parent: NodeKey | null;  // innermost container
  uri?: string;            // file URI
  path?: string;           // workspace-relative file path
  line?: number;           // 0-based line of the name
  character?: number;      // 0-based column of the name
  hash?: string;           // body hash, whitespace-invariant
  detail?: string;
  external?: boolean;
}

export interface GEdge {
  from: NodeKey;           // caller
  to: NodeKey;             // callee
  line?: number;           // first call-site line in the caller, 0-based; orders siblings
  via?: string;            // a call across languages: the binding layer (pybind11, nanobind, torch, slangpy, slangtorch) and where it binds
}

export interface Subgraph {
  nodes: Record<NodeKey, GNode>;
  edges: GEdge[];
}

export const emptyGraph = (): Subgraph => ({ nodes: {}, edges: [] });

export function isContainer(n: GNode | undefined): boolean {
  return !!n && CONTAINER_KINDS.has(n.kind);
}

/** Ancestors of `key`, innermost first, excluding `key`. */
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

/** Union of graphs; later node records replace earlier ones; edges deduplicated by (from, to). */
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

/** FNV-1a 32-bit over UTF-16 code units, hex. Change detection only, not cryptographic. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Body hash invariant to whitespace runs and blank lines. */
export function bodyHash(text: string): string {
  return fnv1a(text.replace(/\s+/g, ' ').trim());
}
