# gaffy layout rules: plan

Scope: [.TODO.md](../.TODO.md) items 1 to 8, the layout rule architecture (P1 to P8), the edge rules (E1 to E6) and the frame overlap rule (F1). Rule ids refer to [heuristics.md](heuristics.md). Citation keys refer to [refs.bib](../refs.bib). Checked items are implemented and tested.

## Decisions (xvdp, 2026-11-25)

| id | decision |
|---|---|
| R1 | implement the whole plan; speed work (P7) last |
| R2 | rule switches and parameters, spacing and route costs included: Rules panel only, `view.rules`, saved with the graph; style.json and `gaffy.style` hold appearance only (font, colors, labels, frame and edge drawing, tension), keys that Options or the Rules panel set are ignored and named in a warning |
| R3 | rule and code links: local clone when the extension runs from one, GitHub otherwise; `docs/**` stays out of the package |
| R4 | one save setting, `gaffy.autoSave`: writes a new view to `.baggy/gaffy/` at once and saves after every change; `gaffy.saveViews` removed; `view.save` stays (script views save whatever the setting) |
| R5 | references added to refs.bib |
| R6 | frames of sibling groups may overlap in empty space; labels never overlap and never lie inside a foreign frame (F1) |
| R7 | h25 default `row`; h39 `rounds` 0, h40 `weight` 0, h20 `right` 0 |

Package size for R3 [measured: `gzip -9`, 2026-11-25]: `docs/heuristics.md` 23 263 bytes, 6 161 compressed; `gaffy-0.9.33.vsix` 139 290 bytes. The generated doc links to `src/`, which the package does not hold, so code links need the clone or GitHub in either case.

## Findings

- Positions are decided in four layers (place, settle, drop repulsion, afterRender commits) that feed back through `view.offset`; counters bound the loop (3 rounds, 3 saves), no convergence property does [derived: place.ts avoid list, scene.ts settle loop, main.ts afterRender].
- Routing is greedy and sequential (h25: level calls, then longest first), without feedback to placement and without rerouting.
- Example: `.baggy/gaffy/bindings_20261125-0750.gaffy` (26 functions, 55 calls). `describe → matchWasm` pays no crossing when routed (cost 117.0 = 99 steps + 2 bends × 3 + 3 borders × 4); 7 calls routed after it cross it twice each: 14 crossings. East-then-south and south-then-east tie in cost [measured, derived]. Routing the two `describe` calls last: 14 → 1, 16 → 2 crossings; crossing cells 53 → 35 [measured].
- The A* estimate is inadmissible¹: steps on a call's own net cost 0.3, the Manhattan estimate assumes ≥ 1. Scaling it by 0.3: crossing cells 53 → 29, routing 96 → 251 ms [measured].
- Debug coverage before this plan: 7 of 37 rules switchable, 10 logged, switches held in webview state only (nothing saved while a rule was off).
- Routing takes 146 of 154 ms per redraw on a 41-function, 71-call view [measured].

## Definitions

- **Superfluous crossing**: a crossing of calls e and f where a route of e that avoids f, with every other route fixed, costs at most (1 + α) times the current route of e; α = `route.detour`.
- **Received crossing**: a crossing on a call's route made by a call routed after it.
- **Explosion**: a redraw after one operation where the picture height or width exceeds g times the unmoved extent plus the moved extent, or a unit jumps ≥ 12 rows (plan D50 metric).
- **Fixed point** of settle: `buildScene` on the settled offsets returns no further move.

## Checklist

### TODO items outside layout

- [x] T7. `gaffy.openCallHierarchy` default false.
- [x] T8. One save setting `gaffy.autoSave` (R4): new views written at once when on, untitled when off; saved after every change when on; `view.save` saves regardless. Canvas menu, Options, and VS Code Settings run one command; displayed value from the resource-scoped effective setting; writes to the workspace.
- [x] T2. "MISSING provider" (VS Code References view, `_assertProvider`): call hierarchy view opened only after `vscode.prepareCallHierarchy` answers; an empty answer warns with language, extension id, installed and active state, and Install, Restart, Report actions. Command `gaffy: List Language Providers` (live probe per workspace language) and `scripts/providers.mjs` (installed extensions against the language table, outside VS Code).
- [x] T1. An answer given without a binding link whose target lookup failed past `MISSES` (`Bridges.partial`) is applied with the pair's stored cross-language calls kept, never cached, and retried with the unresolved pairs; cache format 8 drops the v7 answers cached without links. Test: build.test.ts.
- [x] T6. Add Symbol to View and Make Seed: the new seed shows itself with its markers and the call paths to the other seeds, without siblings of those paths.

