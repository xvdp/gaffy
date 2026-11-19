/**
 * Calls across languages through binding layers, found in source text (pure functions, no VS Code API).
 * No language server sees both sides of a binding: Pylance stops at a compiled module (or its `.pyi`
 * stub), a C++ server knows no Python callers, and a slangpy call resolves at run time. The binding
 * declarations name both sides, so the provider links them (lsp.ts, `Bridges`).
 *
 * Native side (C++, CUDA), `scanNative`:
 * - pybind11 `PYBIND11_MODULE(mod, m)`, nanobind `NB_MODULE(mod, m)`: `m.def("name", &fn)`,
 *   `m.def_submodule("sub")`, `py::class_<T>(m, "Name").def("meth", &T::meth)` (chained, or through a
 *   variable), `def_static`; targets `&fn`, `&ns::fn`, `py::overload_cast<…>(&fn)`, a bare name. A lambda
 *   binds no named function and is skipped. `py::init<…>` (constructors) is skipped.
 * - PyTorch operators `TORCH_LIBRARY(ns, m)` / `TORCH_LIBRARY_IMPL(ns, Key, m)`: `m.def("op", &fn)`,
 *   `m.impl("op", &fn)`, `TORCH_FN(fn)`: Python `torch.ops.ns.op(…)`.
 * Python side:
 * - imports (`import a.b as x`, `from a import b as c`), so `x.fn(…)` and `fn(…)` resolve to module paths;
 * - torch extensions compiled from sources (`load(name="ext", sources=[…])`, `CUDAExtension("pkg.ext",
 *   […])` in setup.py): the module whose name is the `TORCH_EXTENSION_NAME` macro of those sources;
 * - slangpy `spy.Module.load_from_file(device, "x.slang")`, `device.load_module("x")`, slangtorch
 *   `slangtorch.loadModule("x.slang")`: in a Python file that loads x.slang, `….fn(…)` calls `fn` when x.slang
 *   defines `fn`; a function calling `getattr(holder, …)` on a name that held the module (the same last
 *   segment: `module = …load_from_file(…)`, later `getattr(self.module, name)`) reaches every function of
 *   x.slang whose name the file writes as a string literal (kernels chosen by name), marked approximate.
 *   The module object may travel through returns and attributes; only the file and the name are tracked.
 * A Python call matches a binding when its dotted path, resolved through the file's imports, ends with
 * the binding's module (last segment) and Python path. Calls on instances (`obj.meth(…)`) are not matched:
 * the instance's type is unknown in the text.
 */
import { mask } from './textcalls';

export type Via = 'pybind11' | 'nanobind' | 'torch' | 'slangpy' | 'slangtorch';

export interface Binding {
  via: Via;
  module: string;          // Python module as declared (`mod`, `TORCH_EXTENSION_NAME`, `torch.ops.ns`)
  py: string[];            // path inside the module: ['fn'] or ['Class', 'meth']
  target: string;          // C++ name bound: `fn`, `ns::fn`, `T::meth`
  targetAt: number;        // offset of the target's last identifier (where go to definition applies)
  at: number;              // offset of the `.def(` or `.impl(`
}

/** Offset after the bracket matching the one at `open` (masked text), or the text length. */
function close(m: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const want = pairs[m[open]];
  let depth = 0;
  for (let i = open; i < m.length; i++) {
    if (m[i] === m[open]) depth++;
    else if (m[i] === want && --depth === 0) return i + 1;
  }
  return m.length;
}

/** Statements of a block body: split at `;` outside brackets. */
function statements(m: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0, start = from;
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) { out.push([start, i]); start = i + 1; }
  }
  if (to > start) out.push([start, to]);
  return out;
}

