/** @xvdp
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

/** VS Code extensions whose language servers give a language document symbols and call hierarchy (for messages). */
export const SERVERS: Record<string, string> = {
    py: 'Python with Pylance (ms-python.python)',
    rs: 'rust-analyzer (rust-lang.rust-analyzer)',
    c: 'C/C++ (ms-vscode.cpptools) or clangd (llvm-vs-code-extensions.vscode-clangd)',
    cpp: 'C/C++ (ms-vscode.cpptools) or clangd (llvm-vs-code-extensions.vscode-clangd)',
    cuda: 'C/C++ (ms-vscode.cpptools) or clangd (llvm-vs-code-extensions.vscode-clangd)',
    go: 'Go (golang.go)',
    java: 'Language Support for Java (redhat.java)',
    cs: 'C# Dev Kit (ms-dotnettools.csdevkit)',
    dart: 'Dart (Dart-Code.dart-code)',
    slang: 'Slang (shader-slang.slang-language-extension)',
    glsl: 'WebGL GLSL Editor (raczzalan.webgl-glsl-editor)',
};

/** Message for a file whose server lists its functions but gives them no call hierarchy. */
export const noHierarchyHint = (path: string) => langOf(path) === 'rs'
    ? 'rust-analyzer gives no call hierarchy for code it treats as inactive under #[cfg] (for example a module behind a Cargo feature that is off): '
        + 'enable the feature for rust-analyzer, "rust-analyzer.cargo.features": ["<feature>"] or "all", in the workspace settings'
    : `the language server lists the functions but answers no call hierarchy for them (still indexing, or code it treats as inactive); ${serverHint(path)}`;

/** Message for a file whose language answered nothing: the extension that would. */
export const serverHint = (path: string) => {
    const lang = langOf(path);
    return SERVERS[lang] ? `install or enable ${SERVERS[lang]}` : `no language server with call hierarchy is known for .${path.split('.').pop()} files`;
};

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
    '(^|[\\\\/])pkg[\\\\/][\\w-]+(_bg)?\\.js$',                                    // wasm-pack glue (calls show from the caller to the Rust function)
    '^/usr/(include|lib|local/include)/',
].join('|'));

/**
 * Library roots in a path of code outside every workspace folder. The capture is the directory where
 * the library's own paths begin: Python import roots (`site-packages`, `dist-packages`, a typeshed
 * `stdlib` or stub distribution, `lib/python3.x`), C and C++ `include`, the Rust standard `library`, a
 * Cargo crate folder, `node_modules`. `py: true`: files under it import by their path.
 */
const LIB_ROOTS: { re: RegExp; py: boolean }[] = [
    { re: /\/((?:site|dist)-packages)\//g, py: true },
    { re: /\/typeshed-fallback\/(stdlib)\//g, py: true },
    { re: /\/typeshed-fallback\/stubs\/([^/]+)\//g, py: true },
    { re: /\/lib\/(python\d+(?:\.\d+)?)\//g, py: true },
    { re: /\/(include)\//g, py: false },
    { re: /\/lib\/rustlib\/src\/rust\/(library)\//g, py: false },
    { re: /\/registry\/src\/[^/]+\/([^/]+)\//g, py: false },
    { re: /\/(node_modules)\//g, py: false },
];

/**
 * A file outside every workspace folder (absolute POSIX path) → `root` + `/` + `rel` = `abs`, where `rel`
 * starts at the innermost library root the path passes through: `…/lib/python3.12/site-packages/torch/functional.py`
 * → rel `site-packages/torch/functional.py`, module `torch.functional`. Keys stay short and stable across
 * machines, and the folder chain of `rel` is finite. A path through no library root keeps every segment
 * (`rel` = `abs` without its leading `/`); `module` is set only for Python files under an import root.
 */
export function externalPath(abs: string): { root: string; rel: string; module?: string } {
    let best: { start: number; py: boolean } | undefined;
    for (const { re, py } of LIB_ROOTS) {
        for (const m of abs.matchAll(re)) {
            const start = m.index! + m[0].length - m[1].length - 1;    // index of the captured directory name
            if (!best || start > best.start) best = { start, py };
        }
    }
    if (!best) return { root: '/', rel: abs.replace(/^\/+/, '') };
    const rel = abs.slice(best.start);
    const ext = /\.pyi?$/.exec(rel);
    const module = best.py && ext
        ? rel.slice(rel.indexOf('/') + 1, rel.length - ext[0].length).split('/').join('.').replace(/\.__init__$/, '')
        : undefined;
    return { root: abs.slice(0, best.start - 1) || '/', rel, module };
}

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
