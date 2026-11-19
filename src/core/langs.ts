/**
 * Language rules of the call graph provider, kept apart from its behaviour (pure, no VS Code API).
 *
 * - `LANG`: file extension → key prefix of the language (`<lang>:<relpath>#<qual>`).
 * - `TEXT_LANGS`: languages whose servers commonly lack call hierarchy (shader languages); for these the
 *   provider finds calls in the text (textcalls.ts) when the server returns no call hierarchy item.
 * - `EXTERNAL`: paths of code outside the project (installed packages, build output, system headers).
 * - `segments`: a document-symbol or call-hierarchy name → qualified-name segments. Rules, in order:
 *   Rust `impl [<…>] [Trait for] Type` → `Type`, or `Type[Trait]` (two trait impls of one type both define
 *   `fmt`); Go `(*T).M` → `T`, `M`; TypeScript `x.forEach() callback` → `x·forEach·callback`; C++
 *   `ns::Foo<T>::bar(int)` → `ns`, `Foo`, `bar`, operators kept whole (`operator()`); otherwise the
 *   name without its parameter list. A `.` left inside a segment becomes `·`, so `.` separates segments.
 */

export const LANG: Record<string, string> = {
  py: 'py', pyi: 'py',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp', ipp: 'cpp', ixx: 'cpp', cppm: 'cpp',
  cu: 'cuda', cuh: 'cuda', m: 'objc', mm: 'objcpp',
  rs: 'rs', go: 'go', java: 'java', kt: 'kt', kts: 'kt', cs: 'cs', swift: 'swift', dart: 'dart', scala: 'scala', jl: 'jl', rb: 'rb', php: 'php', lua: 'lua', zig: 'zig',
  glsl: 'glsl', vert: 'glsl', frag: 'glsl', geom: 'glsl', comp: 'glsl', tesc: 'glsl', tese: 'glsl',
  rgen: 'glsl', rint: 'glsl', rahit: 'glsl', rchit: 'glsl', rmiss: 'glsl', rcall: 'glsl', mesh: 'glsl', task: 'glsl',
  vs: 'glsl', fs: 'glsl', vsh: 'glsl', fsh: 'glsl',
  hlsl: 'hlsl', hlsli: 'hlsl', fx: 'hlsl', fxh: 'hlsl',
  slang: 'slang', slangh: 'slang',
  wgsl: 'wgsl', metal: 'metal',
};

export const TEXT_LANGS = new Set(['glsl', 'hlsl', 'slang', 'wgsl', 'metal']);

/** Extensions of one language (for the text index of a language). */
export const extsOf = (lang: string) => Object.entries(LANG).filter(([, l]) => l === lang).map(([e]) => e);

export const langOf = (path: string) => {
  const m = /\.([^./\\]+)$/.exec(path);
  const ext = m ? m[1].toLowerCase() : '';
  return LANG[ext] ?? (ext || 'txt');
};

export const EXTERNAL = new RegExp([
  '(^|[\\\\/])(node_modules|site-packages|dist-packages|\\.venv|venv|typeshed|typeshed-fallback)([\\\\/]|$)',
  '\\.d\\.ts$',
  '(^|[\\\\/])target[\\\\/](debug|release|[\\w-]+-[\\w-]+-[\\w-]+)[\\\\/]',      // Rust build output
  '(^|[\\\\/])(_deps|vcpkg_installed|\\.conan2?|\\.cargo|\\.rustup)[\\\\/]',          // fetched C/C++ and Rust dependencies
  '^/usr/(include|lib|local/include)/',
].join('|'));

/** Removes balanced `<…>` groups (generic or template arguments). */
function stripGenerics(s: string): string {
  let prev;
  do { prev = s; s = s.replace(/<[^<>]*>/g, ''); } while (s !== prev);
  return s;
}

const dotless = (s: string) => s.replace(/\./g, '·');
const lastPath = (s: string) => stripGenerics(s).trim().split(/::|\./).filter(Boolean).pop() ?? s.trim();

export function segments(raw: string): string[] {
  const name = raw.trim();
  // Rust impl blocks
  const impl = /^impl\b\s*(?:<.*?>\s*)?(?:(.+?)\s+for\s+)?(.+)$/.exec(name);
  if (impl && /^impl\b/.test(name)) {
    const type = lastPath(impl[2]);
    return [impl[1] ? `${type}[${lastPath(impl[1])}]` : type];
  }
  // Go methods: (*T).M or (T).M
  const go = /^\(\*?([\w.]+)(?:\[.*\])?\)\.(\w+)$/.exec(name);
  if (go) return [dotless(go[1]), go[2]];
  // TypeScript callbacks: `items.forEach() callback`
  const cb = /^(.*)\(\) callback$/.exec(name);
  if (cb) return [`${dotless(cb[1])}·callback`];
  // C++ qualified names, operators kept whole
  const op = name.indexOf('operator');
  const head = op >= 0 ? name.slice(0, op) : name;
  const tail = op >= 0 ? name.slice(op) : '';
  const parts = stripGenerics(head.replace(/\(.*$/, '')).split('::').map((s) => s.trim()).filter(Boolean);
  if (tail) parts.push(tail.replace(/\s+/g, ' ').trim());
  return parts.length ? parts.map(dotless) : [dotless(name)];
}
