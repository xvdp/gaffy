/** @xvdp
 * Custom text editor for `*.gaffy` views: the TextDocument holds the view JSON (VS Code tabs, dirty state, undo,
 * redo, save, hot exit); the webview renders it and posts whole-document edits.
 *
 * Freeze on open: a view built earlier (language-server data in it: `updated`, `explored`), saved and opened again
 * is frozen (no language-server requests, settle results not written) until Unfreeze, a document edit
 * `view.live = <id of this opening>`; Ctrl+Z freezes again. The id is new at every opening of the document, so a
 * saved `live` from an earlier opening does not count. Not frozen: a new view (its seed records only), a view
 * without data (giddy, scripts), an unsaved or restored-dirty document; a view built during this opening carries
 * the id with its first data.
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GNode, isContainer, NodeKey, plain } from '../core/model';
import { Style } from '../core/style';
import { globMatcher, isBuilt, parseDoc, serializeDoc, ViewDoc, ViewSpec } from '../core/viewdoc';
import { BuildMode, extendGraph, Extension, Pair } from './build';
import { frontierOf, pinPaths, visibleOf } from '../core/scene';
import { CallCache } from './cache';
import { viewScope } from './context';
import { gitShort } from './git';
import { LspProvider, MAX_CALLS } from './lsp';
import { readable } from './scope';
import { seedSpec } from './seedspec';
import { folderOf, gaffyDir, homeOf, StyleService } from './style';
import { Trace } from './trace';

/** One opening of a view document (all its panels): id written by Unfreeze; built and saved at opening. */
export interface Opening { id: string; built: boolean; panels: number }

/**
 * Options values stored in the view (Options menu: edge style, curve, parent rule, grouping, tight groups,
 * external code, standard library) where absent: `style` (style.json, gaffy.style) and settings give the defaults.
 */
export function localOptions(doc: ViewDoc, style: Style, cfg: vscode.WorkspaceConfiguration): void {
    const v = doc.view;
    v.edges ??= style.edges.mode;
    v.curve ??= style.edges.curve;
    v.parentRule ??= style.grid.parentRule;
    v.boxes ??= style.boxes.enabled;
    v.tight ??= style.boxes.tight;
    v.external ??= cfg.get<boolean>('includeExternal') ?? false;
    v.stdlib ??= cfg.get<boolean>('includeStandardLibrary') ?? false;
}

export class Session {
    private busy = false;

    constructor(
        readonly document: vscode.TextDocument,
        readonly panel: vscode.WebviewPanel,
        private readonly host: GaffyEditor,
        private readonly opening: Opening,
    ) {}

    /**
     * Frozen: the view was built and saved at opening, is still built (a file rewritten without data, e.g. by
     * giddy, builds), and no Unfreeze of this opening is in the document.
     */
    get held(): boolean {
        if (!this.opening.built) return false;
        try {
            const d = this.doc();
            return isBuilt(d) && d.view.live !== this.opening.id;
        } catch { return true; }
    }

    /** Unfreeze (`on` false): language-server updates, Options values stored in the view; freeze: undoes that. */
    async hold(on: boolean): Promise<void> {
        if (on) {
            this.opening.built = true;
            await this.update((d) => { delete d.view.live; });
            return;
        }
        const style = await this.host.styles.get(this.folder);
        const cfg = vscode.workspace.getConfiguration('gaffy', this.document.uri);
        await this.update((d) => { d.view.live = this.opening.id; localOptions(d, style, cfg); });
        void this.open();
    }

    /** External code and standard library drawn and asked: the view's values, else the settings. */
    outside(): { external: boolean; standard: boolean } {
        const cfg = vscode.workspace.getConfiguration('gaffy', this.document.uri);
        let v: ViewSpec | undefined;
        try { v = this.doc().view; } catch { /* invalid JSON: settings */ }
        return { external: v?.external ?? cfg.get<boolean>('includeExternal') ?? false,
            standard: v?.stdlib ?? cfg.get<boolean>('includeStandardLibrary') ?? false };
    }

