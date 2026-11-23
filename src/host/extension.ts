/** @xvdp
 * Entry point: registers the `.gaffy` custom editor, commands and change handlers.
 * - source save: drops the file's caches; open views rebuild per `gaffy.refreshOnSave` (views containing the
 *   file, all, none), debounced 800 ms;
 * - file rename: rewrites keys, paths and URIs in open views, then rebuilds them.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkOnStart, showReport } from './servers';
import { registerCommands } from './commands';
import { GaffyEditor, Session } from './editor';
import { LspProvider } from './lsp';
import { StyleService } from './style';

export function activate(ctx: vscode.ExtensionContext): void {
    const styles = new StyleService();
    const provider = new LspProvider(() => vscode.workspace.getConfiguration('gaffy').get<boolean>('includeExternal') ?? false);
    const editor = new GaffyEditor(ctx, styles, provider);
    ctx.subscriptions.push(
        styles,
        vscode.window.registerCustomEditorProvider(GaffyEditor.viewType, editor, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true,
        }),
    );
    registerCommands(ctx, editor);
    ctx.subscriptions.push(vscode.commands.registerCommand('gaffy.checkServers', () => showReport()));
    // notification of missing language servers for the workspace's languages (once per version)
    setTimeout(() => void checkOnStart(ctx).catch(() => undefined), 4000);

    const isGaffy = (u: vscode.Uri) => u.path.endsWith('.gaffy') || u.path.includes('/.gaffy/');
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
        const saved = [...pending];
        pending.clear();
        const mode = vscode.workspace.getConfiguration('gaffy').get<string>('refreshOnSave') ?? 'touched';
        const done = new Set<string>();
        for (const s of editor.sessions.values()) {
            const id = s.document.uri.toString();
            if (done.has(id)) continue;
            const doc = s.doc();
            const touched = Object.values(doc.graph.nodes).some((n) => n.uri && saved.includes(n.uri));
            if (mode === 'all' || touched) {
                done.add(id);
                void s.refresh();
            }
        }
    };
    // files changed outside the editor (git checkout, generators): their cached calls are stale
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', true, false, true);
    ctx.subscriptions.push(watcher, watcher.onDidChange((u) => {
        if (isGaffy(u)) return;
        provider.invalidate(u);
        for (const c of editor.allCaches()) c.invalidate(u.toString());
    }));
    ctx.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((d) => {
            if (isGaffy(d.uri)) return;
            provider.invalidate(d.uri);
            for (const c of editor.allCaches()) c.invalidate(d.uri.toString());
            if ((vscode.workspace.getConfiguration('gaffy').get<string>('refreshOnSave') ?? 'touched') === 'off') return;
            pending.add(d.uri.toString());
            clearTimeout(timer);
            timer = setTimeout(flush, 800);
        }),
        vscode.workspace.onDidRenameFiles(async (e) => {
            for (const f of e.files) {
                provider.invalidate(f.oldUri); provider.invalidate(f.newUri);
                for (const c of editor.allCaches()) { c.invalidate(f.oldUri.toString()); c.invalidate(f.newUri.toString()); }
            }
            const seen = new Set<string>();
            const touched: Session[] = [];
            for (const s of editor.sessions.values()) {
                const id = s.document.uri.toString();
                if (seen.has(id)) continue;
                seen.add(id);
                let text = s.document.getText();
                const before = text;
                for (const f of e.files) {
                    const folder = vscode.workspace.getWorkspaceFolder(f.oldUri);
                    if (!folder) continue;
                    const oldRel = path.posix.relative(folder.uri.path, f.oldUri.path);
                    const newRel = path.posix.relative(folder.uri.path, f.newUri.path);
                    text = text.split(f.oldUri.toString()).join(f.newUri.toString())
                        .split(`:${oldRel}`).join(`:${newRel}`)
                        .split(`"${oldRel}"`).join(`"${newRel}"`);
                }
                if (text !== before) {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(s.document.uri, new vscode.Range(0, 0, s.document.lineCount, 0), text);
                    await vscode.workspace.applyEdit(edit);
                    touched.push(s);
                }
            }
            touched.forEach((s) => void s.refresh());
        }),
    );
}

export function deactivate(): void {}
