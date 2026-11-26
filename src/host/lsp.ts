/** @xvdp
 * Call graph provider over the LSP call hierarchy (VS Code commands `vscode.prepareCallHierarchy`,
 * `vscode.provideIncomingCalls`, `vscode.provideOutgoingCalls`, `vscode.executeDocumentSymbolProvider`): TS/JS
 * built in, Python via Pylance, C/C++, Rust, Go, …. Languages without call hierarchy (shaders, `TEXT_LANGS`): text
 * calls (textcalls.ts); callees by go to definition, else by name; callers by references, else workspace scan.
 *
 * Node keys: `<lang>:<relpath>#<qual>`; qual: segments (langs.ts) of the document-symbol chain at the item's name.
 * Containers: file `<lang>:<relpath>`, class `<lang>:<relpath>#<Class>`, folder `dir:<reldir>` (Python package
 * with `__init__.py`).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { viewScope } from './context';
import { EXTERNAL, externalPath, extsOf, LANG, langOf, OVERLOADS, paramTypes, segments, TEXT_LANGS } from '../core/langs';
import { bodyHash, GEdge, GNode, Kind, NodeKey } from '../core/model';
import { pyCallSites } from '../core/bindings';
import { callSites, mask, outline, TextSym } from '../core/textcalls';
import { Bridges, Unresolved } from './bridges';
import { Implicit } from './implicit';
import { readable } from './scope';
import { SeedSpec } from './seedspec';

// symbols enclosing a qualified name: types, functions, namespaces, impl blocks (Object), object literals
// and their variables (TypeScript `const foo = { run() {} }` → `foo.run`)
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

/* Per-request time limit against stalls. */
const REQUEST_MS = 30000;
/* secure tooling: calls kept per answer, either direction; stops a function becoming an unbounded hub. */
export const MAX_CALLS = 5000;
/** Concurrent `describe` calls per answer (symbols, documents, folders cached per file). */
const DESCRIBE_AT_ONCE = 16;

/** `fn` over `items`, ≤ `limit` concurrent, input order; stops on `token` cancel. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>, token?: vscode.CancellationToken): Promise<(R | undefined)[]> {
    const out: (R | undefined)[] = new Array(items.length);
    let i = 0;
    const run = async () => { while (i < items.length && !token?.isCancellationRequested) { const j = i++; out[j] = await fn(items[j]); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return out;
}

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

/**
 * Whether the last symbol of `chain` shares its name with another symbol of its scope (an overload). Names compare
 * by `segments`: the C/C++ extension names symbols with their parameter lists (`f(int a)`, `f(float3 b)`).
 */
function overloaded(chain: readonly Sym[], top: readonly Sym[]): boolean {
    const me = chain[chain.length - 1];
    const base = (x: Sym) => segments(x.name).join('.');
    const scope = chain.length > 1 ? chain[chain.length - 2].children ?? [] : top;
    return scope.some((s) => s !== me && base(s) === base(me));
}

/** Every symbol whose segment chain spells `parts` (overloads); `findQual` returns the first. */
function findQuals(syms: readonly Sym[], parts: string[], out: Sym[] = []): Sym[] {
    for (const s of syms) {
        const seg = segments(s.name);
        if (seg.every((x, i) => parts[i] === x)) {
            if (seg.length === parts.length) out.push(s);
            else findQuals(s.children ?? [], parts.slice(seg.length), out);
        }
        if (!SCOPE.has(s.kind)) findQuals(s.children ?? [], parts, out);
    }
    return out;
}