    get folder(): vscode.Uri { return folderOf(this.document.uri); }
    /** Project of the view (style.ts `homeOf`): seed paths, exports, trace. */
    get home(): vscode.Uri { return homeOf(this.document.uri); }
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
        // untitled views skip autoSave; `view.save` (a script's view) saves whatever the setting
        if (!this.document.isUntitled && (doc.view.save || vscode.workspace.getConfiguration('gaffy').get<boolean>('autoSave'))) await this.document.save();
    }

    async post(): Promise<void> {
        const style = await this.host.styles.get(this.folder);
        const cfg = vscode.workspace.getConfiguration('gaffy', this.document.uri);
        const exclude = cfg.get<string[]>('exclude') ?? [];
        // Options panel settings
        const settings = { includeExternal: cfg.get<boolean>('includeExternal') ?? false, includeStandardLibrary: cfg.get<boolean>('includeStandardLibrary') ?? false,
            saveViews: cfg.get<boolean>('saveViews') ?? false, untitled: this.document.isUntitled, unsaved: this.document.isUntitled || this.document.isDirty,
            trace: cfg.get<boolean>('trace') ?? false,
            held: this.held, debugLayout: cfg.get<boolean>('debugLayout') ?? false };
        void this.panel.webview.postMessage({ type: 'state', text: this.document.getText(), name: this.name, style, exclude, settings, busy: this.busy });
    }

    private queue: Promise<void> = Promise.resolve();

    /** Serial task queue for one view's provider work. */
    private enqueue(task: () => Promise<void>): Promise<void> {
        this.queue = this.queue.then(task, task);
        return this.queue;
    }

    // queued urgent tasks; token of running background work (neighbor checks, prefetch)
    private waiting = 0;
    private yieldFor: vscode.CancellationTokenSource | undefined;

    /**
     * User-blocking task (side opened, edit): preempts background work at its next request (answers kept, rest
     * unasked), runs next, redoes the neighbor checks it needs.
     */
    private urgent(task: () => Promise<void>): Promise<void> {
        this.waiting++;
        this.yieldFor?.cancel();
        return this.enqueue(async () => { this.waiting--; await task(); });
    }

    /** Background-work token: cancelled with `token` or when an urgent task queues. */
    private background(token: vscode.CancellationToken): { token: vscode.CancellationToken; end: () => void } {
        const cts = new vscode.CancellationTokenSource();
        const sub = token.onCancellationRequested(() => cts.cancel());
        this.yieldFor = cts;
        if (this.waiting) cts.cancel();
        return { token: cts.token, end: () => { sub.dispose(); if (this.yieldFor === cts) this.yieldFor = undefined; cts.dispose(); } };
    }

    /** Graph banner; after 400 ms, a cancellable notification. */
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
        // drawn external code and standard library (scene.ts `Outside`)
        const outside = this.outside();
        return {
            maxNodes: cfg.get<number>('maxNodes') ?? 400,
            exclude: (cfg.get<string[]>('exclude') ?? []).map(globMatcher),
            external: outside.external,
            outside,
            cache: this.host.cacheFor(this.folder, outside.external),
        };
    }

    /** Asks pairs, merges answers into the document; writes on change only. */
    private async ask(qs: Pair[], mode: BuildMode, label: string,
        show: (t: string) => void, token?: vscode.CancellationToken): Promise<Extension | undefined> {
        if (!qs.length) return undefined;
        const o = this.opts();
        await o.cache.ready();
        const r = await viewScope.run({ external: o.external }, () => extendGraph(this.host.provider, this.doc(), qs, { ...o, mode, token, doubted: this.doubted,
            progress: (q) => show(`${label} · ${q.definitions} definitions · ${q.requests} language-server requests · ${q.cached} cached`) }));
        // frozen meanwhile (Ctrl+Z past Unfreeze): answers dropped
        if (this.fixed) return undefined;
        const now = this.doc();
        const before = signature(now);
        const first = !this.opening.built || !isBuilt(now);
        now.graph = r.graph;
        now.explored = r.explored;
        if (signature(now) !== before) {
            now.updated = new Date().toISOString();
            const commit = await gitShort(this.home.fsPath);
            if (commit) now.commit = commit; else delete now.commit;
            // first graph of this opening: Unfreeze of this opening, so Freeze then Ctrl+Z works as for an opened view
            if (first) { this.opening.built = true; now.view.live = this.opening.id; }
            await this.write(now);
        }
        for (const u of r.unresolved) this.pending.set(`${u.dir}:${u.key}`, u);
        this.limits(r);
        return r;
    }

    // limits warned once per view and session: `<dir>:<key>` cut at MAX_CALLS; `maxNodes`
    private warned = new Set<string>();

    /** Warns of answers cut at MAX_CALLS and calls lists skipped at `maxNodes`. */
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

    // unanswered pairs of the current task; retried with backoff during server start-up
    private pending = new Map<string, Pair>();
    // per `<dir>:<key>`: count of doubted empty answers until confirmed (build.ts)
    private doubted = new Map<string, number>();
    private retries = 0;
    private retryTimer: NodeJS.Timeout | undefined;

    /** After a task: retries unresolved pairs (RETRY_S), reports them after the last. */
    private settle(): void {
        const n = this.pending.size;
        this.pending.clear();
        clearTimeout(this.retryTimer);
        if (!n) { this.retries = 0; this.note(); return; }
        if (this.retries >= RETRY_S.length) {
            this.retries = 0;
            this.note(`language server: ${n} calls lists unresolved, stored calls kept`);
            void vscode.window.showWarningMessage(plain(`gaffy: ${this.name}: the language server resolved no answer for ${n} (definition, direction) pairs `
                + '(still analyzing, renamed or removed). The view keeps their stored calls; Options > Refresh Language Server retries.'));
            return;
        }
        const sec = RETRY_S[this.retries++];
        this.note(`language server not ready: ${n} calls lists unresolved, retry in ${sec} s`);
        this.retryTimer = setTimeout(() => void this.revalidate(), sec * 1000);
    }

    private note(text?: string): void { void this.panel.webview.postMessage({ type: 'note', text: text ?? '' }); }

    dispose(): void { clearTimeout(this.retryTimer); }

    /**
     * Asks each visible definition's openable directions once (seeds: both; others: the revealing direction) for
     * the markers. Repeats while answers reveal unasked pairs (open side, level within a full view's depth): ≤ 8
     * rounds (one per layer), 64 in full views (`gaffy.maxNodes` bounds the data).
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

    /**
     * Seeds written by name (seedspec.ts, a view a script wrote) become the keys of their definitions, with their
     * records and containers in the graph; then the usual build asks the language server within the view's depths.
     * Paths resolve inside the view's project (the folder holding its `.baggy`), else the workspace folder. Names the
     * language server does not resolve yet
     * (loading) are retried after 2, 5 and 10 s; the rest are reported once.
     */
    async open(): Promise<void> {
        if (this.fixed) return;
        const d = this.doc();
        const named = d.view.seeds.filter((k) => !Object.hasOwn(d.graph.nodes, k)).length;
        // status line (webview): phase and count while seeds resolve
        if (named) {
            await this.progress(async (show) => {
                for (const wait of [0, 2, 5, 10]) {
                    if (wait) {
                        show(`not ready, seeds asked again in ${wait} s`);
                        await new Promise((r) => setTimeout(r, wait * 1000));
                    }
                    const left = await this.resolveSeeds((i, n) => show(`resolving seeds ${i}/${n}`));
                    if (!left.retry.length) {
                        if (left.bad.length) this.badSeeds(left.bad);
                        break;
                    }
                    if (wait === 10) this.badSeeds([...left.bad, ...left.retry]);
                }
            });
        }
        await this.revalidate();
    }

    private async resolveSeeds(step?: (i: number, n: number) => void): Promise<{ bad: string[]; retry: string[] }> {
        const doc = this.doc();
        const named = doc.view.seeds.filter((k) => !Object.hasOwn(doc.graph.nodes, k));
        const bad: string[] = [], retry: string[] = [];
        if (!named.length) return { bad, retry };
        // path bases: the view's project (a repository giddy or a script wrote into), then the workspace folder;
        // a path must stay inside its base
        const bases = this.home.toString() === this.folder.toString() ? [this.folder] : [this.home, this.folder];
        const acc: Record<NodeKey, GNode> = {};
        const found = new Map<string, NodeKey>();
        const fileOf = async (path: string) => {
            for (const base of bases) {
                const uri = vscode.Uri.joinPath(base, path);
                if (!uri.path.startsWith(`${base.path.replace(/\/$/, '')}/`) || !readable(uri)) continue;
                try { await vscode.workspace.fs.stat(uri); return uri; } catch { /* next base */ }
            }
            return undefined;
        };
        for (const [i, seed] of named.entries()) {
            step?.(i + 1, named.length);
            const spec = seedSpec(seed);
            const uri = spec ? await fileOf(spec.path) : undefined;
            if (!spec || !uri) { bad.push(seed); continue; }
            const key = await this.host.provider.seedAt(uri, spec, acc);
            if (key) found.set(seed, key); else retry.push(seed);
        }
        if (found.size) {
            const now = this.doc();
            now.view.seeds = [...new Set(now.view.seeds.map((k) => found.get(k) ?? k))];
            for (const [k, n] of Object.entries(acc)) if (!Object.hasOwn(now.graph.nodes, k)) now.graph.nodes[k] = n;
            await this.write(now);
        }
        return { bad, retry };
    }

    private badSeeds(seeds: string[]): void {
        void vscode.window.showWarningMessage(plain(`gaffy: ${this.name}: ${seeds.length} seed${seeds.length > 1 ? 's' : ''} not found: `
            + `${seeds.slice(0, 5).join(', ')}${seeds.length > 5 ? ', …' : ''} (write <path>#<qualified name> or <path>:<line>, `
            + 'path relative to the folder holding .baggy/ or the workspace folder)'));
    }

    /** Static (`view.static`) or frozen (`held`) view: fixed graph, no language-server requests. */
    private get fixed(): boolean { return !!this.doc().view.static || this.held; }

    ensure(): Promise<void> {
        if (this.fixed) return Promise.resolve();
        return this.urgent(async () => {
            const doc = this.doc();
            if (!this.unaskedPairs(doc, frontierOf(doc, this.opts().exclude, this.opts().outside)).length) return;
            await this.progress((show, token) => this.neighbors(show, token));
            this.settle();
        });
    }

    /**
     * Stable views: seeds' first layer, on-screen neighbors (markers), then background prefetch along the
     * traversal direction to `view.depth`.
     */
    grow(): Promise<void> {
        if (this.fixed) return Promise.resolve();
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
            // giddy's view: built with the paths between seeds, then left one layer at a time with the paths pinned
            const d = this.doc();
            if (d.view.pinPaths && d.view.between && !this.fixed) {
                const o = this.opts();
                pinPaths(d, o.exclude, o.outside);
                await this.write(d);
            }
            this.settle();
        });
    }

    /** Asks one side of a definition, then neighbors of what it reveals. */
    expand(key: NodeKey, dir: 'in' | 'out'): Promise<void> {
        if (this.fixed) return Promise.resolve();
        return this.urgent(async () => {
            await this.progress(async (show, token) => {
                await this.ask([{ key, dir }], 'cached', 'opening', show, token);
                await this.neighbors(show, token);
            });
            this.settle();
        });
    }

    /**
     * Stable views; progressive, non-destructive. Explored pairs: cached answers (cache drops changed files).
     * Uncached: visible → re-asked in background; others → unmarked, stored calls kept until a side opens onto
     * them. Then on-screen neighbors. `force`: visible pairs from the server, other cached answers dropped.
     * Unchanged since save → no server request.
     */
    revalidate(force = false): Promise<void> {
        if (this.fixed) return Promise.resolve();
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
            // merge cached answers; the rest are stale
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

    /** `revalidate` after an optional change; `'revalidate'` re-asks on-screen pairs. */
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

/** Retry delays (s) for unanswered pairs during server start-up analysis. */
const RETRY_S = [2, 4, 8, 15, 30, 60];

const id = (q: Pair) => `${q.dir}:${q.key}`;

/** Order-independent fingerprint of build data: node records, calls, explored directions. */
function signature(d: ViewDoc): string {
    const nodes = Object.entries(d.graph.nodes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const edges = d.graph.edges.map((e) => `${e.from}\u0000${e.to}\u0000${e.line ?? ''}`).sort();
    const ex = Object.entries(d.explored ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([nodes, edges, ex]);
}

/** Definitions exactly `n` layers from the seeds along `dirs`. */
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
    /** Openings per document URI (all panels of one document share one). */
    private openings = new Map<string, Opening>();
    /** Change records of open views (setting gaffy.trace). */
    readonly trace = new Trace();

    /**
     * Call cache of a workspace folder: `.baggy/gaffy/cache/calls.json`, or `calls-external.json` for views drawing
     * external code (answers keep external definitions only there).
     */
    cacheFor(folder: vscode.Uri, external: boolean): CallCache {
        const name = external ? 'calls-external.json' : 'calls.json';
        const k = `${folder.toString()}#${name}`;
        let c = this.caches.get(k);
        if (!c) this.caches.set(k, (c = new CallCache(vscode.Uri.joinPath(gaffyDir(folder), 'cache', name), folder)));
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
        // one record per document change, independent of panel count
        ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.contentChanges.length && [...this.sessions.values()].some((s) => s.document === e.document)) {
                // failed record (link on the path, full disk): view unchanged
                this.trace.change(e.document, e.reason).catch(() => { /* not recorded */ });
            }
        }));
    }

    async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
        const uri = document.uri.toString();
        let opening = this.openings.get(uri);
        if (!opening) {
            // frozen at opening: built, saved (not untitled, not restored with unsaved changes)
            let built = false;
            try { built = !document.isUntitled && !document.isDirty && isBuilt(parseDoc(document.getText())); } catch { /* invalid JSON: shown as an error */ }
            this.openings.set(uri, (opening = { id: randomBytes(8).toString('hex'), built, panels: 0 }));
        }
        opening.panels++;
        const s = new Session(document, panel, this, opening);
        this.trace.open(document);
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
            // status line `Unsaved` clears on save
            vscode.workspace.onDidSaveTextDocument((d) => { if (d.uri.toString() === document.uri.toString()) void s.post(); }),
            panel.onDidChangeViewState(() => { if (panel.active) this.active = s; }),
            panel.webview.onDidReceiveMessage(async (m) => {
                try {
                    if (m.type === 'ready') {
                        await s.post();
                        const doc = s.doc();
                        // seeds written by name resolve first; stored data, then changes only (no language server when none)
                        if (doc.view.seeds.length) void s.open();
                    } else if (m.type === 'edit') {
                        if (m.text !== document.getText()) this.trace.edit(document, m.cause, m.moved);
                        const was = s.outside().external;
                        await s.write(parseDoc(m.text, s.name));
                        this.trace.written(document);
                        // external code on: answers fetched without it asked again (on screen now, the rest when opened)
                        if (!was && s.outside().external) void s.refresh(undefined, 'revalidate');
                        else void s.ensure();
                    } else {
                        await this.onMessage(s, m);
                    }
                } catch (e) {
                    void vscode.window.showErrorMessage(plain(`gaffy: ${(e as Error).message}`));
                }
            }),
        ];
        panel.onDidDispose(() => {
            if (--opening!.panels === 0) this.openings.delete(uri);
            s.dispose();
            subs.forEach((d) => d.dispose());
            this.sessions.delete(id);
            if (this.active === s) this.active = undefined;
        });
    }

    private html(webview: vscode.Webview, dist: vscode.Uri, media: vscode.Uri): string {
        // unguessable nonce per page: only the script carrying it runs (Content Security Policy)
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
