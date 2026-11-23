/** @xvdp
 * View change trace, on with the setting `gaffy.trace`: one JSON line per change of a view document, appended
 * to `.gaffy/trace/<view>.jsonl` in the view's workspace folder. VS Code's undo stack keeps whole document
 * texts only, without the event that made them; the trace adds that event.
 *
 * Record: `t` (ISO time), `view`, `seq` (per view, from 1 in each session), `cause`, `changed`, `graph`, `moved`.
 * - `cause`: what the webview reports for its own edits (`event`: click, dblclick, mousedown (a drag), key …,
 *   menu <command>, auto; `target`: the vertex key, call or text under the pointer; `cell`: [row, column] of
 *   the grid; `fn`: the functions that acted, `›` between nested ones; `args`), else `undo`, `redo`, the id of
 *   the host command that ran last (`command`), or `external` (language server answers, edits of the file).
 * - `changed`: per view field that differs, objects as `{key: [before, after]}`, arrays as `{added, removed}`,
 *   other values as `[before, after]` (null: absent).
 * - `graph`: functions and calls added or removed (`nodes`, `edges`: [added, removed]) when the data changed.
 * - `moved`: labels (vertex keys) and frames (box units) whose grid cell changed, `[key, before, after]`
 *   (webview edits only; null where one appeared or left).
 * `tools/gaffy-trace.mjs` prints a trace as a list.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseDoc, ViewDoc } from '../core/viewdoc';
import { folderOf, gaffyDir } from './style';
import { noLinks } from './safefs';
import { Cause, checkedCause, Moved, traceRecord } from './tracerec';

const on = (uri: vscode.Uri) => vscode.workspace.getConfiguration('gaffy', uri).get<boolean>('trace') ?? false;
/** Size at which a trace file moves to `<view>.1.jsonl` (replacing the previous one) and a new file starts: at most 2 × 20 MB per view. */
const MAX_BYTES = 20 * 1024 * 1024;

export class Trace {
    private last = new Map<string, ViewDoc>();
    private pending = new Map<string, { cause: Cause; moved?: Moved }>();
    private seq = new Map<string, number>();
    private command: string | undefined;

    /** The cause of the next change of `doc` (a webview edit; its fields checked, tracerec.ts `checkedCause`). */
    edit(doc: vscode.TextDocument, cause: unknown, moved: unknown) {
        const c = checkedCause(cause, moved);
        if (c) this.pending.set(doc.uri.toString(), c);
    }

    /** After an edit was written: a cause no change consumed (the text did not change) goes, so it names nothing later. */
    written(doc: vscode.TextDocument) { this.pending.delete(doc.uri.toString()); }

    /** A host command runs (`id`) or ended (undefined): changes meanwhile are its doing unless the webview names another cause. */
    ran(id: string | undefined) { this.command = id; }

    /** The view as last recorded, so the first change after opening has a before. */
    open(doc: vscode.TextDocument) {
        try { this.last.set(doc.uri.toString(), parseDoc(doc.getText(), 'v')); } catch { /* invalid JSON: no before */ }
    }

    async change(doc: vscode.TextDocument, reason: vscode.TextDocumentChangeReason | undefined): Promise<void> {
        const id = doc.uri.toString();
        let now: ViewDoc;
        try { now = parseDoc(doc.getText(), 'v'); } catch { return; }
        const before = this.last.get(id);
        this.last.set(id, now);
        const p = this.pending.get(id);
        this.pending.delete(id);
        const command = this.command;
        if (!on(doc.uri)) return;
        const cause: Cause = reason === vscode.TextDocumentChangeReason.Undo ? { event: 'undo' }
            : reason === vscode.TextDocumentChangeReason.Redo ? { event: 'redo' }
                : p?.cause ?? (command ? { event: 'command', fn: command } : { event: 'external' });
        const n = (this.seq.get(id) ?? 0) + 1;
        this.seq.set(id, n);
        const name = path.basename(doc.uri.path, '.gaffy');
        const rec = traceRecord(before, now, cause, p?.moved, name, n);
        // only in a trusted workspace, never through a symbolic link (safefs.ts)
        if (!vscode.workspace.isTrusted) return;
        const base = folderOf(doc.uri);
        const file = vscode.Uri.joinPath(gaffyDir(base), 'trace', `${name}.jsonl`);
        const old = vscode.Uri.joinPath(gaffyDir(base), 'trace', `${name}.1.jsonl`);
        if (file.scheme !== 'file') return;
        await noLinks(base, file);
        await noLinks(base, old);
        await fs.mkdir(path.dirname(file.fsPath), { recursive: true });
        try {
            if ((await fs.stat(file.fsPath)).size > MAX_BYTES) await fs.rename(file.fsPath, old.fsPath);
        } catch { /* no file yet */ }
        await fs.appendFile(file.fsPath, JSON.stringify(rec) + '\n');
    }
}