/** Symbol whose segment chain spells `parts`; searches through non-scope symbols (absent from quals). */
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
    /** `<dir>:<key>` of empty outgoing answers for bodies with call sites (`silentOf`). */
    private silent = new Set<string>();
    /** `<dir>:<key>` → full length of answers over `MAX_CALLS` (`clampOf`). */
    private clamps = new Map<string, number>();

    /** Calls across languages (pybind11, nanobind, torch, slangpy, slangtorch); `gaffy.bridges`. */
    readonly bridges = new Bridges(this, () => vscode.workspace.getConfiguration('gaffy').get<boolean>('bridges') ?? true);
    /** Runtime calls without a call expression: construction, instance calls. */
    readonly implicit = new Implicit(this);

    constructor(private includeExternal: () => boolean) {}

    /** Function enclosing `pos` as a call hierarchy item (Python callers of a binding). */
    async callerAt(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
        const fn = functionSymAt(await this.symbolsOf(uri), pos);
        return fn ? (await this.prepare(uri, fn.selectionRange.start))[0] : undefined;
    }

    /**
     * Range of a definition's full text: Pyright and Pylance set `range` = `selectionRange` (name only; measured
     * with Pyright), so the outline symbol at the name supplies the body.
     */
    async bodyOf(it: vscode.CallHierarchyItem): Promise<vscode.Range> {
        if (!it.range.isEqual(it.selectionRange)) return it.range;
        const pos = it.selectionRange.start;
        let found: Sym | undefined;
        const walk = (ss: readonly Sym[]) => {
            for (const s of ss) {
                if (!s.range.contains(pos)) continue;
                if (s.selectionRange.contains(pos)) found = s;
                walk(s.children ?? []);
            }
        };
        walk(await this.symbolsOf(it.uri));
        return found?.range ?? it.range;
    }

    /** Full length of the last (`key`, `dir`) answer over `MAX_CALLS`, else undefined; read once. */
    clampOf(key: NodeKey, dir: 'in' | 'out'): number | undefined {
        const n = this.clamps.get(`${dir}:${key}`);
        this.clamps.delete(`${dir}:${key}`);
        return n;
    }

    /**
     * Whether the last (`key`, `dir`) answer was empty despite call sites in the text (loading server, e.g.
     * TypeScript's syntax-only server); read once; build.ts doubts it.
     */
    silentOf(key: NodeKey, dir: 'in' | 'out'): boolean {
        return this.silent.delete(`${dir}:${key}`);
    }

    invalidate(uri: vscode.Uri): void {
        const u = uri.toString();
        this.symbols.delete(u);
        for (const [k, it] of this.items) if (it.uri.toString() === u) this.items.delete(k);
        this.index.delete(langOf(uri.path));
        this.bridges.invalidate(uri);
    }

    /** Call hierarchy items at `pos`; for text languages without one, the enclosing function. */
    async prepare(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem[]> {
        if (!readable(uri)) return [];
        let r: vscode.CallHierarchyItem[] | vscode.CallHierarchyItem | undefined;
        try {
            r = await timed(vscode.commands.executeCommand<vscode.CallHierarchyItem[] | vscode.CallHierarchyItem>('vscode.prepareCallHierarchy', uri, pos));
        } catch { r = undefined; }
        const items = (!r ? [] : Array.isArray(r) ? r : [r]).filter((i) => readable(i.uri));
        if (items.length || !TEXT_LANGS.has(langOf(uri.path))) return items;
        const it = await this.textItem(uri, pos);
        return it ? [it] : [];
    }

    async symbolsOf(uri: vscode.Uri): Promise<Sym[]> {
        if (!readable(uri)) return [];
        const u = uri.toString();
        let p = this.symbols.get(u);
        if (!p) {
            p = Promise.resolve(vscode.commands.executeCommand<(Sym | vscode.SymbolInformation)[]>(
                'vscode.executeDocumentSymbolProvider', uri))
                .then((r) => (r ?? []).filter((s): s is Sym => 'selectionRange' in s))
                .catch(() => [] as Sym[])
                .then(async (syms) => {
                    // text languages without symbol provider: text outline
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

    /** Function at `pos` as a call hierarchy item from document symbols or text outline. */
    private async textItem(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
        const fn = functionSymAt(await this.symbolsOf(uri), pos);
        if (!fn) return undefined;
        const it = new vscode.CallHierarchyItem(fn.kind, fn.name, fn.detail ?? '', uri, fn.range, fn.selectionRange);
        this.textItems.add(it);
        return it;
    }

    /** Workspace functions of one text language, with masked text for call-site scans. */
    private files(lang: string): Promise<TextFile[]> {
        let p = this.index.get(lang);
        if (!p) {
            p = (async () => {
                const uris = await vscode.workspace.findFiles(`**/*.{${extsOf(lang).join(',')}}`, '**/{node_modules,.git,.gaffy,.baggy}/**', 3000);
                const out: TextFile[] = [];
                for (const uri of uris) {
                    try {
                        if ((await vscode.workspace.fs.stat(uri)).size > 2_000_000) continue;   // generated or minified: not scanned
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

    /** Call-site callees: go to definition, else functions of that name (same file first). */
    private async resolve(uri: vscode.Uri, pos: vscode.Position, name: string): Promise<vscode.CallHierarchyItem[]> {
        let locs: (vscode.Location | vscode.LocationLink)[] = [];
        try { locs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, pos) ?? []; } catch { /* none */ }
        for (const l of locs) {
            const tu = 'targetUri' in l ? l.targetUri : l.uri;
            const tp = 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange).start : l.range.start;
            if (!readable(tu)) continue;
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
        // server references, when available
        let refs: vscode.Location[] = [];
        try { refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', it.uri, it.selectionRange.start) ?? []; } catch { /* none */ }
        refs = refs.filter((r) => readable(r.uri) && !(r.uri.toString() === it.uri.toString() && r.range.intersection(it.selectionRange)));
        if (refs.length) {
            for (const r of refs) await callerAt(r.uri, r.range.start);
            return edges;
        }
        // else call sites of that name in the language's files, resolving here or unresolved
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

    /** Adds the folder chain of `reldir` to `acc`; returns the innermost folder key, null at the root. */
    private async folders(root: vscode.Uri, reldir: string, py: boolean, acc: Record<NodeKey, GNode>): Promise<{ key: NodeKey | null; pkg: string[] }> {
        if (!reldir || reldir === '.' || reldir === '/') return { key: null, pkg: [] };
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

    /** Adds `item` and its containers to `acc` as nodes; returns its key, undefined when excluded. */
    async describe(item: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<NodeKey | undefined> {
        const folder = vscode.workspace.getWorkspaceFolder(item.uri);
        const external = !folder || EXTERNAL.test(item.uri.path);
        // the building view's choice (context.ts), else the setting (a new view's seed)
        if (external && !(viewScope.getStore()?.external ?? this.includeExternal())) return undefined;
        // outside every folder: path from its library root (`site-packages/torch/functional.py`)
        const lib = folder ? undefined : externalPath(item.uri.path);
        const root = folder?.uri ?? item.uri.with({ path: lib!.root });
        const rel = folder ? path.posix.relative(root.path, item.uri.path) : lib!.rel;
        const ext = path.posix.extname(rel).slice(1).toLowerCase();
        const lang = LANG[ext] ?? (ext || 'txt');   // langs.ts
        const py = lang === 'py';

        const reldir = path.posix.dirname(rel);
        const dirs = await this.folders(root, reldir === '.' ? '' : reldir, py && !external, acc);
        const stem = path.posix.basename(rel, path.posix.extname(rel));
        const module = lib?.module ?? (dirs.pkg.length ? [...dirs.pkg, stem].join('.') : rel.slice(0, rel.length - path.posix.extname(rel).length));
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
            // a symbol can carry several segments (C++ `Foo::bar`); leading ones become containers
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
            // not in the outline (overload listed once, nested definition): enclosing scopes as containers,
            // so every overload of `C.f` keys as `C.f`
            const segs = chain.flatMap((sym) => segments(sym.name).map((name, j, all) => ({ name, sym, lead: j < all.length - 1 })));
            for (let i = 0; i < segs.length; i++) {
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
            qual = [...segs.map((x) => x.name), ...segments(item.name)].join('.');
            kind = kindOf(item.kind);
        }

        let key = `${fileKey}#${qual}`;
        let hash: string | undefined;
        let types: string | undefined;
        try {
            if (readable(item.uri)) {
                const doc = await vscode.workspace.openTextDocument(item.uri);
                hash = bodyHash(doc.getText(await this.bodyOf(item)));
                // overloads (same name, one scope): parameter types in the key, `f(int,float3*)`
                if (OVERLOADS.has(lang) && chain.length && overloaded(chain, await this.symbolsOf(item.uri))) {
                    types = paramTypes(doc.getText(new vscode.Range(item.selectionRange.start, doc.positionAt(doc.offsetAt(item.selectionRange.start) + 4000))));
                    if (types !== undefined) key = `${fileKey}#${qual}(${types})`;
                }
            }
        } catch { /* unreadable: no MOD tracking */ }
        const name = qual.split('.').pop() || item.name;
        acc[key] = { key, kind, name, qual, module, parent, uri: item.uri.toString(),
            path: rel, line: item.selectionRange.start.line, character: item.selectionRange.start.character,
            hash, detail: item.detail || (types !== undefined ? `${name}(${types})` : undefined), external };
        this.items.set(key, item);
        return key;
    }

    /**
     * Key of the definition a seed names (seedspec.ts): by qualified name through document symbols, or by line
     * (innermost symbol containing it); `acc` gains its record and containers. Undefined while the file has no
     * symbols (language server loading) or no call hierarchy item there.
     */
    async seedAt(uri: vscode.Uri, spec: SeedSpec, acc: Record<NodeKey, GNode>): Promise<NodeKey | undefined> {
        const syms = await this.symbolsOf(uri);
        if (!syms.length) this.symbols.delete(uri.toString());   // a loading server answers none: ask again on retry
        let sym: Sym | undefined;
        if (spec.qual) sym = findQual(syms, spec.qual.split('.'));
        else if (spec.line) {
            const l = spec.line - 1;
            const inside = (list: readonly Sym[]): Sym | undefined => {
                const s = list.find((x) => x.range.start.line <= l && l <= x.range.end.line);
                return s ? inside(s.children ?? []) ?? s : undefined;
            };
            sym = inside(syms);
        }
        if (!sym) return undefined;
        const items = await this.prepare(uri, sym.selectionRange.start);
        return items.length ? this.describe(items[0], acc) : undefined;
    }

    /** Call hierarchy item of a node: cached, else by qualified name (tolerates line moves). */
    async item(key: NodeKey, node: GNode | undefined): Promise<vscode.CallHierarchyItem | undefined> {
        const hit = this.items.get(key);
        if (hit) return hit;
        if (!node?.uri || node.qual === '<module>') return undefined;
        const uri = vscode.Uri.parse(node.uri);
        let pos: vscode.Position | undefined;
        const syms = await this.symbolsOf(uri);
        let sym = node.qual ? findQual(syms, node.qual.split('.')) : undefined;
        // an overload key `qual(types)`: the same-named symbol whose parameter types match
        const want = key.endsWith(')') && node.qual ? key.slice(key.indexOf('#') + 1 + node.qual.length) : undefined;
        if (want?.startsWith('(')) {
            const all = findQuals(syms, node.qual.split('.'));
            if (all.length > 1) {
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const at = (x: Sym) => doc.getText(new vscode.Range(x.selectionRange.start, doc.positionAt(doc.offsetAt(x.selectionRange.start) + 4000)));
                    sym = all.find((x) => `(${paramTypes(at(x))})` === want) ?? sym;
                } catch { /* unreadable: first overload */ }
            }
        }
        if (sym) pos = sym.selectionRange.start;
        else if (node.line !== undefined) pos = new vscode.Position(node.line, node.character ?? 0);
        if (!pos) return undefined;
        const items = await this.prepare(uri, pos);
        const it = items.find((i) => segments(i.name).pop() === node.name) ?? (sym ? items[0] : undefined);
        if (it) this.items.set(key, it);
        return it;
    }

    /**
     * Outgoing calls. `undefined`: no answer (unresolved definition: server analyzing, request failed);
     * `[]`: calls nothing.
     */
    /** Answer of (`key`, `dir`) given without a binding link whose target did not resolve (bridges.ts `partial`). */
    partialOf(key: NodeKey, dir: 'in' | 'out'): boolean { return this.bridges.partial.has(`${dir}:${key}`); }

    async outgoing(key: NodeKey, acc: Record<NodeKey, GNode>, token?: vscode.CancellationToken): Promise<GEdge[] | undefined> {
        const it = await this.item(key, acc[key]).catch(() => undefined);
        if (!it) return undefined;
        let own: GEdge[] | undefined;
        let answered: vscode.Range[] = [];
        if (this.textItems.has(it)) own = await this.textOutgoing(key, it, acc).catch(() => undefined);
        else {
            const r = await this.lspOutgoing(key, it, acc, await this.bridges.boundIn(it.uri).catch(() => undefined), token);
            own = r?.edges;
            answered = r?.ranges ?? [];
            if (r && !r.ranges.length) {
                try {
                    const doc = await vscode.workspace.openTextDocument(it.uri);
                    const text = doc.getText(), from = doc.offsetAt(it.selectionRange.end), to = doc.offsetAt((await this.bodyOf(it)).end);
                    const sites = langOf(it.uri.path) === 'py' ? pyCallSites(text, from, to) : callSites(text, from, to);
                    if (sites.length) this.silent.add(`out:${key}`);
                } catch { /* unreadable: taken as answered */ }
            }
        }
        if (!own) return undefined;
        // plus cross-language calls (bridges.ts) and implicit calls
        // a binding target not resolved yet (C/C++ server loading): no answer, retried rather than cached incomplete
        const cross = await this.bridges.outgoing(key, it, acc).catch((e) => (e instanceof Unresolved ? undefined : []));
        if (!cross) return undefined;
        const implicit = await this.implicit.outgoing(key, it, acc, answered).catch(() => []);
        return own.concat(cross, implicit);
    }

    /**
     * Server outgoing calls and their call ranges; unreadable schemes dropped (scope.ts); first `MAX_CALLS` kept
     * (`clampOf`: full length). `bound`: binding-matched call ranges; server edges from them drop (same-name match).
     * Cancelled `token` → undefined (a partial answer is no answer).
     */
    private async lspOutgoing(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>,
        bound?: (r: vscode.Range) => boolean, token?: vscode.CancellationToken): Promise<{ edges: GEdge[]; ranges: vscode.Range[] } | undefined> {
        let calls: vscode.CallHierarchyOutgoingCall[] | undefined;
        try {
            calls = await timed(vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', it));
        } catch { return undefined; }
        if (!calls) return undefined;
        const ok = calls.filter((x) => readable(x.to.uri));
        if (ok.length > MAX_CALLS) this.clamps.set(`out:${key}`, ok.length);
        const take = ok.slice(0, MAX_CALLS).filter((c) => !(bound && c.fromRanges.length && c.fromRanges.every(bound)));
        const tos = await mapLimit(take, DESCRIBE_AT_ONCE, (c) => this.describe(c.to, acc), token);
        if (token?.isCancellationRequested) return undefined;
        return {
            edges: take.flatMap((c, i) => (tos[i] ? [{ from: key, to: tos[i]!, line: c.fromRanges[0]?.start.line }] : [])),
            ranges: calls.flatMap((c) => c.fromRanges),
        };
    }

    /** Incoming calls of a definition; `undefined` and `[]` as for `outgoing`. */
    async incoming(key: NodeKey, acc: Record<NodeKey, GNode>, token?: vscode.CancellationToken): Promise<GEdge[] | undefined> {
        const it = await this.item(key, acc[key]).catch(() => undefined);
        if (!it) return undefined;
        const own = this.textItems.has(it) ? await this.textIncoming(key, it, acc).catch(() => undefined) : await this.lspIncoming(key, it, acc, token);
        // plus cross-language callers and implicit callers (constructing class)
        if (!own) return undefined;
        const cross = await this.bridges.incoming(key, it, acc).catch((e) => (e instanceof Unresolved ? undefined : []));
        if (!cross) return undefined;
        return own.concat(cross, await this.implicit.incoming(key, it, acc).catch(() => []));
    }

    /** Incoming calls from the language server; schemes, `MAX_CALLS`, concurrency and `token` as for `lspOutgoing`. */
    private async lspIncoming(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>,
        token?: vscode.CancellationToken): Promise<GEdge[] | undefined> {
        let calls: vscode.CallHierarchyIncomingCall[] | undefined;
        try {
            calls = await timed(vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', it));
        } catch { return undefined; }
        if (!calls) return undefined;
        const ok = calls.filter((x) => readable(x.from.uri));
        if (ok.length > MAX_CALLS) this.clamps.set(`in:${key}`, ok.length);
        const boundBy = new Map<string, Promise<((r: vscode.Range) => boolean) | undefined>>();
        const take = ok.slice(0, MAX_CALLS);
        const froms = await mapLimit(take, DESCRIBE_AT_ONCE, async (c) => {
            // caller with only binding call sites called the binding, not this same-named function
            const u = c.from.uri.toString();
            if (!boundBy.has(u)) boundBy.set(u, this.bridges.boundIn(c.from.uri).catch(() => undefined));
            const bound = await boundBy.get(u);
            if (bound && c.fromRanges.length && c.fromRanges.every(bound)) return undefined;
            return this.describe(c.from, acc);
        }, token);
        if (token?.isCancellationRequested) return undefined;
        return take.flatMap((c, i) => (froms[i] ? [{ from: froms[i]!, to: key, line: c.fromRanges[0]?.start.line }] : []));
    }
}
