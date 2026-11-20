/**
 * Custom text editor for `*.gaffy` view files. The TextDocument holds the view as JSON; the webview
 * renders it and posts whole-document edits back. VS Code supplies tabs, dirty state, undo, redo,
 * save and hot exit through the TextDocument.
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isContainer, NodeKey, plain } from '../core/model';
import { globToRegExp, parseDoc, serializeDoc, ViewDoc } from '../core/viewdoc';
import { BuildMode, extendGraph, Extension, Pair } from './build';
import { frontierOf, visibleOf } from '../core/scene';
import { CallCache } from './cache';
import { LspProvider, MAX_CALLS } from './lsp';
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
        // an unsaved (untitled) view stays unsaved until the user saves it
        if (!this.document.isUntitled && vscode.workspace.getConfiguration('gaffy').get<boolean>('autoSave')) await this.document.save();
    }

    async post(): Promise<void> {
        const style = await this.host.styles.get(this.folder);
        const cfg = vscode.workspace.getConfiguration('gaffy', this.document.uri);
        const exclude = cfg.get<string[]>('exclude') ?? [];
        // settings the Options panel shows and toggles
        const settings = { includeExternal: cfg.get<boolean>('includeExternal') ?? false, includeStandardLibrary: cfg.get<boolean>('includeStandardLibrary') ?? false,
            saveViews: cfg.get<boolean>('saveViews') ?? false, untitled: this.document.isUntitled };
        void this.panel.webview.postMessage({ type: 'state', text: this.document.getText(), name: this.name, style, exclude, settings, busy: this.busy });
    }

    private queue: Promise<void> = Promise.resolve();

    /** Provider work of one view runs one task at a time. */
    private enqueue(task: () => Promise<void>): Promise<void> {
        this.queue = this.queue.then(task, task);
        return this.queue;
    }

    // urgent tasks queued, and the token of the background work running (neighbor checks, prefetch)
    private waiting = 0;
    private yieldFor: vscode.CancellationTokenSource | undefined;

    /**
     * A task the user waits for (a side opened, an edit): background work running in the queue stops at
     * its next request (answers so far are kept, the rest stays unasked) and this task runs next; it
     * redoes the neighbor checks it needs.
     */
    private urgent(task: () => Promise<void>): Promise<void> {
        this.waiting++;
        this.yieldFor?.cancel();
        return this.enqueue(async () => { this.waiting--; await task(); });
    }

    /** Token for background work: cancelled with `token`, or when an urgent task is queued. */
    private background(token: vscode.CancellationToken): { token: vscode.CancellationToken; end: () => void } {
        const cts = new vscode.CancellationTokenSource();
        const sub = token.onCancellationRequested(() => cts.cancel());
        this.yieldFor = cts;
        if (this.waiting) cts.cancel();
        return { token: cts.token, end: () => { sub.dispose(); if (this.yieldFor === cts) this.yieldFor = undefined; cts.dispose(); } };
    }

    /** Banner in the graph, and after 400 ms a notification with a cancel button. */
    private async progress(fn: (show: (t: string) => void, token: vscode.CancellationToken) => Promise<void>): Promise<void> {
        const cts = new vscode.CancellationTokenSource();
        let text = 'starting';
        let notify: ((t: string) => void) | undefined;
        const show = (t: string) => { text = t; void this.panel.webview.postMessage({ type: 'progress', text: t }); notify?.(t); };
        let done!: () => void;
        const finished = new Promise<void>((r) => { done = r; });
        const timer = setTimeout(() => {
            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: plain(`gaffy: ${this.name}`), cancellable: true },
                async (progress, token) => {
                    token.onCancellationRequested(() => cts.cancel());
                    notify = (t) => progress.report({ message: plain(t) });
                    notify(text);
                    await finished;
                });
        }, 400);
        this.busy = true;
        void this.panel.webview.postMessage({ type: 'busy', busy: true });
        try {
            await fn(show, cts.token);
        } catch (e) {
            void vscode.window.showErrorMessage(plain(`gaffy: ${(e as Error).message}`));
        } finally {
            clearTimeout(timer);
            done();
            cts.dispose();
            this.busy = false;
            void this.panel.webview.postMessage({ type: 'busy', busy: false });
        }
    }

    private opts() {
        const cfg = vscode.workspace.getConfiguration('gaffy', this.document.uri);
        return {
            maxNodes: cfg.get<number>('maxNodes') ?? 400,
            exclude: (cfg.get<string[]>('exclude') ?? []).map(globToRegExp),
            external: cfg.get<boolean>('includeExternal') ?? false,
            // external code drawn, and of it the standard library (scene.ts `Outside`)
            outside: { external: cfg.get<boolean>('includeExternal') ?? false, standard: cfg.get<boolean>('includeStandardLibrary') ?? false },
            cache: this.host.cacheFor(this.folder),
        };
    }

    /** Ask for (definition, direction) pairs and merge the answers into the current document; writes only on change. */
    private async ask(qs: Pair[], mode: BuildMode, label: string,
        show: (t: string) => void, token?: vscode.CancellationToken): Promise<Extension | undefined> {
        if (!qs.length) return undefined;
        const o = this.opts();
        await o.cache.ready();
        const r = await extendGraph(this.host.provider, this.doc(), qs, { ...o, mode, token, doubted: this.doubted,
            progress: (q) => show(`${label} · ${q.definitions} definitions · ${q.requests} language-server requests · ${q.cached} cached`) });
        const now = this.doc();
        const before = signature(now);
        now.graph = r.graph;
        now.explored = r.explored;
        if (signature(now) !== before) {
            now.updated = new Date().toISOString();
            await this.write(now);
        }
        for (const u of r.unresolved) this.pending.set(`${u.dir}:${u.key}`, u);
        this.limits(r);
        return r;
    }

    // limits reported once per view and session: `<dir>:<key>` of answers cut at MAX_CALLS, and `maxNodes`
    private warned = new Set<string>();

    /** Warns of answers cut at the call limit and of calls lists not asked at the definition limit. */
    private limits(r: Extension): void {
        const cut = r.clamped.filter((c) => !this.warned.has(`${c.dir}:${c.key}`));
        for (const c of cut) this.warned.add(`${c.dir}:${c.key}`);
        if (cut.length) {
            const c = cut[0];
            const more = cut.length > 1 ? ` ${cut.length - 1} more answers are cut the same way.` : '';
            void vscode.window.showWarningMessage(plain(`gaffy: ${this.name}: ${r.graph.nodes[c.key]?.name ?? c.key}() has ${c.total} `
                + `${c.dir === 'out' ? 'calls' : 'callers'} in the language server's answer; the view takes the first ${MAX_CALLS} `
                + `(security limit on one answer).${more}`));
        }
        if (r.capped && !this.warned.has('maxNodes')) {
            this.warned.add('maxNodes');
            const max = this.opts().maxNodes;
            void vscode.window.showWarningMessage(plain(`gaffy: ${this.name}: the view holds ${max} definitions (gaffy.maxNodes); `
                + `${r.capped} calls lists were not asked, so some sides open empty.`), 'Open Setting')
                .then((pick) => pick && vscode.commands.executeCommand('workbench.action.openSettings', 'gaffy.maxNodes'));
        }
    }

    private unasked(doc: ViewDoc, keys: NodeKey[], dirs: ('in' | 'out')[]): Pair[] {
        return this.unaskedPairs(doc, keys.flatMap((key) => dirs.map((dir) => ({ key, dir }))));
    }

    private unaskedPairs(doc: ViewDoc, pairs: Pair[]): Pair[] {
        const ex = doc.explored ?? {};
        return pairs.filter(({ key, dir }) => ex[key] !== dir && ex[key] !== 'both');
    }

    // pairs without an answer in the current task; retried with backoff while the language server starts
    private pending = new Map<string, Pair>();
    // empty answers that would drop a definition's stored calls, per `<dir>:<key>`: counted until confirmed (build.ts)
    private doubted = new Map<string, number>();
    private retries = 0;
    private retryTimer: NodeJS.Timeout | undefined;

    /** After a task: retry unresolved pairs later, or report them after the last attempt. */
    private settle(): void {
        const n = this.pending.size;
        this.pending.clear();
        clearTimeout(this.retryTimer);
        if (!n) { this.retries = 0; this.note(); return; }
        if (this.retries >= RETRY_S.length) {
            this.retries = 0;
            this.note(`language server: ${n} calls lists unresolved, stored calls kept`);
            void vscode.window.showWarningMessage(plain(`gaffy: ${this.name}: the language server resolved no answer for ${n} (definition, direction) pairs `
                + '(still analyzing, renamed or removed). The view keeps their stored calls; Options > Refresh from Language Server retries.'));
            return;
        }
        const sec = RETRY_S[this.retries++];
        this.note(`language server not ready: ${n} calls lists unresolved, retry in ${sec} s`);
        this.retryTimer = setTimeout(() => void this.revalidate(), sec * 1000);
    }

    private note(text?: string): void { void this.panel.webview.postMessage({ type: 'note', text: text ?? '' }); }

    dispose(): void { clearTimeout(this.retryTimer); }

    /**
     * Visible definitions: the directions each may open (seeds both, others the direction that revealed
     * them) asked once, so the markers know what lies beyond. An answer can reveal more (an open side, or a
     * level within a full view's depth), so this repeats until nothing visible is unasked: at most 8 rounds
     * (one per revealed layer), 64 in full views (`all` levels; `gaffy.maxNodes` bounds the data).
     */
    private async neighbors(show: (t: string) => void, token: vscode.CancellationToken): Promise<void> {
        const bg = this.background(token);
        try {
            const rounds = this.doc().view.arrange === 'grow' ? 8 : 64;
            for (let i = 0; i < rounds && !bg.token.isCancellationRequested; i++) {
                const qs = this.unaskedPairs(this.doc(), frontierOf(this.doc(), this.opts().exclude, this.opts().outside));
                if (!qs.length || !(await this.ask(qs, 'cached', 'checking neighbors', show, bg.token))?.asked) break;
            }
        } finally { bg.end(); }
    }

    ensure(): Promise<void> {
        return this.urgent(async () => {
            const doc = this.doc();
            if (!this.unaskedPairs(doc, frontierOf(doc, this.opts().exclude, this.opts().outside)).length) return;
            await this.progress((show, token) => this.neighbors(show, token));
            this.settle();
        });
    }

    /**
     * Stable views: the seeds' first layer (shown at once), the neighbors of everything on screen (for the
     * markers), then a prefetch along the traversal direction up to `view.depth` layers, in the background.
     */
    grow(): Promise<void> {
        return this.enqueue(async () => {
            await this.progress(async (show, token) => {
                let doc = this.doc();
                const dirs: ('in' | 'out')[] = doc.view.direction === 'both' ? ['in', 'out'] : [doc.view.direction];
                await this.ask(this.unasked(doc, doc.view.seeds, dirs), 'cached', 'first layer', show, token);
                await this.neighbors(show, token);
                const bg = this.background(token);
                try {
                    for (let level = 2; level <= doc.view.depth && !bg.token.isCancellationRequested; level++) {
                        doc = this.doc();
                        const reach = layers(doc, dirs, level - 1);
                        const qs = this.unasked(doc, reach, dirs);
                        if (!qs.length) break;
                        await this.ask(qs, 'cached', `prefetch ${level}/${doc.view.depth}`, show, bg.token);
                    }
                } finally { bg.end(); }
            });
            this.settle();
        });
    }

    /** Ask a side of one definition, then the neighbors of what that reveals. */
    expand(key: NodeKey, dir: 'in' | 'out'): Promise<void> {
        return this.urgent(async () => {
            await this.progress(async (show, token) => {
                await this.ask([{ key, dir }], 'cached', 'opening', show, token);
                await this.neighbors(show, token);
            });
            this.settle();
        });
    }

    /**
     * Stable views, progressive and non-destructive. Every explored pair takes its cached answer (no
     * language server; the cache drops answers of files changed since). Pairs without a cached answer:
     * visible ones are asked again in the background, the others lose their explored mark and are asked
     * when a side opens onto them; until then they keep their stored calls. Then the neighbors of what is
     * on screen. `force`: every visible pair from the language server, every other pair's cached answer dropped.
     * With nothing changed since the view was saved this asks the language server nothing.
     */
    revalidate(force = false): Promise<void> {
        return this.enqueue(async () => {
            let doc = this.doc();
            if (!Object.keys(doc.explored ?? {}).length) { void this.grow(); return; }
            const o = this.opts();
            await o.cache.ready();
            const vis = new Set(visibleOf(doc, this.opts().exclude, this.opts().outside));
            const pairs = Object.entries(doc.explored ?? {}).flatMap(([key, d]) =>
                (d === 'both' ? ['in', 'out'] as const : [d as 'in' | 'out']).map((dir) => ({ key, dir })));
            const shown = pairs.filter((q) => vis.has(q.key));
            const rest = pairs.filter((q) => !vis.has(q.key));
            if (force) for (const q of rest) o.cache.drop(q.key, q.dir);
            // cached answers merge without the language server; the others are stale
            const quiet = () => undefined;
            const r = force ? undefined : await this.ask(pairs, 'cacheOnly', '', quiet);
            const stale = force ? new Set(rest.map(id)) : new Set((r?.missed ?? []).filter((q) => !vis.has(q.key)).map(id));
            if (stale.size) {
                const d = this.doc();
                const ex = { ...(d.explored ?? {}) };
                for (const k of new Set([...stale].map((x) => x.slice(x.indexOf(':') + 1)))) {
                    const keep = (['in', 'out'] as const).filter((dir) => (ex[k] === dir || ex[k] === 'both') && !stale.has(`${dir}:${k}`));
                    if (keep.length) ex[k] = keep[0]; else delete ex[k];
                }
                d.explored = ex;
                await this.write(d);
            }
            const visStale = force ? shown : (r?.missed ?? []).filter((q) => vis.has(q.key));
            doc = this.doc();
            const neighbors = this.unaskedPairs(doc, frontierOf(doc, this.opts().exclude, this.opts().outside));
            if (visStale.length || neighbors.length) {
                await this.progress(async (show, token) => {
                    await this.ask(visStale, force ? 'fresh' : 'cached', force ? 'asking the language server' : 'updating changed files', show, token);
                    await this.neighbors(show, token);
                });
            }
            this.settle();
        });
    }

    /** `revalidate`, after an optional change; `how === 'revalidate'` asks the on-screen pairs from the language server. */
    async refresh(mutate?: (d: ViewDoc) => void, how: 'cached' | 'revalidate' = 'cached'): Promise<void> {
        if (mutate) { const d = this.doc(); mutate(d); await this.write(d); }
        return this.revalidate(how === 'revalidate');
    }

    /** Applies a local change without querying the provider. */
    async update(mutate: (d: ViewDoc) => void): Promise<void> {
        const doc = this.doc();
        mutate(doc);
        await this.write(doc);
    }
}

