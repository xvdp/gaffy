# gaffy terms

Terms used in rules. . Pictures: [examples.md](examples.md); rules: [heuristics.md](heuristics.md).

## Terms

These exist to clarify possible byzantine language of heuristics.
| term | meaning | 
|---|---|
| function | any of function, method, class, symbol which may call or be called. |
| call | connection between caller and called |
| seed | initial function queried or added later.  |
| group | namespace, package, folder, module or class + content |
| frame | group border |
| block | functions in a group and not in subgroups|
| parent | caller | 
| stem | call line root | 
| branch | each arrow attached to a stem `├─>` or `└─>` |
| trunk | call line that collects several calls |
| exit row | row under last branch |
| path search | cheapest grid path on the character grid considering steps, bends, crossings and frame border.|
| search order | call search order.
| marker | `>>`, `└─>>` |
| move | drag displacement  | 
| lock | lock on a function |
| unit |  group + content, or parent and calle functions. |
| settle | move offset values after dragging.
| opener | function that opens a marker.|
| anchor | function that keeps its spot on screen while picture changes |

## Call line draw logic
```
call caller => called
├── same block, called hangs under caller ............ branch on caller's stem (rows, no search)
├── same block, several calls into one called ........ trunk, column ro the right of labels (rows, no search)

└── anything else (other group, moved unit, blocked) .. path search; line joins called trunk
```

"Tree lines" are stems and branches: the lines from a parent to the functions hanging under it. "Lanes" are trunks laid out with the rows of a block. "Routed" calls are the ones whose line comes from path search. "Routing" is the path search of all such calls, one at a time in search order.

## Rule order

Every redraw runs stages in the same order:

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

Rules are not independent passes but steps in an algorithm:

| type of rule | rules | effect |
|---|---|---|
| order | h04, h06, h07, h08, h16, h25 | decide a sequence; no conflict, every later step depends on it |
| choice | h02, h09, h10, h12, h25 | one of several alternatives |
| position | h13, h14, h17, h18, h19, h22, h41 | compute rows, columns, frames |
| collision | h15, h20, h21, h23, h38 | move overlaps and shift later groups and call lines. **probably where the monsters live** |
| cost | h28, h29, h40 | weights inside path search; trade-offs, no conflict |
| look | h36, h37 | drawing only |
| view | h30, h31, h33, h34, h35 | screen position, drags, saves |
