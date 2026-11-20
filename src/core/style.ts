/**
 * Style: defaults, merged with the `gaffy.style` setting, then `.gaffy/style.json`, then per-view
 * overrides (ViewSpec.boxes, edges, curve, parentRule). `view` holds the choices a new view starts
 * with (layout, traverse); they are written into the view file at creation.
 */
import type { EdgeMode, ParentRule } from './viewdoc';

export type Curve = 'orthogonal' | 'rounded' | 'sigmoid' | 'spline';
export type FrameLine = 'solid' | 'rounded' | 'dashed' | 'dotted' | 'double';

export interface Style {
    view: { arrange: 'grow' | 'auto'; traverse: 'command' | 'both' };
    font: { family: string; size: number; lineHeight: number };
    grid: { indent: number; laneGap: number; parentRule: ParentRule };
    edges: { mode: EdgeMode; glyphs: 'unicode' | 'ascii'; arrow: boolean; cross: string; width: number; curve: Curve; lead: number; tension: number };
    labels: { strip: string[]; parens: boolean };
    boxes: { enabled: boolean; modules: boolean; root: boolean; tight: boolean; fill: 'none' | 'hue'; alpha: number; line: FrameLine };
    route: { bend: number; cross: number; border: number; adjacent: number; channel: number };
    colors: Record<string, string>;
}

export const DEFAULT_STYLE: Style = {
    view: { arrange: 'grow', traverse: 'command' },
    font: { family: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace", size: 13, lineHeight: 1.25 },
    grid: { indent: 4, laneGap: 2, parentRule: 'joint' },
    edges: { mode: 'vector', glyphs: 'unicode', arrow: true, cross: '│', width: 1, curve: 'rounded', lead: 3, tension: 0.5 },
    labels: { strip: [], parens: true },
    boxes: { enabled: true, modules: false, root: true, tight: true, fill: 'none', alpha: 0.08, line: 'dashed' },
    route: { bend: 3, cross: 6, border: 4, adjacent: 2, channel: 4 },
    colors: {
        fg: 'var(--vscode-editor-foreground)',
        bg: 'var(--vscode-editor-background)',
        edge: 'var(--vscode-editorLineNumber-foreground)',
        highlight: '#ddaa22', // 'var(--vscode-focusBorder)'
        seed: 'var(--vscode-textLink-foreground)',
        frame: 'var(--vscode-editorWidget-border)',
        namespace: 'var(--vscode-descriptionForeground)',
        external: 'var(--vscode-disabledForeground)',
        selected: 'var(--vscode-editor-selectionBackground)',
        selection: 'var(--vscode-textLink-activeForeground)',
        twisty: 'var(--vscode-textLink-foreground)',
    },
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge<T>(base: T, ...over: unknown[]): T {
    let out: unknown = structuredClone(base);
    for (const o of over) out = mergeOne(out, o);
    return out as T;
}

function mergeOne(a: unknown, b: unknown): unknown {
    if (b === undefined || b === null) return a;
    if (isPlain(a) && isPlain(b)) {
        const r: Plain = { ...a };
        // a key that names an object's prototype would change what the merged style inherits: skipped
        for (const [k, v] of Object.entries(b)) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') r[k] = mergeOne(a[k], v);
        return r;
    }
    return b;
}

/** Box-drawing glyph per direction mask. N=1, S=2, E=4, W=8. */
export const N = 1, S = 2, E = 4, W = 8;

const UNICODE: Record<number, string> = {
    [N]: '│', [S]: '│', [N | S]: '│', [E]: '─', [W]: '─', [E | W]: '─',
    [S | E]: '┌', [S | W]: '┐', [N | E]: '└', [N | W]: '┘',
    [N | S | E]: '├', [N | S | W]: '┤', [S | E | W]: '┬', [N | E | W]: '┴', [N | S | E | W]: '┼',
};

const ASCII: Record<number, string> = {
    [N]: '|', [S]: '|', [N | S]: '|', [E]: '-', [W]: '-', [E | W]: '-',
    [S | E]: '+', [S | W]: '+', [N | E]: '`', [N | W]: '+',
    [N | S | E]: '|', [N | S | W]: '+', [S | E | W]: '+', [N | E | W]: '+', [N | S | E | W]: '+',
};

export interface GlyphSet {
    mask: (m: number) => string;
    cross: string;
    frame: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
}

/** Frame glyphs per line style: dashed and dotted frames read apart from solid call lines. */
const FRAMES: Record<FrameLine, GlyphSet['frame']> = {
    solid: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
    rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
    dashed: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '┄', v: '┆' },
    dotted: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '┈', v: '┊' },
    double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
};

export function glyphSet(style: Style): GlyphSet {
    const ascii = style.edges.glyphs === 'ascii';
    const table = ascii ? ASCII : UNICODE;
    return {
        mask: (m) => table[m] ?? ' ',
        cross: ascii ? '|' : style.edges.cross,
        frame: ascii
            ? { tl: '+', tr: '+', bl: '+', br: '+', h: style.boxes.line === 'double' ? '=' : '-', v: style.boxes.line === 'double' ? 'H' : '|' }
            : FRAMES[style.boxes.line] ?? FRAMES.solid,
    };
}