### P1 to P3: rule registry, rule context, saved rule state

- [x] P1. `src/core/rules.ts`: one entry per rule (id, stage, title, text, switchable, alternatives, parameters with default, range, unit). `explain.ts` SWITCHES, TITLES, FLAGS and the texts of `scripts/rules.ts` merged into it; `scripts/rules.ts` keeps code anchors only.
- [x] P1b. `npm run heuristics` writes `src/core/rules.lines.ts` (code sites per rule), the switch, alternative and parameter list of each rule into heuristics.md, and `rules` in `schemas/style.schema.json`; `npm run docs:check` compares all three with the commit.
- [x] P2. Rule context `Rules` (switches, alternatives, parameters, log) passed through `buildScene` to reveal, layout, place, settle and route; every rule reads its switch and parameters from it; constants named in a rule's text become parameters.
- [x] P3. `view.rules` (`off`, `alt`, `params`), parsed with types checked and parameters clamped to their ranges; saved with the graph and applied on open; commits continue while rules are off. style.json restricted to appearance (`USER_STYLE`, core/style.ts); the schema lists those keys only; Edit style.json writes them only.

### P4 to P5: logs and rule panel

- [x] P4. Layout debug panel (src/webview/dbgpanel.ts), tab Rules (Options > Arrange > Rules…): every rule by stage with switch, alternative, parameters (view value, else style.json, else default; ↺ drops the view's value), links to its explanation and code sites; host `openRule` (src/host/sources.ts) opens the gaffy sources when the extension runs from them or a workspace folder holds them, else GitHub at the build commit.
- [x] P4b. Tab Actions: one entry per change (commits, undo, redo, host updates): cause, each moved group and function with old and new cell, functions carried by their group counted under it, the decisions of the rules that placed each, with links; replaces the decision log editor.
- [x] P5. Tab Edges: per call (grid.ts `RouteRecord`), routing order, kind, pass, arrival side and reason, cost parts, crossings paid and received with the crossing calls (braids marked), reroute round; filter on crossed calls; a click selects the call.

### P6 and F1: placement parameters

- [x] P6a. Settle parameters: search radius, line range, label margin, rounds.
- [x] P6b. h20: cheapest of "down d rows" and "right c columns past the overlapped item", weights `h20_unmoved_box_descent.down` (1), `.right` (0: never right). h15 and h21 descend only (h21 margin parameter). knn view, right = 1: picture 250 × 67 → 273 × 54 cells, crossing cells 31 → 31, bends 211 → 205; bindings and runaway views unchanged [measured: `npm run metrics`].
- [x] F1. h38_frame_overlap (on): sibling frames may overlap where no label, header or arrival cell of one lies within `margin` (1) of the other; h20 and settle test labels against frames; switched off, frames nest or stay apart. Test: an overlapping moved group stays with h38 on, settles apart with it off. knn, bindings, runaway views: no change [measured: `npm run explain -- <view> --off h38_frame_overlap`].

### E1 to E6: edge rules

- [x] E1. Routing order alternatives `rules.alt.h25_routing_order`: `longest` (default), `shortest`, `row` (caller row, caller column, callee row: a caller's fan-out top to bottom).
- [x] E2. Bundling parameter `h29_route_cost.bundle` (0.3): cost per step on a line of the same callee, or of the same caller alone.
- [x] E3. Braid: a call crossed twice by one later call; the earlier call of a braid joins the h39 candidates.
- [x] E4. h39_reroute [nair1987, mcmurchie1995pathfinder]: candidates (received crossings ≥ `min`, braids) grouped by caller; per attempt one caller's candidates route after the others, most crossed first; kept when the total route cost (cells, bends × bend, crossing cells × cross) drops; `tries` callers per round, `rounds` rounds (default 0: off).
- [x] E5. Placement aware of calls: h20 candidates weigh the calls whose span (caller to callee box) the candidate frame covers, `h20_unmoved_box_descent.cross` (0: off) [kieffer2016].
- [x] E6. h40_lookahead [lou2002congestion]: each cell costs `weight` per pending call whose bounding box holds it (default 0: off).
- [x] E7. `h29_route_cost.estimate` (1): scale of the A* distance estimate; ≤ `bundle` makes it admissible.

### Measurements: edge rules

Crossing cells and redraw time per configuration [measured: `npm run metrics -- <view> '<rules JSON>'…` (scripts/metrics.ts), default style, 2026-11-25]:

| view (functions / calls) | default (`longest`) | h39 rounds 3 | h40 weight 0.5 | h25 `row` | `row` + h39 rounds 3 |
|---|---|---|---|---|---|
| bindings (26 / 55) | 53, 95 ms | 37, 745 ms | 42, 282 ms | 23, 20 ms | 18, 573 ms |
| knn (41 / 71) | 31, 189 ms | 20, 1068 ms | 18, 548 ms | 9, 80 ms | 9, 526 ms |
| runaway (17 / 17) | 2 | 2 | 2 | 2 | 2 |
| heuristics (59 / 60) | 0 | 0 | 0 | 0 | 0 |

Bends, bindings: 153 default, 143 h39, 200 h40, 144 `row`. Bends, knn: 211, 175, 220, 174. h25 `row` lowers crossings and time on both larger views; defaults stay as before until a decision (R7).

### P8: tests

- [x] T-a. test/matrix.test.ts: fixtures (kazoo, moo, star) × boxes (off, packages, modules) × tight × parent rule (dfs, nearest, joint) × pairwise covering array of the 16 switchable rules (10 rows) × no moves, or a moved group and a lock where drawn; bounds and determinism always, `invariants()` when no guard rule (h15, h20, h21, h23, h38) is off. `npm test`: a subset (60+ runs); `npm run test:matrix`: all (1080 runs).
- [x] T-b. Bounds: picture within 3 × the unmoved picture plus the moves; settle fixed point (settled offsets settle no further); determinism (two builds draw the same text).
- [x] T-c. Group and ungroup each container, then reset grouping: no move or lock keyed to a group missing from the picture; bounds; invariants.
- [x] T-d. Seeded sequences of 25 operations (open, close, drag, drag group, lock, unlock, group, ungroup, collapse, expand, hide) on runaway.gaffy, settled offsets saved as the webview does: every call routed, growth per operation bounded, invariants at the end. Seed 2 open (see below), marked `it.fails`.
- [x] T-e. test/edges.test.ts on `test/data/bindings.gaffy` (the bindings view without local paths): bounds on crossing cells, edge log consistency, h25 `row`, h39, h40, admissible estimate, h24 off.

### Release 0.9.34

`npm version patch --no-git-tag-version` (package.json, package-lock.json), then `npm run package`: typecheck, 164 tests, build, `gaffy-0.9.34.vsix` (11 files, 159.7 KB; 0.9.33: 139.3 KB).

### Default routing order `row`

Crossing cells, `longest` → `row`, with namespace boxes and without [measured: test probe, `buildScene`, default style, 2026-11-25]: kazoo 5 → 5, 5 → 5; moo 14 → 16, 0 → 0; moo callers 0 → 0; star 0 → 0; runaway 2 → 2, 3 → 3; bindings 53 → 23, 19 → 19; heuristics 0 → 0; knn 12 → 5, 18 → 9; knn-2 31 → 9, 15 → 15. With one h39 round on `row`: moo (boxes) 14, bindings 18, at up to twice the routing time on views with crossings. Goldens updated: joint_many, kazoo_module_boxes, kazoo_noodles_locked, moo_boxes (routes only).

### Defects found by the tests (fixed)

| defect | cause | fix |
|---|---|---|
| a group holding a locked function slid 1600 rows (matrix, kazoo, modules, tight) | h20 descends a group whose frame a lock pins (locks are absolute): no progress, 200 retries | h20 stops when a move gains nothing, flagged `a locked unit inside pins the frame` |
| a locked function inside a group moved by an offset drifted by that offset | h19 translated the group's content, locked units included | `translate` leaves locked units and their content in place for a group move |
| a locked unit drifted by the normalization shift (content above row 0 or left of column 0) | locks applied before the picture's normalization | `place` runs again with the locks offset by the shift (≤ 3 runs) |
| moves keyed to a group whose key a grouping change replaced (chain compression) | `dropMovesWithin` dropped moves inside the container only | also the moves and locks of the groups around it |
| 7 calls dashed after a drag next to the outermost frame | h26 chose a left arrival with no cell to approach it (frame border at column 0) | a left arrival needs an approach cell |
| unmoved rows of a block ran into a locked function's label; its marker row lost its route | h14 ignored locks | h14 rows skip the cells of a locked function of the block |
| Hide Selection on a collapsed container holding a seed emptied the view | hide kept seeds by key only | hide keeps every vertex standing for a seed |
| the path between two seeds vanished after closing and reopening (knn view, found by xvdp): `distCUDA2 → knn` erased, path functions uncolored, `>>` gone | the C/C++ server lists `distCUDA2` among the callers of `knn` and answers no calls for `distCUDA2`; an answer replaced every call of its (definition, direction) pair, so the empty calls answer erased the call the callers answer had reported; pinned path functions (joined seeds) are asked on both sides, which first asked `distCUDA2`'s calls | `GEdge.seen` records the answers that reported a call (`in`, `out`, `both`); an answer drops a call of its pair only when no answer of the other pair reported it (build.ts); replay of the saved view with its cache restores the call and the colored path in either answer order [measured: replay test, 2026-11-25] |

### Open

- O1. Seed 2 of T-d: a function moved inside a group moved by an offset lands on a locked label of that group; three settle saves do not clear it.
- O2. Locked functions are avoided by the rows of their own block (h14) and by later sibling groups; earlier sibling groups and other blocks do not avoid them.
- O4. Delete (test/joins.test.ts): removed functions, groups and cut calls leave the view with the functions only they revealed; the remaining ends keep markers; a marker click restores one side's hidden neighbors (one layer per click), joined-seed paths included.
- O5. knn view after the fix (202 × 61 cells) [measured: `npm run metrics`]: crossing cells 12 default, 5 with h25 `row`, 0 with h39 rounds 3 (117 ms), 2 with h40 weight 0.5; on the bindings view `row` gives the fewest. Default choice open (R7).
- O3. Matrix subset time: 13.5 s, dominated by switch rows with h24 off (every call routed by search, ≈ 400 ms per build); S1 applies.

### Docs

- [x] D-a. `npm run heuristics`: heuristics.md, ordering.md, heuristics.gaffy with the new rules and parameters.
- [x] D-b. development.md: scripts, settings, rule panel, logs.

### P7: speed (last)

- [x] S1. Router: nets per cell (`occN`) and static obstacles (`obs`: labels, padding, marks, borders, reservations) as typed arrays; Maps read only for cells holding lines; heap swap without temporary arrays; per-expansion lookups hoisted. Routes unchanged (same `gridCost` on every view).
- [x] S2. Webview: a redraw without a change of document text, style, filters or debugging reuses the scene (selection, hover, toolbar). Route reuse across document changes: not done.
- [x] S3. h33 drop repulsion bounded by parameters `cells` (4, was 12) and `ms` (400, was 1500).
- [x] S4. HEAD (fff735a) against the working tree, alternating, 3 × 10 builds each, default rules [measured: `buildScene` 10 times per view after one, HEAD sources from `git archive` against the working tree, alternating]: bindings 70.1 to 70.6 → 46.4 to 48.5 ms; runaway 10.5 to 11.2 → 7.4 to 7.5 ms; knn 95.7 to 106.3 → 98.9 to 99.7 ms (run-to-run variance on this machine up to 2×: inconclusive). With the rules of this plan on the working tree: h39 rounds 3, 149 to 338 ms on bindings; h24 off, 65 to 113 ms. `npm test` 12.7 s (1.9 s before; the rule matrix subset takes most); `npm run test:matrix` 191 s before S1.

¹ Admissible estimate: a lower bound of the remaining cost; A* with an admissible estimate returns a cheapest path [hart1968astar].
