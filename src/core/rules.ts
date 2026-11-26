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

export type Stage = 'Reveal' | 'Boxes' | 'Block layout' | 'Placement' | 'Routing' | 'Webview';
export const STAGES: Stage[] = ['Reveal', 'Boxes', 'Block layout', 'Placement', 'Routing', 'Webview'];

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
    { id: 'h01_first_revealer', stage: 'Reveal', title: 'First revealer',
        text: 'One layer at a time: sides open in seed order, and each function\'s neighbours by call line. The first function to reveal another is its opener: the opener fixes the side the revealed function may open and the level an arrowhead into it closes.' },
    { id: 'h02_call_depth_by_path', stage: 'Reveal', title: 'Call depth by path', control: "Options > Call depth by (view.depthRule)",
        text: 'Full layout: a function\'s level is its fewest calls from a seed (shortest) or its most calls with loops ignored (longest).' },
    { id: 'h03_box_order', stage: 'Boxes', title: 'Box first-appearance order',
        text: 'Boxes are created in the order their functions occur in the data. The order only breaks ties of h16_item_order.' },
    { id: 'h04_sort_key', stage: 'Block layout', title: 'Sort key',
        text: 'Ties are broken by (file path, definition line, name).' },
    { id: 'h05_marker_row_first', stage: 'Block layout', title: 'Marker row first',
        text: 'A `└─>>` marker has the empty sort key: it is always a function\'s first child row.' },
    { id: 'h06_root_order', stage: 'Block layout', title: 'Root order',
        text: 'The top-level functions of a block are ordered by your Move Up/Down order, then the rows of their outside callers (h13_caller_alignment), then seed order, then h04_sort_key.' },
    { id: 'h07_child_order', stage: 'Block layout', title: 'Child order', alternatives: { default: "line", choices: { "line": "call line, then sort key", "definition": "definition order (h04_sort_key)" } },
        text: 'A function\'s calls are ordered by your Move Up/Down order, then call line, then h04_sort_key.' },
    { id: 'h08_row_order', stage: 'Block layout', title: 'Row order',
        text: 'Rows follow a depth-first walk from uncalled functions (seeds first where a loop has no entry). Every caller row lies above its callee rows, except calls back up a loop, which show as `↻` tags.' },
    { id: 'tree_parent_rule', stage: 'Block layout', title: 'Decision: tree parent rule', control: "Options > Parenting (view.parentRule)",
        text: 'Chooses the caller a function hangs under (`└─>`): `joint` (Options > Parenting, the default) for a function with two or more callers in the block, else `dfs` or `nearest`.' },
    { id: 'h09_joint_parent', stage: 'Block layout', title: 'Joint parent', control: "Options > Parenting (view.parentRule)",
        text: 'Two or more callers in the block: a caller directly above shares its branch (`├───┴─>`); otherwise the function takes no tree parent and every call enters from the left through one collector line (`┌──┘`, `└─>`).' },
    { id: 'h10_dfs_nearest_parent', stage: 'Block layout', title: 'dfs / nearest parent', control: "Options > Parenting (view.parentRule)", params: { indent: { value: 4, min: 3, max: 16, doc: "columns from a tree parent to its child" } },
        text: '`dfs`: the caller that first reached the function in the walk. `nearest`: the closest caller above whose vertical line no row in between would cross. Without a parent, a function is indented under its nearest caller.' },
    { id: 'h11_port_row', stage: 'Block layout', title: 'Port row',
        text: 'A function that both receives and sends routed calls gets a row below it; its outgoing lines leave from there, so an incoming and an outgoing line never share a row.' },
    { id: 'h12_lane_packing', stage: 'Block layout', title: 'Lane packing', alternatives: { default: "shortest", choices: { "shortest": "shortest lane first", "longest": "longest lane first" } }, params: { gap: { value: 2, min: 1, max: 8, doc: "columns between lanes with overlapping rows" } },
        text: 'Vertical call lines are placed shortest first, each in the first free column right of every label it passes.' },
    { id: 'h13_caller_alignment', stage: 'Placement', title: 'Caller alignment', without: "block roots one row after another from the top, not at their callers' rows",
        text: 'Each top-level function of a block takes the earliest outside-caller row still free, so its incoming call can run level.' },
    { id: 'h14_monotone_rows', stage: 'Placement', title: 'Monotone rows',
        text: 'A row\'s position is the larger of "row above + 1" and its preferred row (h13_caller_alignment); an approach row stays directly above its function. Rows skip the cells of a locked function of the block (locks are absolute), whose tree below moves with it.' },
    { id: 'h15_block_descent', stage: 'Placement', title: 'Block descent', without: "blocks keep their row over earlier siblings", params: { flag: { value: 12, min: 1, max: 1000, doc: "rows of descent that flag the decision" } },
        text: 'A block that would overlap something already placed moves down until clear.' },
    { id: 'h21_moved_function_descent', stage: 'Placement', title: 'Moved function descent', without: "moved functions keep their row over labels of their block", params: { margin: { value: 2, min: 0, max: 8, doc: "cells kept between labels of one row" }, flag: { value: 4, min: 1, max: 1000, doc: "rows of descent that flag the decision" } },
        text: 'A moved, unlocked function with its tree moves down until its labels clear the other labels of its own block. A collapsed container moves and locks as `collapsed:<key>`, apart from its expanded vertex, so expanding it returns to the layout before the collapse.' },
    { id: 'h16_item_order', stage: 'Placement', title: 'Item order',
        text: 'Within a box: locked items first, then callers\' items before callees\' items (ties by h03_box_order).' },
    { id: 'h17_item_column', stage: 'Placement', title: 'Item column', without: "child boxes at the content column, not right of their calling siblings", params: { channel: { value: 4, min: 1, max: 16, doc: "columns of the routing channel right of a calling item, plus one per entering call" } },
        text: 'An item goes right of the rightmost earlier item that calls into it, plus a channel of `route.channel` columns + 1 per incoming call; otherwise at the box\'s left edge.' },
    { id: 'h18_item_row', stage: 'Placement', title: 'Item row', without: "child boxes stacked below earlier siblings, not at their callers' rows",
        text: 'An item starts at its first placed caller\'s row, else below the unlocked items already placed.' },
    { id: 'h41_callee_below', stage: 'Placement', title: 'Callee group below its caller', without: "the group sits right of its calling groups, at the caller's row (h17_item_column, h18_item_row)",
        text: 'One layer at a time: a group called from a single sibling group, on screen because the callers of one of its functions were opened (caller revealed upward), hangs below the caller\'s group, its content one indent right of the caller: `caller()` over `└─> f()`, as a callee below its caller. Replaces h17_item_column and h18_item_row for that group; h20_unmoved_box_descent still keeps it clear of other groups.' },
    { id: 'item_state', stage: 'Placement', title: 'Decision: locked, moved or unmoved item',
        text: 'A box item is placed by its lock, by its offset, or by trial placement.' },
    { id: 'h19_lock_and_box_offset', stage: 'Placement', title: 'Lock and box offset',
        text: 'A moved box is placed as if unmoved (at its trial row), then translated whole by its offset: labels, lanes and inner frames keep their places relative to its frame. A locked box translates the same way, onto its fixed cell (frame corner).' },
    { id: 'h20_unmoved_box_descent', stage: 'Placement', title: 'Unmoved box descent', without: "unmoved boxes keep their trial row over earlier siblings", params: { flag: { value: 12, min: 1, max: 1000, doc: "rows of descent that flag the decision" }, down: { value: 1, min: 0, max: 10, doc: "cost per row of descent" }, right: { value: 0, min: 0, max: 10, doc: "cost per column of a move right past the overlapped item; 0: never right" }, cross: { value: 0, min: 0, max: 10, doc: "cost per call between other functions whose span the box would cover (E5)" } },
        text: 'An unmoved box that overlaps an earlier item moves down until clear, by the distance from its top to below that item, or right past it when that costs less (`down`, `right`, `cross`). A box whose frame a locked unit inside pins (locks are absolute) stops where a further move gains nothing, flagged. An earlier box moved by an offset counts at its unmoved place, so a move never pushes unmoved boxes down. Moved boxes are exempt; h23_settle handles them.' },
    { id: 'h22_frame_extent', stage: 'Placement', title: 'Frame extent', control: "Options > Grouping > Tight (view.tight)",
        text: 'Tight groups (Options > Grouping > Tight, the default): a frame is its content\'s bounding box plus margin. Otherwise the frame keeps the box\'s unmoved corner and only grows. Ungrouping or grouping a container drops the moves inside it (`dropMovesWithin`): offsets count from the box that held them.' },
    { id: 'h23_settle', stage: 'Placement', title: 'Settle', without: "moved units stay where their offsets put them", params: { range: { value: 12, min: 1, max: 40, doc: "Manhattan radius of the ring search" }, far: { value: 80, min: 0, max: 400, doc: "cells of the straight-line search past the rings" }, margin: { value: 4, min: 1, max: 12, doc: "cells between labels of one row" }, rounds: { value: 3, min: 0, max: 8, doc: "settle rounds per redraw" }, flag: { value: 12, min: 1, max: 1000, doc: "move length that flags the decision" } },
        text: 'Every redraw, moved units whose labels or frames lie on other content, or whose frame touches another frame without a free row or column between (no corridor for calls), move to the nearest clear offset, up to 3 rounds (the loop in buildScene). The move that displaces least goes first (distance × labels moved: a small unit yields to a large one); ties: boxes before functions, then the smaller unit. Search: 12 cells around (vertical first), then straight lines up to 80, never off the top or left edge. Locked units never move. Lines are not considered.' },
    { id: 'h38_frame_overlap', stage: 'Placement', title: 'Frame overlap', without: "frames nest or stay apart: an overlapping group descends", params: { margin: { value: 1, min: 0, max: 6, doc: "cells kept between a label and a foreign frame border" } },
        text: 'Frames of sibling groups may overlap where their content does not. A group overlapping an earlier sibling group\'s frame stays when no label, header or arrival cell of either lies within `margin` of the other\'s frame: h20_unmoved_box_descent and h23_settle test labels against frames, not frames against frames. Blocks of functions (h15_block_descent) keep clear of other content. Labels never overlap.' },
    { id: 'h24_tree_lines_first', stage: 'Routing', title: 'Tree lines first', without: "every call routed by search: no tree elbows, no lanes",
        text: 'Tree branches and lanes are drawn before routed calls; a branch between functions with different offsets is routed instead.' },
    { id: 'h25_routing_order', stage: 'Routing', title: 'Routing order', alternatives: { default: "row", choices: { "longest": "level calls shortest first, then the rest longest first", "shortest": "level calls, then the rest shortest first", "row": "by caller row, then callee row: top to bottom" } },
        text: 'Calls are routed one at a time, each an obstacle for the calls after it: the order decides which call takes a free corridor and which must cross it. Straightened calls first, then by the chosen alternative: `row` (default), callers top to bottom, a caller\'s calls together in callee order; `longest`, level calls shortest first, then the rest longest first; `shortest`, level calls, then the rest shortest first.' },
    { id: 'h26_arrival_side', stage: 'Routing', title: 'Arrival side',
        text: 'A call enters from the left when most callers are to the function\'s left, or the function sends from its label end, or the joint rule applies; else at its right end. The two cells on the entering side are reserved for its incoming calls.' },
    { id: 'h27_departure_reservation', stage: 'Routing', title: 'Departure reservation', without: "no cells reserved after a caller's label for its calls",
        text: 'The two cells right of a caller\'s label end, or right of its port, are reserved for its outgoing calls.' },
    { id: 'h28_departure_point', stage: 'Routing', title: 'Departure point', params: { under: { value: 2, min: 0, max: 20, doc: "cost of leaving under or over the first character instead of the label end" } },
        text: 'A call leaves from the label end (cost 0) or from under or over the first character (cost 2). A function whose end receives calls never sends from it; with no free start the call is drawn dashed.' },
    { id: 'h29_route_cost', stage: 'Routing', title: 'Route cost', params: { bend: { value: 3, min: 0, max: 100, doc: "per change of heading" }, cross: { value: 6, min: 0, max: 100, doc: "per crossing of another call's line" }, border: { value: 4, min: 0, max: 100, doc: "per frame border crossed" }, adjacent: { value: 2, min: 0, max: 100, doc: "per vertical step next to another call's vertical line" }, bundle: { value: 0.3, min: 0.05, max: 1, doc: "per step on a line of the same callee, or of the same caller alone (merging)" }, relaxTurn: { value: 40, min: 0, max: 1000, doc: "second pass: turning on another line" }, relaxAlong: { value: 400, min: 0, max: 10000, doc: "second pass: running along another line" }, steps: { value: 400000, min: 1000, max: 2000000, doc: "search states per call before the dashed fallback" }, estimate: { value: 1, min: 0.05, max: 1, doc: "scale of the distance estimate; ≤ 0.3: admissible (cheapest routes, slower)" } },
        text: 'A* over (cell, heading), guided by the grid (Manhattan) distance to the arrival cell. Each step costs 1; +4 entering a frame border (`route.border`), +6 crossing another call\'s line (`route.cross`), 0.3 along this target\'s own line (joining it), +3 per change of heading (`route.bend`), +2 for a vertical step next to another call\'s vertical line (`route.adjacent`). Never: label cells and padding, markers, reversing, running along a border, cells reserved for another call. The first pass forbids running along or turning on another line; a second pass allows them at +400 and +40. No route in both passes (400 000 search steps): dashed.' },
    { id: 'h39_reroute', stage: 'Routing', title: 'Reroute', params: { rounds: { value: 0, min: 0, max: 8, doc: "reroute rounds; 0: off" }, min: { value: 2, min: 1, max: 50, doc: "received crossings that send a call to reroute" }, tries: { value: 3, min: 1, max: 20, doc: "callers tried per round" } },
        text: 'Rip-up and reroute: after routing, calls that calls routed later crossed at least `min` times, and the earlier call of each braid (two calls crossing each other twice), are candidates. Per attempt, the candidates of one caller, most crossed first, are routed again after the others; an attempt is kept when the total route cost (cells, bends, crossings) drops, else the next caller is tried: `tries` callers per round, `rounds` rounds.' },
    { id: 'h40_lookahead', stage: 'Routing', title: 'Lookahead', params: { weight: { value: 0, min: 0, max: 4, doc: "cost per pending call box over a cell" } },
        text: 'Each cell costs `weight` per call not routed yet whose bounding box (caller to callee) holds it, so early routes leave the corridors later calls need; 0: off.' },
    { id: 'h36_call_kind_style', stage: 'Routing', title: 'Call kind style', without: "every call drawn plain",
        text: 'Cells that only implicit calls (construction, instance call) or only calls across languages pass are drawn in their kind\'s style: dotted and dash-dot, in text and export (`┈ ┊`, `─·─·`) and in every vector style; a plain call on a cell makes it plain.' },
    { id: 'h37_hops', stage: 'Webview', title: 'Hops', without: "crossings drawn without hops", params: { radius: { value: 0.525, min: 0.1, max: 1, doc: "hop radius in cells" } },
        text: 'Where a horizontal call line crosses a vertical one (one cell, neither turning), the horizontal line hops over it with a half circle of 0.525 cell, in orthogonal and rounded edges; text shows the crossing glyph.' },
    { id: 'h30_action_anchor', stage: 'Webview', title: 'Action anchor', without: "the view does not pan after an open, close or remove",
        text: 'The function you last opened, closed or removed keeps its spot on screen: the view pans to compensate.' },
    { id: 'h31_still_anchor', stage: 'Webview', title: 'Still anchor', without: "the view does not pan after a drag or re-arrange",
        text: 'After a drag or Re-arrange Selection, the view stays fixed on a seed or another function that did not move.' },
    { id: 'h32_multi_unit_drag', stage: 'Webview', title: 'Multi-unit drag',
        text: 'Dragging a selected function moves each selected function with the functions below it, each once; one inside another selected function\'s tree moves with that function.' },
    { id: 'h33_drop_repulsion', stage: 'Webview', title: 'Drop repulsion', without: "drops land where dropped", params: { cells: { value: 4, min: 0, max: 40, doc: "cells searched along and beside the drag" }, ms: { value: 400, min: 0, max: 5000, doc: "time limit of the search" } },
        text: 'A drop on content, or one that leaves a call unroutable, moves on in the drag direction, then sideways, up to `cells` cells (4) or `ms` (400 ms). Since h23_settle runs in buildScene, most trial spots look clear at once; each further trial is a full layout.' },
    { id: 'h34_offset_handover', stage: 'Webview', title: 'Offset handover', without: "a moved function keeps its offset when its callers open",
        text: 'Opening the callers of a moved function: when a caller revealed by that opening becomes its tree parent and has no offset or lock, the caller takes the function\'s offset and the function loses it. The offset now moves both, so the caller sits right above the function where you put it.' },
    { id: 'h35_save_what_is_drawn', stage: 'Webview', title: 'Save what is drawn', params: { saves: { value: 3, min: 0, max: 10, doc: "settled offsets saved in a row" } },
        text: 'The view saves the offsets h23_settle drew with, at most 3 saves in a row; any other change resets the count.' },];

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
