# gaffy dev


## Languages Supported

| Language | Server (VS Code extension) | Call hierarchy | gaffy |
|---|---|---|---|
| Python | Pylance | yes | language server |
| TypeScript, JavaScript | built in | yes (TypeScript 5.9 LanguageService, measured) | language server; constructors named by class; object-literal methods qualified by their variable (`obj.run`) |
| Rust | rust-analyzer (`rust-lang.rust-analyzer`); none under an inactive `#[cfg]` (module behind a disabled Cargo feature): set `"rust-analyzer.cargo.features"` | yes (not measured here) | language server; `impl Foo` → `Foo`, `impl Display for Foo` → `Foo[Display]`: `fmt` of two trait impls stays distinct |
| C, C++, CUDA, Objective-C | Microsoft C/C++ (registers a provider) or clangd | yes | language server; `ns::Foo::bar` → `ns` › `Foo` › `bar`; template arguments dropped; operators kept whole |
| Go, Java, C#, Kotlin, Swift, Dart | gopls, each language's server | per server (not measured here) | language server; Go `(*T).M` → `T` › `M` |
| GLSL | WebGL GLSL Editor (registers a provider) | yes | language server; without it: text |
| Slang | Slang (slangd 1.8): definitions and document symbols, no references (measured) | no | text: call sites by go to definition; callers by a scan of workspace Slang files |
| HLSL, WGSL, Metal | per extension | usually no | text: document symbols, else a C-like outline; go to definition when offered, else by name |

Text calls ([src/core/textcalls.ts](../src/core/textcalls.ts)): comments, strings, preprocessor lines masked; functions and containers (`struct`, `class`, `namespace`, `interface`, `extension`, `cbuffer`) from document symbols, else brace matching; call site: name + `(` (optional `<…>`), control keywords excluded; constructor of a project type counted when a function of that name exists; calls through function pointers or macros missed. Name rules per language: [src/core/langs.ts](../src/core/langs.ts). External code (installed packages, `target/`, `_deps/`, `/usr/include`): hidden unless `gaffy.includeExternal`.

## Cross language bridges

Binding declarations link calls no language server sees across (Python ↔ C++/CUDA, Python ↔ Slang, TypeScript ↔ Rust): [src/core/bindings.ts](../src/core/bindings.ts), [src/host/bridges.ts](../src/host/bridges.ts); setting `gaffy.bridges`. Tooltip: the binding (`via pybind11: ext.cpp:16`).

