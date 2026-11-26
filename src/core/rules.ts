/** @xvdp
 * Layout rule registry: every rule that decides what is shown, where, and how calls run (docs/heuristics.md,
 * generated from this table and the code anchors of scripts/rules.ts). Per rule: stage, title, text; `without`: the
 * rule can be switched off, and what remains; `alternatives`: named variants, one chosen; `params`: numbers the rule
 * reads, with default and range; `control`: the Options entry that chooses it.
 *
 * Configuration layers, later wins: registry defaults, the view's `rules` (Rules panel, saved with the graph), a
 * debugging override (scripts/explain.ts `--off`). `off`: the last layer holding a list replaces the earlier ones;
 * `alt`, `params`: merged by key. Values from files are checked: unknown rules, choices and parameters dropped,
 * numbers clamped to their range (`parseRules`).
 */
import type { Decision } from './explain';

export type Stage = 'Reveal' | 'Grouping' | 'Rows' | 'Placement' | 'Settle' | 'Call lines' | 'View';
export const STAGES: Stage[] = ['Reveal', 'Grouping', 'Rows', 'Placement', 'Settle', 'Call lines', 'View'];

export interface Param { value: number; min: number; max: number; doc: string }

export interface RuleSpec {
    id: string;
    stage: Stage;
    title: string;
    text: string;
    without?: string;                                                  // switchable: what remains when off
    control?: string;                                                  // chosen by this Options entry
    alternatives?: { default: string; choices: Record<string, string> };
    params?: Record<string, Param>;
}