/** Bound function in a `.def(`/`.impl(` argument list after the name: `&fn`, `overload_cast<…>(&fn)`, `TORCH_FN(fn)`, `fn`. */
function targetOf(m: string, from: number, to: number): { name: string; at: number } | undefined {
  const args = m.slice(from, to);
  const r = /^\s*,\s*(?:(?:py|nb|pybind11|nanobind)::overload_cast\s*<[^>]*>\s*\(\s*|TORCH_FN\s*\(\s*|static_cast\s*<[^>]*>\s*\(\s*)?&?\s*((?:\w+\s*::\s*)*~?\w+)/.exec(args);
  if (!r || /^\s*,\s*\[/.test(args)) return undefined;                 // a lambda binds no named function
  const name = r[1].replace(/\s+/g, '');
  if (/^(py|nb|pybind11|nanobind)::(init|arg|return_value_policy|keep_alive)/.test(name)) return undefined;
  const last = name.split('::').pop()!;
  return { name, at: from + r.index + r[0].lastIndexOf(last) };
}

export function scanNative(text: string): Binding[] {
  const m = mask(text, true);
  const out: Binding[] = [];
  const blocks = /\b(PYBIND11_MODULE|NB_MODULE|TORCH_LIBRARY|TORCH_LIBRARY_IMPL|TORCH_LIBRARY_FRAGMENT)\s*\(([^)]*)\)\s*\{/g;
  for (let b = blocks.exec(m); b; b = blocks.exec(m)) {
    const args = b[2].split(',').map((x) => x.trim());
    const body0 = b.index + b[0].length - 1, body1 = close(m, body0);
    const kind = b[1];
    if (kind.startsWith('TORCH_LIBRARY')) {
      const ns = args[0], v = args[args.length - 1];
      const def = new RegExp(`\\b${v}\\s*\\.\\s*(def|impl)\\s*\\(\\s*"([^"(.]+)`, 'g');
      def.lastIndex = body0;
      for (let d = def.exec(m); d && d.index < body1; d = def.exec(m)) {
        const t = targetOf(m, def.lastIndex + m.slice(def.lastIndex).indexOf('"') + 1, close(m, m.indexOf('(', d.index)) - 1);
        if (t) out.push({ via: 'torch', module: `torch.ops.${ns}`, py: [d[2].trim()], target: t.name, targetAt: t.at, at: d.index });
      }
      continue;
    }
    const via: Via = kind === 'NB_MODULE' ? 'nanobind' : 'pybind11';
    const modVar = args[1];
    const modules = new Map<string, string>([[modVar, args[0]]]);                    // variable → module path
    const classes = new Map<string, { module: string; name: string }>();             // variable → bound class
    for (const [s0, s1] of statements(m, body0 + 1, body1 - 1)) {
      const st = m.slice(s0, s1);
      // submodule: auto sub = m.def_submodule("sub")
      const sub = /^\s*(?:auto|\w+(?:::\w+)*)\s+(\w+)\s*=\s*(\w+)\s*\.\s*def_submodule\s*\(\s*"([^"]+)"/.exec(st);
      if (sub && modules.has(sub[2])) { modules.set(sub[1], `${modules.get(sub[2])}.${sub[3]}`); continue; }
      // class: [auto v =] py::class_<T, …>(m, "Name") followed by chained .def(…)
      const cls = /^\s*(?:(?:auto|[\w:<>, ]+?)\s+(\w+)\s*=\s*)?(?:py|nb|pybind11|nanobind)::class_\s*<[^(]*?>\s*\(\s*(\w+)\s*,\s*"([^"]+)"/.exec(st);
      let owner: { module: string; cls?: string } | undefined;
      let chainFrom = 0;
      if (cls && modules.has(cls[2])) {
        const c = { module: modules.get(cls[2])!, name: cls[3] };
        if (cls[1]) classes.set(cls[1], c);
        owner = { module: c.module, cls: c.name };
        chainFrom = cls.index + cls[0].length;
      } else {
        const lead = /^\s*(\w+)\s*\./.exec(st);
        if (lead && modules.has(lead[1])) owner = { module: modules.get(lead[1])! };
        else if (lead && classes.has(lead[1])) { const c = classes.get(lead[1])!; owner = { module: c.module, cls: c.name }; }
      }
      if (!owner) continue;
      const def = /\.\s*(def|def_static)\s*\(\s*"([^"]+)"/g;
      def.lastIndex = chainFrom;
      for (let d = def.exec(st); d; d = def.exec(st)) {
        const open = s0 + d.index + d[0].indexOf('(');
        const t = targetOf(m, s0 + d.index + d[0].length, close(m, open) - 1);
        if (!t) continue;
        out.push({ via, module: owner.module, py: owner.cls ? [owner.cls, d[2]] : [d[2]], target: t.name, targetAt: t.at, at: s0 + d.index });
      }
    }
  }
  return out;
}

// ---- Python ---------------------------------------------------------------------------------------

/** Comments and string literals of Python source become spaces (offsets kept); `keep` keeps strings. */
export function maskPy(text: string, keepStrings = false): string {
  const out = text.split('');
  const blank = (a: number, b: number) => { for (let i = a; i < b; i++) if (out[i] !== '\n') out[i] = ' '; };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '#') { let j = i; while (j < text.length && text[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < text.length && !text.startsWith(q, j) && (triple || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      if (!keepStrings) blank(i + q.length, Math.min(j, text.length));
      i = j + q.length;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Local names bound by imports → dotted module or member paths. */
export function pyImports(text: string): Map<string, string> {
  const m = maskPy(text);
  const out = new Map<string, string>();
  for (const r of m.matchAll(/^[ \t]*import[ \t]+([^\n]+)/gm)) {
    for (const part of r[1].split(',')) {
      const x = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (!x) continue;
      if (x[2]) out.set(x[2], x[1]); else out.set(x[1].split('.')[0], x[1].split('.')[0]);
    }
  }
  for (const r of m.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm)) {
    for (const part of r[2].replace(/[()]/g, '').split(',')) {
      const x = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (x) out.set(x[2] ?? x[1], `${r[1]}.${x[1]}`);
    }
  }
  return out;
}

const PY_KEYWORDS = new Set(['if', 'elif', 'while', 'for', 'return', 'yield', 'not', 'and', 'or', 'in', 'is', 'lambda', 'with', 'assert', 'del', 'print', 'await']);

/** Dotted callees written in `text[from, to)`: `a.b.c(` → `a.b.c`. */
export function pyCallSites(text: string, from = 0, to = text.length): { dotted: string; at: number }[] {
  const m = maskPy(text).slice(from, to);
  const out: { dotted: string; at: number }[] = [];
  for (const r of m.matchAll(/(?<![\w.])([A-Za-z_]\w*(?:[ \t]*\.[ \t]*[A-Za-z_]\w*)*)[ \t]*\(/g)) {
    const dotted = r[1].replace(/\s+/g, '');
    if (PY_KEYWORDS.has(dotted) || /\b(def|class)\s+$/.test(m.slice(Math.max(0, r.index! - 8), r.index!))) continue;
    out.push({ dotted, at: from + r.index! + r[0].lastIndexOf(dotted.split('.').pop()!) });
  }
  return out;
}

export interface ExtModule { name: string; sources: string[]; local?: string }

/** Torch C++/CUDA extensions declared in Python: `x = load(name=…, sources=[…])`, `CUDAExtension("pkg.ext", […])`. */
export function extModules(text: string): ExtModule[] {
  const m = maskPy(text, true);
  const out: ExtModule[] = [];
  const strings = (s: string) => [...s.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  // `torch.utils.cpp_extension.load`, under any local name
  const loaders = new Set(['load', 'load_inline']);
  for (const [local, path] of pyImports(text)) if (/cpp_extension\.load(_inline)?$/.test(path)) loaders.add(local);
  for (const r of m.matchAll(/(?:(\w+)\s*=\s*)?([\w.]+)\s*\(/g)) {
    if (!loaders.has(r[2].split('.').pop()!)) continue;
    const args = m.slice(r.index! + r[0].length, close(m, r.index! + r[0].length - 1) - 1);
    const name = /\bname\s*=\s*["']([\w.]+)["']/.exec(args)?.[1];
    const src = /\bsources\s*=\s*\[([^\]]*)\]/.exec(args)?.[1];
    if (name && src) out.push({ name: name.split('.').pop()!, sources: strings(src), local: r[1] });
  }
  for (const r of m.matchAll(/\b(?:CUDAExtension|CppExtension|Extension|Pybind11Extension)\s*\(/g)) {
    const args = m.slice(r.index! + r[0].length, close(m, r.index! + r[0].length - 1) - 1);
    const name = /^\s*(?:name\s*=\s*)?["']([\w.]+)["']/.exec(args)?.[1] ?? /\bname\s*=\s*["']([\w.]+)["']/.exec(args)?.[1];
    const src = /^\s*(?:name\s*=\s*)?["'][\w.]+["']\s*,\s*(?:sources\s*=\s*)?\[([^\]]*)\]/.exec(args)?.[1] ?? /\bsources\s*=\s*\[([^\]]*)\]/.exec(args)?.[1];
    if (name && src) out.push({ name: name.split('.').pop()!, sources: strings(src) });
  }
  return out;
}

export interface SlangLoad { target: string; file: string; via: 'slangpy' | 'slangtorch' }

/** Slang modules loaded in Python and the name (or `self.attr`) holding each. */
export function slangLoads(text: string): SlangLoad[] {
  const m = maskPy(text, true);
  const out: SlangLoad[] = [];
  for (const r of m.matchAll(/((?:self\.)?\w+)\s*=\s*([^\n]{0,240}?\b(load_from_file|loadModule|load_module)\s*\()/g)) {
    const open = r.index! + r[0].length - 1;
    const args = m.slice(open + 1, close(m, open) - 1);
    const file = /["']([^"']+?)["']/.exec(args.replace(/^\s*\w+\s*,/, ''))?.[1] ?? /["']([^"']+?)["']/.exec(args)?.[1];
    if (!file) continue;
    out.push({ target: r[1], file: /\.slang$/.test(file) ? file : `${file}.slang`, via: r[3] === 'loadModule' ? 'slangtorch' : 'slangpy' });
  }
  return out;
}

/**
 * Slang functions a Python function in `text[from, to)` reaches, among `names` (functions of the .slang
 * files its file loads): method-style calls `….fn(…)`; with `getattr(h, …)` in the function, `h` ending in
 * one of `holders` (names the module was assigned to), each name written as a string literal in the file
 * (`dynamic`).
 */
export function slangCalls(text: string, from: number, to: number, names: ReadonlySet<string>, holders: ReadonlySet<string>): { name: string; at: number; dynamic: boolean }[] {
  const out: { name: string; at: number; dynamic: boolean }[] = [];
  for (const s of pyCallSites(text, from, to)) {
    const parts = s.dotted.split('.');
    if (parts.length > 1 && names.has(parts[parts.length - 1])) out.push({ name: parts[parts.length - 1], at: s.at, dynamic: false });
  }
  const body = maskPy(text).slice(from, to);
  const g = [...body.matchAll(/\bgetattr\s*\(\s*([\w.]+)\s*,/g)].find((r) => holders.has(r[1].split('.').pop()!))?.index ?? -1;
  if (g >= 0) {
    const seen = new Set(out.map((o) => o.name));
    for (const r of maskPy(text, true).matchAll(/["'](\w+)["']/g)) {
      if (names.has(r[1]) && !seen.has(r[1])) { seen.add(r[1]); out.push({ name: r[1], at: from + g, dynamic: true }); }
    }
  }
  return out;
}

/** A dotted callee resolved through the imports of its file: the first name replaced by what it imports. */
export function resolveDotted(dotted: string, imports: ReadonlyMap<string, string>): string[] {
  const parts = dotted.split('.');
  const head = imports.get(parts[0]);
  return head ? [...head.split('.').filter(Boolean), ...parts.slice(1)] : parts;
}

/** Bindings a resolved Python callee reaches: its path ends with the binding's module (last segment) and Python path. */
export function matchBindings<B extends Binding>(path: string[], bindings: readonly B[], moduleOf: (b: B) => string = (b) => b.module): B[] {
  return bindings.filter((b) => {
    const full = [...moduleOf(b).split('.'), ...b.py];
    const want = b.via === 'torch' ? full : [full[full.length - b.py.length - 1], ...b.py];
    if (path.length < want.length) return false;
    const tail = path.slice(path.length - want.length);
    return tail.every((x, i) => x === want[i]);
  });
}

// ---- wasm-bindgen: Rust exported to JavaScript and TypeScript -------------------------------------

/** Rust source with comments (and string literals unless `keepStrings`) as spaces; offsets kept. */
export function maskRust(text: string, keepStrings = false): string {
  const out = text.split('');
  const blank = (a: number, b: number) => { for (let i = a; i < b; i++) if (out[i] !== '\n') out[i] = ' '; };
  for (let i = 0; i < text.length;) {
    if (text.startsWith('//', i)) { let j = i; while (j < text.length && text[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (text.startsWith('/*', i)) {
      let j = i + 2, depth = 1;                                                // block comments nest in Rust
      while (j < text.length && depth) { if (text.startsWith('/*', j)) { depth++; j += 2; } else if (text.startsWith('*/', j)) { depth--; j += 2; } else j++; }
      blank(i, j); i = j; continue;
    }
    if (/^'(?:\\.|[^\\'])'/.test(text.slice(i, i + 4))) { i += text[i + 1] === '\\' ? 4 : 3; continue; }   // char literal, not a lifetime
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (!keepStrings) blank(i + 1, j);
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

export interface WasmExport {
  js: string;              // name in JavaScript (`js_name`, else the Rust name)
  rust: string;            // Rust function name
  cls?: string;            // JavaScript class of a method (`js_class`, else the Rust type)
  kind: 'function' | 'method' | 'static' | 'constructor';
  at: number;              // offset of the Rust function name
}

/**
 * Items exported by `#[wasm_bindgen]`: `pub fn` at module level (functions), and in an exported `impl T`
 * every `pub fn`: `#[wasm_bindgen(constructor)]` (`new T(…)`), with a `self` receiver (methods), without
 * (static). `getter` and `setter` methods are property reads and writes in JavaScript, not calls: skipped.
 * Other attributes between `#[wasm_bindgen]` and the item are skipped.
 */
export function scanWasm(text: string): WasmExport[] {
  const m = maskRust(text);
  const out: WasmExport[] = [];
  const impls: { cls: string; start: number; end: number }[] = [];
  const inImpl = (at: number) => impls.some((b) => at > b.start && at < b.end);
  const opt = (attr: string, key: string) => new RegExp(`\\b${key}\\s*=\\s*"?([\\w$]+)"?`).exec(attr)?.[1];
  for (const r of m.matchAll(/#\[\s*wasm_bindgen\b[^\]]*\]/g)) {
    const attr = text.slice(r.index!, r.index! + r[0].length);
    const after = r.index! + r[0].length;
    const lead = /^(?:\s*#\[[^\]]*\])*\s*/.exec(m.slice(after))![0].length;
    const at = after + lead;
    const item = m.slice(at, at + 400);
    const im = /^impl(?:\s*<[^>{]*>)?\s+([\w:]+)(?:\s*<[^>{]*>)?\s*\{/.exec(item);
    if (im) {
      const open = at + im[0].length - 1;
      impls.push({ cls: opt(attr, 'js_class') ?? im[1].split('::').pop()!, start: open, end: close(m, open) });
      continue;
    }
    const fn = /^pub(?:\s*\([^)]*\))?\s+(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/.exec(item);
    if (fn && !inImpl(at)) out.push({ js: opt(attr, 'js_name') ?? fn[1], rust: fn[1], kind: 'function', at: at + fn[0].length - fn[1].length });
  }
  for (const b of impls) {
    const body = m.slice(b.start, b.end);
    for (const f of body.matchAll(/((?:#\[[^\]]*\]\s*)*)pub(?:\s*\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>(]*>)?\s*\(\s*(&\s*(?:'\w+\s+)?(?:mut\s+)?self\b|mut\s+self\b|self\b)?/g)) {
      const attrs = text.slice(b.start + f.index!, b.start + f.index! + f[1].length);
      if (/\b(getter|setter)\b/.test(attrs)) continue;
      const kind = /\bconstructor\b/.test(attrs) ? 'constructor' : f[3] ? 'method' : 'static';
      const name = b.start + f.index! + f[0].indexOf(f[2], f[1].length);
      out.push({ js: opt(attrs, 'js_name') ?? f[2], rust: f[2], cls: b.cls, kind, at: name });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface JsImport { local: string; name: string; spec: string }   // name: imported name, `*` (namespace), `default`

/** ES module imports (`import a, { b as c } from 's'`, `import * as ns from 's'`), dynamic `import('s')` and `require('s')`. */
export function jsImports(text: string): JsImport[] {
  const m = mask(text, true);
  const out: JsImport[] = [];
  const named = (list: string, spec: string) => {
    for (const part of list.split(',')) {
      const x = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (x) out.push({ local: x[2] ?? x[1], name: x[1], spec });
    }
  };
  for (const r of m.matchAll(/\bimport\s+(?!type\s)([^'";]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = r[1], spec = r[2];
    const def = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause);
    if (def) out.push({ local: def[1], name: 'default', spec });
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) out.push({ local: ns[1], name: '*', spec });
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) named(braces[1], spec);
  }
  for (const r of m.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (r[1].startsWith('{')) named(r[1].slice(1, -1).replace(/:\s*/g, ' as '), r[2]);
    else out.push({ local: r[1], name: '*', spec: r[2] });
  }
  return out;
}

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'super', 'import', 'require']);

/** Calls written in `text[from, to)`: `a.b.c(` → `a.b.c`, `new C(` (`ctor`). Declarations `function f(` are not calls. */
export function jsCallSites(text: string, from = 0, to = text.length): { dotted: string; at: number; ctor: boolean }[] {
  const m = mask(text).slice(from, to);
  const out: { dotted: string; at: number; ctor: boolean }[] = [];
  for (const r of m.matchAll(/(?<![\w$.])(new\s+)?([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^<>()]*>\s*)?\(/g)) {
    const dotted = r[2].replace(/\s+|\?/g, '');
    if (JS_KEYWORDS.has(dotted) || /\bfunction\s*\*?\s*$/.test(m.slice(Math.max(0, r.index! - 12), r.index!))) continue;
    out.push({ dotted, at: from + r.index! + r[0].lastIndexOf(dotted.split('.').pop()!), ctor: !!r[1] });
  }
  return out;
}

/** Exports a JavaScript call reaches through the imports of one wasm module: `f(…)`, `ns.f(…)`, `new C(…)`, `C.s(…)`. */
export function matchWasm(call: { dotted: string; ctor: boolean }, imports: readonly JsImport[], exports: readonly WasmExport[]): WasmExport[] {
  const parts = call.dotted.split('.');
  const imp = imports.find((i) => i.local === parts[0]);
  if (!imp || imp.name === 'default') return [];
  const path = imp.name === '*' ? parts.slice(1) : [imp.name, ...parts.slice(1)];
  if (path.length === 1) {
    return exports.filter((e) => (call.ctor ? e.kind === 'constructor' && e.cls === path[0] : e.kind === 'function' && e.js === path[0]));
  }
  if (path.length === 2 && !call.ctor) return exports.filter((e) => e.kind === 'static' && e.cls === path[0] && e.js === path[1]);
  return [];
}
