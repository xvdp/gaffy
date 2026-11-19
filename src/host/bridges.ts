/**
 * Calls across languages joined to the language-server graph (bindings.ts parses the text).
 *
 * Outgoing calls of a Python function gain: a call matching a pybind11, nanobind or torch binding → the
 * C++/CUDA function the binding names (go to definition at the binding's target, else a workspace symbol
 * of that name); in a file loading a .slang module (slangpy, slangtorch), `….fn(…)` → `fn` of that file,
 * and `getattr(…)` → the functions of that file named by string literals (approximate).
 * Incoming calls of a C, C++, CUDA or Slang function gain the Python functions calling it that way.
 * wasm-bindgen: outgoing calls of a TypeScript or JavaScript function gain the Rust functions exported
 * with `#[wasm_bindgen]` that it calls through an import of the crate's wasm-pack package (the crate's
 * `pkg/` folder, `pkg/<crate>.js`, or the package name, which is the crate name); incoming calls of such a
 * Rust function gain those callers. The generated glue `pkg/*.js` counts as external code (langs.ts), so
 * the call shows once, from the caller to the Rust function.
 * Edges carry `via` (`pybind11: src/ext.cpp:42`). Indexes of the workspace's binding files and Python
 * files are built once and dropped when one of those files changes.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Binding, extModules, jsCallSites, jsImports, matchBindings, matchWasm, pyCallSites, pyImports, resolveDotted, scanNative, scanWasm, slangCalls, slangLoads, WasmExport } from '../core/bindings';
import { langOf, segments } from '../core/langs';
import { GEdge, GNode, NodeKey } from '../core/model';
import type { LspProvider } from './lsp';

const SKIP = '{**/node_modules/**,**/.git/**,**/_deps/**,**/.venv/**,**/venv/**,**/site-packages/**,**/.gaffy/**}';
const NATIVE = new Set(['c', 'cpp', 'cuda']);
const JS = new Set(['ts', 'js']);
type Located = Binding & { uri: vscode.Uri; module: string };
interface Crate { name: string; dir: string }                                  // Cargo package name, folder of its Cargo.toml
type Exported = WasmExport & { uri: vscode.Uri; crate: Crate };
interface PyFile { uri: vscode.Uri; text: string }

const lineOf = (text: string, offset: number) => { let n = 0; for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

export class Bridges {
  private native?: Promise<Located[]>;
  private python?: Promise<PyFile[]>;
  private targets = new Map<string, Promise<vscode.CallHierarchyItem | undefined>>();
  private wasm?: Promise<Exported[]>;
  private js?: Promise<PyFile[]>;

  constructor(private readonly p: LspProvider, private readonly enabled: () => boolean) {}

  invalidate(uri: vscode.Uri): void {
    const lang = langOf(uri.path);
    if (NATIVE.has(lang)) { this.native = undefined; this.targets.clear(); }
    if (lang === 'py') { this.python = undefined; this.native = undefined; }     // extension module names come from Python
    if (lang === 'rs' || uri.path.endsWith('Cargo.toml')) this.wasm = undefined;
    if (JS.has(lang)) this.js = undefined;
  }

  private async read(uri: vscode.Uri): Promise<string> {
    try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return ''; }
  }

  private pyFiles(): Promise<PyFile[]> {
    this.python ??= (async () => {
      const uris = await vscode.workspace.findFiles('**/*.py', SKIP, 5000);
      return Promise.all(uris.map(async (uri) => ({ uri, text: await this.read(uri) })));
    })();
    return this.python;
  }

  /** Bindings of the workspace, each with its Python module; `TORCH_EXTENSION_NAME` takes the name of the extension built from its file. */
  private bindings(): Promise<Located[]> {
    this.native ??= (async () => {
      const uris = await vscode.workspace.findFiles('**/*.{c,cc,cpp,cxx,cu,cuh,h,hh,hpp,hxx,inl,ipp}', SKIP, 5000);
      const exts = (await this.pyFiles()).filter((f) => /cpp_extension|Extension\s*\(/.test(f.text)).flatMap((f) => extModules(f.text));
      const out: Located[] = [];
      for (const uri of uris) {
        const text = await this.read(uri);
        if (!/PYBIND11_MODULE|NB_MODULE|TORCH_LIBRARY/.test(text)) continue;
        const base = path.posix.basename(uri.path);
        for (const b of scanNative(text)) {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(b.module)) { out.push({ ...b, uri }); continue; }
          // a macro module name: the extensions built from this file, else the file's stem
          const names = exts.filter((e) => e.sources.some((s) => path.posix.basename(s) === base)).map((e) => e.name);
          for (const name of names.length ? names : [base.replace(/\.[^.]+$/, '')]) out.push({ ...b, uri, module: name });
        }
      }
      return out;
    })();
    return this.native;
  }

  /** The C++/CUDA function a binding names: go to definition at its target, else a workspace symbol of that name. */
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

  /** The .slang file a Python file loads as `file`: relative to it, else by name anywhere in the workspace (include paths). */
  private async slangFile(from: vscode.Uri, file: string): Promise<vscode.Uri | undefined> {
    const near = vscode.Uri.joinPath(from, '..', file);
    try { await vscode.workspace.fs.stat(near); return near; } catch { /* include path */ }
    return (await vscode.workspace.findFiles(`**/${path.posix.basename(file)}`, SKIP, 1))[0];
  }

  /** Functions of a .slang file by name (document symbols, else the text outline). */
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

  /** Rust items exported with `#[wasm_bindgen]`, each with its crate (the nearest Cargo.toml with a [package] name). */
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

  /** The crate an import specifier names: its wasm-pack package folder or file, or the package name (the crate name). */
  private static crateOfSpec(spec: string, from: vscode.Uri, crates: Crate[]): Crate | undefined {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return crates.find((c) => spec === c.name || spec.startsWith(`${c.name}/`));
    const abs = path.posix.normalize(path.posix.join(path.posix.dirname(from.path), spec));
    return crates.find((c) => abs === `${c.dir}/pkg` || abs.startsWith(`${c.dir}/pkg/`)
      || path.posix.basename(abs).replace(/\.(m?js|ts)$/, '') === c.name.replace(/-/g, '_') && abs.startsWith(c.dir));
  }

  /** Exports a JavaScript/TypeScript text reaches in `[from, to)`, with each call's offset. */
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

  /** Calls from a Python function across bindings. */
  async outgoing(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
    if (!this.enabled()) return [];
    if (JS.has(langOf(it.uri.path))) {
      // TypeScript/JavaScript → Rust through wasm-bindgen
      const doc = await vscode.workspace.openTextDocument(it.uri);
      const edges: GEdge[] = [];
      for (const { e, at } of await this.wasmCalls(it.uri, doc.getText(), doc.offsetAt(it.selectionRange.end), doc.offsetAt(it.range.end))) {
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
    const sites = pyCallSites(text, doc.offsetAt(it.selectionRange.end), doc.offsetAt(it.range.end));
    if (!sites.length) return [];
    const imports = pyImports(text);
    for (const e of extModules(text)) if (e.local) imports.set(e.local, e.name);
    const bindings = await this.bindings();
    const edges: GEdge[] = [];
    // Slang: the functions of the .slang files this Python file loads
    for (const l of slangLoads(text)) {
      const uri = await this.slangFile(it.uri, l.file);
      if (!uri) continue;
      const fns = await this.slangFns(uri);
      const holders = new Set(slangLoads(text).map((x) => x.target.split('.').pop()!));
      for (const c of slangCalls(text, doc.offsetAt(it.selectionRange.end), doc.offsetAt(it.range.end), new Set(fns.keys()), holders)) {
        const t = (await this.p.prepare(uri, fns.get(c.name)!.selectionRange.start))[0];
        const to = t && (await this.p.describe(t, acc));
        if (to) edges.push({ from: key, to, line: doc.positionAt(c.at).line, via: `${l.via}: ${l.file}${c.dynamic ? ' (by name, getattr)' : ''}` });
      }
    }
    for (const s of sites) {
      const line = doc.positionAt(s.at).line;
      for (const b of matchBindings(resolveDotted(s.dotted, imports), bindings)) {
        const t = await this.target(b);
        const to = t && (await this.p.describe(t, acc));
        if (to) edges.push({ from: key, to, line, via: `${b.via}: ${vscode.workspace.asRelativePath(b.uri)}:${lineOf(await this.read(b.uri), b.at) + 1}` });
      }
    }
    return edges;
  }

  /** Python callers of a C, C++, CUDA or Slang function across bindings. */
  async incoming(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
    const lang = langOf(it.uri.path);
    if (!this.enabled()) return [];
    if (lang === 'rs') {
      // TypeScript/JavaScript callers of a Rust function exported through wasm-bindgen
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
    if (!(NATIVE.has(lang) || lang === 'slang')) return [];
    const name = segments(it.name).pop()!;
    const edges: GEdge[] = [];
    const caller = async (f: PyFile, at: number, via: string) => {
      const doc = await vscode.workspace.openTextDocument(f.uri);
      const c = await this.p.callerAt(f.uri, doc.positionAt(at));
      const from = c && (await this.p.describe(c, acc));
      if (from) edges.push({ from, to: key, line: doc.positionAt(at).line, via });
    };
    const files = (await this.pyFiles()).filter((f) => f.text.includes(name));
    if (lang === 'slang') {
      for (const f of files) {
        const l = slangLoads(f.text).find((x) => path.posix.basename(x.file) === path.posix.basename(it.uri.path));
        if (!l) continue;
        // each Python function reaching `name`: its call sites, or its `getattr(` when the file names `name`
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
    for (const b of (await this.bindings()).filter((x) => x.target.split('::').pop() === name)) {
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
