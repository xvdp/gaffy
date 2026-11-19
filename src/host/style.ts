/**
 * Style per workspace folder: DEFAULT_STYLE ← setting `gaffy.style` ← `<folder>/.gaffy/style.json`.
 * Fires `onDidChange` when either source changes.
 */
import * as vscode from 'vscode';
import { deepMerge, DEFAULT_STYLE, Style } from '../core/style';

export const gaffyDir = (folder: vscode.Uri) => vscode.Uri.joinPath(folder, '.gaffy');

export function folderOf(uri: vscode.Uri): vscode.Uri {
  // an unsaved view (untitled document) carries the path it will be saved to
  if (uri.scheme === 'untitled') uri = vscode.Uri.file(uri.path);
  const f = vscode.workspace.getWorkspaceFolder(uri);
  if (f) return f.uri;
  // a view file outside any workspace folder: its .gaffy parent's parent
  const parts = uri.path.split('/');
  const i = parts.lastIndexOf('.gaffy');
  return i > 0 ? uri.with({ path: parts.slice(0, i).join('/') }) : vscode.Uri.joinPath(uri, '..');
}

export class StyleService implements vscode.Disposable {
  private cache = new Map<string, Promise<Style>>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private subs: vscode.Disposable[] = [];

  constructor() {
    const w = vscode.workspace.createFileSystemWatcher('**/.gaffy/style.json');
    const bust = () => { this.cache.clear(); this.emitter.fire(); };
    this.subs.push(w, w.onDidChange(bust), w.onDidCreate(bust), w.onDidDelete(bust),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gaffy.style') && bust()));
  }

  get(folder: vscode.Uri): Promise<Style> {
    const k = folder.toString();
    let p = this.cache.get(k);
    if (!p) {
      p = this.load(folder);
      this.cache.set(k, p);
    }
    return p;
  }

  private async load(folder: vscode.Uri): Promise<Style> {
    const setting = vscode.workspace.getConfiguration('gaffy', folder).get<object>('style') ?? {};
    let file: unknown = {};
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(gaffyDir(folder), 'style.json'));
      file = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      if (!(e instanceof vscode.FileSystemError)) {
        void vscode.window.showWarningMessage(`gaffy: .gaffy/style.json ignored: ${(e as Error).message}`);
      }
    }
    return deepMerge(DEFAULT_STYLE, setting, file);
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}
