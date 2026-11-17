# gaffy

VS Code extension: persistent, manipulable call graphs laid out on a character grid and rendered with D3. Each view is a `.gaffy` file under `<workspace>/.gaffy/views/` and opens as a tab. Call data comes from the language server's call hierarchy (LSP[^lsp]), so every language with a call-hierarchy server works: TypeScript and JavaScript (built into VS Code), Python (Pylance), C/C++, Rust, Go.

## Install

```bash
npm install
npm run package                              # typecheck, tests, bundles, gaffy-<version>.vsix
code --install-extension gaffy-0.1.0.vsix
```

Development: open `gaffy/` in VS Code and press F5 (Extension Development Host). `npm run watch` rebuilds on change.

## Create a view

| entry | command | seeds | traversal |
|---|---|---|---|
| editor context menu, cursor on a function | gaffy: Graph Callers | the function | incoming calls, `gaffy.depth` hops |
| | gaffy: Graph Callees | the function | outgoing calls |
| | gaffy: Graph Callers and Callees | the function | both |
| | gaffy: Add Symbol to Active View | appended to the open view | view direction |
| explorer context menu on a file | gaffy: Graph File | functions and methods of the file | outgoing, 1 hop |

The view file is written to `.gaffy/views/<name>.<callers|callees|calls>.gaffy` and opened.

## Layout

Rows list callers above callees (orientation `down`); each definition occupies one row.

```
scripts/mote_paths.traverse()
├─> scripts/mote_paths.speckle()
│   └─> analysis.speckle.treatments() ──────────────────┐
├─> scripts/mote_paths.streamed()                       │
│   └─> render.harmonics.project_streamed()             │
│       └─> render.harmonics.sh_eval()                  │
│           └─> render.mi_render.compile_aovs() ────────┤
└─> scripts/mote_paths.layers()                         │
    └─> render.mi_scene.load() <────────────────────────┘
```

- `├─>`, `└─>`: tree edge from the caller's stem.
- `──┐`, `──┤`, `<──┘`: lane; all calls into one definition share one lane and arrive with `<`.
- `└────┐` on the row under a definition: departure row, used when the definition both receives and sends lanes.
- `↻`: direct recursion; `↻ f()`: call back to `f` higher in the same chain.
- `[render.harmonics] (6)`: collapsed container with its member count.
- `⌉ │ ⌋ name`: run of consecutive rows in one module or file.
- `ADD`, `MOD`, `REMOVE`: change against the view baseline (first build, or the last "Accept Changes").

Algorithm, invariants and complexity: [src/core/layout.ts](src/core/layout.ts); plan: [plan.md](plan.md).

## Interaction

| input | action |
|---|---|
| click a definition | open it beside the graph (`gaffy.openBeside`) |
| double click | expand one level in the view direction; Shift: both directions |
| double click a collapsed container | expand it |
| click a bracket label | collapse that container |
| drag a definition vertically | reorder among its tree siblings |
| hover | highlight its stems and lanes, its callers and callees |
| right click | node menu: go to definition, editor context menu, peek references, call hierarchy, expand callers or callees, make or remove seed, hide, collapse class, file or package, move up or down, tag, reveal in explorer, copy path or qualified name |
| ↑ ↓ | move focus |
| Enter, e, c or ←, → | open; expand; collapse innermost container; expand collapsed |
| h, u | hide focused; unhide all |
| Alt+↑ ↓ | move focused definition among siblings |
| f, g, l | flip orientation; glyph or vector edges; full or relative labels |
| r, 0, x | rebuild; fit; export |

"Editor context menu…" opens the definition in an editor and shows VS Code's own editor context menu at its cursor, with every installed extension's entries. VS Code exposes no command that opens the explorer context menu for a given file; "Reveal in Explorer" selects the file there, where Shift+F10 opens it.

## Change tracking

- Saving a source file rebuilds open views that contain a definition from that file (`gaffy.refreshOnSave`: `touched`, `all`, `off`).
- Renaming a file rewrites keys, paths and URIs in open views, then rebuilds them.
- Definitions keep their identity across line moves: keys are `<lang>:<path>#<qualified name>`.
- A definition removed since the baseline remains as a REMOVE ghost until "Accept Changes".

## Files

```
.gaffy/
  views/<name>.gaffy     view: seeds, direction, depth, collapsed, hidden, order, tags, orientation,
                         last built graph, baseline hashes, ghosts (JSON)
  export/<name>.md       ASCII export, <pre> with links to path#Lline
  export/<name>.txt      ASCII export, plain
  style.json             style overrides (gaffy: Edit Style writes the defaults)
```

## Style

`.gaffy/style.json` overrides the `gaffy.style` setting, which overrides the defaults in [src/core/style.ts](src/core/style.ts). Schema: [schemas/style.schema.json](schemas/style.schema.json).

```json
{
  "font":      { "family": "'JetBrains Mono', monospace", "size": 13, "lineHeight": 1.25 },
  "grid":      { "indent": 4, "laneGap": 2, "parentRule": "dfs" },
  "edges":     { "mode": "glyph", "glyphs": "unicode", "arrow": true, "cross": "│", "width": 1 },
  "labels":    { "mode": "full", "strip": ["gutai."], "parens": true, "status": true },
  "container": { "kinds": ["module", "file"], "minRun": 2, "boxes": true },
  "colors":    { "ADD": "#3fb950", "MOD": "#d29922", "REMOVE": "#f85149" }
}
```

## Settings

| setting | default | effect |
|---|---|---|
| `gaffy.depth` | 4 | hop limit for new views |
| `gaffy.maxNodes` | 400 | definitions fetched per build |
| `gaffy.includeExternal` | false | include site-packages, node_modules, stubs |
| `gaffy.autoSave` | true | save the view file after each graph change |
| `gaffy.refreshOnSave` | touched | rebuild policy after a source save |
| `gaffy.openBeside` | true | open definitions beside the graph |

## Tests and preview

```bash
npm test                  # core: quotient, layout invariants, golden ASCII in test/golden/
UPDATE_GOLDEN=1 npm test  # rewrite goldens after an intended layout change
npm run preview           # dist/preview.html?doc=exp4|star[&edges=vector&orientation=up&labels=relative]
```

The preview loads the webview bundle in a browser with a mocked VS Code API and fixture views from giddy's experiment 4 and rrequest.md example (*).

[^lsp]: LSP, Language Server Protocol: JSON-RPC protocol between editors and language servers; call hierarchy requests `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls` since version 3.16.
