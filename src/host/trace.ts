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
import { Cause, Moved, traceRecord } from './tracerec';

const on = (uri: vscode.Uri) => vscode.workspace.getConfiguration('gaffy', uri).get<boolean>('trace') ?? false;

export class Trace {
    private last = new Map<string, ViewDoc>();
    private pending = new Map<string, { cause: Cause; moved?: Moved }>();
    private seq = new Map<string, number>();
    private command: string | undefined;

    /** The cause of the next change of `doc` (a webview edit). */
    edit(doc: vscode.TextDocument, cause: Cause | undefined, moved: Moved | undefined) {
        if (cause) this.pending.set(doc.uri.toString(), { cause, moved });
    }

    /** A host command ran: the next change is its doing unless the webview names another cause. */
    ran(id: string) { this.command = id; }

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
        this.command = undefined;
        if (!on(doc.uri)) return;
        const cause: Cause = reason === vscode.TextDocumentChangeReason.Undo ? { event: 'undo' }
            : reason === vscode.TextDocumentChangeReason.Redo ? { event: 'redo' }
                : p?.cause ?? (command ? { event: 'command', fn: command } : { event: 'external' });
        const n = (this.seq.get(id) ?? 0) + 1;
        this.seq.set(id, n);
        const name = path.basename(doc.uri.path, '.gaffy');
        const rec = traceRecord(before, now, cause, p?.moved, name, n);
        const file = vscode.Uri.joinPath(gaffyDir(folderOf(doc.uri)), 'trace', `${name}.jsonl`);
        if (file.scheme !== 'file') return;
        await fs.mkdir(path.dirname(file.fsPath), { recursive: true });
        await fs.appendFile(file.fsPath, JSON.stringify(rec) + '\n');
    }
}
