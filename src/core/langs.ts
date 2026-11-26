/** @xvdp
 * Language rules of the call graph provider (pure, no VS Code API).
 *
 * - `LANG`: file extension → language key prefix (`<lang>:<relpath>#<qual>`).
 * - `TEXT_LANGS`: shader languages, servers commonly without call hierarchy: calls from text (textcalls.ts) when
 *   the server returns no item.
 * - `EXTERNAL`: paths outside the project (installed packages, build output, system headers).
 * - `segments`: symbol or call-hierarchy name → qualified-name segments, rules in order: Rust
 *   `impl [<…>] [Trait for] Type` → `Type` or `Type[Trait]` (two trait impls of one type may both define `fmt`);
 *   Go `(*T).M` → `T`, `M`; TypeScript `x.forEach() callback` → `x·forEach·callback`; C++ `ns::Foo<T>::bar(int)`
 *   → `ns`, `Foo`, `bar`, operators whole (`operator()`); else the name without parameters. `.` inside a
 *   segment → `·`; `.` separates segments.
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

/**
 * Languages with function overloading: overloads in one scope key apart by parameter types (lsp.ts `describe`).
 * Python `@overload` stubs and TypeScript overload signatures describe one implementation: not listed.
 */
export const OVERLOADS = new Set(['cpp', 'cuda', 'objcpp', 'java', 'kt', 'cs', 'swift', 'dart', 'scala', 'glsl', 'hlsl', 'slang', 'metal']);

/** Comma-separated parts of a parameter list at depth 0 of (), <>, [], {}. */
export function splitTop(list: string): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if ('(<[{'.includes(c)) depth++;
        else if (')>]}'.includes(c)) depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
    }
    out.push(list.slice(start));
    return out;
}

/** Type of one parameter: default value dropped; `name: Type` → Type; C-like `Type name[…]` → `Type[…]`. */
function paramType(p: string): string {
    let s = p.replace(/\s+/g, ' ').trim();
    const eq = s.search(/(?<![=!<>])=(?!=)/);
    if (eq >= 0) s = s.slice(0, eq).trim();
    const colon = /(^|[^:]):(?!:)/.exec(s);
    if (colon) s = s.slice(colon.index + colon[0].length).trim();
    else {
        const m = /^(.*?[\w>\])])\s*([*&\s]*?)\s*\b[A-Za-z_]\w*\s*((?:\[[^\]]*\]\s*)*)$/.exec(s);
        if (m) s = `${m[1]}${m[2]}${m[3]}`;
    }
    return s.replace(/\s*([*&\[\],<>])\s*/g, '$1').trim();
}

/**
 * Parameter types of the definition whose name `text` starts with: the list between the first `(` and its match,
 * parameters split at top-level commas, each reduced by `paramType`. `f(int a, const T* b = 0, int c[3])` →
 * `int,const T*,int[3]`; `fun f(a: Int, b: String = "")` → `Int,String`; `f()`, `f(void)` → ``. Undefined without
 * a closed parameter list within 4000 characters.
 */
export function paramTypes(text: string): string | undefined {
    const open = text.indexOf('(');
    if (open < 0 || open > 4000) return undefined;
    let depth = 0;
    for (let i = open; i < Math.min(text.length, open + 4000); i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) {
            const inner = text.slice(open + 1, i).trim();
            if (!inner || inner === 'void') return '';
            return splitTop(inner).map(paramType).join(',');
        }
    }
    return undefined;
}

/**
 * Language providers: VS Code extensions answering document symbols and call hierarchy, per language (`langs`: LANG
 * ids). `any`: extension ids that serve it; `install`: the one to suggest; `restart`: commands restarting its server,
 * offered only when registered; `optional`: gaffy draws the language without it (text calls), with this caveat.
 * Read by host/servers.ts (start-up check, report, warnings) and scripts/providers.ts (list outside VS Code).
 */
export interface Provider { label: string; langs: string[]; glob: string; any: string[]; install: string; name: string; restart: string[]; optional?: string }

