/** @xvdp
 * Layout debugging: decision log of the rules (rules.ts) and an override of their configuration. Rule ids as in
 * docs/heuristics.md; `npm run explain` resolves them to code lines (scripts/rules.ts anchors).
 *
 * Decision: rule, function, unit it placed (`box:<key>`, `block:<box key>`, a vertex key, `collapsed:<key>`), the
 * values it used and its outcome. Flag: a decision past the threshold of its rule's `flag` parameter, a candidate
 * cause of a jump. No cost without `Debug.log`.
 */
import { RuleConfig, RULES } from './rules';

/** Rules that can be switched off, with what remains without them (rules.ts `without`). */
export const SWITCHES: Record<string, string> = Object.fromEntries(RULES.filter((r) => r.without).map((r) => [r.id, r.without!]));

/** Titles of the rules (rules.ts). */
export const TITLES: Record<string, string> = Object.fromEntries(RULES.map((r) => [r.id, r.title]));

export interface Decision {
    rule: string;
    fn: string;                             // function that applied the rule (placeBox, placeBlock, settleMoved, layout, buildGrid)
    unit: string;
    text: string;                           // outcome in words
    values: Record<string, unknown>;        // inputs and outcome
    flag?: string;                          // why it may be a cause of a jump
}

/** Layout debugging: decision log, and a rule configuration over the view's (scripts/explain.ts). */
export interface Debug {
    log?: (d: Decision) => void;
    rules?: RuleConfig;
}

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
