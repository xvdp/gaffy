/** @xvdp
 * View change trace (`gaffy.trace`): one JSON line per view-document change in `.gaffy/trace/<view>.jsonl`;
 * records the causing event, absent from VS Code's undo stack. `tools/gaffy-trace.mjs` prints it as a list.
 * Fields: `t` (ISO time), `view`, `seq` (per view and session, from 1), `cause`, `changed`, `graph`, `moved`.
 * - `cause`: webview edit: `event` (click, dblclick, mousedown = drag, key …, menu <command>, auto), `target`
 *   (vertex key, call or text under the pointer), `cell` (grid [row, column]), `fn` (acting functions, `›`
 *   nesting), `args`; else `undo`, `redo`, `command` (last host command id), `external` (server answers, file edits).
 * - `changed`: differing view fields; objects `{key: [before, after]}`, arrays `{added, removed}`, else
 *   `[before, after]` (null: absent).
 * - `graph`: `nodes`, `edges` counts `[added, removed]` on data change.
 * - `moved`: `[key, before, after]` grid cells of labels (vertex keys) and frames (box units); webview edits
 *   only; null on appear or leave.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseDoc, ViewDoc } from '../core/viewdoc';
import { folderOf, gaffyDir } from './style';
import { noLinks } from './safefs';
import { Cause, checkedCause, Moved, traceRecord } from './tracerec';

const on = (uri: vscode.Uri) => vscode.workspace.getConfiguration('gaffy', uri).get<boolean>('trace') ?? false;
/** Rotation size: the trace moves to `<view>.1.jsonl` (replacing it) and restarts; ≤ 2 × 20 MB per view. */
const MAX_BYTES = 20 * 1024 * 1024;

export class Trace {
    private last = new Map<string, ViewDoc>();
    private pending = new Map<string, { cause: Cause; moved?: Moved }>();
    private seq = new Map<string, number>();
    private command: string | undefined;

    /** Cause of the next change of `doc` (webview edit; tracerec.ts `checkedCause`). */
    edit(doc: vscode.TextDocument, cause: unknown, moved: unknown) {
        const c = checkedCause(cause, moved);
        if (c) this.pending.set(doc.uri.toString(), c);
    }

    /** After an edit write: drops an unconsumed cause (text unchanged). */
    written(doc: vscode.TextDocument) { this.pending.delete(doc.uri.toString()); }

    /** Host command start (`id`) or end (undefined): default cause of changes meanwhile. */
    ran(id: string | undefined) { this.command = id; }

    /** Records the opened view as the `before` of its first change. */
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
        // trusted workspace only, never through a symbolic link (safefs.ts)
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
