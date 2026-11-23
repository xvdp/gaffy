# gaffy development

Workflow, release, naming, publishing, and architecture of the gaffy VS Code extension. Terms marked with a footnote number are defined at the end.

## 1. Tooling in Python terms

| npm / Node.js | Python analogue | In this project |
|---|---|---|
| `package.json` | `pyproject.toml`: metadata, dependencies, scripts | also the VS Code extension manifest (section 6) |
| `package-lock.json` | `poetry.lock`, `uv.lock` | exact versions of every installed package; commit it |
| `node_modules/` | the virtual environment's `site-packages`, per project | created by `npm install`; never committed |
| `npm install` | `pip install -e .` / `uv sync` | installs `dependencies` and `devDependencies` |
| `npm run <script>` | `make <target>`, `nox -s <session>` | runs a command from `package.json` `scripts` |
| `npx <tool>` | `python -m <tool>` | runs a tool installed in `node_modules/.bin` |
| `dependencies` | runtime requirements | D3 modules, bundled into the webview |
| `devDependencies` | `[dev]` extras | TypeScript, esbuild, vitest, vsce, type declarations |
| TypeScript¹ `tsc` | `mypy` | `npm run typecheck`: types only, emits nothing |
| esbuild² | a build backend producing one file | `npm run build`: strips types and bundles to `dist/` |
| vitest³ | `pytest` | `npm test`: runs `test/**/*.test.ts` |
| vsce⁴ | `python -m build` + `twine` | `vsce package` makes the `.vsix`; `vsce publish` uploads it |

