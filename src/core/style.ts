/**
 * Style: defaults, merged with the `gaffy.style` setting, then `.gaffy/style.json`, then per-view
 * overrides (ViewSpec.boxes, edges, curve, parentRule).
 */
import type { EdgeMode, ParentRule } from './viewdoc';

export type Curve = 'orthogonal' | 'rounded' | 'sigmoid' | 'spline';
export type FrameLine = 'solid' | 'rounded' | 'dashed' | 'dotted' | 'double';

export interface Style {
  font: { family: string; size: number; lineHeight: number };
  grid: { indent: number; laneGap: number; parentRule: ParentRule };
  edges: { mode: EdgeMode; glyphs: 'unicode' | 'ascii'; arrow: boolean; cross: string; width: number; curve: Curve };
  labels: { strip: string[]; parens: boolean };
  boxes: { enabled: boolean; modules: boolean; root: boolean; fill: 'none' | 'hue'; alpha: number; line: FrameLine };
  route: { bend: number; cross: number; border: number; channel: number };
  colors: Record<string, string>;
}

export const DEFAULT_STYLE: Style = {
  font: { family: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace", size: 13, lineHeight: 1.25 },
  grid: { indent: 4, laneGap: 2, parentRule: 'dfs' },
  edges: { mode: 'glyph', glyphs: 'unicode', arrow: true, cross: '│', width: 1, curve: 'orthogonal' },
  labels: { strip: [], parens: true },
  boxes: { enabled: true, modules: false, root: true, fill: 'none', alpha: 0.08, line: 'dashed' },
  route: { bend: 3, cross: 6, border: 4, channel: 4 },
  colors: {
    fg: 'var(--vscode-editor-foreground)',
    bg: 'var(--vscode-editor-background)',
    edge: 'var(--vscode-editorLineNumber-foreground)',
    highlight: 'var(--vscode-focusBorder)',
    seed: 'var(--vscode-textLink-foreground)',
    frame: 'var(--vscode-editorWidget-border)',
    namespace: 'var(--vscode-descriptionForeground)',
    external: 'var(--vscode-disabledForeground)',
    selected: 'var(--vscode-editor-selectionBackground)',
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
    for (const [k, v] of Object.entries(b)) r[k] = mergeOne(a[k], v);
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
