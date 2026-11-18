/**
 * Call cache per workspace folder: the answers of the language server (incoming or outgoing calls of
 * one definition) with the node records they introduced, persisted to `.gaffy/cache/calls.json`.
 *
 * Validity: a saved or renamed file drops the outgoing entries of its definitions and every incoming
 * entry (a change anywhere can add or remove a call into any definition). On load, files whose
 * modification time differs from the recorded one are treated as saved. Only answers of resolved
 * definitions are stored (version 2; version 1 files may hold empty answers of unresolved ones and are dropped).
 */
import * as vscode from 'vscode';
import { ancestors, GEdge, GNode, NodeKey } from '../core/model';

type Dir = 'in' | 'out';
const extOf = (uri: string) => /\.([A-Za-z0-9]+)$/.exec(uri)?.[1];
interface Entry { edges: GEdge[]; at: number }
interface Stored {
  version: 2;
  nodes: Record<NodeKey, GNode>;
  out: Record<NodeKey, Entry>;
  in: Record<NodeKey, Entry>;
  files: Record<string, number>;
}

export class CallCache {
  private nodes = new Map<NodeKey, GNode>();
  private entries: Record<Dir, Map<NodeKey, Entry>> = { in: new Map(), out: new Map() };
  private files = new Map<string, number>();
  private exts = new Set<string>();       // file extensions of cached definitions
  private timer: NodeJS.Timeout | undefined;
  private readonly loaded: Promise<void>;

  constructor(private readonly file: vscode.Uri) {
    this.loaded = this.load();
  }

  ready(): Promise<void> { return this.loaded; }

  private async load(): Promise<void> {
    let raw: Stored;
    try {
      raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file)));
      if (raw.version !== 2) return;
    } catch { return; }
    for (const [k, n] of Object.entries(raw.nodes ?? {})) this.remember(k, n);
    for (const d of ['in', 'out'] as Dir[]) for (const [k, e] of Object.entries(raw[d] ?? {})) this.entries[d].set(k, e);
    const changed: string[] = [];
    await Promise.all(Object.entries(raw.files ?? {}).map(async ([uri, mtime]) => {
      try {
        const st = await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
        if (st.mtime !== mtime) changed.push(uri); else this.files.set(uri, mtime);
      } catch { changed.push(uri); }
    }));
    for (const uri of changed) this.invalidate(uri, false);
  }

  get size(): number { return this.entries.in.size + this.entries.out.size; }

  node(key: NodeKey): GNode | undefined { return this.nodes.get(key); }

  /** Cached answer for `key` in direction `dir`, with the records of every node it names and their containers. */
  get(key: NodeKey, dir: Dir): { edges: GEdge[]; nodes: Record<NodeKey, GNode> } | undefined {
    const e = this.entries[dir].get(key);
    if (!e) return undefined;
    const nodes: Record<NodeKey, GNode> = {};
    const take = (k: NodeKey) => {
      for (let n = this.nodes.get(k); n && !nodes[n.key]; n = n.parent ? this.nodes.get(n.parent) : undefined) nodes[n.key] = n;
    };
    take(key);
    for (const x of e.edges) { take(x.from); take(x.to); }
    return { edges: e.edges, nodes };
  }

  put(key: NodeKey, dir: Dir, edges: GEdge[], acc: Record<NodeKey, GNode>): void {
    const keep = (k: NodeKey) => {
      const n = acc[k];
      if (!n) return;
      this.remember(k, n);
      if (n.uri && !this.files.has(n.uri)) this.files.set(n.uri, 0);
      for (const a of ancestors(acc, k)) if (acc[a]) this.remember(a, acc[a]);
    };
    keep(key);
    for (const e of edges) { keep(e.from); keep(e.to); }
    this.entries[dir].set(key, { edges, at: Date.now() });
    this.schedule();
  }

  private remember(k: NodeKey, n: GNode): void {
    this.nodes.set(k, n);
    const e = n.uri ? extOf(n.uri) : undefined;
    if (e) this.exts.add(e);
  }

  has(key: NodeKey, dir: Dir): boolean { return this.entries[dir].has(key); }

  /** Forget one answer (asked again on next use). */
  drop(key: NodeKey, dir: Dir): void {
    if (this.entries[dir].delete(key)) this.schedule();
  }

  /**
   * A file changed: its outgoing entries and every incoming entry are stale. Files with an extension no
   * cached definition has (logs, bytecode, build output) cannot add or remove a call and change nothing.
   */
  invalidate(uri: string, persist = true): void {
    const ext = extOf(uri);
    if (!this.files.has(uri) && ext !== undefined && !this.exts.has(ext)) return;
    for (const [k] of this.entries.out) if (this.nodes.get(k)?.uri === uri) this.entries.out.delete(k);
    this.entries.in.clear();
    this.files.delete(uri);
    if (persist) this.schedule();
  }

  clear(): void {
    this.entries.in.clear();
    this.entries.out.clear();
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), 2000);
  }

  private async save(): Promise<void> {
    const files: Record<string, number> = {};
    await Promise.all([...this.files.keys()].map(async (uri) => {
      try { files[uri] = (await vscode.workspace.fs.stat(vscode.Uri.parse(uri))).mtime; } catch { /* gone */ }
    }));
    const out: Stored = {
      version: 2,
      nodes: Object.fromEntries(this.nodes),
      out: Object.fromEntries(this.entries.out),
      in: Object.fromEntries(this.entries.in),
      files,
    };
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.file, '..'));
      await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(JSON.stringify(out)));
    } catch { /* read-only workspace: the cache stays in memory */ }
  }
}