esbuild does not check types; `tsc --noEmit` does [cited: esbuild documentation, "TypeScript caveats", https://esbuild.github.io/content-types/#typescript-caveats]. The `package` script runs both.

## 2. Making a change and releasing a version

### 2.1 Scripts

| Command | Effect |
|---|---|
| `npm install` | install packages after cloning or after `package.json` dependency changes |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | vitest over `test/**/*.test.ts` ([vitest.config.mjs](../vitest.config.mjs)) |
| `npm run build` | esbuild: `dist/extension.js` (host) and `dist/webview.js` (webview), [esbuild.mjs](../esbuild.mjs) |
| `npm run watch` | build again on every save |
| `npm run package` | typecheck, test, build, then `vsce package` → `gaffy-<version>.vsix` |
| `npm run install:local` | `code --install-extension gaffy-<version>.vsix`, the version from `package.json` (`$npm_package_version`) |
| `npm run preview` | build, then `dist/preview.html`: the webview in a browser with fixture graphs |
| `npm run heuristics` | writes `docs/heuristics.md`, `docs/heuristics.gaffy` and `docs/ordering.md` from `scripts/heuristics.ts` and `scripts/ordering.ts`; run after layout or menu changes, the line links follow the code |
| `npm run docs:check` | `npm run heuristics`, then `git diff --exit-code -- docs`: fails when the committed docs lag the code |

### 2.2 Steps

1. Edit `src/…`.
2. Run `npm test`. A golden test compares a rendered graph with `test/golden/<name>.txt`. When a change alters a layout on purpose, regenerate the goldens with `UPDATE_GOLDEN=1 npx vitest run` and read the difference with `git diff test/golden` before committing.
3. Set the version. Either edit `"version"` in `package.json`, or run `npm version patch --no-git-tag-version` (`minor`, `major` likewise), which edits `package.json` and `package-lock.json` together. Without `--no-git-tag-version`, `npm version` also commits and tags in git [cited: npm documentation, `npm version`, https://docs.npmjs.com/cli/commands/npm-version].
4. Run `npm run package`. Output: `gaffy-<version>.vsix` in the project folder.
5. Install: `npm run install:local` (or `code --install-extension gaffy-<version>.vsix --force`, or Extensions view > `…` > Install from VSIX). Then Command Palette > Developer: Reload Window.

Development without packaging: open `gaffy/` in VS Code, press F5. [.vscode/launch.json](../.vscode/launch.json) builds and starts an Extension Development Host⁵, a second VS Code window running the extension from `dist/`; with `npm run watch` running, Developer: Reload Window in that window loads the latest build.

### 2.3 Why `npm run package` produced no `.vsix` for 0.7.1

`package` chains its steps with `&&`: a failing step stops the chain [established: POSIX shell `&&` list semantics]. The default tree parent changed to `joint` in `DEFAULT_STYLE`, the test styles inherited that default, 13 goldens drawn with `dfs` no longer matched, and `vsce package` never ran [observed]. The test styles now pin `parentRule: 'dfs'` ([test/core.test.ts](../test/core.test.ts), `flat`, `boxed`), so a changed default no longer changes the goldens. vitest also collected two scratch tests from `.preview/`; [vitest.config.mjs](../vitest.config.mjs) now limits it to `test/`.

## 3. Renaming the extension

### 3.1 Identity fields

| Field | Rule | Effect of a change |
|---|---|---|
| `package.json` `name` | lowercase, no spaces [cited: extension manifest reference, https://code.visualstudio.com/api/references/extension-manifest] | the extension identifier is `<publisher>.<name>` (now `xvdp.gaffy`); a new name installs as a different extension beside the old one |
| `package.json` `displayName` | free text, spaces allowed | the name shown in the Extensions view and the Marketplace |
| `package.json` `publisher` | the Marketplace publisher id | part of the identifier |
| git repository name | none | independent of every field above |

So: the extension can be renamed without renaming the git repository, and a display name with spaces needs only `displayName` (`"displayName": "Gaffy Call Graphs"`); `name`, command ids, settings and the `.gaffy` file extension stay as they are [cited: extension manifest reference].

### 3.2 Internal identifiers named `gaffy`

These are names inside the code, independent of `displayName`. A full rename changes all of them; `grep -rn gaffy src package.json schemas media` lists them.

| Identifier | Where | Note |
|---|---|---|
| command ids `gaffy.*` | `package.json` `contributes.commands`, `menus`, [src/host/commands.ts](../src/host/commands.ts) | keybindings users made refer to them |
| settings `gaffy.*` | `package.json` `contributes.configuration`, `getConfiguration('gaffy')` calls | users' settings keep the old keys |
| custom editor `gaffy.view` | `package.json` `customEditors`, `webviewId == 'gaffy.view'` in `when` clauses, [src/host/editor.ts](../src/host/editor.ts) | |
| view file extension `*.gaffy` | `customEditors` `selector`, [src/host/commands.ts](../src/host/commands.ts) | existing view files need renaming, or a reader for both extensions |
| folder `.gaffy/` | [src/host/style.ts](../src/host/style.ts) `gaffyDir` | holds views, cache, style.json, exports |
| `.vsix` file name | from `name` and `version` | |

The view file extension and the folder are tokens of their own: a `displayName` with spaces leaves them as they are; changing them is a separate choice (for example `*.callgraph`).

## 4. Publishing

### 4.1 VS Code Marketplace

[cited: "Publishing Extensions", https://code.visualstudio.com/api/working-with-extensions/publishing-extension]

1. Create a publisher at https://marketplace.visualstudio.com/manage; its id goes into `package.json` `publisher` (now `xvdp`).
2. Create an Azure DevOps⁶ Personal Access Token⁷ with scope Marketplace > Manage and organization "All accessible organizations".
3. `npx vsce login <publisher>` and paste the token.
4. `npx vsce publish` (or `npx vsce publish patch` to bump and publish).

State [observed: `package.json`, files]: `license` Apache-2.0 with `LICENSE` (the Apache text, unchanged) and `NOTICE` (name, copyright, repository; redistributions carry it); `repository` https://github.com/xvdp/gaffy, so vsce rewrites relative README links and images to it. Missing: an `icon` (section 5). Images in `README.md` must use `https` URLs or relative paths vsce rewrites, and SVG images are restricted [cited: same page, "Image restrictions"].

Marketplace page from another file: `vsce package --no-dependencies --readme-path README.marketplace.md` (and the same flag for `vsce publish`); as a script beside `package` in `package.json`: `"package:marketplace": "npm run typecheck && npm test && npm run build && vsce package --no-dependencies --readme-path README.marketplace.md"`. GitHub keeps showing `README.md`.

Versions: the Marketplace accepts only versions higher than the last published one; `major.minor.patch` without pre-release suffixes. A major version 0 signals a format and interface that may still change (semantic versioning [cited: https://semver.org, item 4]); 1.0.0 fits once the `.gaffy` view format and the settings are kept compatible from then on (`parseDoc` migrations read older views). Pre-releases: `vsce publish --pre-release`; VS Code recommends `major.EVEN.patch` for releases and `major.ODD.patch` for pre-releases, since the Marketplace compares numbers only [cited: publishing page, "Pre-release extensions"].

### 4.2 Open VSX

VSCodium, Cursor and other VS Code builds read the Open VSX registry, not the Marketplace [cited: https://open-vsx.org]. Steps: an account and access token at open-vsx.org, `npx ovsx create-namespace <publisher> -p <token>`, then `npx ovsx publish gaffy-<version>.vsix -p <token>`.

## 5. Icon

`package.json` `"icon": "media/icon.png"`: a PNG of at least 128 × 128 pixels (256 × 256 for high-density screens); the extension icon may not be SVG [cited: extension manifest reference, `icon`; publishing page, image restrictions]. The `.gaffy` view files can carry a file icon through `contributes.languages[].icon` with `light` and `dark` images, shown where the user's file icon theme defines none [cited: extension manifest reference, `contributes.languages`].

## 6. Parts of the project

```
package.json          manifest: identity, VS Code version range, entry point, activation, contributions; npm scripts
esbuild.mjs           two bundles: host (Node, CommonJS⁸, `vscode` left external) and webview (browser, IIFE⁹)
schemas/              JSON schema of .gaffy/style.json (completion and validation in the editor)
media/webview.css     webview styles, mapped to VS Code theme variables
src/core/             pure TypeScript, no VS Code API: runs in the host (export), the webview (render) and tests
  model.ts              graph types: nodes (definitions, containers), edges (calls)
  viewdoc.ts            the .gaffy document: view settings and the stored graph; parse, serialize
  quotient.ts           collapse and hide: the graph a view draws
  reveal.ts             visibility: open sides (one layer at a time), call depths (full)
  boxes.ts, labels.ts   namespace boxes, label text
  layout.ts             rows, tree parents, lanes inside one box
  place.ts              boxes and blocks in 2D, moves, locks
  settle.ts             moved units the picture grew into: nearest clear offset, least displacement first
  grid.ts               character grid, A* routing, glyphs (call kinds), text export
  bindings.ts           binding declarations parsed from source text (pybind11, nanobind, torch, slangpy, wasm-bindgen)
  scene.ts              pipeline: document → quotient → visibility → boxes → layout → placement → grid
  style.ts              style defaults and merge
  langs.ts, textcalls.ts  language rules; calls found in text for shader languages
src/host/             extension host: Node.js, VS Code API
  extension.ts          activate(): registers the editor and commands, watches saves and renames
  editor.ts             custom text editor: one Session per open view; webview messages; language-server queue
  commands.ts           command and menu handlers, view creation, export
  lsp.ts                call hierarchy through VS Code's language-server commands
  build.ts, cache.ts    answers folded into the view; persistent call cache
  bridges.ts            calls across languages from bindings.ts, joined to the language-server graph
  implicit.ts           implicit calls: construction, instance call
  servers.ts            which language servers the workspace needs, and whether they are installed
  scope.ts              URI scheme gate (`readable`)
  safefs.ts             no writes through symbolic links under `.gaffy/` (`noLinks`)
  seedspec.ts           seeds written by name in a view file (`<path>#<qualified name>`, `<path>:<line>`)
  trace.ts, tracerec.ts view change records (setting gaffy.trace)
  style.ts              style.json per workspace folder
src/webview/main.ts   webview: D3 rendering, interaction, toolbar and options
test/                 vitest tests, fixtures, golden text renders
scripts/preview.mjs   browser preview of the webview with fixtures and simulated steps (GAFFY_PREVIEW_FILE=<view> for any view file; steps=…, trace=1)
scripts/heuristics.ts the layout heuristics as a graph: writes docs/heuristics.md and docs/heuristics.gaffy (`npm run heuristics`)
scripts/ordering.ts   every function that changes what is shown or where: writes docs/ordering.md (`npm run heuristics`)
tools/gaffy-trace.mjs standalone, no dependencies, not packaged: prints a view trace (.gaffy/trace/<view>.jsonl, setting gaffy.trace)
test/data/            view files reduced from real cases, names made up (runaway.gaffy: box descent drift)
```

## 7. What a VS Code extension needs

[cited: "Extension Anatomy", https://code.visualstudio.com/api/get-started/extension-anatomy; extension manifest reference]

1. **Manifest** (`package.json`): `name`, `publisher`, `version`, `engines.vscode` (the API versions it needs, here `^1.90.0`), `main` (the JavaScript file VS Code loads), `activationEvents` (when to load it; here `workspaceContains:.gaffy`, plus every command it contributes), `contributes` (static declarations VS Code reads without running code: commands, menus, settings, custom editors, JSON schemas).
2. **Entry module** exporting `activate(context)` and optionally `deactivate()`; VS Code calls `activate` once, in the extension host process. Here: [src/host/extension.ts](../src/host/extension.ts).
3. **The `vscode` module**: the API object VS Code injects at run time; it is never bundled (`external: ['vscode']` in [esbuild.mjs](../esbuild.mjs)), and `@types/vscode` supplies its types for `tsc`.
4. **Package** (`.vsix`): a zip of the manifest, `dist/`, `media/`, `schemas/`, `README.md`, with an `extension.vsixmanifest`; [.vscodeignore](../.vscodeignore) lists what stays out.

Particular to VS Code, absent from a plain browser or Node.js program:

- the extension host⁵, a separate Node.js process that runs every extension, apart from the editor's UI;
- contribution points and `when` clauses¹⁰ that place commands in menus without running extension code;
- the API surface: commands, documents, editors, workspace file system, language features (here `vscode.prepareCallHierarchy` and related commands), custom editors;
- webviews¹¹: sandboxed iframes¹² that exchange messages with the host through `postMessage`; no direct access to the editor or the file system; a Content Security Policy¹³ restricts which scripts and styles load;
- theme variables (`--vscode-*` CSS custom properties) inside webviews.

## 8. VS Code, browser, mobile

TypeScript compiles to JavaScript, and JavaScript runs in two kinds of runtime: Node.js¹⁴ (files, processes, network, no DOM¹⁵) and browsers (DOM, no files or processes) [established]. npm installs packages for either; a package that uses only standard JavaScript runs in both, one that uses Node.js modules (`node:fs`, `node:child_process`) runs only in Node.js.

| Target | Runtime | gaffy |
|---|---|---|
| VS Code desktop extension | extension host on Node.js; webviews in Chromium | this project |
| VS Code remote (SSH, WSL, containers) | the extension host runs on the remote machine [cited: "Supporting Remote Development", https://code.visualstudio.com/api/advanced-topics/remote-extensions] | works: the host code calls only the VS Code API and `git` on that machine |
| VS Code for the web (vscode.dev) | web extensions run in a browser web worker, declared by a `browser` entry, no Node.js modules [cited: "Web Extensions", https://code.visualstudio.com/api/extension-guides/web-extensions] | not supported: [src/host/commands.ts](../src/host/commands.ts) runs `git` through `node:child_process`, and `node:path` needs a browser replacement |
| browser page | DOM | the webview bundle `dist/webview.js` runs in any browser; `npm run preview` shows it in Firefox with fixture data |
| mobile | mobile browsers, or app frameworks (React Native, Capacitor) that host JavaScript | VS Code has no mobile app; the webview bundle would run in a mobile browser page, the extension would not |

Separation already in place: `src/core/` uses no runtime-specific API, so the layout and routing run in Node.js (tests, export) and in the browser (webview) unchanged [observed]. A port to another host (a web page, a JupyterLab extension, a standalone app) would reuse `src/core/` and `src/webview/`, replacing the host side: data source (language server), file storage, and the message channel.

## 9. D3 in gaffy

D3¹⁶ is a set of independent modules. gaffy uses four, bundled into `dist/webview.js` [observed: `package.json` `dependencies`]:

| Module | Version | Use |
|---|---|---|
| `d3-selection` | 3.0.1 | data joins: one SVG element per frame, call, hit path, label, marker, box header; the HTML toolbar and options panel |
| `d3-zoom` | 3.0.1 | pan and zoom of the SVG root; the transform is stored in the webview state and shifted to keep the anchored function in place |
| `d3-drag` | 3.0.1 | dragging functions and boxes, snapped to whole grid cells |
| `d3-shape` | 3.2.0 | curve generation for the spline style |

D3 lays out nothing here. Placement and routing are gaffy's own (`src/core/`): the grid assigns every label, line and arrowhead a character cell, and the webview draws those cells either as glyphs or as vector paths. Built on top of D3 for interaction ([src/webview/main.ts](../src/webview/main.ts)):

- hit paths: wide transparent strokes over each call; a click resolves the grid cell under the pointer to every call through it (forks and merges select together);
- arrowhead regions (one layer at a time): the arrowhead cell and the blank before the name close a level, separate from the line, which only selects;
- markers `>>` and `└─>>` with their own click handlers;
- selection state and an overlay layer for highlights;
- anchoring: after each layout the zoom transform shifts by the anchored name's move;
- drop repulsion: candidate drops are laid out in memory and checked for collisions before one is committed;
- context menus through `data-vscode-context` attributes, which VS Code reads to fill its own menus;
- the message protocol with the host: `state`, `edit`, `expand`, `refresh`, `progress`, `note`.

## 10. Security

Threat model: a workspace or a `.gaffy` file comes from someone else (a cloned repository, a download). Its files are data to gaffy; none of them may run code, read files outside the workspace through gaffy, or reach the network.

| Surface | Measure |
|---|---|
| Webview | Content Security Policy: `default-src 'none'`; scripts only with a per-page nonce from `crypto.randomBytes`; styles from the extension and inline; images and fonts from the extension only. Labels, tooltips and toolbar text are set as text, never as HTML. `localResourceRoots`: `dist/`, `media/`. |
| Text shown from outside data | Labels, box headers, tooltips, the quick pick of hidden neighbors and the text and HTML exports show C0/C1 controls, zero-width characters and bidirectional controls¹⁷ as `\u{…}` (`visible` in `src/core/model.ts`): a name cannot display as another name (Trojan Source, CVE-2021-42574 [boucher2023trojan], keys in [refs.bib](../refs.bib)). Notification and progress messages pass through `plain`, which also splits every `](`: VS Code renders `[label](https:…|command:…|file:…)` in a notification as a link and runs a `command:` link on click [api: microsoft/vscode main, `src/vs/base/common/linkedText.ts` `parseLinkedText`; `src/vs/workbench/browser/parts/notifications/notificationsViewer.ts`, `openerService.open(URI.parse(link), { allowCommands: true })`; read 2026-11-19], so a name, path or error message cannot carry one. |
| Messages from the webview | The host acts on a fixed set of message types; `setting` writes only `includeExternal`, `includeStandardLibrary` and `saveViews` (booleans); `expand` takes `in` or `out` and a key the view holds as its own property; `openAt` takes a non-negative integer line; `save` runs a fixed command; the trace fields `cause` and `moved` are reduced to strings of at most 200 characters, integer cells and at most 2000 entries (`checkedCause` in `src/host/tracerec.ts`). |
| Node records in `.gaffy` files and the call cache | Opened only for the scheme `file` or a workspace folder's scheme (`readable` in `src/host/scope.ts`); shown with `showTextDocument` (read only), never executed. Node keys `__proto__`, `constructor`, `prototype` are dropped on load; the cache looks up the modification times of its files for those schemes only. |
| Language-server answers | Call hierarchy items, incoming and outgoing calls, definitions, references, document and workspace symbols: a location of another scheme is dropped where the answer arrives, before any document is opened, hashed or asked about (`readable`); gaffy sends no request for a URI of another scheme. At most 5000 calls per answer (`MAX_CALLS`; a longer answer is cut, cached with its full length, and reported once per view in a warning), 30 s per request (`REQUEST_MS`) in `src/host/lsp.ts`. A file outside every workspace folder is keyed from its library root (`externalPath` in `src/core/langs.ts`: `site-packages/torch/functional.py`), so its folder chain is finite. Answer data reaches no command id, setting, process argument, file path outside `.gaffy/`, HTML markup, or the network; every `executeCommand` id is a constant. |
| `style.json` | Merged without the keys `__proto__`, `constructor`, `prototype` (prototype pollution); colors become CSS custom properties, which cannot load external resources under the policy above. |
| git | `git rev-parse --short HEAD` (view file names) runs only in a trusted workspace and only in a workspace folder: a `.git/config` from a downloaded folder can make git run programs. `package.json` declares `untrustedWorkspaces: limited`. |
| Source text (bindings, shader languages) | Read, never run: `setup.py` and build files are matched with regular expressions; a name from the text enters an expression only after it matches an identifier pattern (a `TORCH_LIBRARY` variable such as `.*.*.*` once took 16 s to scan); a class walk over base classes visits each class once, at most 64. Files over 2 MB are skipped; declaration headers over 600 characters are not parsed (bounded regular-expression work); a `.slang` path written in Python source resolves only inside a workspace folder. |
| Writes under `.gaffy/` | Call cache, trace, exports, new views and `style.json` never write through a symbolic link: every existing path segment below the workspace folder is checked with lstat first (`noLinks` in `src/host/safefs.ts`); a repository shipping `.gaffy/cache/calls.json` as a link to a shell startup file cannot make gaffy truncate or append to it. The trace writes only in a trusted workspace and rotates at 20 MB. |
| Settings from the workspace | `package.json` lists `gaffy.trace`, `gaffy.exclude` and `gaffy.style` as restricted configurations: in an untrusted workspace VS Code reads them from user settings only. Globs match in linear time (`globMatcher`, no regular expression to backtrack); style numbers are clamped to the ranges of `schemas/style.schema.json` (`boundedStyle`). |
| View files | `parseDoc` keeps strings in lists, drops special keys and values of the wrong type in keyed records, bounds offsets to ±1000 and locks to [0, 2000] cells; routing searches grids up to 10⁶ cells and draws larger ones with fallback lines, so a crafted file cannot allocate gigabytes. |
| Export | Writes only under `.gaffy/`; file names keep `[A-Za-z0-9_.-]`; HTML text and attributes are escaped (`&`, `<`, `>`, `"`, `'`); links are paths relative to `.gaffy/` and start with `./` or `../`, so no first segment reads as a scheme. |
| Dependencies | Shipped: the D3 modules in `dist/webview.js` (`npm audit --omit=dev`: 0 vulnerabilities). Development only (vitest, vsce): findings in `npm audit` that do not reach the package. |

Trace reader: `tools/gaffy-trace.mjs` prints control, zero-width and bidirectional characters from trace data as `\u{…}` (text) or `\uXXXX` (`--json`), so names cannot send terminal escape sequences.

Not covered: a malicious language-server extension itself. It runs in the extension host with the editor's rights, with or without gaffy; VS Code's defences against it (Marketplace scanning, publisher trust, block list) act on the extension, not on its answers. gaffy treats its answers as data under the measures above, so they gain no capability through gaffy that the extension lacks without it, and gaffy displays no name in a form that hides what it is.

## Footnotes

1. TypeScript: JavaScript with static types; `tsc` checks types and can emit JavaScript.
2. esbuild: a JavaScript bundler: resolves imports into one output file and removes TypeScript types.
3. vitest: a test runner for JavaScript and TypeScript.
4. vsce: Visual Studio Code Extensions, the command-line tool that packages and publishes extensions (npm package `@vscode/vsce`).
5. Extension host: the Node.js process in which VS Code runs extensions; the Extension Development Host is a VS Code window that loads an extension from a source folder.
6. Azure DevOps: Microsoft's service that issues the tokens the Marketplace accepts.
7. Personal Access Token (PAT): a revocable password substitute with a limited scope.
8. CommonJS (CJS): Node.js's module format (`require`, `module.exports`).
9. IIFE: immediately invoked function expression; a bundle format that runs as one `<script>` without a module loader.
10. `when` clause: a boolean expression over context keys (editor language, focused view, webview section) that decides whether a menu entry or command shows.
11. Webview: an HTML page inside VS Code, run by the editor's Chromium in its own sandbox.
12. iframe: an HTML element embedding a separate document with its own scripts and origin.
13. Content Security Policy (CSP): a header or meta tag listing the sources a page may load scripts, styles and images from.
14. Node.js: a JavaScript runtime outside the browser, built on V8, with file, process and network modules.
15. DOM: Document Object Model, the browser's tree of page elements that scripts read and change.
16. D3: Data-Driven Documents, a JavaScript library that binds data to document elements.
17. Bidirectional (bidi) controls: Unicode format characters that change the display order of text without changing its stored order: embeddings and overrides U+202A–U+202E, isolates U+2066–U+2069, marks U+200E, U+200F, U+061C.
