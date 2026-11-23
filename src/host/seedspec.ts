/** @xvdp
 * Seeds written by name in a view file, e.g. by a script: `<path>#<qualified name>` or `<path>:<line>` (1-based
 * line inside the definition); path relative to the view's workspace folder. A gaffy key without its node record
 * (`py:<path>#<qual>`) reads as `<path>#<qual>`. Resolved when the view opens (editor.ts `resolveSeeds`).
 */
export interface SeedSpec { path: string; qual?: string; line?: number }

/** Path and qualified name, or path and line, of a seed written by name; undefined for anything else. */
export function seedSpec(seed: string): SeedSpec | undefined {
    const s = seed.trim();
    const byName = /^(.+?)#([^#]+)$/.exec(s);
    const byLine = byName ? null : /^(.+):(\d+)$/.exec(s);
    // a gaffy key prefix: language id and colon before a relative path (`py:src/a.py`)
    const path = (byName?.[1] ?? byLine?.[1] ?? '').replace(/^[a-z][a-z0-9]{0,7}:(?![/\\])/, '');
    if (!path || path.includes('\0')) return undefined;
    if (byName) return { path, qual: byName[2].trim() };
    const line = Number(byLine![2]);
    return line >= 1 ? { path, line } : undefined;
}
