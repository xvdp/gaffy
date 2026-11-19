/**
 * Call graph provider over the LSP call hierarchy exposed by VS Code built-in commands:
 * `vscode.prepareCallHierarchy`, `vscode.provideIncomingCalls`, `vscode.provideOutgoingCalls`,
 * `vscode.executeDocumentSymbolProvider`. Works for every language whose server implements call
 * hierarchy (TS/JS built in, Python via Pylance, C/C++, Rust, Go, …). Languages whose server has none
 * (shader languages, `TEXT_LANGS`) get calls found in the text (textcalls.ts): call sites in a function
 * body resolved by go to definition, else by name among the functions of that language in the workspace;
 * callers by references, else by the same scan over the workspace.
 *
 * Node keys: `<lang>:<relpath>#<qual>`; qual = segments (langs.ts) of the document-symbol chain enclosing
 * the item's name position. Containers: file `<lang>:<relpath>`, class `<lang>:<relpath>#<Class>`, folder
 * `dir:<reldir>` (Python packages when the folder holds `__init__.py`).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXTERNAL, extsOf, LANG, langOf, segments, TEXT_LANGS } from '../core/langs';
import { bodyHash, GEdge, GNode, Kind, NodeKey } from '../core/model';
import { callSites, mask, outline, TextSym } from '../core/textcalls';
import { Bridges } from './bridges';

// symbols that enclose a qualified name: types, functions, namespaces, impl blocks (Object), object
// literals and their variables (TypeScript `const obj = { run() {} }` → `obj.run`)
const SCOPE = new Set([
  vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Enum,
  vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Namespace, vscode.SymbolKind.Module, vscode.SymbolKind.Package, vscode.SymbolKind.Object,
  vscode.SymbolKind.Variable, vscode.SymbolKind.Constant,
]);
const FUNCTIONS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);

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

/**
 * A language-server request that has not answered after `ms` counts as no answer (retried later): one
 * stalled request would otherwise hold a view's request queue, and every open, close and refresh behind it.
 */
const REQUEST_MS = 30000;
function timed<T>(p: Thenable<T>, ms = REQUEST_MS): Promise<T | undefined> {
  return new Promise((res) => {
    const t = setTimeout(() => res(undefined), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(undefined); });
  });
}
interface TextFile { uri: vscode.Uri; doc: vscode.TextDocument; masked: string; fns: Sym[] }

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

/** Symbol whose chain of segments spells `parts`; non-scope symbols are skipped in quals, so search through them. */
function findQual(syms: readonly Sym[], parts: string[]): Sym | undefined {
  const queue = [...syms];
  while (queue.length) {
    const s = queue.shift()!;
    const seg = segments(s.name);
    if (seg.every((x, i) => parts[i] === x)) {
      if (seg.length === parts.length) return s;
      const hit = findQual(s.children ?? [], parts.slice(seg.length));
      if (hit) return hit;
    }
    if (!SCOPE.has(s.kind)) queue.push(...(s.children ?? []));
  }
  return undefined;
}

/** Innermost function or method symbol containing `pos`. */
function functionSymAt(syms: readonly Sym[], pos: vscode.Position): Sym | undefined {
  for (const s of syms) {
    if (!s.range.contains(pos)) continue;
    const inner = functionSymAt(s.children ?? [], pos);
    if (inner) return inner;
    if (FUNCTIONS.has(s.kind)) return s;
  }
  return undefined;
}

/** Text outline as document symbols (servers without document symbols). */
function toSymbols(doc: vscode.TextDocument, syms: TextSym[]): Sym[] {
  return syms.map((t) => {
    const name = new vscode.Range(doc.positionAt(t.nameAt), doc.positionAt(t.nameAt + t.name.length));
    const s = new vscode.DocumentSymbol(t.name, '', t.kind === 'function' ? vscode.SymbolKind.Function : vscode.SymbolKind.Struct,
      new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end)), name);
    s.children = toSymbols(doc, t.children);
    return s;
  });
}

export class LspProvider {
  private items = new Map<NodeKey, vscode.CallHierarchyItem>();
  private symbols = new Map<string, Promise<Sym[]>>();
  private packages = new Map<string, Promise<boolean>>();

  /** Calls across languages (pybind11, nanobind, torch, slangpy, slangtorch); `gaffy.bridges`. */
  readonly bridges = new Bridges(this, () => vscode.workspace.getConfiguration('gaffy').get<boolean>('bridges') ?? true);

  constructor(private includeExternal: () => boolean) {}

  /** The function enclosing `pos`, as a call hierarchy item (Python callers of a binding). */
  async callerAt(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
    const fn = functionSymAt(await this.symbolsOf(uri), pos);
    return fn ? (await this.prepare(uri, fn.selectionRange.start))[0] : undefined;
  }

