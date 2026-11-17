/**
 * Style: defaults, merged with the `gaffy.style` setting, then `.gaffy/style.json`, then per-view
 * overrides (ViewSpec.edges, labels, parentRule).
 */
import type { EdgeMode, LabelMode, ParentRule } from './viewdoc';

export interface Style {
  font: { family: string; size: number; lineHeight: number };
  grid: { indent: number; laneGap: number; parentRule: ParentRule };
  edges: { mode: EdgeMode; glyphs: 'unicode' | 'ascii'; arrow: boolean; cross: string; width: number };
  labels: { mode: LabelMode; strip: string[]; parens: boolean; status: boolean };
  container: { kinds: string[]; minRun: number; boxes: boolean };
  colors: Record<string, string>;
}

export const DEFAULT_STYLE: Style = {
  font: { family: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace", size: 13, lineHeight: 1.25 },
  grid: { indent: 4, laneGap: 2, parentRule: 'dfs' },
  edges: { mode: 'glyph', glyphs: 'unicode', arrow: true, cross: '│', width: 1 },
  labels: { mode: 'full', strip: [], parens: true, status: true },
  container: { kinds: ['module', 'file'], minRun: 2, boxes: true },
  colors: {
    fg: 'var(--vscode-editor-foreground)',
    bg: 'var(--vscode-editor-background)',
    edge: 'var(--vscode-editorLineNumber-foreground)',
    highlight: 'var(--vscode-focusBorder)',
    seed: 'var(--vscode-textLink-foreground)',
    container: 'var(--vscode-descriptionForeground)',
    box: 'var(--vscode-editorWidget-border)',
    external: 'var(--vscode-disabledForeground)',
    ADD: '#3fb950',
    MOD: '#d29922',
    REMOVE: '#f85149',
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
  bracket: { top: string; mid: string; bot: string; one: string };
}

export function glyphSet(style: Style): GlyphSet {
  const table = style.edges.glyphs === 'ascii' ? ASCII : UNICODE;
  const ascii = style.edges.glyphs === 'ascii';
  return {
    mask: (m) => table[m] ?? ' ',
    cross: ascii ? '|' : style.edges.cross,
    bracket: ascii ? { top: ']', mid: '|', bot: ']', one: ']' } : { top: '⌉', mid: '│', bot: '⌋', one: ']' },
  };
}
