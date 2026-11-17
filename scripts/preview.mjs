// Browser preview of the webview without VS Code: dist/preview.html?doc=exp4|star
// Mocks acquireVsCodeApi, echoes edits back as state, maps VS Code theme variables to dark defaults.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

mkdirSync('dist', { recursive: true });
await esbuild.build({ entryPoints: ['test/preview-data.ts'], outfile: 'dist/preview-data.cjs', bundle: true,
  platform: 'node', format: 'cjs', logLevel: 'warning' });
const data = execFileSync(process.execPath, ['dist/preview-data.cjs']).toString();
const css = readFileSync('media/webview.css', 'utf8');
const js = readFileSync('dist/webview.js', 'utf8');

const theme = `
:root {
  --vscode-editor-foreground: #d4d4d4; --vscode-editor-background: #1e1e1e;
  --vscode-editorLineNumber-foreground: #6e7681; --vscode-focusBorder: #3794ff;
  --vscode-textLink-foreground: #4daafc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-editorWidget-border: #454545; --vscode-disabledForeground: #6b6b6b;
  --vscode-panel-border: #333; --vscode-button-background: #0e639c; --vscode-button-foreground: #fff;
  --vscode-button-secondaryBackground: #3a3d41; --vscode-button-secondaryForeground: #ccc;
  --vscode-list-hoverBackground: #2a2d2e; --vscode-list-activeSelectionBackground: #04395e;
  --vscode-editor-selectionHighlightBackground: #3a3d4199; --vscode-font-family: sans-serif;
}`;

const mock = `
const DATA = ${data};
DATA.style = JSON.parse(JSON.stringify(DATA.style));
const params = new URLSearchParams(location.search);
const which = params.get('doc') || 'exp4';
let state = {};
const initial = JSON.parse(DATA.docs[which]);
for (const p of ['edges', 'order', 'parentRule', 'curve']) if (params.get(p)) initial.view[p] = params.get(p);
if (params.get('boxes')) initial.view.boxes = params.get('boxes') === 'on';
if (params.get('fill')) DATA.style.boxes.fill = params.get('fill');
let text = JSON.stringify(initial, null, 1) + '\\n';
const log = (m) => { const el = document.getElementById('log'); if (el) el.textContent = JSON.stringify(m).slice(0, 300); };
// simulated drag (sim=drag&label=<text>&dx=&dy=): runs synchronously after the first render
const simulate = () => {
  if (params.get('sim') !== 'drag') return;
  const want = params.get('label') || '';
  const scope = params.get('box') ? '.heads g' : '.labels g';
  const g = [...document.querySelectorAll(scope)].find((x) => (x.querySelector('text')?.textContent ?? '').includes(want));
  if (!g) { log({ sim: 'no label ' + want }); return; }
  const r = g.getBoundingClientRect();
  const x = r.left + 5, y = r.top + r.height / 2;
  const dx = +(params.get('dx') || 0), dy = +(params.get('dy') || 0);
  const ev = (type, cx, cy, target) => target.dispatchEvent(new MouseEvent(type, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0 }));
  if (params.get('dbl')) { g.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true, view: window })); return; }
  ev('mousedown', x, y, g);
  for (let i = 1; i <= 10; i++) ev('mousemove', x + (dx * i) / 10, y + (dy * i) / 10, window);
  ev('mouseup', x + dx, y + dy, window);
};
// messages to the webview are delivered synchronously, so the page is final when it finishes loading
const deliver = () => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', text, name: which, style: DATA.style } }));
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    log(m);
    if (m.type === 'ready') queueMicrotask(() => { deliver(); simulate(); });
    if (m.type === 'edit') { text = m.text; deliver(); }
  },
  getState() { return state; },
  setState(s) { state = s; },
});`;

writeFileSync('dist/preview.html', `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>gaffy preview</title>
<style>${theme}\n${css}\n#log{font:11px monospace;color:#888;padding:2px 8px}</style></head>
<body><div id="toolbar"></div><svg id="graph" tabindex="0"></svg><div id="status"></div><div id="log"></div>
<script>${mock}</script><script>${js}</script></body></html>
`);
console.log('dist/preview.html');