/** Retry delays in seconds for answers the language server did not give (startup analysis). */
const RETRY_S = [2, 4, 8, 15, 30, 60];

const id = (q: Pair) => `${q.dir}:${q.key}`;

/** Order-free fingerprint of the data a build changes: node records, calls, explored directions. */
function signature(d: ViewDoc): string {
    const nodes = Object.entries(d.graph.nodes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const edges = d.graph.edges.map((e) => `${e.from}\u0000${e.to}\u0000${e.line ?? ''}`).sort();
    const ex = Object.entries(d.explored ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([nodes, edges, ex]);
}

/** Definitions exactly `n` layers from the seeds along `dirs` in the view's data. */
function layers(doc: ViewDoc, dirs: ('in' | 'out')[], n: number): NodeKey[] {
    const out = new Map<NodeKey, NodeKey[]>(), inc = new Map<NodeKey, NodeKey[]>();
    for (const e of doc.graph.edges) {
        if (!out.has(e.from)) out.set(e.from, []);
        out.get(e.from)!.push(e.to);
        if (!inc.has(e.to)) inc.set(e.to, []);
        inc.get(e.to)!.push(e.from);
    }
    let level = new Set(doc.view.seeds);
    const seen = new Set(level);
    for (let i = 0; i < n; i++) {
        const next = new Set<NodeKey>();
        for (const k of level) for (const d of dirs) for (const m of (d === 'out' ? out : inc).get(k) ?? []) if (!seen.has(m)) { seen.add(m); next.add(m); }
        level = next;
    }
    return [...level].filter((k) => !isContainer(doc.graph.nodes[k]));
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
        ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gaffy')) this.sessions.forEach((s) => void s.post());
        }));
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
                        // stored data at once, then only what changed since (no language server when nothing did)
                        if (doc.view.seeds.length) void s.revalidate();
                    } else if (m.type === 'edit') {
                        await s.write(parseDoc(m.text, s.name));
                        void s.ensure();
                    } else {
                        await this.onMessage(s, m);
                    }
                } catch (e) {
                    void vscode.window.showErrorMessage(plain(`gaffy: ${(e as Error).message}`));
                }
            }),
        ];
        panel.onDidDispose(() => {
            s.dispose();
            subs.forEach((d) => d.dispose());
            this.sessions.delete(id);
            if (this.active === s) this.active = undefined;
        });
    }

    private html(webview: vscode.Webview, dist: vscode.Uri, media: vscode.Uri): string {
        // a fresh unguessable nonce per page: only the script carrying it runs (Content Security Policy)
        const nonce = randomBytes(18).toString('base64url');
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
