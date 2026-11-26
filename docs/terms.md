# gaffy terms

One word per thing, in the UI, the docs, rule titles and rule texts. Rule ids (`h25_routing_order`) and code identifiers keep older names: saved views name rules in `view.rules`, and group units are `box:<key>`. Pictures: [examples.md](examples.md); rules: [heuristics.md](heuristics.md).

## Terms

| term | meaning | replaces |
|---|---|---|
| function | a definition drawn as a label (function, method, class) | vertex, node, symbol, definition |
| call | one call of a caller to a callee | edge, arrow |
| call line | the drawn line of one or more calls | net, line, edge |
| seed | a function a view starts from | |
| added seed | a seed added to an open view: closed, drawn with the call paths to the other seeds | joined seed |
| group | a namespace (package, folder, module, class) drawn with its content | box, namespace box, container |
| frame | the border of a group | box border |
| block | the functions directly in one group, outside its subgroups; laid out as one tree | block |
| parent | the caller a function hangs under | tree parent |
| stem | the vertical line under a parent's first character | tree stem |
| branch | the `├─>` or `└─>` from a stem to a function hanging under it | tree elbow, tree line |
| trunk | one vertical line that collects every call into one function and enters it, `<─┘` at its end or `└─>` from the left | lane, collector |
| exit row | the row under a function from which its calls leave, when calls also arrive at its end | port row |
| path search | finding the cells of a call line on the character grid: the cheapest way around labels and frames, by steps, bends, crossings and frame borders | routing, A* |
| search order | the order in which calls are searched; each searched call is an obstacle for the later ones | routing order |
| marker | `>>` before a label (callers not drawn), `└─>>` under it (calls not drawn) | marker, stub |
| move | the displacement a drag gives a function or group, kept relative to where the layout puts it | offset |
| lock | a fixed cell for a function or group | lock |
| unit | what one drag moves: a function with the functions hanging under it, or a group with its content | unit |
| settle | moving dragged units off other content after the picture changed | settle |
| opener | the function whose opened side showed another; it fixes the side the shown function may open | revealer |
| anchor | the function that keeps its spot on screen while the picture changes around it | anchor |

## How a call line is drawn

```
call caller => callee
├── same block, callee hangs under caller ............ branch on the caller's stem (rows, no search)
├── same block, several calls into one callee ........ trunk, a column right of the labels (rows, no search)
└── anything else (other group, moved unit, blocked) .. path search; the line joins the callee's trunk where it meets it
```

"Tree lines" are stems and branches: the lines from a parent to the functions hanging under it. "Lanes" are trunks laid out with the rows of a block. "Routed" calls are the ones whose line comes from path search. "Routing" is the path search of all such calls, one at a time in search order.

## Rule order

Every redraw runs the same stages in the same order:

```
redraw
├── 1 reveal (h01, h02) ............ which functions are drawn
├── 2 grouping (h03) ............... which groups are framed
├── 3 rows, per block (h04 to h12) . row order, parents, columns, exit rows, trunk columns
├── 4 placement (h13 to h22, h38, h41)  groups top-down: column and row of each group and block, moves, locks, frames
├── 5 settle (h23) ................. moved units off content; each round runs 4 again, at most 3 rounds
├── 6 call lines (h24 to h29, h36, h39, h40)  branches and trunks, then path search in search order; h39 runs 6 again
└── 7 view (h30 to h35, h37) ....... pan, drag, saves, hops
```

Inside a stage a rule acts at its step of one algorithm, not as a pass of its own. By effect:

| kind | rules | effect |
|---|---|---|
| order | h04, h06, h07, h08, h16, h25 | decide a sequence; no conflict, every later step depends on it |
| choice | h02, h09, h10, h12, h25 | one of several alternatives |
| position | h13, h14, h17, h18, h19, h22, h41 | compute rows, columns, frames |
| collision | h15, h20, h21, h23, h38 | move what overlaps; a moved group shifts every later group and every call line: the rules that change everything else |
| cost | h28, h29, h40 | weights inside path search; trade-offs, no conflict |
| look | h36, h37 | drawing only |
| view | h30, h31, h33, h34, h35 | screen position, drags, saves |