  invalidate(uri: vscode.Uri): void {
    const u = uri.toString();
    this.symbols.delete(u);
    for (const [k, it] of this.items) if (it.uri.toString() === u) this.items.delete(k);
    this.index.delete(langOf(uri.path));
    this.bridges.invalidate(uri);
  }

  /** Call hierarchy items at a position; for text languages without a call hierarchy, the enclosing function. */
  async prepare(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem[]> {
    let r: vscode.CallHierarchyItem[] | vscode.CallHierarchyItem | undefined;
    try {
      r = await timed(vscode.commands.executeCommand<vscode.CallHierarchyItem[] | vscode.CallHierarchyItem>('vscode.prepareCallHierarchy', uri, pos));
    } catch { r = undefined; }
    const items = !r ? [] : Array.isArray(r) ? r : [r];
    if (items.length || !TEXT_LANGS.has(langOf(uri.path))) return items;
    const it = await this.textItem(uri, pos);
    return it ? [it] : [];
  }

  async symbolsOf(uri: vscode.Uri): Promise<Sym[]> {
    const u = uri.toString();
    let p = this.symbols.get(u);
    if (!p) {
      p = Promise.resolve(vscode.commands.executeCommand<(Sym | vscode.SymbolInformation)[]>(
        'vscode.executeDocumentSymbolProvider', uri))
        .then((r) => (r ?? []).filter((s): s is Sym => 'selectionRange' in s))
        .catch(() => [] as Sym[])
        .then(async (syms) => {
          // text languages without a symbol provider: the text outline
          if (syms.length || !TEXT_LANGS.has(langOf(uri.path))) return syms;
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            return toSymbols(doc, outline(doc.getText()));
          } catch { return []; }
        });
      this.symbols.set(u, p);
    }
    return p;
  }

  // ---- calls found in the text (TEXT_LANGS) ----------------------------------------------------------
  private textItems = new WeakSet<vscode.CallHierarchyItem>();
  private index = new Map<string, Promise<TextFile[]>>();

  /** The function at `pos` as a call hierarchy item built from document symbols (or the text outline). */
  private async textItem(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
    const fn = functionSymAt(await this.symbolsOf(uri), pos);
    if (!fn) return undefined;
    const it = new vscode.CallHierarchyItem(fn.kind, fn.name, fn.detail ?? '', uri, fn.range, fn.selectionRange);
    this.textItems.add(it);
    return it;
  }

