/**
 * Custom text editor for `*.gaffy` view files. The TextDocument holds the view as JSON; the webview
 * renders it and posts whole-document edits back. VS Code supplies tabs, dirty state, undo, redo,
 * save and hot exit through the TextDocument.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { globToRegExp, parseDoc, serializeDoc, ViewDoc } from '../core/viewdoc';
import { applyBuild, buildGraph, BuildMode, BuildProgress } from './build';
import { CallCache } from './cache';
import { LspProvider } from './lsp';
import { folderOf, gaffyDir, StyleService } from './style';

export class Session {
  private busy = false;

  constructor(
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
    private readonly host: GaffyEditor,
  ) {}

  get folder(): vscode.Uri { return folderOf(this.document.uri); }
  get name(): string { return path.basename(this.document.uri.path, '.gaffy'); }

  doc(): ViewDoc {
    try {
      return parseDoc(this.document.getText(), this.name);
    } catch (e) {
      throw new Error(`gaffy: ${this.document.uri.fsPath} is not valid JSON: ${(e as Error).message}`);
    }
  }

  async write(doc: ViewDoc): Promise<void> {
    const text = serializeDoc(doc);
    if (text === this.document.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    const end = this.document.lineAt(Math.max(0, this.document.lineCount - 1)).range.end;
    edit.replace(this.document.uri, new vscode.Range(new vscode.Position(0, 0), end), text);
    await vscode.workspace.applyEdit(edit);
    if (vscode.workspace.getConfiguration('gaffy').get<boolean>('autoSave')) await this.document.save();
  }

  async post(): Promise<void> {
    const style = await this.host.styles.get(this.folder);
    const exclude = vscode.workspace.getConfiguration('gaffy', this.document.uri).get<string[]>('exclude') ?? [];
    void this.panel.webview.postMessage({ type: 'state', text: this.document.getText(), name: this.name, style, exclude, busy: this.busy });
  }

  /**
   * Rebuild from the seeds. `cached` (default): cached answers, the language server for the rest.
   * `revalidate`: first from the cache alone (instant), then every definition again from the language server.
   * Progress: banner in the graph, and after 400 ms a notification with a cancel button.
   */
  async refresh(mutate?: (d: ViewDoc) => void, how: 'cached' | 'revalidate' = 'cached'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const cts = new vscode.CancellationTokenSource();
    let text = 'starting';
    let notify: ((t: string) => void) | undefined;
    const show = (t: string) => {
      text = t;
      void this.panel.webview.postMessage({ type: 'progress', text: t });
      notify?.(t);
    };
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const timer = setTimeout(() => {
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `gaffy: ${this.name}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => cts.cancel());
          notify = (t) => progress.report({ message: t });
          notify(text);
          await finished;
        });
    }, 400);
    void this.panel.webview.postMessage({ type: 'busy', busy: true });
    try {
      const doc = this.doc();
      mutate?.(doc);
      const cfg = vscode.workspace.getConfiguration('gaffy', this.document.uri);
      const opts = {
        maxNodes: cfg.get<number>('maxNodes') ?? 400,
        exclude: (cfg.get<string[]>('exclude') ?? []).map(globToRegExp),
        cache: this.host.cacheFor(this.folder),
        token: cts.token,
      };
      await opts.cache.ready();
      const fmt = (phase: string) => (q: BuildProgress) =>
        show(`${phase} · depth ${q.level}/${q.depth} · ${q.definitions} definitions · ${q.requests} language-server requests · ${q.cached} cached`);
      const phases: BuildMode[] = how === 'revalidate' ? ['cacheOnly', 'fresh'] : ['cached'];
      let current = doc;
      for (const mode of phases) {
        const label = mode === 'cacheOnly' ? 'from cache' : mode === 'fresh' ? 'asking the language server' : 'building';
        show(label);
        const r = await buildGraph(this.host.provider, current, { ...opts, mode, progress: fmt(label) });
        if (cts.token.isCancellationRequested) { show('cancelled'); break; }
        if (mode !== 'cacheOnly' && r.missing.length) {
          void vscode.window.showWarningMessage(`gaffy: seeds not resolved: ${r.missing.map((k) => k.split('#').pop()).join(', ')}`);
        }
        if (mode === 'cacheOnly' && !Object.keys(r.graph.edges).length && !Object.keys(current.graph.nodes).length) continue;
        current = applyBuild(current, r);
        await this.write(current);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`gaffy: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      done();
      cts.dispose();
      this.busy = false;
      void this.panel.webview.postMessage({ type: 'busy', busy: false });
    }
  }

  /** Applies a local change without querying the provider. */
  async update(mutate: (d: ViewDoc) => void): Promise<void> {
    const doc = this.doc();
    mutate(doc);
    await this.write(doc);
  }
}

export class GaffyEditor implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'gaffy.view';
  readonly sessions = new Map<string, Session>();
  active: Session | undefined;
  private caches = new Map<string, CallCache>();

  /** Call cache of a workspace folder, `.gaffy/cache/calls.json`. */
  cacheFor(folder: vscode.Uri): CallCache {
    const k = folder.toString();
    let c = this.caches.get(k);
    if (!c) this.caches.set(k, (c = new CallCache(vscode.Uri.joinPath(gaffyDir(folder), 'cache', 'calls.json'))));
    return c;
  }

  allCaches(): CallCache[] { return [...this.caches.values()]; }

  /** Handlers for webview messages that need commands (open, expand, export). */
  onMessage: (s: Session, m: { type: string; [k: string]: unknown }) => Promise<void> = async () => {};

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly styles: StyleService,
    readonly provider: LspProvider,
  ) {
    ctx.subscriptions.push(styles.onDidChange(() => this.sessions.forEach((s) => void s.post())));
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const s = new Session(document, panel, this);
    const id = `${document.uri.toString()}#${Math.random().toString(36).slice(2)}`;
    this.sessions.set(id, s);
    this.active = s;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    panel.webview.html = this.html(panel.webview, dist, media);

    const subs = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length) void s.post();
      }),
      panel.onDidChangeViewState(() => { if (panel.active) this.active = s; }),
      panel.webview.onDidReceiveMessage(async (m) => {
        try {
          if (m.type === 'ready') {
            await s.post();
            const doc = s.doc();
            if (doc.view.seeds.length && !Object.keys(doc.graph.nodes).length) await s.refresh();
          } else if (m.type === 'edit') {
            const doc = parseDoc(m.text, s.name);
            await s.write(doc);
            if (m.rebuild) await s.refresh();
          } else {
            await this.onMessage(s, m);
          }
        } catch (e) {
          void vscode.window.showErrorMessage(`gaffy: ${(e as Error).message}`);
        }
      }),
    ];
    panel.onDidDispose(() => {
      subs.forEach((d) => d.dispose());
      this.sessions.delete(id);
      if (this.active === s) this.active = undefined;
    });
  }

  private html(webview: vscode.Webview, dist: vscode.Uri, media: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    const canvas = JSON.stringify({ webviewSection: 'canvas', preventDefaultContextMenuItems: true });
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body data-vscode-context='${canvas}'>
<div id="toolbar"></div>
<div id="banner"></div>
<svg id="graph" tabindex="0"></svg>
<div id="status"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
