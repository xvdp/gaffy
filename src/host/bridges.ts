/** @xvdp
 * Cross-language edges added to language-server answers; bindings.ts parses the text.
 * - pybind11, nanobind, torch: Python call → bound C++/CUDA function (go to definition at the binding target,
 *   else workspace symbol by name).
 * - slangpy, slangtorch: `….fn(…)` → `fn` of the loaded .slang module; `getattr(…)` → functions named by
 *   string literals (approximate).
 * - wasm-bindgen: TypeScript/JavaScript → `#[wasm_bindgen]` Rust export, via an import of the crate's wasm-pack
 *   package (`pkg/`, `pkg/<crate>.js`, crate name). Glue `pkg/*.js` is external code (langs.ts): one edge.
 * - torch.autograd: `X.apply(…)` → `X.forward`, `X` a `torch.autograd.Function` subclass; the language server
 *   stops at `Function.apply`.
 * Incoming calls get the reverse edges. A binding-matched call site drops the server's edge: with the compiled
 * module unresolved, the server matches by name (`_C.magoo(…)` → wrapper `magoo`; measured with Pyright).
 * Edges carry `via` (`pybind11: src/ext.cpp:42`). Indexes: per project (nearest folder with a build or package
 * manifest), else workspace; dropped when a file of their kind changes.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Binding, extModules, jsCallSites, jsImports, matchBindings, matchWasm, pyCallSites, pyImports, resolveDotted, scanNative, scanWasm, slangCalls, slangLoads, WasmExport } from '../core/bindings';
import { langOf, segments } from '../core/langs';
import { GEdge, GNode, NodeKey } from '../core/model';
import type { LspProvider } from './lsp';
import { readable } from './scope';

const SKIP = '{**/node_modules/**,**/.git/**,**/_deps/**,**/.venv/**,**/venv/**,**/site-packages/**,**/.gaffy/**}';
const MANIFESTS = ['setup.py', 'pyproject.toml', 'setup.cfg', 'CMakeLists.txt', 'Cargo.toml', 'package.json'];
const NATIVE = new Set(['c', 'cpp', 'cuda']);
const JS = new Set(['ts', 'js']);
type Located = Binding & { uri: vscode.Uri; module: string };
interface Crate { name: string; dir: string }                                  // Cargo package name, folder of its Cargo.toml
type Exported = WasmExport & { uri: vscode.Uri; crate: Crate };
interface PyFile { uri: vscode.Uri; text: string }

const lineOf = (text: string, offset: number) => { let n = 0; for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

export class Bridges {
    private native = new Map<string, Promise<Located[]>>();     // per project folder ('' the workspace)
    private python = new Map<string, Promise<PyFile[]>>();
    private projects = new Map<string, Promise<string>>();
    private targets = new Map<string, Promise<vscode.CallHierarchyItem | undefined>>();
    private wasm?: Promise<Exported[]>;
    private js?: Promise<PyFile[]>;

    constructor(private readonly p: LspProvider, private readonly enabled: () => boolean) {}

    invalidate(uri: vscode.Uri): void {
        const lang = langOf(uri.path);
        if (NATIVE.has(lang)) { this.native.clear(); this.targets.clear(); }
        if (lang === 'py') { this.python.clear(); this.native.clear(); }              // extension module names come from Python
        if (MANIFESTS.includes(path.posix.basename(uri.path))) this.projects.clear();
        if (lang === 'rs' || uri.path.endsWith('Cargo.toml')) this.wasm = undefined;
        if (JS.has(lang)) this.js = undefined;
    }

    /** File text; '' over 2 MB (generated, minified, data). */
    private async read(uri: vscode.Uri): Promise<string> {
        try {
            if ((await vscode.workspace.fs.stat(uri)).size > 2_000_000) return '';
            return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch { return ''; }
    }

    /** Project folder: nearest ancestor with a manifest, below the workspace folder; else ''. */
    private project(uri: vscode.Uri): Promise<string> {
        const top = vscode.workspace.getWorkspaceFolder(uri)?.uri.path;
        const up = (dir: string): Promise<string> => {
            if (!top || dir === top || !dir.startsWith(top)) return Promise.resolve('');
            let p = this.projects.get(dir);
            if (!p) {
                p = (async () => {
                    for (const m of MANIFESTS) { try { await vscode.workspace.fs.stat(vscode.Uri.file(`${dir}/${m}`)); return dir; } catch { /* next */ } }
                    return up(path.posix.dirname(dir));
                })();
                this.projects.set(dir, p);
            }
            return p;
        };
        return up(path.posix.dirname(uri.path));
    }

    private find(scope: string, glob: string): Thenable<vscode.Uri[]> {
        return vscode.workspace.findFiles(scope ? new vscode.RelativePattern(vscode.Uri.file(scope), glob) : glob, SKIP, 5000);
    }

    private pyFiles(scope = ''): Promise<PyFile[]> {
        let p = this.python.get(scope);
        if (!p) {
            p = (async () => Promise.all((await this.find(scope, '**/*.py')).map(async (uri) => ({ uri, text: await this.read(uri) }))))();
            this.python.set(scope, p);
        }
        return p;
    }

    /** Bindings with their Python module; `TORCH_EXTENSION_NAME` → extension built from the file. */
    private bindings(scope = ''): Promise<Located[]> {
        let cached = this.native.get(scope);
        if (cached) return cached;
        cached = (async () => {
            const uris = await this.find(scope, '**/*.{c,cc,cpp,cxx,cu,cuh,h,hh,hpp,hxx,inl,ipp}');
            const exts = (await this.pyFiles(scope)).filter((f) => /cpp_extension|Extension\s*\(/.test(f.text)).flatMap((f) => extModules(f.text));
            const out: Located[] = [];
            for (const uri of uris) {
                const text = await this.read(uri);
                if (!/PYBIND11_MODULE|NB_MODULE|TORCH_LIBRARY/.test(text)) continue;
                const base = path.posix.basename(uri.path);
                for (const b of scanNative(text)) {
                    if (!/^[A-Z_][A-Z0-9_]*$/.test(b.module)) { out.push({ ...b, uri }); continue; }
                    // macro module name → extensions built from this file, else the file stem
                    const names = exts.filter((e) => e.sources.some((s) => path.posix.basename(s) === base)).map((e) => e.name);
                    for (const name of names.length ? names : [base.replace(/\.[^.]+$/, '')]) out.push({ ...b, uri, module: name });
                }
            }
            return out;
        })();
        this.native.set(scope, cached);
        return cached;
    }

    /** Bindings for a file: its project's, else the workspace's. */
    private async bindingsFor(uri: vscode.Uri): Promise<Located[]> {
        const scope = await this.project(uri);
        const own = scope ? await this.bindings(scope) : [];
        return own.length ? own : this.bindings('');
    }

    /** Offsets of Python call sites a binding (pybind11, nanobind, torch) matches. */
    private async bound(uri: vscode.Uri, text: string, from = 0, to = text.length): Promise<{ at: number; b: Located }[]> {
        const imports = pyImports(text);
        for (const e of extModules(text)) if (e.local) imports.set(e.local, e.name);
        const bindings = await this.bindingsFor(uri);
        const out: { at: number; b: Located }[] = [];
        for (const s of pyCallSites(text, from, to)) for (const b of matchBindings(resolveDotted(s.dotted, imports), bindings)) out.push({ at: s.at, b });
        return out;
    }

    /**
     * Python file: predicate true at binding call sites, whose server edges (same-named Python function) drop.
     * Undefined for other files or without bindings.
     */
    async boundIn(uri: vscode.Uri): Promise<((r: vscode.Range) => boolean) | undefined> {
        if (!this.enabled() || langOf(uri.path) !== 'py') return undefined;
        const doc = await vscode.workspace.openTextDocument(uri);
        const at = (await this.bound(uri, doc.getText())).map((x) => x.at);
        if (!at.length) return undefined;
        return (r) => { const a = doc.offsetAt(r.start), b = doc.offsetAt(r.end); return at.some((x) => x >= a && x <= b); };
    }

    /** torch.autograd: `X.forward` for `X.apply(…)`, `X` a `torch.autograd.Function` subclass. */
    private async forwardOf(uri: vscode.Uri, doc: vscode.TextDocument, at: number, dotted: string): Promise<vscode.CallHierarchyItem | undefined> {
        const cls = dotted.split('.').slice(-2, -1)[0];
        if (!cls) return undefined;
        const pos = doc.positionAt(doc.getText().lastIndexOf(cls, at));
        let defs: (vscode.Location | vscode.LocationLink)[] = [];
        try { defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, pos) ?? []; } catch { return undefined; }
        for (const l of defs) {
            const tu = 'targetUri' in l ? l.targetUri : l.uri;
            const tp = 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange).start : l.range.start;
            if (!readable(tu)) continue;
            const syms = await this.p.symbolsOf(tu);
            const find = (ss: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
                for (const x of ss) { if (x.range.contains(tp) && x.kind === vscode.SymbolKind.Class) return x; const c = find(x.children ?? []); if (c) return c; }
                return undefined;
            };
            const c = find(syms);
            const tdoc = await vscode.workspace.openTextDocument(tu);
            if (!c || !/\bFunction\b/.test(tdoc.getText(new vscode.Range(c.range.start, c.selectionRange.end.translate(0, 200))).split(':')[0])) continue;
            const fwd = (c.children ?? []).find((x) => x.name === 'forward');
            if (fwd) return (await this.p.prepare(tu, fwd.selectionRange.start))[0];
        }
        return undefined;
    }

    /** Bound C++/CUDA function: go to definition at the target, else workspace symbol by name. */
    private target(b: Located): Promise<vscode.CallHierarchyItem | undefined> {
        const id = `${b.uri.toString()}#${b.targetAt}`;
        let t = this.targets.get(id);
        if (!t) {
            t = (async () => {
                const last = b.target.split('::').pop()!;
                const pick = (items: vscode.CallHierarchyItem[]) => items.find((i) => segments(i.name).pop() === last) ?? items[0];
                try {
                    const doc = await vscode.workspace.openTextDocument(b.uri);
                    const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', b.uri, doc.positionAt(b.targetAt)) ?? [];
                    for (const l of defs) {
                        const items = await this.p.prepare('targetUri' in l ? l.targetUri : l.uri, 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange).start : l.range.start);
                        if (items.length) return pick(items);
                    }
                    const owner = b.target.split('::').slice(-2, -1)[0];
                    const syms = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', last) ?? [];
                    for (const s of syms.filter((x) => segments(x.name).pop() === last && (!owner || (x.containerName ?? '').includes(owner) || x.name.includes(`${owner}::`)))) {
                        const items = await this.p.prepare(s.location.uri, s.location.range.start);
                        if (items.length) return pick(items);
                    }
                } catch { /* no C++ server */ }
                return undefined;
            })();
            this.targets.set(id, t);
        }
        return t;
    }

    /** Loaded .slang `file`: relative to the loader, else by name (include paths). */
    private async slangFile(from: vscode.Uri, file: string): Promise<vscode.Uri | undefined> {
        const near = vscode.Uri.joinPath(from, '..', file);
        // source-text paths resolve only inside a workspace folder
        try { if (vscode.workspace.getWorkspaceFolder(near)) { await vscode.workspace.fs.stat(near); return near; } } catch { /* include path */ }
        return (await vscode.workspace.findFiles(`**/${path.posix.basename(file)}`, SKIP, 1))[0];
    }

    /** .slang functions by name (document symbols, else text outline). */
    private async slangFns(uri: vscode.Uri): Promise<Map<string, vscode.DocumentSymbol>> {
        const out = new Map<string, vscode.DocumentSymbol>();
        const walk = (ss: readonly vscode.DocumentSymbol[]) => {
            for (const s of ss) {
                if (s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method) out.set(segments(s.name).pop()!, s);
                walk(s.children ?? []);
            }
        };
        walk(await this.p.symbolsOf(uri));
        return out;
    }

    // ---- wasm-bindgen -------------------------------------------------------------------------------

    /** `#[wasm_bindgen]` Rust exports with their crate (nearest Cargo.toml with a [package] name). */
    private exportsOf(): Promise<Exported[]> {
        this.wasm ??= (async () => {
            const crates = new Map<string, Promise<Crate | undefined>>();
            const crateOf = (dir: string): Promise<Crate | undefined> => {
                let c = crates.get(dir);
                if (!c) {
                    c = (async () => {
                        const toml = await this.read(vscode.Uri.file(`${dir}/Cargo.toml`));
                        const name = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(toml)?.[1];
                        if (name) return { name, dir };
                        const up = path.posix.dirname(dir);
                        return up === dir ? undefined : crateOf(up);
                    })();
                    crates.set(dir, c);
                }
                return c;
            };
            const out: Exported[] = [];
            for (const uri of await vscode.workspace.findFiles('**/*.rs', '{**/target/**,**/.git/**,**/node_modules/**}', 5000)) {
                const text = await this.read(uri);
                if (!text.includes('wasm_bindgen')) continue;
                const crate = await crateOf(path.posix.dirname(uri.path));
                if (crate) for (const e of scanWasm(text)) out.push({ ...e, uri, crate });
            }
            return out;
        })();
        return this.wasm;
    }

    private jsFiles(): Promise<PyFile[]> {
        this.js ??= (async () => {
            const uris = await vscode.workspace.findFiles('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', '{**/node_modules/**,**/.git/**,**/dist/**,**/pkg/**,**/target/**,**/*.d.ts,**/.gaffy/**}', 5000);
            return Promise.all(uris.map(async (uri) => ({ uri, text: await this.read(uri) })));
        })();
        return this.js;
    }

    /** Crate of an import specifier: wasm-pack package folder, file, or crate name. */
    private static crateOfSpec(spec: string, from: vscode.Uri, crates: Crate[]): Crate | undefined {
        if (!spec.startsWith('.') && !spec.startsWith('/')) return crates.find((c) => spec === c.name || spec.startsWith(`${c.name}/`));
        const abs = path.posix.normalize(path.posix.join(path.posix.dirname(from.path), spec));
        return crates.find((c) => abs === `${c.dir}/pkg` || abs.startsWith(`${c.dir}/pkg/`)
            || path.posix.basename(abs).replace(/\.(m?js|ts)$/, '') === c.name.replace(/-/g, '_') && abs.startsWith(c.dir));
    }

    /** Exports called in `[from, to)`, with call offsets. */
    private async wasmCalls(uri: vscode.Uri, text: string, from: number, to: number): Promise<{ e: Exported; at: number }[]> {
        const exports = await this.exportsOf();
        if (!exports.length) return [];
        const crates = [...new Map(exports.map((e) => [e.crate.dir, e.crate])).values()];
        const byCrate = new Map<string, ReturnType<typeof jsImports>>();
        for (const i of jsImports(text)) {
            const c = Bridges.crateOfSpec(i.spec, uri, crates);
            if (c) byCrate.set(c.dir, [...(byCrate.get(c.dir) ?? []), i]);
        }
        if (!byCrate.size) return [];
        const out: { e: Exported; at: number }[] = [];
        for (const call of jsCallSites(text, from, to)) {
            for (const [dir, imports] of byCrate) {
                for (const e of matchWasm(call, imports, exports.filter((x) => x.crate.dir === dir))) out.push({ e: e as Exported, at: call.at });
            }
        }
        return out;
    }

    private async wasmVia(e: Exported): Promise<string> {
        return `wasm-bindgen: ${vscode.workspace.asRelativePath(e.uri)}:${lineOf(await this.read(e.uri), e.at) + 1}`;
    }

    /** Cross-language calls out of a function. */
    async outgoing(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
        if (!this.enabled()) return [];
        if (JS.has(langOf(it.uri.path))) {
            // TypeScript/JavaScript → Rust through wasm-bindgen
            const doc = await vscode.workspace.openTextDocument(it.uri);
            const edges: GEdge[] = [];
            for (const { e, at } of await this.wasmCalls(it.uri, doc.getText(), doc.offsetAt(it.selectionRange.end), doc.offsetAt((await this.p.bodyOf(it)).end))) {
                const rdoc = await vscode.workspace.openTextDocument(e.uri);
                const t = (await this.p.prepare(e.uri, rdoc.positionAt(e.at)))[0];
                const to = t && (await this.p.describe(t, acc));
                if (to) edges.push({ from: key, to, line: doc.positionAt(at).line, via: await this.wasmVia(e) });
            }
            return edges;
        }
        if (langOf(it.uri.path) !== 'py') return [];
        const doc = await vscode.workspace.openTextDocument(it.uri);
        const text = doc.getText();
        const from = doc.offsetAt(it.selectionRange.end), upto = doc.offsetAt((await this.p.bodyOf(it)).end);
        const sites = pyCallSites(text, from, upto);
        if (!sites.length) return [];
        const edges: GEdge[] = [];
        // torch.autograd: X.apply(…) → X.forward
        for (const s of sites.filter((x) => x.dotted.endsWith('.apply'))) {
            const t = await this.forwardOf(it.uri, doc, s.at, s.dotted);
            const to = t && (await this.p.describe(t, acc));
            if (to) edges.push({ from: key, to, line: doc.positionAt(s.at).line, via: `torch.autograd: ${s.dotted.split('.').slice(-2, -1)[0]}.apply → forward` });
        }
        // Slang: functions of the .slang files this file loads
        for (const l of slangLoads(text)) {
            const uri = await this.slangFile(it.uri, l.file);
            if (!uri) continue;
            const fns = await this.slangFns(uri);
            const holders = new Set(slangLoads(text).map((x) => x.target.split('.').pop()!));
            for (const c of slangCalls(text, doc.offsetAt(it.selectionRange.end), doc.offsetAt((await this.p.bodyOf(it)).end), new Set(fns.keys()), holders)) {
                const t = (await this.p.prepare(uri, fns.get(c.name)!.selectionRange.start))[0];
                const to = t && (await this.p.describe(t, acc));
                if (to) edges.push({ from: key, to, line: doc.positionAt(c.at).line, via: `${l.via}: ${l.file}${c.dynamic ? ' (by name, getattr)' : ''}` });
            }
        }
        for (const { at, b } of await this.bound(it.uri, text, from, upto)) {
            const t = await this.target(b);
            const to = t && (await this.p.describe(t, acc));
            if (to) edges.push({ from: key, to, line: doc.positionAt(at).line, via: `${b.via}: ${vscode.workspace.asRelativePath(b.uri)}:${lineOf(await this.read(b.uri), b.at) + 1}` });
        }
        return edges;
    }

    /** Cross-language callers of a function. */
    async incoming(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
        const lang = langOf(it.uri.path);
        if (!this.enabled()) return [];
        if (lang === 'rs') {
            // TypeScript/JavaScript callers of a wasm-bindgen Rust export
            const rust = segments(it.name).pop()!;
            const mine = (await this.exportsOf()).filter((e) => e.uri.toString() === it.uri.toString() && e.rust === rust);
            if (!mine.length) return [];
            const edges: GEdge[] = [];
            for (const f of (await this.jsFiles()).filter((x) => mine.some((e) => x.text.includes(e.js)))) {
                for (const { e, at } of await this.wasmCalls(f.uri, f.text, 0, f.text.length)) {
                    if (!mine.includes(e)) continue;
                    const doc = await vscode.workspace.openTextDocument(f.uri);
                    const c = await this.p.callerAt(f.uri, doc.positionAt(at));
                    const from = c && (await this.p.describe(c, acc));
                    if (from) edges.push({ from, to: key, line: doc.positionAt(at).line, via: await this.wasmVia(e) });
                }
            }
            return edges;
        }
        if (!(NATIVE.has(lang) || lang === 'slang' || lang === 'py')) return [];
        const name = segments(it.name).pop()!;
        const edges: GEdge[] = [];
        const caller = async (f: PyFile, at: number, via: string) => {
            const doc = await vscode.workspace.openTextDocument(f.uri);
            const c = await this.p.callerAt(f.uri, doc.positionAt(at));
            const from = c && (await this.p.describe(c, acc));
            if (from) edges.push({ from, to: key, line: doc.positionAt(at).line, via });
        };
        // Python files mentioning the name: the function's project, else the workspace
        const scope = await this.project(it.uri);
        let files = (await this.pyFiles(scope)).filter((f) => f.text.includes(name));
        if (!files.length && scope) files = (await this.pyFiles('')).filter((f) => f.text.includes(name));
        if (lang === 'py') {
            // torch.autograd: X.forward ← callers of X.apply(…)
            if (name !== 'forward') return [];
            const doc = await vscode.workspace.openTextDocument(it.uri);
            const cls = segments(it.name).length > 1 ? undefined : (await this.p.symbolsOf(it.uri)).flatMap((x) => [x, ...(x.children ?? [])])
                .find((x) => x.kind === vscode.SymbolKind.Class && x.range.contains(it.selectionRange.start));
            if (!cls || !/\bFunction\b/.test(doc.getText(new vscode.Range(cls.range.start, cls.selectionRange.end.translate(0, 200))).split(':')[0])) return [];
            for (const f of (await this.pyFiles(scope || '')).filter((x) => x.text.includes(`${cls.name}.apply`))) {
                for (const s of pyCallSites(f.text)) if (s.dotted.endsWith(`${cls.name}.apply`)) await caller(f, s.at, `torch.autograd: ${cls.name}.apply → forward`);
            }
            return edges;
        }
        if (lang === 'slang') {
            for (const f of files) {
                const l = slangLoads(f.text).find((x) => path.posix.basename(x.file) === path.posix.basename(it.uri.path));
                if (!l) continue;
                // sites reaching `name`: call sites, or `getattr(` when the file names `name`
                const seen = new Set<string>();
                const holders = new Set(slangLoads(f.text).map((x) => x.target.split('.').pop()!));
                for (const c of slangCalls(f.text, 0, f.text.length, new Set([name]), holders)) {
                    const sites = c.dynamic
                        ? [...f.text.matchAll(/\bgetattr\s*\(\s*([\w.]+)\s*,/g)].filter((r) => holders.has(r[1].split('.').pop()!)).map((r) => r.index!)
                        : [c.at];
                    for (const at of sites) {
                        if (seen.has(`${at}`)) continue;
                        seen.add(`${at}`);
                        await caller(f, at, `${l.via}: ${l.file}${c.dynamic ? ' (by name, getattr)' : ''}`);
                    }
                }
            }
            return edges;
        }
        // bindings whose target is this function
        const mine: Located[] = [];
        if (!files.length) return edges;
        for (const b of (await this.bindingsFor(it.uri)).filter((x) => x.target.split('::').pop() === name)) {
            const t = await this.target(b);
            if (t && t.uri.toString() === it.uri.toString() && t.range.contains(it.selectionRange.start)) mine.push(b);
        }
        for (const f of files) {
            const imports = pyImports(f.text);
            for (const e of extModules(f.text)) if (e.local) imports.set(e.local, e.name);
            for (const s of pyCallSites(f.text)) {
                for (const b of matchBindings(resolveDotted(s.dotted, imports), mine)) {
                    await caller(f, s.at, `${b.via}: ${vscode.workspace.asRelativePath(b.uri)}:${lineOf(await this.read(b.uri), b.at) + 1}`);
                }
            }
        }
        return edges;
    }
}
