/** @xvdp
 * Call cache per workspace folder (`.baggy/gaffy/cache/calls.json`): language-server answers (one definition's incoming
 * or outgoing calls) with the node records they introduced; resolved definitions only.
 *
 * Invalidation: a saved or renamed file drops its definitions' outgoing entries and all incoming entries (any
 * change can add or remove a call into any definition). Load: mtime ≠ record → treated as saved. Format v7; older
 * dropped: v1 empty answers of unresolved definitions; v2 two keys per overload (`C.f`, `f`); v3 body scans
 * (instance calls, bindings) that saw only the name; v4 empty answers from a loading server; v5 one key for the
 * overloads of a scope (C++ `f(int)`, `f(float3)` → `f`; now `f(int)`, `f(float3)`); v6 cross-language answers
 * cached while the C/C++ server was loading (binding targets unresolved, links missing).
 */
import * as vscode from 'vscode';
import { noLinks } from './safefs';
import { ancestors, GEdge, GNode, NodeKey } from '../core/model';
import { readable } from './scope';

type Dir = 'in' | 'out';
const extOf = (uri: string) => /\.([A-Za-z0-9]+)$/.exec(uri)?.[1];
interface Entry { edges: GEdge[]; at: number; clamped?: number }   // clamped: full answer length when over the call limit
interface Stored {
    version: 7;
    nodes: Record<NodeKey, GNode>;
    out: Record<NodeKey, Entry>;
    in: Record<NodeKey, Entry>;
    files: Record<string, number>;
}

export class CallCache {
    private nodes = new Map<NodeKey, GNode>();
    private entries: Record<Dir, Map<NodeKey, Entry>> = { in: new Map(), out: new Map() };
    private files = new Map<string, number>();
    private exts = new Set<string>();       // file extensions of cached definitions
    private timer: NodeJS.Timeout | undefined;
    private readonly loaded: Promise<void>;

    constructor(private readonly file: vscode.Uri, private readonly base: vscode.Uri) {
        this.loaded = this.load();
    }

    ready(): Promise<void> { return this.loaded; }

    private async load(): Promise<void> {
        let raw: Stored;
        try {
            raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file)));
            if (raw.version !== 7) return;
        } catch { return; }
        /* secure tooling: drop prototype keys (JSON `__proto__`); node keys are `<lang>:<path>#<qual>`. */
        const ok = (k: string) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
        for (const [k, n] of Object.entries(raw.nodes ?? {})) if (ok(k)) this.remember(k, n);
        for (const d of ['in', 'out'] as Dir[]) for (const [k, e] of Object.entries(raw[d] ?? {})) if (ok(k) && Array.isArray(e?.edges)) this.entries[d].set(k, e);
        const changed: string[] = [];
        await Promise.all(Object.entries(raw.files ?? {}).map(async ([uri, mtime]) => {
            try {
                const u = vscode.Uri.parse(uri);
                if (!readable(u)) throw new Error('scheme');
                const st = await vscode.workspace.fs.stat(u);
                if (st.mtime !== mtime) changed.push(uri); else this.files.set(uri, mtime);
            } catch { changed.push(uri); }
        }));
        for (const uri of changed) this.invalidate(uri, false);
    }

    /** Cached (`key`, `dir`) answer with its node and container records. */
    get(key: NodeKey, dir: Dir): { edges: GEdge[]; nodes: Record<NodeKey, GNode>; clamped?: number } | undefined {
        const e = this.entries[dir].get(key);
        if (!e) return undefined;
        const nodes: Record<NodeKey, GNode> = {};
        const take = (k: NodeKey) => {
            for (let n = this.nodes.get(k); n && !nodes[n.key]; n = n.parent ? this.nodes.get(n.parent) : undefined) nodes[n.key] = n;
        };
        take(key);
        for (const x of e.edges) { take(x.from); take(x.to); }
        return { edges: e.edges, nodes, clamped: e.clamped };
    }

    put(key: NodeKey, dir: Dir, edges: GEdge[], acc: Record<NodeKey, GNode>, clamped?: number): void {
        const keep = (k: NodeKey) => {
            const n = acc[k];
            if (!n) return;
            this.remember(k, n);
            if (n.uri && !this.files.has(n.uri)) this.files.set(n.uri, 0);
            for (const a of ancestors(acc, k)) if (acc[a]) this.remember(a, acc[a]);
        };
        keep(key);
        for (const e of edges) { keep(e.from); keep(e.to); }
        this.entries[dir].set(key, clamped ? { edges, at: Date.now(), clamped } : { edges, at: Date.now() });
        this.schedule();
    }

    private remember(k: NodeKey, n: GNode): void {
        this.nodes.set(k, n);
        const e = n.uri ? extOf(n.uri) : undefined;
        if (e) this.exts.add(e);
    }

    /** Forget one answer (asked again on next use). */
    drop(key: NodeKey, dir: Dir): void {
        if (this.entries[dir].delete(key)) this.schedule();
    }

    /**
     * File change: drops its outgoing entries and all incoming entries; no-op for extensions without cached
     * definitions (logs, bytecode, build output).
     */
    invalidate(uri: string, persist = true): void {
        const ext = extOf(uri);
        if (!this.files.has(uri) && ext !== undefined && !this.exts.has(ext)) return;
        for (const [k] of this.entries.out) if (this.nodes.get(k)?.uri === uri) this.entries.out.delete(k);
        this.entries.in.clear();
        this.files.delete(uri);
        if (persist) this.schedule();
    }

    clear(): void {
        this.entries.in.clear();
        this.entries.out.clear();
        this.schedule();
    }

    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.save(), 2000);
    }

    private async save(): Promise<void> {
        const files: Record<string, number> = {};
        await Promise.all([...this.files.keys()].map(async (uri) => {
            try {
                const u = vscode.Uri.parse(uri);
                if (readable(u)) files[uri] = (await vscode.workspace.fs.stat(u)).mtime;
            } catch { /* gone */ }
        }));
        const out: Stored = {
            version: 7,
            nodes: Object.fromEntries(this.nodes),
            out: Object.fromEntries(this.entries.out),
            in: Object.fromEntries(this.entries.in),
            files,
        };
        try {
            await noLinks(this.base, this.file);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.file, '..'));
            await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(JSON.stringify(out)));
        } catch { /* read-only workspace or link on the path (safefs.ts): memory only */ }
    }
}