export const RULES: RuleSpec[] = [
    { id: 'h01_first_revealer', stage: 'Reveal', title: 'First opener',
        text: 'One layer at a time: sides open in seed order, and each function\'s neighbours by call line. The first function to show another is its opener: the opener fixes the side the shown function may open and the level an arrowhead into it closes.' },
    { id: 'h02_call_depth_by_path', stage: 'Reveal', title: 'Call depth by path', control: "Options > Call depth by (view.depthRule)",
        text: 'Full layout: a function\'s level is its fewest calls from a seed (shortest) or its most calls with loops ignored (longest).' },
    { id: 'h03_box_order', stage: 'Grouping', title: 'Group first-appearance order',
        text: 'Groups are created in the order their functions occur in the data. The order only breaks ties of h16_item_order.' },
    { id: 'h04_sort_key', stage: 'Rows', title: 'Sort key',
        text: 'Ties are broken by (file path, definition line, name).' },
    { id: 'h05_marker_row_first', stage: 'Rows', title: 'Marker row first',
        text: 'A `└─>>` marker row has the empty sort key: it is always the first row hanging under its function.' },
    { id: 'h06_root_order', stage: 'Rows', title: 'Root order',
        text: 'The top functions of a block (no parent) are ordered by your Move Up/Down order, then the rows of their callers outside the block (h13_caller_alignment), then seed order, then h04_sort_key.' },
    { id: 'h07_child_order', stage: 'Rows', title: 'Child order', alternatives: { default: "line", choices: { "line": "call line, then sort key", "definition": "definition order (h04_sort_key)" } },
        text: 'The functions hanging under a parent are ordered by your Move Up/Down order, then call line, then h04_sort_key.' },
    { id: 'h08_row_order', stage: 'Rows', title: 'Row order',
        text: 'Rows follow a depth-first walk from uncalled functions (seeds first where a loop has no entry). Every caller lies above its callees, except calls back up a loop, which show as `↻` tags.' },
    { id: 'tree_parent_rule', stage: 'Rows', title: 'Decision: parent rule', control: "Options > Parenting (view.parentRule)",
        text: 'Chooses the parent of a function, the caller it hangs under (`└─>`): `joint` (Options > Parenting, the default) for a function with two or more callers in its block, else `dfs` or `nearest`.' },
    { id: 'h09_joint_parent', stage: 'Rows', title: 'Shared entry from the left', control: "Options > Parenting (view.parentRule)",
        text: 'Two or more callers in the block: a caller right above shares its branch (`├───┴─>`); otherwise the function takes no parent and every call enters it from the left through one trunk (`┌──┘`, `└─>`), turning in on the row above it.' },
    { id: 'h10_dfs_nearest_parent', stage: 'Rows', title: 'Parent: first or nearest caller', control: "Options > Parenting (view.parentRule)", params: { indent: { value: 4, min: 3, max: 16, doc: "columns from a tree parent to its child" } },
        text: '`dfs`: the caller that first reached the function in the walk. `nearest`: the closest caller above whose stem no row in between would cross. Without a parent, a function is indented under its nearest caller.' },
    { id: 'h11_port_row', stage: 'Rows', title: 'Exit row',
        text: 'A function whose end receives a trunk and that also sends calls by trunk or path search gets an exit row below it; its calls leave from there, so an arriving and a leaving line never share a row.' },
    { id: 'h12_lane_packing', stage: 'Rows', title: 'Trunk columns', alternatives: { default: "shortest", choices: { "shortest": "shortest trunk first", "longest": "longest trunk first" } }, params: { gap: { value: 2, min: 1, max: 8, doc: "columns between trunks with overlapping rows" } },
        text: 'The trunks of a block are placed shortest first, each in the first free column right of every label it passes, `gap` columns from the trunks beside it.' },
    { id: 'h13_caller_alignment', stage: 'Placement', title: 'Caller alignment', without: "the top functions of a block one row after another from the top, not at their callers' rows",
        text: 'Each top function of a block takes the earliest row of its callers outside the block still free, so the call runs level.' },
    { id: 'h14_monotone_rows', stage: 'Placement', title: 'Rows only go down',
        text: 'A row\'s place is the larger of "row above + 1" and its preferred row (h13_caller_alignment); the row where a shared entry turns in (h09) stays right above its function. Rows skip the cells of a locked function of the block (locks are absolute); the functions hanging under it move with it.' },
    { id: 'h15_block_descent', stage: 'Placement', title: 'Block slides down', without: "blocks keep their row over earlier groups", params: { flag: { value: 12, min: 1, max: 1000, doc: "rows of descent that flag the decision" } },
        text: 'A block that would overlap something already placed slides down until clear.' },
    { id: 'h21_moved_function_descent', stage: 'Placement', title: 'Moved function slides down', without: "moved functions keep their row over labels of their block", params: { margin: { value: 2, min: 0, max: 8, doc: "cells kept between labels of one row" }, flag: { value: 4, min: 1, max: 1000, doc: "rows of descent that flag the decision" } },
        text: 'A moved, unlocked function with the functions hanging under it slides down until its labels clear the other labels of its block. A collapsed group moves and locks as `collapsed:<key>`, apart from its expanded function, so expanding it returns to the layout before the collapse.' },
    { id: 'h16_item_order', stage: 'Placement', title: 'Group order',
        text: 'Within a group, its block and subgroups are placed locked ones first, then callers before callees (ties by h03_box_order).' },
    { id: 'h17_item_column', stage: 'Placement', title: 'Group column', without: "subgroups at the left edge of their group, not right of the groups calling them", params: { channel: { value: 4, min: 1, max: 16, doc: "columns between a calling group or block and the group it calls" } },
        text: 'A subgroup goes right of the rightmost earlier subgroup or block calling into it, plus `channel` columns and 1 per function the calls enter; otherwise at the left edge of its group.' },
    { id: 'h18_item_row', stage: 'Placement', title: 'Group row', without: "subgroups stacked below the earlier ones, not at their callers' rows",
        text: 'A subgroup starts at the row of its first placed caller, else below the unlocked subgroups placed before it.' },
    { id: 'h41_callee_below', stage: 'Placement', title: 'Callee group below its caller', without: "the group sits right of its calling groups, at the caller's row (h17_item_column, h18_item_row)", params: { tries: { value: 6, min: 1, max: 15, doc: "cells tried around the plan; 1: the plan only" }, move: { value: 1, min: 0, max: 10, doc: "cost per cell between a tried cell and the plan" } },
        text: 'One layer at a time: a group called from a single sibling group, on screen because the callers of one of its functions were opened, hangs below the caller\'s group, placed for the calls into it: one caller with nothing hanging under it and no label below it in its group drops its call straight down, so the group\'s content sits one indent right of it (`caller()` over `└─> f()`); otherwise the group sits right of the callers\' label ends and a channel, so their calls run right, down into one trunk, in from the left. Then up to `tries` cells around this plan are tried, nearest first: for each, the calls touching the group are routed (everything else an obstacle), and the cell with the least route cost plus `move` per cell from the plan is kept. What was drawn before stays. Replaces h17_item_column and h18_item_row for that group; h20_unmoved_box_descent still keeps it clear of other groups.' },
    { id: 'item_state', stage: 'Placement', title: 'Decision: locked, moved or unmoved group',
        text: 'A subgroup is placed by its lock, by its move, or by trial placement.' },
    { id: 'h19_lock_and_box_offset', stage: 'Placement', title: 'Moved or locked group',
        text: 'A moved group is placed as if unmoved (at its trial row), then shifted whole by its move: labels, trunks and inner frames keep their places in its frame. A locked group shifts the same way, onto its fixed cell (frame corner).' },
    { id: 'h20_unmoved_box_descent', stage: 'Placement', title: 'Group slides down or right', without: "unmoved groups keep their trial row over earlier ones", params: { flag: { value: 12, min: 1, max: 1000, doc: "rows of descent that flag the decision" }, down: { value: 1, min: 0, max: 10, doc: "cost per row of descent" }, right: { value: 0, min: 0, max: 10, doc: "cost per column of a move right past the overlapped item; 0: never right" }, cross: { value: 0, min: 0, max: 10, doc: "cost per call between other functions whose span the group would cover" } },
        text: 'An unmoved group that overlaps an earlier one slides down until clear, by the distance from its top to below it, or right past it when that costs less (`down`, `right`, `cross`). A group whose frame a locked unit inside pins (locks are absolute) stops where a further slide gains nothing, flagged. An earlier group moved by a drag counts at its unmoved place, so a move never pushes unmoved groups down. Moved groups are exempt; h23_settle handles them.' },
    { id: 'h22_frame_extent', stage: 'Placement', title: 'Frame size', control: "Options > Grouping > Tight (view.tight)",
        text: 'Tight frames (Options > Grouping > Tight, the default): a frame is its content\'s bounding box plus margin. Otherwise a frame keeps its group\'s unmoved corner and only grows. Grouping or ungrouping a namespace drops the moves inside it (`dropMovesWithin`): moves count from the group that held them.' },
    { id: 'h23_settle', stage: 'Settle', title: 'Settle moved units', without: "moved units stay where their moves put them", params: { range: { value: 12, min: 1, max: 40, doc: "Manhattan radius of the ring search" }, far: { value: 80, min: 0, max: 400, doc: "cells of the straight-line search past the rings" }, margin: { value: 4, min: 1, max: 12, doc: "cells between labels of one row" }, rounds: { value: 3, min: 0, max: 8, doc: "settle rounds per redraw" }, flag: { value: 12, min: 1, max: 1000, doc: "move length that flags the decision" } },
        text: 'Every redraw, moved units whose labels or frames lie on other content, or whose frame touches another frame without a free row or column between (no corridor for call lines), go to the nearest clear spot, at most `rounds` rounds (the loop in buildScene). The move that displaces least goes first (distance × labels moved: a small unit yields to a large one); ties: groups before functions, then the smaller unit. Search: `range` cells around (vertical first), then straight lines up to `far`, never off the top or left edge. Locked units never move. Call lines are not considered.' },
    { id: 'h38_frame_overlap', stage: 'Placement', title: 'Frame overlap', without: "frames nest or stay apart: an overlapping group descends", params: { margin: { value: 1, min: 0, max: 6, doc: "cells kept between a label and a foreign frame border" } },
        text: 'Frames of sibling groups may overlap where their content does not. A group overlapping an earlier sibling\'s frame stays when no label, header or arrival cell of either lies within `margin` of the other\'s frame: h20_unmoved_box_descent and h23_settle test labels against frames, not frames against frames. Blocks (h15_block_descent) keep clear of other content. Labels never overlap.' },
    { id: 'h24_tree_lines_first', stage: 'Call lines', title: 'Branches and trunks first', without: "every call line by path search: no branches, no trunks",
        text: 'Branches and the trunks of a block are drawn before path search; a branch between functions with different moves is searched instead.' },
    { id: 'h25_routing_order', stage: 'Call lines', title: 'Search order', alternatives: { default: "row", choices: { "longest": "level calls shortest first, then the rest longest first", "shortest": "level calls, then the rest shortest first", "row": "by caller row, then callee row: top to bottom" } },
        text: 'Calls are searched one at a time, each an obstacle for the calls after it: the order decides which call takes a free corridor and which must cross it. Straightened calls first, then by the chosen alternative: `row` (default), callers top to bottom, a caller\'s calls together in callee order; `longest`, level calls shortest first, then the rest longest first; `shortest`, level calls, then the rest shortest first.' },
    { id: 'h26_arrival_side', stage: 'Call lines', title: 'Arrival side',
        text: 'A call enters from the left (`──> f()`) when most callers lie left of the function, or the function sends from its label end, or the shared entry (h09) applies, and a cell before the two arrival cells is free; else at its end (`f() <──`). The two cells on the entering side are kept for calls into it.' },
    { id: 'h27_departure_reservation', stage: 'Call lines', title: 'Departure cells kept', without: "no cells kept after a caller's label for its calls",
        text: 'The two cells right of a caller\'s label end, or right of the start of its exit row, are kept for its calls.' },
    { id: 'h28_departure_point', stage: 'Call lines', title: 'Departure point', params: { under: { value: 2, min: 0, max: 20, doc: "cost of leaving under or over the first character instead of the label end" } },
        text: 'A call leaves from the label end (cost 0) or from under or over the first character (cost `under`; crossing a horizontal frame border adds its cost). A function whose end receives calls never sends from it; with no free start the call is drawn dashed.' },
    { id: 'h29_route_cost', stage: 'Call lines', title: 'Path cost', params: { bend: { value: 3, min: 0, max: 100, doc: "per change of heading" }, cross: { value: 6, min: 0, max: 100, doc: "per crossing of another call line" }, border: { value: 4, min: 0, max: 100, doc: "per frame border crossed" }, adjacent: { value: 2, min: 0, max: 100, doc: "per vertical step next to another call's vertical line" }, bundle: { value: 0.3, min: 0.05, max: 1, doc: "per step along a line into the same callee, or along the caller's own lines, crossings included (joining it)" }, relaxTurn: { value: 40, min: 0, max: 1000, doc: "second pass: turning on another line" }, relaxAlong: { value: 400, min: 0, max: 10000, doc: "second pass: running along another line" }, steps: { value: 400000, min: 1000, max: 2000000, doc: "search states per call before a dashed line" }, estimate: { value: 1, min: 0.05, max: 1, doc: "scale of the distance estimate; ≤ 0.3: admissible (cheapest routes, slower)" } },
        text: 'Path search: A* over (cell, heading), guided by the grid (Manhattan) distance to the arrival cell. Each step costs 1; +`border` entering a frame border, +`cross` crossing another call line, `bundle` along a line into the same callee (joining its trunk) or along the caller\'s own lines, also where another line crosses them (calls of one caller leave as one bundle and split once), +`bend` per change of heading, +`adjacent` for a vertical step next to another call\'s vertical line. Never: label cells and padding, markers, reversing, running along a border, cells kept for another call. The first pass forbids running along or turning on another line; a second allows them at +`relaxAlong` and +`relaxTurn`. No path in both passes (`steps` search states): dashed.' },
    { id: 'h39_reroute', stage: 'Call lines', title: 'Search again', params: { rounds: { value: 0, min: 0, max: 8, doc: "search-again rounds; 0: off" }, min: { value: 2, min: 1, max: 50, doc: "crossings by later calls that make a call a candidate" }, tries: { value: 3, min: 1, max: 20, doc: "callers tried per round" } },
        text: 'Rip-up and reroute: after path search, calls that calls searched later crossed at least `min` times, and the earlier call of each braid (two calls crossing each other twice), are candidates. Per attempt, one caller\'s candidates, most crossed first, are searched again after the others; an attempt is kept when the total path cost (cells, bends, crossings) drops, else the next caller is tried: `tries` callers per round, `rounds` rounds.' },
    { id: 'h40_lookahead', stage: 'Call lines', title: 'Room for later calls', params: { weight: { value: 0, min: 0, max: 4, doc: "cost per call not searched yet whose bounding box holds the cell" } },
        text: 'Each cell costs `weight` per call not searched yet whose bounding box (caller to callee) holds it, so early paths leave the corridors later calls need; 0: off.' },
    { id: 'h36_call_kind_style', stage: 'Call lines', title: 'Call kind style', without: "every call drawn plain",
        text: 'Cells that only implicit calls (construction, instance call) or only calls across languages pass are drawn in their kind\'s style: dotted and dash-dot, in text and export (`┈ ┊`, `─·─·`) and in every vector style; a plain call on a cell makes it plain.' },
    { id: 'h37_hops', stage: 'View', title: 'Hops', without: "crossings drawn without hops", params: { radius: { value: 0.525, min: 0.1, max: 1, doc: "hop radius in cells" } },
        text: 'Where a horizontal call line crosses a vertical one (one cell, neither turning), the horizontal line hops over it with a half circle of `radius` cell, in orthogonal and rounded call lines; text shows the crossing glyph.' },
    { id: 'h30_action_anchor', stage: 'View', title: 'Keep the acted-on function still', without: "the view does not pan after an open, close or remove",
        text: 'The function you last opened, closed or removed keeps its spot on screen: the view pans to compensate.' },
    { id: 'h31_still_anchor', stage: 'View', title: 'Keep an unmoved function still', without: "the view does not pan after a drag or re-arrange",
        text: 'After a drag or Re-arrange Selection, the view stays fixed on a seed or another function that did not move.' },
    { id: 'h32_multi_unit_drag', stage: 'View', title: 'Multi-unit drag',
        text: 'Dragging a selected function moves each selected function with the functions hanging under it, each once; one hanging under another selected function moves with that one.' },
    { id: 'h33_drop_repulsion', stage: 'View', title: 'Drop search', without: "drops land where dropped", params: { cells: { value: 4, min: 0, max: 40, doc: "cells searched along and beside the drag" }, ms: { value: 400, min: 0, max: 5000, doc: "time limit of the search" } },
        text: 'A drop on content, or one that leaves a call without a path, moves on in the drag direction, then sideways, up to `cells` cells or `ms` milliseconds. Since h23_settle runs in buildScene, most trial spots look clear at once; each further trial is a full layout.' },
    { id: 'h34_offset_handover', stage: 'View', title: 'Move passes to the new parent', without: "a moved function keeps its move when its callers open",
        text: 'Opening the callers of a moved function: when a caller shown by that opening becomes its parent and has no move or lock, the caller takes the function\'s move and the function loses it. The move now carries both, so the caller sits right above the function where you put it.' },
    { id: 'h35_save_what_is_drawn', stage: 'View', title: 'Save settled moves', params: { saves: { value: 3, min: 0, max: 10, doc: "settled offsets saved in a row" } },
        text: 'The view saves the moves h23_settle drew with, at most `saves` saves in a row; any other change resets the count.' },];

