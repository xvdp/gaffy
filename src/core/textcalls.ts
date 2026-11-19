/**
 * Calls found in source text, for languages whose language server has no call hierarchy (shader
 * languages: GLSL, HLSL, Slang, WGSL, Metal). Pure functions over a file's text; the provider resolves
 * the names (go to definition, else by name in the workspace).
 *
 * `mask`: comments, string literals and preprocessor lines become spaces (offsets kept).
 * `outline`: C-like declarations by brace matching. A `{` whose header (text since the previous `;`, `{`
 * or `}`) names a container (`struct|class|namespace|interface|extension|enum|cbuffer|tbuffer`) opens a
 * container; one whose header ends in `name(…)`, optionally followed by `: SEMANTIC`, `-> Type` or
 * `const`, opens a function, unless a function is already open (then it opens a block).
 * `callSites`: identifiers followed by `(`, optionally with `<…>` generic arguments, minus control-flow
 * keywords. Type constructors (`float3(…)`, `vec3(…)`) stay in; they resolve to nothing in the project.
 * Accuracy: a call through a function pointer or a macro is missed; a constructor call of a project
 * type counts as a call of a function with that name if one exists.
 */

export interface TextSym {
  name: string;
  kind: 'function' | 'container';
  nameAt: number;          // offset of the name
  start: number;           // offset of the header start
  end: number;             // offset after the closing brace
  body: number;            // offset after the opening brace
  children: TextSym[];
}

export function mask(text: string, keepStrings = false): string {
  const out = text.split('');
  const blank = (a: number, b: number) => { for (let i = a; i < b; i++) if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  const n = text.length;
  let lineStart = true;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (lineStart && /[ \t]/.test(c)) { i++; continue; }
    if (lineStart && c === '#') {                      // preprocessor line, with continuations
      let j = i;
      while (j < n && !(text[j] === '\n' && text[j - 1] !== '\\')) j++;
      blank(i, j); i = j; continue;
    }
    lineStart = c === '\n';
    if (c === '/' && d === '/') { let j = i; while (j < n && text[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { const j = text.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; blank(i, e); i = e; continue; }
    if (!keepStrings && (c === '"' || c === "'")) {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, n)); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

const CONTAINER = /\b(struct|class|namespace|interface|extension|enum|cbuffer|tbuffer)\s+([A-Za-z_]\w*)[^]*$/;
const FUNCTION = /([A-Za-z_]\w*)\s*(?:<[^<>;{}()]*>\s*)?\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)\s*(?::\s*[A-Za-z_]\w*\s*)?(?:->\s*[^{};]{1,240}?)?\s*(?:const\s*)?(?:throws\s*)?$/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'do', 'else', 'case', 'catch', 'layout', 'defined',
  'alignof', 'decltype', 'static_assert', 'new', 'delete', 'throw', 'typeof', 'register', 'packoffset', 'numthreads', 'shader',
  'vk', 'attribute', 'unroll', 'loop', 'branch', 'flatten']);

export function outline(text: string): TextSym[] {
  const m = mask(text);
  const roots: TextSym[] = [];
  type Open = { sym?: TextSym; kind: 'function' | 'container' | 'block' };
  const stack: Open[] = [];
  let since = 0;                                      // start of the current header
  const inFunction = () => stack.some((s) => s.kind === 'function');
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === ';') { since = i + 1; continue; }
    if (c === '}') {
      const top = stack.pop();
      if (top?.sym) top.sym.end = i + 1;
      since = i + 1;
      continue;
    }
    if (c !== '{') continue;
    // a header longer than any declaration (minified or generated text) is not parsed: bounded regex work
    const header = m.slice(Math.max(since, i - 600), i);
    const parent = [...stack].reverse().find((s) => s.sym)?.sym;
    const add = (sym: TextSym) => (parent ? parent.children : roots).push(sym);
    let open: Open = { kind: 'block' };
    if (!inFunction()) {
      const f = FUNCTION.exec(header);
      const k = CONTAINER.exec(header);
      if (f && !KEYWORDS.has(f[1]) && !(k && k.index > f.index)) {
        const nameAt = since + f.index;
        const sym: TextSym = { name: f[1], kind: 'function', nameAt, start: since + header.search(/\S/), end: m.length, body: i + 1, children: [] };
        add(sym);
        open = { sym, kind: 'function' };
      } else if (k) {
        const nameAt = since + k.index + k[0].indexOf(k[2], k[1].length);
        const sym: TextSym = { name: k[2], kind: 'container', nameAt, start: since + k.index, end: m.length, body: i + 1, children: [] };
        add(sym);
        open = { sym, kind: 'container' };
      }
    }
    stack.push(open);
    since = i + 1;
  }
  return roots;
}

export interface Site { name: string; at: number }

export function callSites(text: string, from: number, to: number, masked = false): Site[] {
  const m = (masked ? text : mask(text)).slice(from, to);
  const out: Site[] = [];
  // `f(…)`, `f<T>(…)`, and CUDA kernel launches `k<<<grid, block>>>(…)`
  const re = /\b([A-Za-z_]\w*)\s*(?:<<<[^;]*?>>>\s*|<[^<>;{}()]*>\s*)?\(/g;
  for (let r = re.exec(m); r; r = re.exec(m)) {
    if (KEYWORDS.has(r[1])) continue;
    // a declaration inside the body (`float3 f(…)` of a local prototype) is rare in shaders: kept
    out.push({ name: r[1], at: from + r.index });
  }
  return out;
}

/** Innermost function of an outline containing `offset`. */
export function functionAt(syms: TextSym[], offset: number): TextSym | undefined {
  for (const s of syms) {
    if (offset < s.start || offset >= s.end) continue;
    const inner = functionAt(s.children, offset);
    if (inner) return inner;
    if (s.kind === 'function') return s;
  }
  return undefined;
}

/** Qualified segments of the symbol at `nameAt`: containers, then the name. */
export function qualOf(syms: TextSym[], nameAt: number, up: string[] = []): string[] | undefined {
  for (const s of syms) {
    if (s.nameAt === nameAt) return [...up, s.name];
    if (nameAt >= s.start && nameAt < s.end) {
      const q = qualOf(s.children, nameAt, [...up, s.name]);
      if (q) return q;
    }
  }
  return undefined;
}