| Layer | Declarations read | Python call that links |
|---|---|---|
| pybind11, nanobind | `PYBIND11_MODULE(mod, m)` / `NB_MODULE(mod, m)`: `m.def("fn", &cpp_fn)`, `py::overload_cast<…>(&fn)`, `m.def_submodule("sub")`, `py::class_<T>(m, "T").def("meth", &T::meth)`, `def_static` | `mod.fn(…)`, `fn(…)` after `from mod import fn`, `mod.T.meth(…)`, through the file's imports |
| torch extensions | `PYBIND11_MODULE(TORCH_EXTENSION_NAME, m)`; module name from `load(name=…, sources=[…])` or `CUDAExtension("pkg._C", […])` in setup.py | `_C.fn(…)` after `from . import _C` |
| torch operators | `TORCH_LIBRARY(ns, m)`, `TORCH_LIBRARY_IMPL(ns, CUDA, m)`: `m.impl("op", &op_cuda)` | `torch.ops.ns.op(…)` |
| slangpy, slangtorch | `spy.Module.load_from_file(device, "x.slang")`, `device.load_module("x")`, `slangtorch.loadModule("x.slang")` in the Python file | `….fn(…)` for `fn` defined in x.slang; a function calling `getattr(h, …)` on a name that held the module (`module`, `self.module`) links to each x.slang function named in a string literal of the file (marked "by name, getattr") |
| wasm-bindgen (Rust ↔ TypeScript, JavaScript) | `#[wasm_bindgen]` on `pub fn` (`js_name`) and on `impl T` (`#[wasm_bindgen(constructor)]`, methods, statics, `js_class`); `getter`/`setter` methods: property reads, not calls; crate: nearest `Cargo.toml` `[package]` | `f(…)` after `import { f } from '…/pkg'` (crate's wasm-pack folder, `pkg/<crate>.js`, or package name = crate name), `ns.f(…)` after `import * as ns`, `new T(…)`, `T.s(…)`, dynamic `import(…)`, `require(…)`; generated glue `pkg/*.js` is external code, so each call shows once, caller → Rust function |

C++/CUDA end: go to definition at the binding's target (C/C++ extension or clangd), else a workspace symbol of that name; CUDA host functions in `.cu` files alike; kernel launches `k<<<grid, block>>>(…)`: text calls. torch.autograd: `X.apply(…)` on a `torch.autograd.Function` subclass → `X.forward` (dispatched at run time; the language server stops at `Function.apply`). Not linked: calls on instances (`obj.meth(…)`, type unknown in the text), lambdas in bindings, constructors (`py::init`), registrations built in loops. A binding match replaces the language server's edge from that call site, which matches by name while the compiled module is unresolved (`_C.rasterize_gaussians(…)` taken for the Python wrapper `rasterize_gaussians`; measured with Pyright).

Search scope for bindings and callers: the file's project (nearest folder with `setup.py`, `pyproject.toml`, `setup.cfg`, `CMakeLists.txt`, `Cargo.toml` or `package.json`), then the workspace.

Requirement: both sides in the workspace. An installed package's `site-packages` holds the Python wrapper and the compiled module, no C++/CUDA source: add the source repository as a second workspace folder (File > Add Folder to Workspace), resolved by Pylance through `pip install -e <repo>` or `"python.analysis.extraPaths": ["<repo>"]` (Pyright resolves extra paths before `site-packages`). Otherwise the call ends at the installed copy: external code, shown only with `gaffy.includeExternal` (VS Code setting, not style.json).

Direction: binding calls are outgoing calls; a function shown as a caller opens only its callers. Path `forward → _C.rasterize_gaussians → RasterizeGaussiansCUDA`: the calls of `forward` (a seed, or a view from gaffy> Call Hierarchy (dn)).

### Implicit calls (classes)

Runtime method calls without a call expression naming the method, absent from language-server answers; added by [src/host/implicit.ts](../src/host/implicit.ts), with a tooltip:

- Construction: a class calls `__new__`, `__init__` (nearest base class defining one) and `__post_init__` (Python), or `constructor` (TypeScript, JavaScript): `Foo(…)` → `caller → Foo → Foo.__init__`; callers of `Foo.__init__` start with `Foo`.
- Instance call (Python): `obj(…)` calls `type(obj).__call__`, or `forward` for a torch `nn.Module` (no `__call__` below `Module`). Type of `obj`: the language server's type definition at the call site (`criterion(x, y)`, `self.net(x)`); call sites with an answer skipped.

Not followed (a call trace would see them): backprop, hooks, `with` blocks, iteration, operators, properties, decorators.



## Scripts
[package.json](../package.json#L928)

| command | effect |
|---|---|
| `npm install` | dependencies, after cloning or a `package.json` change |
| `npm run install:local` | latest vsix: `code --install-extension gaffy-<version>.vsix --force` (reinstalls same version), version from `package.json` |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | vitest: core, routing invariants, golden text pictures in `test/golden/`, rule configuration, edge rules on `test/data/bindings.gaffy`, a subset of the rule matrix, seeded operation sequences |
| `npm run test:matrix` | tests all rules (fixtures × boxes × tight × parent rule × switched-off rules × moves; about 3 minutes) |
| `UPDATE_GOLDEN=1 npm test` | goldens rewritten after an intended layout change |
| `npm run build` | esbuild bundles: `dist/extension.js` (host), `dist/webview.js` (webview) |
| `npm run watch` | build on every save |
| `npm run package` | `npm run` {`typecheck`, `test`, `build`},  `vsce package` =>  `gaffy-<version>.vsix` |
| `npm run release` | `npm run` {`typecheck`, `test`, `build`, `version patch --no-git-tag-version`}, `vsce package` => `gaffy-<version>+0.0.1.vsix`, version increment in `package.json` & `package-lock.json`|
| `npm run preview` | `dist/preview.html`: the webview in a browser with fixture views; `GAFFY_PREVIEW_FILE=<view.gaffy> npm run preview` for any view |
| `npm run heuristics` | `docs/heuristics.md`, `docs/heuristics.gaffy`, `docs/ordering.md`, `docs/examples.md` (pictures of terms and rules), `src/core/rules.lines.ts` (code sites per rule), regenerated from the code; `schemas/style.schema.json` restricted to the appearance keys of `USER_STYLE` |
| `npm run docs:check` | `npm run heuristics`, then a failure when `docs/`, `rules.lines.ts` or the schema differs from the commit |
| `npm run explain -- <view.gaffy> [--unit <text>] [--flags] [--off <rules>] [--trace <trace.jsonl>]` | placement decision log with code lines, rule ablation, trace replay (README: Layout debugging) |
| `node tools/gaffy-trace.mjs <trace.jsonl>` | view change log (setting `gaffy.trace`) as a list |
| `npm run metrics -- <view.gaffy> ['<rules JSON>' …]` | edge metrics per rule configuration: picture size, crossing cells, bends, routed cells, unrouted calls, route cost, build time |
| `npm run providers -- [folder]` | language providers outside VS Code: languages with files under the folder, the extension each needs, installed or missing (`code --list-extensions`, else the extension folder) |


## Files

```
package.json          manifest: identity, VS Code version range, entry point, activation, contributions; npm scripts
.github/workflows/publish.yml  Marketplace publish, manual run, Trusted Publishing (OIDC, no stored token)
esbuild.mjs           two bundles: host (Node, CommonJS⁸, `vscode` left external) and webview (browser, IIFE⁹)
schemas/              JSON schema of .baggy/gaffy/style.json: appearance keys (font, colors, labels, frame and edge drawing); layout choices live in the view (Options, Rules panel)
media/webview.css     webview styles, mapped to VS Code theme variables
src/core/             TypeScript, no VS Code API: runs in the host (export), the webview (render) and tests
  model.ts              graph types: nodes (definitions, containers), edges (calls)
  viewdoc.ts            the .gaffy document: view settings and the stored graph; parse, serialize
  quotient.ts           collapse and hide: the graph a view draws
  reveal.ts             visibility: open sides (one layer at a time), call depths (full)
  boxes.ts, labels.ts   namespace boxes, label text
  layout.ts             rows, tree parents, lanes inside one box
  place.ts              boxes and blocks in 2D, moves, locks
  settle.ts             moved units the picture grew into: nearest clear offset, least displacement first
  rules.ts              rule registry: id, stage, text, switch, alternatives, parameters; configuration layers (defaults, legacy style keys, style.json `rules`, view `rules`)
  rules.lines.ts        generated: code sites per rule (npm run heuristics)
  paths.ts              calls to ask for the call paths between seeds (added seeds, Paths between seeds only)
  explain.ts            layout debugging: decision log and flags
  grid.ts               character grid, A* routing, glyphs (call kinds), text export
  bindings.ts           binding declarations parsed from source text (pybind11, nanobind, torch, slangpy, wasm-bindgen)
  scene.ts              pipeline: document → quotient → visibility → boxes → layout → placement → grid
  style.ts              style defaults and merge
  langs.ts, textcalls.ts  language rules; calls found in text for shader languages
  weblinks.ts           git remote -> https web base; file links at a commit (GitHub, GitLab, Bitbucket)
src/host/             extension host: Node.js, VS Code API
  extension.ts          activate(): registers the editor and commands, watches saves and renames
  editor.ts             custom text editor: one Session per open view; webview messages; language-server queue
  commands.ts           command and menu handlers, view creation, export
  lsp.ts                call hierarchy through VS Code's language-server commands
  build.ts, cache.ts    answers folded into the view; persistent call cache
  bridges.ts            calls across languages from bindings.ts, joined to the language-server graph
  implicit.ts           implicit calls: construction, instance call
  servers.ts            language providers per workspace language: installed, active, live probe; List Language Providers; warning with actions
  settings.ts           gaffy.autoSave read per folder, written where it takes effect
  sources.ts            rule links of the debugging panel: local gaffy sources, else GitHub at the build commit
  git.ts                commit for view file names; remote, commit and root for export web links
  scope.ts              URI scheme gate (`readable`)
  safefs.ts             no writes through symbolic links under `.baggy/gaffy/` (`noLinks`)
  seedspec.ts           seeds written by name in a view file (`<path>#<qualified name>`, `<path>:<line>`)
  trace.ts, tracerec.ts view change records (setting gaffy.trace)
  style.ts              style.json per workspace folder
src/webview/main.ts   webview: D3 rendering, interaction, toolbar and options
src/webview/dbgpanel.ts  layout debugging panel: Rules, Actions (running log), Calls (how each call line is drawn)
test/                 vitest tests, fixtures, golden text renders
scripts/preview.mjs   browser preview of the webview with fixtures and simulated steps (GAFFY_PREVIEW_FILE=<view> for any view file; steps=…, trace=1)
scripts/heuristics.ts the layout heuristics as a graph: writes docs/heuristics.md and docs/heuristics.gaffy (`npm run heuristics`)
scripts/ordering.ts   every function that changes what is shown or where: writes docs/ordering.md (`npm run heuristics`)
scripts/rules.ts      pipeline functions, calls and rules with their code anchors (heuristics.ts, explain.ts)
scripts/explain.ts    placement decision log of a view file (`npm run explain`; core: src/core/explain.ts)
scripts/providers.ts  language providers outside VS Code (`npm run providers`)
scripts/metrics.ts    edge metrics of a view per rule configuration (`npm run metrics`)
scripts/examples.ts   docs/examples.md: pictures of terms and rules from made-up graphs (`npm run heuristics`)
tools/gaffy-trace.mjs standalone, no dependencies, not packaged: prints a view trace (.baggy/gaffy/trace/<view>.jsonl, setting gaffy.trace)
test/data/            view files reduced from real cases (runaway.gaffy: box descent drift, names made up; bindings.gaffy: gaffy's bindings.ts and its callers, redundant crossings)
```

## 2. D3 in gaffy

gaffy uses four D3 modules, bundled into `dist/webview.js`. Built on top of D3 for interaction ([src/webview/main.ts](../src/webview/main.ts)):

| Module | Version | Use |
|---|---|---|
| `d3-selection` | 3.0.1 | data joins: SVG element per frame, call, hit path, label, marker, box header;  HTML toolbar and options panel |
| `d3-zoom` | 3.0.1 | pan and zoom of SVG root; the transform is stored in the webview state and shifted to keep the anchored function in place |
| `d3-drag` | 3.0.1 | dragging functions and boxes, snapped to whole grid cells |
| `d3-shape` | 3.2.0 | curve generation for the spline style |

Layout is gaffy's (`src/core/`): grid assigns label, line and arrowhead, character cell. Wwebview draws those cells either as glyphs or as vector paths. 

- hit paths: wide transparent strokes over each call; a click resolves the grid cell under the pointer to every call through it (forks and merges select together);
- arrowhead regions (one layer at a time): the arrowhead cell and the blank before the name close a level, separate from the line, which only selects;
- markers `>>` and `└─>>` with their own click handlers;
- selection state and an overlay layer for highlights;
- anchoring: after each layout the zoom transform shifts by the anchored name's move;
- drop repulsion: candidate drops are laid out in memory and checked for collisions before one is committed;
- context menus through `data-vscode-context` attributes, which VS Code reads to fill its own menus;
- the message protocol with the host: `state`, `edit`, `expand`, `refresh`, `progress`, `note`.

## 3. Security

I ran several security reviews to ensure that this code is not leveraged with ill intent. Still this relies on language servers and user trusted projects, if those are bad the user has a bigger fish in the pond.

Threat model: a workspace or a `.gaffy` file comes from someone else (a cloned repository, a download). Its files are data to gaffy; none of them may run code, read files outside the workspace through gaffy, or reach the network.

| Surface | Measure |
|---|---|
| Webview | Content Security Policy: `default-src 'none'`; scripts only with a per-page nonce from `crypto.randomBytes`; styles from the extension and inline; images and fonts from the extension only. Labels, tooltips and toolbar text are set as text, never as HTML. `localResourceRoots`: `dist/`, `media/`. |
| Text shown from outside data | Labels, box headers, tooltips, hover cards (language-server signature text, set as text, never as markup), the quick pick of hidden neighbors and the text and HTML exports show C0/C1 controls, zero-width characters and bidirectional controls¹⁷ as `\u{…}` (`visible` in `src/core/model.ts`): a name cannot display as another name (Trojan Source, CVE-2021-42574 [boucher2023trojan], keys in [refs.bib](../refs.bib)). Notification and progress messages pass through `plain`, which also splits every `](`: VS Code renders `[label](https:…|command:…|file:…)` in a notification as a link and runs a `command:` link on click [api: microsoft/vscode main, `src/vs/base/common/linkedText.ts` `parseLinkedText`; `src/vs/workbench/browser/parts/notifications/notificationsViewer.ts`, `openerService.open(URI.parse(link), { allowCommands: true })`; read 2026-11-19], so a name, path or error message cannot carry one. |
| Messages from the webview | The host acts on a fixed set of message types; `setting` writes only `autoSave` (through the command `gaffy.toggleAutoSave`) and `debugLayout` (booleans); `seed` (Make Seed in a frozen view) takes a key the view holds as its own property and adds it as a seed, unfreezing the view; `openRule` takes a rule id of the registry and a site index of `rules.lines.ts` or `doc`, and opens that file from the gaffy sources or a github.com URL built from package.json `repository`; `expand` takes `in` or `out` and a key the view holds as its own property; `openAt` takes a non-negative integer line; `save` runs a fixed command; the trace fields `cause` and `moved` are reduced to strings of at most 200 characters, integer cells and at most 2000 entries (`checkedCause` in `src/host/tracerec.ts`). |
| Node records in `.gaffy` files and the call cache | Opened only for the scheme `file` or a workspace folder's scheme (`readable` in `src/host/scope.ts`); shown with `showTextDocument` (read only), never executed. Node keys `__proto__`, `constructor`, `prototype` are dropped on load; the cache looks up the modification times of its files for those schemes only. |
| Language-server answers | Call hierarchy items, incoming and outgoing calls, definitions, references, document and workspace symbols: a location of another scheme is dropped where the answer arrives, before any document is opened, hashed or asked about (`readable`); gaffy sends no request for a URI of another scheme. At most 5000 calls per answer (`MAX_CALLS`; a longer answer is cut, cached with its full length, and reported once per view in a warning), 30 s per request (`REQUEST_MS`) in `src/host/lsp.ts`. A file outside every workspace folder is keyed from its library root (`externalPath` in `src/core/langs.ts`: `site-packages/torch/functional.py`), so its folder chain is finite. Answer data reaches no command id, setting, process argument, file path outside `.gaffy/`, HTML markup, or the network; every `executeCommand` id is a constant. |
| `style.json` | Merged without the keys `__proto__`, `constructor`, `prototype` (prototype pollution); colors become CSS custom properties, which cannot load external resources under the policy above. |
| git | `git rev-parse --short HEAD` (view file names); `git remote get-url origin`, `git rev-parse HEAD`, `git rev-parse --show-toplevel` (export web links): run only in a trusted workspace and only in a workspace folder: a `.git/config` from a downloaded folder can make git run programs. `package.json` declares `untrustedWorkspaces: limited`. |
| Source text (bindings, shader languages) | Read, never run: `setup.py` and build files are matched with regular expressions; a name from the text enters an expression only after it matches an identifier pattern (a `TORCH_LIBRARY` variable such as `.*.*.*` once took 16 s to scan); a class walk over base classes visits each class once, at most 64. Files over 2 MB are skipped; declaration headers over 600 characters are not parsed (bounded regular-expression work); a `.slang` path written in Python source resolves only inside a workspace folder. |
| Writes under `.baggy/gaffy/` | Call cache, trace, exports, new views and `style.json` never write through a symbolic link: every existing path segment below the workspace folder is checked with lstat first (`noLinks` in `src/host/safefs.ts`); a repository shipping `.gaffy/cache/calls.json` as a link to a shell startup file cannot make gaffy truncate or append to it. The trace writes only in a trusted workspace and rotates at 20 MB. |
| Settings from the workspace | `package.json` lists `gaffy.trace`, `gaffy.exclude` and `gaffy.style` as restricted configurations: in an untrusted workspace VS Code reads them from user settings only. Globs match in linear time (`globMatcher`, no regular expression to backtrack); style numbers are clamped to the ranges of `schemas/style.schema.json` (`boundedStyle`). |
| View files | `parseDoc` keeps strings in lists, drops special keys and values of the wrong type in keyed records, bounds offsets to ±1000 and locks to [0, 2000] cells; routing searches grids up to 10⁶ cells and draws larger ones with fallback lines, so a crafted file cannot allocate gigabytes. |
| Export | Writes only under the project's `.baggy/gaffy/`; file names keep `[A-Za-z0-9_.-]`; HTML text and attributes are escaped (`&`, `<`, `>`, `"`, `'`); links are paths relative to `.baggy/gaffy/` and start with `./` or `../`, so no first segment reads as a scheme; with `gaffy.exportWebLinks`, links are `https://` URLs built from the origin remote (`src/core/weblinks.ts`): credentials dropped, other schemes and local remotes refused, path segments URI-encoded. |
| Dependencies | Shipped: the D3 modules in `dist/webview.js` (`npm audit --omit=dev`: 0 vulnerabilities). Development only (vitest, vsce): findings in `npm audit` that do not reach the package. |

Trace reader: `tools/gaffy-trace.mjs` prints control, zero-width and bidirectional characters from trace data as `\u{…}` (text) or `\uXXXX` (`--json`), so names cannot send terminal escape sequences.



## Building, progress, cache

- Progress: status line `⟳ language server: <phase> …` with growing dots (seed resolution `resolving seeds 3/34`, then layers, definitions, language-server requests, cached answers), the same phase in a banner over the graph; after 400 ms also a notification with cancel.
- Cache: each language-server answer (callers or called of one definition), in `.baggy/gaffy/cache/calls.json` (`calls-external.json` for views with external code). Depth or direction changes, expansion and view opening ask the language server only for uncached answers.
- Invalidation: a saved, renamed or externally changed source file drops its definitions' cached outgoing calls and all cached incoming calls; files of an extension no cached definition has (logs, bytecode, build output): none. `gaffy: Clear Call Cache`: everything.
- No answer ≠ empty answer: a definition the language server does not resolve (analyzing after a reload, renamed, removed) keeps its stored calls, uncached, unexplored; retries after 2, 4, 8, 15, 30, 60 s (`language server not ready` in the status line), then a warning with the count.
- Timeout: 30 s without an answer counts as no answer (retried); one stalled request never holds the queue.
- Unfrozen view: explored (definition, direction) pairs take cached answers; stale pairs on screen asked again in the background, off screen kept and asked when a side opens onto them. Nothing changed since the last save: no request.
- **Refresh Language Server** (Options > File, `r`, `gaffy: Refresh Language Server`): every on-screen (definition, direction) pair asked again; cached answers of the others dropped (asked when a side or a call depth reaches them).

## Change tracking

- Source save: open views with a definition from that file updated (`gaffy.refreshOnSave`: `touched`, `all`, `off`), asking only the pairs made stale.
- File rename: keys, paths, URIs rewritten in open views, then updated alike.
- Definition identity across line moves: keys `<lang>:<path>#<qualified name>`.
- Views keep every definition the language server named; closed sides, lower call depths, hides only take them off screen.


## Settings

| setting | default | effect |
|---|---|---|
| `gaffy.depth` | 3 | one layer at a time: levels prefetched in the background; full: the starting call depths |
| `gaffy.maxNodes` | 400 | definitions fetched per build |
| `gaffy.openCallHierarchy` | true | also open VS Code's Call Hierarchy, in the References view, when creating a view |
| `gaffy.saveViews` | false | Autosave Graphs: new views written to `.baggy/gaffy/`, saved after each change. Off: closing an unsaved view discards it (hot exit keeps it across window reloads) |
| `gaffy.trace` | false | view change log, undo and redo included, in `.baggy/gaffy/trace/<view>.jsonl`: event, target, grid cell, acting functions, changed fields, moved labels and boxes; trusted workspaces only. Reader: `node tools/gaffy-trace.mjs <file>` (this repository) |
| `gaffy.exclude` | none | globs of folders and files kept off screen (for example `"**/tests/**"`); Options > Folders includes them again per view |
| `gaffy.includeExternal` | false | new views: show external code (Options > Folders per view): installed packages (site-packages, node_modules), stubs, system headers, build output, wasm-pack glue |
| `gaffy.includeStandardLibrary` | false | new views, with external code: builtins and standard library (Python typeshed `stdlib`, `pythonX.Y`; Rust core, alloc, std; C++ standard headers; TypeScript `lib.*.d.ts`); off: installed packages only; drawn without the language server |
| `gaffy.exportWebLinks` | false | Save as Text: .md links point to the origin remote at the current commit (valid once pushed); off: relative to `.baggy/gaffy/` |
| `gaffy.autoSave` | true | save the view file after each graph change |
| `gaffy.refreshOnSave` | touched | update policy after a source save |
| `gaffy.openDefinitions` | true | Open Definitions: a view from the editor opens beside it; a click opens the definition next to the graph. Off: active column; a click only selects |

## Tests and preview

Preview page parameters: `../dist/preview.html?doc=sh|exp4|star|grow|two[&edges=vector&curve=sigmoid&fill=hue&boxes=off&parentRule=joint]`.

Preview: the webview bundle in a browser, mocked VS Code API, fixture views (`sh`, `exp4`, `star`, `grow`, `two`) over made-up packages; `GAFFY_PREVIEW_FILE=<view.gaffy>` previews any view.