export const RULE: ReadonlyMap<string, RuleSpec> = new Map(RULES.map((r) => [r.id, r]));

/** Rule configuration of one layer (style.json `rules`, view `rules`). */
export interface RuleConfig {
    off?: string[];                          // switched-off rules (`without` set)
    alt?: Record<string, string>;            // chosen alternative per rule
    params?: Record<string, number>;         // `<rule id>.<param>` => value
}

const SPECIAL = new Set(['__proto__', 'constructor', 'prototype']);

/** Checked configuration from file data: known switchable rules, known choices, finite numbers clamped to range. */
export function parseRules(x: unknown): RuleConfig | undefined {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
    const v = x as Record<string, unknown>;
    const out: RuleConfig = {};
    if (Array.isArray(v.off)) out.off = [...new Set(v.off.filter((r): r is string => typeof r === 'string' && !!RULE.get(r)?.without))];
    if (v.alt && typeof v.alt === 'object' && !Array.isArray(v.alt)) {
        const alt: Record<string, string> = {};
        for (const [r, c] of Object.entries(v.alt as Record<string, unknown>)) {
            if (SPECIAL.has(r) || typeof c !== 'string') continue;
            if (RULE.get(r)?.alternatives && Object.hasOwn(RULE.get(r)!.alternatives!.choices, c)) alt[r] = c;
        }
        if (Object.keys(alt).length) out.alt = alt;
    }
    if (v.params && typeof v.params === 'object' && !Array.isArray(v.params)) {
        const params: Record<string, number> = {};
        for (const [k, n] of Object.entries(v.params as Record<string, unknown>)) {
            const p = paramOf(k);
            if (!p || typeof n !== 'number' || !Number.isFinite(n)) continue;
            params[k] = Math.min(p.max, Math.max(p.min, n));
        }
        if (Object.keys(params).length) out.params = params;
    }
    return out.off || out.alt || out.params ? out : undefined;
}