export const PROVIDERS: Provider[] = [
    { label: 'Python', langs: ['py'], glob: '**/*.{py,pyi}', any: ['ms-python.vscode-pylance', 'ms-pyright.pyright', 'detachhead.basedpyright'],
        install: 'ms-python.vscode-pylance', name: 'Pylance', restart: ['python.analysis.restartLanguageServer', 'pyright.restartserver', 'basedpyright.restartserver'] },
    { label: 'Rust', langs: ['rs'], glob: '**/*.rs', any: ['rust-lang.rust-analyzer'], install: 'rust-lang.rust-analyzer', name: 'rust-analyzer',
        restart: ['rust-analyzer.restartServer'] },
    { label: 'C, C++, CUDA', langs: ['c', 'cpp', 'cuda', 'objc', 'objcpp'], glob: '**/*.{c,cc,cpp,cxx,cu,cuh,h,hh,hpp,hxx}',
        any: ['ms-vscode.cpptools', 'llvm-vs-code-extensions.vscode-clangd'], install: 'ms-vscode.cpptools', name: 'C/C++ or clangd',
        restart: ['C_Cpp.RestartIntelliSenseForFile', 'clangd.restart'] },
    { label: 'TypeScript, JavaScript', langs: ['ts', 'js'], glob: '**/*.{ts,tsx,js,jsx,mjs,cjs}', any: ['vscode.typescript-language-features'],
        install: 'vscode.typescript-language-features', name: 'TypeScript (built in)', restart: ['typescript.restartTsServer'] },
    { label: 'Go', langs: ['go'], glob: '**/*.go', any: ['golang.go'], install: 'golang.go', name: 'Go', restart: ['go.languageserver.restart'] },
    { label: 'Java', langs: ['java'], glob: '**/*.java', any: ['redhat.java'], install: 'redhat.java', name: 'Language Support for Java', restart: ['java.restart'] },
    { label: 'C#', langs: ['cs'], glob: '**/*.cs', any: ['ms-dotnettools.csdevkit', 'ms-dotnettools.csharp'], install: 'ms-dotnettools.csdevkit', name: 'C# Dev Kit',
        restart: ['dotnet.restartServer'] },
    { label: 'Dart', langs: ['dart'], glob: '**/*.dart', any: ['dart-code.dart-code'], install: 'Dart-Code.dart-code', name: 'Dart', restart: ['dart.restartAnalysisServer'] },
    { label: 'Slang', langs: ['slang'], glob: '**/*.{slang,slangh}', any: ['shader-slang.slang-language-extension'], install: 'shader-slang.slang-language-extension',
        name: 'Slang', restart: [], optional: 'gaffy finds Slang calls in the text without it; with it, go to definition makes them exact' },
    { label: 'GLSL', langs: ['glsl'], glob: '**/*.{glsl,vert,frag,comp,geom,tesc,tese}', any: ['raczzalan.webgl-glsl-editor'], install: 'raczzalan.webgl-glsl-editor',
        name: 'WebGL GLSL Editor', restart: [], optional: 'gaffy finds GLSL calls in the text without it' },
];

/** Provider of a file's language. */
export const providerOf = (path: string): Provider | undefined => {
    const lang = langOf(path);
    return PROVIDERS.find((p) => p.langs.includes(lang));
};

/** VS Code extension per language for document symbols and call hierarchy (messages). */
export const SERVERS: Record<string, string> = Object.fromEntries(PROVIDERS.flatMap((p) =>
    p.langs.map((l) => [l, p.any.length > 1 ? `${p.name} (${p.any.join(' or ')})` : `${p.name} (${p.install})`])));

/** Message: server lists the file's functions but returns no call hierarchy. */
export const noHierarchyHint = (path: string) => langOf(path) === 'rs'
    ? 'rust-analyzer gives no call hierarchy for code it treats as inactive under #[cfg] (for example a module behind a Cargo feature that is off): '
        + 'enable the feature for rust-analyzer, "rust-analyzer.cargo.features": ["<feature>"] or "all", in the workspace settings'
    : `the language server lists the functions but answers no call hierarchy for them (still indexing, or code it treats as inactive); ${serverHint(path)}`;

/** Message: no answer for the file's language; names the extension that would. */
export const serverHint = (path: string) => {
    const lang = langOf(path);
    return SERVERS[lang] ? `install or enable ${SERVERS[lang]}` : `no language server with call hierarchy is known for .${path.split('.').pop()} files`;
};

/** File extensions of a language (for its text index). */
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
    '(^|[\\\\/])pkg[\\\\/][\\w-]+(_bg)?\\.js$',                                    // wasm-pack glue (calls show caller → Rust function)
    '^/usr/(include|lib|local/include)/',
].join('|'));

/**
 * Library roots in paths outside every workspace folder. Capture: directory where library paths begin: Python
 * import roots (`site-packages`, `dist-packages`, typeshed `stdlib` or stub distribution, `lib/python3.x`),
 * C/C++ `include`, Rust standard `library`, Cargo crate folder, `node_modules`. `py: true`: files import by path.
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
 * File outside every workspace folder (absolute POSIX path) → `root` + `/` + `rel` = `abs`; `rel` starts at the
 * innermost library root: `…/lib/python3.12/site-packages/torch/functional.py` → rel
 * `site-packages/torch/functional.py`, module `torch.functional`. Keys: short, machine-independent; finite folder
 * chain of `rel`. No library root: `rel` = `abs` without leading `/`. `module`: Python files under an import root only.
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
