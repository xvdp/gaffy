/**
 * Call graph provider over the LSP call hierarchy exposed by VS Code built-in commands:
 * `vscode.prepareCallHierarchy`, `vscode.provideIncomingCalls`, `vscode.provideOutgoingCalls`,
 * `vscode.executeDocumentSymbolProvider`. Works for every language whose server implements call
 * hierarchy (TS/JS built in, Python via Pylance, C/C++, Rust, Go).
 *
 * Node keys: `<lang>:<relpath>#<qual>`; qual = names of the document-symbol chain enclosing the item's
 * name position. Containers: file `<lang>:<relpath>`, class `<lang>:<relpath>#<Class>`, folder
 * `dir:<reldir>` (Python packages when the folder holds `__init__.py`).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { bodyHash, GEdge, GNode, Kind, NodeKey } from '../core/model';

const LANG: Record<string, string> = {
  py: 'py', pyi: 'py', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cu: 'cpp',
  rs: 'rs', go: 'go', jl: 'jl', java: 'java', rb: 'rb', cs: 'cs', swift: 'swift', kt: 'kt',
};
const EXTERNAL = /(^|[\\/])(node_modules|site-packages|dist-packages|\.venv|venv|typeshed|typeshed-fallback)([\\/]|$)|\.d\.ts$/;
const SCOPE = new Set([
  vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Enum,
  vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Namespace, vscode.SymbolKind.Module,
]);

function kindOf(k: vscode.SymbolKind): Kind {
  switch (k) {
    case vscode.SymbolKind.Function: return 'function';
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor: return 'method';
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.Struct: return 'class';
    default: return 'function';
  }
}

type Sym = vscode.DocumentSymbol;

function chainAt(syms: readonly Sym[], pos: vscode.Position): Sym[] {
  const chain: Sym[] = [];
  let level: readonly Sym[] | undefined = syms;
  while (level?.length) {
    const s: Sym | undefined = level.find((x) => x.range.contains(pos));
    if (!s) break;
    chain.push(s);
    if (s.selectionRange.contains(pos)) break;
    level = s.children;
  }
  return chain.filter((s, i) => i === chain.length - 1 || SCOPE.has(s.kind));
}

function findQual(syms: readonly Sym[], parts: string[]): Sym | undefined {
  let level: readonly Sym[] = syms;
  let hit: Sym | undefined;
  for (let i = 0; i < parts.length; i++) {
    // non-scope symbols are skipped in quals; search through them
    const queue = [...level];
    hit = undefined;
    while (queue.length) {
      const s = queue.shift()!;
      if (s.name === parts[i] || s.name.replace(/\(.*$/, '') === parts[i]) { hit = s; break; }
      if (!SCOPE.has(s.kind)) queue.push(...(s.children ?? []));
    }
    if (!hit) return undefined;
    level = hit.children ?? [];
  }
  return hit;
}

export class LspProvider {
  private items = new Map<NodeKey, vscode.CallHierarchyItem>();
  private symbols = new Map<string, Promise<Sym[]>>();
  private packages = new Map<string, Promise<boolean>>();

  constructor(private includeExternal: () => boolean) {}

  invalidate(uri: vscode.Uri): void {
    const u = uri.toString();
    this.symbols.delete(u);
    for (const [k, it] of this.items) if (it.uri.toString() === u) this.items.delete(k);
  }

  async prepare(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem[]> {
    const r = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | vscode.CallHierarchyItem>(
      'vscode.prepareCallHierarchy', uri, pos);
    return !r ? [] : Array.isArray(r) ? r : [r];
  }

  async symbolsOf(uri: vscode.Uri): Promise<Sym[]> {
    const u = uri.toString();
    let p = this.symbols.get(u);
    if (!p) {
      p = Promise.resolve(vscode.commands.executeCommand<(Sym | vscode.SymbolInformation)[]>(
        'vscode.executeDocumentSymbolProvider', uri))
        .then((r) => (r ?? []).filter((s): s is Sym => 'selectionRange' in s))
        .catch(() => []);
      this.symbols.set(u, p);
    }
    return p;
  }

  private isPackage(dir: vscode.Uri): Promise<boolean> {
    const k = dir.toString();
    let p = this.packages.get(k);
    if (!p) {
      p = Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, '__init__.py'))).then(() => true, () => false);
      this.packages.set(k, p);
    }
    return p;
  }

  /** Adds the folder chain of `rel` to `acc`; returns the innermost folder key, null at the root. */
  private async folders(root: vscode.Uri, reldir: string, py: boolean, acc: Record<NodeKey, GNode>): Promise<{ key: NodeKey | null; pkg: string[] }> {
    if (!reldir || reldir === '.') return { key: null, pkg: [] };
    const key = `dir:${reldir}`;
    const parentDir = path.posix.dirname(reldir);
    const up = await this.folders(root, parentDir === '.' ? '' : parentDir, py, acc);
    const name = path.posix.basename(reldir);
    const isPkg = py && (await this.isPackage(vscode.Uri.joinPath(root, reldir)));
    const pkg = isPkg ? [...up.pkg, name] : [];
    if (!acc[key]) {
      acc[key] = { key, kind: isPkg ? 'package' : 'folder', name, qual: '', module: isPkg ? pkg.join('.') : reldir,
        parent: up.key, uri: vscode.Uri.joinPath(root, reldir).toString(), path: reldir };
    }
    return { key, pkg };
  }

  /** Describes `item` as a node, adding it and its containers to `acc`; undefined when excluded. */
  async describe(item: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<NodeKey | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(item.uri);
    const external = !folder || EXTERNAL.test(item.uri.path);
    if (external && !this.includeExternal()) return undefined;
    const root = folder?.uri ?? vscode.Uri.file(path.dirname(item.uri.fsPath));
    const rel = folder ? path.posix.relative(root.path, item.uri.path) : item.uri.path;
    const ext = path.posix.extname(rel).slice(1).toLowerCase();
    const lang = LANG[ext] ?? (ext || 'txt');
    const py = lang === 'py';

    const reldir = path.posix.dirname(rel);
    const dirs = await this.folders(root, reldir === '.' ? '' : reldir, py && !external, acc);
    const stem = path.posix.basename(rel, path.posix.extname(rel));
    const module = dirs.pkg.length ? [...dirs.pkg, stem].join('.') : rel.slice(0, rel.length - path.posix.extname(rel).length);
    const fileKey = `${lang}:${rel}`;
    if (!acc[fileKey]) {
      acc[fileKey] = { key: fileKey, kind: py ? 'module' : 'file', name: stem, qual: '', module, parent: dirs.key,
        uri: item.uri.toString(), path: rel, line: 0, external };
    }

    const isModuleItem = item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module;
    const chain = isModuleItem ? [] : chainAt(await this.symbolsOf(item.uri), item.selectionRange.start);
    let parent = fileKey;
    let qual: string;
    let kind: Kind;
    if (isModuleItem) {
      qual = '<module>';
      kind = 'other';
    } else if (chain.length && chain[chain.length - 1].selectionRange.contains(item.selectionRange.start)) {
      const names = chain.map((s) => s.name.replace(/\(.*$/, ''));
      for (let i = 0; i < chain.length - 1; i++) {
        const ck = `${fileKey}#${names.slice(0, i + 1).join('.')}`;
        if (!acc[ck]) {
          acc[ck] = { key: ck, kind: kindOf(chain[i].kind), name: names[i], qual: names.slice(0, i + 1).join('.'),
            module, parent, uri: item.uri.toString(), path: rel, line: chain[i].selectionRange.start.line,
            character: chain[i].selectionRange.start.character, external };
        }
        parent = ck;
      }
      qual = names.join('.');
      kind = kindOf(chain[chain.length - 1].kind);
    } else {
      qual = item.name.replace(/\(.*$/, '');
      kind = kindOf(item.kind);
    }

    const key = `${fileKey}#${qual}`;
    let hash: string | undefined;
    try {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      hash = bodyHash(doc.getText(item.range));
    } catch { /* unreadable: no MOD tracking */ }
    acc[key] = { key, kind, name: qual.split('.').pop() || item.name, qual, module, parent, uri: item.uri.toString(),
      path: rel, line: item.selectionRange.start.line, character: item.selectionRange.start.character,
      hash, detail: item.detail, external };
    this.items.set(key, item);
    return key;
  }

  /** Call hierarchy item for a known node: cache, else re-resolved by qualified name (line moves are tolerated). */
  async item(key: NodeKey, node: GNode | undefined): Promise<vscode.CallHierarchyItem | undefined> {
    const hit = this.items.get(key);
    if (hit) return hit;
    if (!node?.uri || node.qual === '<module>') return undefined;
    const uri = vscode.Uri.parse(node.uri);
    let pos: vscode.Position | undefined;
    const sym = node.qual ? findQual(await this.symbolsOf(uri), node.qual.split('.')) : undefined;
    if (sym) pos = sym.selectionRange.start;
    else if (node.line !== undefined) pos = new vscode.Position(node.line, node.character ?? 0);
    if (!pos) return undefined;
    const items = await this.prepare(uri, pos);
    const it = items.find((i) => i.name.replace(/\(.*$/, '') === node.name) ?? (sym ? items[0] : undefined);
    if (it) this.items.set(key, it);
    return it;
  }

  async outgoing(key: NodeKey, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
    const it = await this.item(key, acc[key]);
    if (!it) return [];
    const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', it) ?? [];
    const edges: GEdge[] = [];
    for (const c of calls) {
      const to = await this.describe(c.to, acc);
      if (to) edges.push({ from: key, to, line: c.fromRanges[0]?.start.line });
    }
    return edges;
  }

  async incoming(key: NodeKey, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
    const it = await this.item(key, acc[key]);
    if (!it) return [];
    const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', it) ?? [];
    const edges: GEdge[] = [];
    for (const c of calls) {
      const from = await this.describe(c.from, acc);
      if (from) edges.push({ from, to: key, line: c.fromRanges[0]?.start.line });
    }
    return edges;
  }
}