/** Parameter spec of `<rule id>.<param>`. */
export function paramOf(key: string): Param | undefined {
    const i = key.lastIndexOf('.');
    if (i < 0) return undefined;
    const r = RULE.get(key.slice(0, i)), name = key.slice(i + 1);
    return r?.params && Object.hasOwn(r.params, name) ? r.params[name] : undefined;
}

/**
 * Rule context of one layout: switches, alternatives, parameters (layers merged), and the decision log of layout
 * debugging (explain.ts). Passed from buildScene to reveal, layout, place, settle and route.
 */
export class Rules {
    readonly off: ReadonlySet<string>;
    private readonly alts = new Map<string, string>();
    private readonly params = new Map<string, number>();

    /** `layers`: the view's rules, then an override. */
    constructor(layers: readonly (RuleConfig | undefined)[] = [], readonly log?: (d: Decision) => void) {
        let off: string[] = [];
        for (const l of layers) if (l?.off) off = l.off;
        this.off = new Set(off);
        for (const r of RULES) for (const [name, p] of Object.entries(r.params ?? {})) this.params.set(`${r.id}.${name}`, p.value);
        for (const l of layers) {
            for (const [k, v] of Object.entries(l?.alt ?? {})) this.alts.set(k, v);
            for (const [k, v] of Object.entries(l?.params ?? {})) { const p = paramOf(k); if (p) this.params.set(k, Math.min(p.max, Math.max(p.min, v))); }
        }
    }

