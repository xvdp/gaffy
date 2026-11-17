/**
 * Custom text editor for `*.gaffy` view files. The TextDocument holds the view as JSON; the webview
 * renders it and posts whole-document edits back. VS Code supplies tabs, dirty state, undo, redo,
 * save and hot exit through the TextDocument.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseDoc, serializeDoc, ViewDoc } from '../core/viewdoc';
import { buildGraph, reconcile } from './build';
import { LspProvider } from './lsp';
import { folderOf, StyleService } from './style';

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
    void this.panel.webview.postMessage({ type: 'state', text: this.document.getText(), name: this.name, style, busy: this.busy });
  }

  async refresh(mutate?: (d: ViewDoc) => void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    void this.panel.webview.postMessage({ type: 'busy', busy: true });
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `gaffy: building ${this.name}`, cancellable: false },
        async () => {
          const doc = this.doc();
          mutate?.(doc);
          const max = vscode.workspace.getConfiguration('gaffy').get<number>('maxNodes') ?? 400;
          const r = await buildGraph(this.host.provider, doc, { maxNodes: max });
          if (r.missing.length) {
            void vscode.window.showWarningMessage(`gaffy: seeds not resolved: ${r.missing.map((k) => k.split('#').pop()).join(', ')}`);
          }
          await this.write(reconcile(doc, r));
        });
    } catch (e) {
      void vscode.window.showErrorMessage(`gaffy: ${(e as Error).message}`);
    } finally {
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
<svg id="graph" tabindex="0"></svg>
<div id="status"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