  /** Functions of one text language in the workspace, with their masked text for call sites. */
  private files(lang: string): Promise<TextFile[]> {
    let p = this.index.get(lang);
    if (!p) {
      p = (async () => {
        const uris = await vscode.workspace.findFiles(`**/*.{${extsOf(lang).join(',')}}`, '**/{node_modules,.git,.gaffy}/**', 3000);
        const out: TextFile[] = [];
        for (const uri of uris) {
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const fns: Sym[] = [];
            const walk = (ss: readonly Sym[]) => { for (const x of ss) { if (FUNCTIONS.has(x.kind)) fns.push(x); walk(x.children ?? []); } };
            walk(await this.symbolsOf(uri));
            out.push({ uri, doc, masked: mask(doc.getText()), fns });
          } catch { /* unreadable */ }
        }
        return out;
      })();
      this.index.set(lang, p);
    }
    return p;
  }

  /** Functions a call site names: go to definition, else every function of that name (same file first). */
  private async resolve(uri: vscode.Uri, pos: vscode.Position, name: string): Promise<vscode.CallHierarchyItem[]> {
    let locs: (vscode.Location | vscode.LocationLink)[] = [];
    try { locs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, pos) ?? []; } catch { /* none */ }
    for (const l of locs) {
      const tu = 'targetUri' in l ? l.targetUri : l.uri;
      const tp = 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange).start : l.range.start;
      const it = await this.textItem(tu, tp);
      if (it && segments(it.name).pop() === name) return [it];
    }
    const files = await this.files(langOf(uri.path));
    const hits = files.flatMap((f) => f.fns.filter((x) => segments(x.name).pop() === name).map((x) => ({ f, x })));
    const local = hits.filter((h) => h.f.uri.toString() === uri.toString());
    return (local.length ? local : hits).map(({ f, x }) => {
      const it = new vscode.CallHierarchyItem(x.kind, x.name, x.detail ?? '', f.uri, x.range, x.selectionRange);
      this.textItems.add(it);
      return it;
    });
  }

  private async textOutgoing(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
    const doc = await vscode.workspace.openTextDocument(it.uri);
    const edges: GEdge[] = [];
    for (const site of callSites(doc.getText(), doc.offsetAt(it.selectionRange.end), doc.offsetAt(it.range.end))) {
      const pos = doc.positionAt(site.at);
      for (const t of await this.resolve(it.uri, pos, site.name)) {
        const to = await this.describe(t, acc);
        if (to) edges.push({ from: key, to, line: pos.line });
      }
    }
    return edges;
  }

  private async textIncoming(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
    const name = segments(it.name).pop()!;
    const edges: GEdge[] = [];
    const callerAt = async (uri: vscode.Uri, pos: vscode.Position) => {
      const c = await this.textItem(uri, pos);
      const from = c && (await this.describe(c, acc));
      if (from) edges.push({ from, to: key, line: pos.line });
    };
    // references, where the server has them
    let refs: vscode.Location[] = [];
    try { refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', it.uri, it.selectionRange.start) ?? []; } catch { /* none */ }
    refs = refs.filter((r) => !(r.uri.toString() === it.uri.toString() && r.range.intersection(it.selectionRange)));
    if (refs.length) {
      for (const r of refs) await callerAt(r.uri, r.range.start);
      return edges;
    }
    // else every call site of that name in the language's files that resolves here (or does not resolve)
    for (const f of await this.files(langOf(it.uri.path))) {
      for (const fn of f.fns) {
        for (const site of callSites(f.masked, f.doc.offsetAt(fn.selectionRange.end), f.doc.offsetAt(fn.range.end), true)) {
          if (site.name !== name) continue;
          const pos = f.doc.positionAt(site.at);
          const to = await this.resolve(f.uri, pos, name);
          if (to.length && !to.some((t) => t.uri.toString() === it.uri.toString() && t.range.contains(it.selectionRange.start))) continue;
          await callerAt(f.uri, pos);
        }
      }
    }
    return edges;
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
    const lang = LANG[ext] ?? (ext || 'txt');   // langs.ts
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
      // one symbol may carry several segments (`Foo::bar` in C++): the leading ones become containers
      const segs = chain.flatMap((s, i) => segments(s.name).map((name, j, all) => ({ name, sym: s, last: i === chain.length - 1 && j === all.length - 1, lead: j < all.length - 1 })));
      for (let i = 0; i < segs.length - 1; i++) {
        const q = segs.slice(0, i + 1).map((x) => x.name).join('.');
        const ck = `${fileKey}#${q}`;
        if (!acc[ck]) {
          const sym = segs[i].sym;
          acc[ck] = { key: ck, kind: segs[i].lead ? 'class' : kindOf(sym.kind), name: segs[i].name, qual: q,
            module, parent, uri: item.uri.toString(), path: rel, line: sym.selectionRange.start.line,
            character: sym.selectionRange.start.character, external };
        }
        parent = ck;
      }
      qual = segs.map((x) => x.name).join('.');
      kind = kindOf(chain[chain.length - 1].kind);
    } else {
      qual = segments(item.name).join('.');
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
    const it = items.find((i) => segments(i.name).pop() === node.name) ?? (sym ? items[0] : undefined);
    if (it) this.items.set(key, it);
    return it;
  }

  /**
   * Outgoing calls of a definition. `undefined`: no answer (the definition does not resolve, e.g. while
   * the language server is still analyzing, or the request failed); `[]`: the definition calls nothing.
   */
  async outgoing(key: NodeKey, acc: Record<NodeKey, GNode>): Promise<GEdge[] | undefined> {
    const it = await this.item(key, acc[key]).catch(() => undefined);
    if (!it) return undefined;
    const own = this.textItems.has(it) ? await this.textOutgoing(key, it, acc).catch(() => undefined) : await this.lspOutgoing(key, it, acc);
    // calls across languages join the answer (a Python function calling bound C++/CUDA or Slang)
    return own && own.concat(await this.bridges.outgoing(key, it, acc).catch(() => []));
  }

  private async lspOutgoing(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[] | undefined> {
    let calls: vscode.CallHierarchyOutgoingCall[] | undefined;
    try {
      calls = await timed(vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', it));
    } catch { return undefined; }
    if (!calls) return undefined;
    const edges: GEdge[] = [];
    for (const c of calls) {
      const to = await this.describe(c.to, acc);
      if (to) edges.push({ from: key, to, line: c.fromRanges[0]?.start.line });
    }
    return edges;
  }

  /** Incoming calls of a definition; `undefined` and `[]` as for `outgoing`. */
  async incoming(key: NodeKey, acc: Record<NodeKey, GNode>): Promise<GEdge[] | undefined> {
    const it = await this.item(key, acc[key]).catch(() => undefined);
    if (!it) return undefined;
    const own = this.textItems.has(it) ? await this.textIncoming(key, it, acc).catch(() => undefined) : await this.lspIncoming(key, it, acc);
    // Python callers across bindings join the answer
    return own && own.concat(await this.bridges.incoming(key, it, acc).catch(() => []));
  }

  private async lspIncoming(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[] | undefined> {
    let calls: vscode.CallHierarchyIncomingCall[] | undefined;
    try {
      calls = await timed(vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', it));
    } catch { return undefined; }
    if (!calls) return undefined;
    const edges: GEdge[] = [];
    for (const c of calls) {
      const from = await this.describe(c.from, acc);
      if (from) edges.push({ from, to: key, line: c.fromRanges[0]?.start.line });
    }
    return edges;
  }
}