    /** Rule applies: not switched off. */
    on(id: string): boolean { return !this.off.has(id); }

    /** Chosen alternative of `id`. */
    alt(id: string): string { return this.alts.get(id) ?? RULE.get(id)?.alternatives?.default ?? ''; }

    /** Parameter `name` of rule `id`. */
    p(id: string, name: string): number {
        const v = this.params.get(`${id}.${name}`);
        if (v === undefined) throw new Error(`rules: no parameter ${id}.${name}`);
        return v;
    }

    /** Records a decision while layout debugging logs. */
    note(d: Decision): void { this.log?.(d); }

    /** The same configuration with another decision log (placement and settle log apart, scene.ts). */
    withLog(log?: (d: Decision) => void): Rules {
        const r = Object.create(Rules.prototype) as Rules;
        Object.assign(r, this, { log });
        return r;
    }
}

/** Merged configuration of `layers` (as Rules reads them): for the rules panel and saved views. */
export function mergeRules(...layers: (RuleConfig | undefined)[]): RuleConfig {
    const out: RuleConfig = {};
    for (const l of layers) {
        if (l?.off) out.off = [...l.off];
        if (l?.alt) out.alt = { ...(out.alt ?? {}), ...l.alt };
        if (l?.params) out.params = { ...(out.params ?? {}), ...l.params };
    }
    return out;
}
