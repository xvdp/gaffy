/** @xvdp
 * Layout debugging: decision log and rule switches of placement (place.ts) and settle (settle.ts). Rule ids as in
 * docs/heuristics.md; `npm run explain` resolves them to code lines (scripts/rules.ts anchors).
 *
 * Decision: rule, function, unit it placed (`box:<key>`, `block:<box key>`, a vertex key, `collapsed:<key>`), the
 * values it used and its outcome. Flag: a decision past a threshold of `FLAGS`, a candidate cause of a jump.
 * Switches: a rule in `off` is skipped (the layout without it); off by default, no cost without `Debug`.
 */

/** Rules that can be switched off, with what remains without them. */
export const SWITCHES: Record<string, string> = {
    h13_caller_alignment: 'block roots one row after another from the top, not at their callers\' rows',
    h15_block_descent: 'blocks keep their row over earlier siblings',
    h17_item_column: 'child boxes at the content column, not right of their calling siblings',
    h18_item_row: 'child boxes stacked below earlier siblings, not at their callers\' rows',
    h20_unmoved_box_descent: 'unmoved boxes keep their trial row over earlier siblings',
    h21_moved_function_descent: 'moved functions keep their row over labels of their block',
    h23_settle: 'moved units stay where their offsets put them',
};

/** Titles of the logged rules (docs/heuristics.md). */
export const TITLES: Record<string, string> = {
    h13_caller_alignment: 'Caller alignment',
    h15_block_descent: 'Block descent',
    h16_item_order: 'Item order',
    h17_item_column: 'Item column',
    h18_item_row: 'Item row',
    h19_lock_and_box_offset: 'Lock and box offset',
    h20_unmoved_box_descent: 'Unmoved box descent',
    h21_moved_function_descent: 'Moved function descent',
    h22_frame_extent: 'Frame extent',
    h23_settle: 'Settle',
};

/** Flag thresholds (cells). */
export const FLAGS = {
    descent: 12,          // h15, h20: an unmoved item slid this many rows below its trial row
    fnDescent: 4,         // h21: a moved function slid this many rows
    settle: 12,           // h23: a settle move this long (|Δcolumn| + |Δrow|)
};

export interface Decision {
    rule: string;
    fn: 'placeBox' | 'placeBlock' | 'settleMoved' | 'buildScene';
    unit: string;
    text: string;                           // outcome in words
    values: Record<string, unknown>;        // inputs and outcome
    flag?: string;                          // why it may be a cause of a jump
}

export interface Debug {
    off?: ReadonlySet<string>;              // switched-off rules (SWITCHES keys)
    log?: (d: Decision) => void;
}

export const isOff = (d: Debug | undefined, rule: string) => !!d?.off?.has(rule);

/** Decisions about `unit`: its own, its block's (`block:<box>` for a vertex in that box), its boxes'. */
export function decisionsOf(all: readonly Decision[], unit: string, boxes: readonly string[]): Decision[] {
    const own = new Set([unit, ...boxes.map((b) => `box:${b}`), ...boxes.map((b) => `block:${b}`)]);
    return all.filter((d) => own.has(d.unit));
}

/** One line per decision: `h20 Unmoved box descent · placeBox · box:dir:x · rows 4 → 16 · {values} ⚑ flag`. */
export function decisionLine(d: Decision, where?: (rule: string) => string | undefined): string {
    const at = where?.(d.rule);
    const vals = JSON.stringify(d.values);
    return `${d.rule.slice(0, 3)} ${TITLES[d.rule] ?? d.rule} · ${d.fn}${at ? ` (${at})` : ''} · ${d.unit} · ${d.text}`
        + (vals !== '{}' ? ` · ${vals}` : '') + (d.flag ? ` ⚑ ${d.flag}` : '');
}
