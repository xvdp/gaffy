/** @xvdp
 * Style per workspace folder: DEFAULT_STYLE ← setting `gaffy.style` ← `<folder>/.baggy/gaffy/style.json`.
 * Fires `onDidChange` on either source change. Data folders: `.baggy/gaffy/` (gaffy), `.baggy/giddy/` (giddy reports).
 */
import * as vscode from 'vscode';
import { plain } from '../core/model';
import { boundedStyle, deepMerge, DEFAULT_STYLE, Style } from '../core/style';

/** gaffy data folder of a project folder: views, text exports, `style.json`, `cache/`, `trace/`. */
export const gaffyDir = (folder: vscode.Uri) => vscode.Uri.joinPath(folder, '.baggy', 'gaffy');

/** Folder holding a view's data folder: `<X>/.baggy/gaffy/…` → X; legacy layout `<X>/.gaffy/…` → X. */
export function holderOf(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme === 'untitled') uri = vscode.Uri.file(uri.path);
    const parts = uri.path.split('/');
    for (let i = parts.length - 2; i > 0; i--) {
        if ((parts[i] === '.baggy' && parts[i + 1] === 'gaffy') || parts[i] === '.gaffy') return uri.with({ path: parts.slice(0, i).join('/') });
    }
    return undefined;
}

/** Workspace folder of a view (style, call cache); outside every workspace folder: its holder, else its folder. */
export function folderOf(uri: vscode.Uri): vscode.Uri {
    // untitled view: its path is the save target
    if (uri.scheme === 'untitled') uri = vscode.Uri.file(uri.path);
    const f = vscode.workspace.getWorkspaceFolder(uri);
    if (f) return f.uri;
    return holderOf(uri) ?? vscode.Uri.joinPath(uri, '..');
}

/**
 * Project of a view: the folder holding its data folder (a repository giddy or a script wrote into), else its
 * workspace folder. Seed paths, text exports, trace and the commit hash refer to it.
 */
export function homeOf(uri: vscode.Uri): vscode.Uri {
    return holderOf(uri) ?? folderOf(uri);
}

export class StyleService implements vscode.Disposable {
    private cache = new Map<string, Promise<Style>>();
    private emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;
    private subs: vscode.Disposable[] = [];

    constructor() {
        const w = vscode.workspace.createFileSystemWatcher('**/.baggy/gaffy/style.json');
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
                void vscode.window.showWarningMessage(plain(`gaffy: .baggy/gaffy/style.json ignored: ${(e as Error).message}`));
            }
        }
        return boundedStyle(deepMerge(DEFAULT_STYLE, setting, file));
    }

    dispose(): void {
        this.subs.forEach((s) => s.dispose());
        this.emitter.dispose();
    }
}
