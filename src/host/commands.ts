/** @xvdp
 * Commands: graph creation (editor, explorer), view, node (webview context menu). `webview/context` commands
 * receive the clicked element's merged `data-vscode-context`: `{ webviewSection, key, webview }`.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { noHierarchyHint, serverHint } from '../core/langs';
import { toHtmlPre, toText } from '../core/grid';
import { ancestors, GNode, NodeKey, plain, visible } from '../core/model';
import { buildScene, siblingsOf } from '../core/scene';
import { DEFAULT_STYLE, glyphSet } from '../core/style';
import { Direction, dropMovesWithin, emptyDoc, globMatcher, ROOTS, serializeDoc, ViewDoc, ViewSpec } from '../core/viewdoc';
import { GaffyEditor, Session } from './editor';
import { noLinks } from './safefs';
import { readable } from './scope';
import { folderOf, gaffyDir } from './style';

interface NodeArg { key?: NodeKey; unit?: string; to?: NodeKey; webviewSection?: string }

const cfg = () => vscode.workspace.getConfiguration('gaffy');

function nodeOf(doc: ViewDoc, key: NodeKey): GNode | undefined {
    return doc.graph.nodes[key];
}

/** Unused name in `dir`: no file, no open document (unsaved views hold a path without a file). */
async function uniqueUri(dir: vscode.Uri, stem: string, ext: string): Promise<vscode.Uri> {
    const safe = stem.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'view';
    const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.path));
    for (let i = 1; ; i++) {
        const u = vscode.Uri.joinPath(dir, `${safe}${i > 1 ? `-${i}` : ''}${ext}`);
        if (open.has(u.path)) continue;
        try { await vscode.workspace.fs.stat(u); } catch { return u; }
    }
}

/**
 * Short HEAD hash in `cwd`; undefined outside git. Trusted workspaces only: a cloned or downloaded folder's
 * `.git/config` can make git run programs.
 */
function gitShort(cwd: string): Promise<string | undefined> {
    // a trusted window can hold folders outside its workspace folders (an active editor's file)
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))) return Promise.resolve(undefined);
    return new Promise((res) => execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 3000 },
        (err, out) => res(err ? undefined : out.trim() || undefined)));
}

const dateSlug = (d = new Date()) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

/** Column for definitions: left of the graph, else beside it. */
function besideGraph(s: Session): vscode.ViewColumn {
    const c = s.panel.viewColumn;
    return c && c > 1 ? c - 1 : vscode.ViewColumn.Beside;
}

/**
 * Location of a node: its URI; else its workspace-relative path, tried against the view's folder and each parent up
 * to the workspace folder (views written without URIs, e.g. docs/heuristics.gaffy, path relative to the repository).
 */
async function nodeUri(n: GNode | undefined, s: Session): Promise<vscode.Uri | undefined> {
    if (n?.uri) return vscode.Uri.parse(n.uri);
    if (!n?.path || n.external) return undefined;
    const view = s.document.uri.scheme === 'untitled' ? vscode.Uri.file(s.document.uri.path) : s.document.uri;
    const top = s.folder.path;
    for (let dir = vscode.Uri.joinPath(view, '..'); dir.path.startsWith(top); dir = vscode.Uri.joinPath(dir, '..')) {
        const u = vscode.Uri.joinPath(dir, n.path);
        if (u.path.startsWith(`${dir.path}/`)) { try { await vscode.workspace.fs.stat(u); return u; } catch { /* next folder up */ } }
        if (dir.path === top) break;
    }
    return undefined;
}

async function openNode(n: GNode | undefined, s: Session, focus: boolean, column: vscode.ViewColumn): Promise<vscode.TextEditor | undefined> {
    const uri = await nodeUri(n, s);
    if (!n || !uri) return undefined;
    /*security tooling: reject arbitrary URI schemes.*/
    if (!readable(uri)) return undefined;
    if (n.kind === 'package' || n.kind === 'folder') {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return undefined;
    }
    const pos = new vscode.Position(n.line ?? 0, n.character ?? 0);
    return vscode.window.showTextDocument(uri, {
        viewColumn: column,
        selection: new vscode.Range(pos, pos),
        preserveFocus: !focus,
        preview: true,
    });
}

/** Innermost container of `key`, or `key`, with kind in `kinds`. */
function containerOfKind(doc: ViewDoc, key: NodeKey, kinds: string[]): NodeKey | undefined {
    const nodes = doc.graph.nodes;
    for (const k of [key, ...ancestors(nodes, key)]) if (kinds.includes(nodes[k]?.kind)) return k;
    return undefined;
}

export function registerCommands(ctx: vscode.ExtensionContext, editor: GaffyEditor): void {
    const provider = editor.provider;
    const reg = (id: string, fn: (...a: any[]) => unknown) =>
        ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...a: any[]) => {
            editor.trace.ran(id);
            try { await fn(...a); } catch (e) { void vscode.window.showErrorMessage(plain(`gaffy: ${(e as Error).message}`)); } finally { editor.trace.ran(undefined); }
        }));

    const active = (): Session => {
        if (!editor.active) throw new Error('no active gaffy view');
        return editor.active;
    };

    // ---- view creation ------------------------------------------------------------------------------
    const seedAtCursor = async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed) throw new Error('no active editor');
        const items = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'gaffy: asking the language server about the symbol at the cursor…' },
            () => provider.prepare(ed.document.uri, ed.selection.active));
        if (!items.length) throw new Error(`no call hierarchy at the cursor: ${(await provider.symbolsOf(ed.document.uri)).length ? noHierarchyHint(ed.document.uri.path) : serverHint(ed.document.uri.path)}`);
        const acc: Record<NodeKey, GNode> = {};
        const key = await provider.describe(items[0], acc);
        if (!key) throw new Error('symbol outside the workspace (gaffy.includeExternal is off)');
        return { key, acc, uri: ed.document.uri, node: acc[key] };
    };

    /**
     * New view in `.gaffy/views/`: style.json `view` settings, then `over`. Without `gaffy.saveViews`: untitled,
     * bound to that path (Save writes, close discards). `fromEditor` + `gaffy.openDefinitions`: opens beside the editor.
     */
    const createView = async (base: vscode.Uri, stem: string, doc: ViewDoc, over: Partial<Pick<ViewSpec, 'arrange' | 'depthUp' | 'depthDown'>> = {},
        fromEditor = false) => {
        const folder = folderOf(base);
        const views = vscode.Uri.joinPath(gaffyDir(folder), 'views');
        await noLinks(folder, views);
        await vscode.workspace.fs.createDirectory(views);
        // <symbol>_<short commit hash, or date>.gaffy
        const uri = await uniqueUri(views, `${stem}_${(await gitShort(folder.fsPath)) ?? dateSlug()}`, '.gaffy');
        await noLinks(folder, uri);   // also the later save path (untitled)
        // initial settings: style.json `view`
        const start = (await editor.styles.get(folder)).view;
        doc.view.depth = cfg().get<number>('depth') ?? 3;
        doc.view.arrange = start.arrange;
        if (start.traverse === 'both') doc.view.direction = 'both';
        // one layer at a time: seed's first side; full: same sides to the configured depth
        doc.view.depthUp = doc.view.direction !== 'out' ? doc.view.depth : 0;
        doc.view.depthDown = doc.view.direction !== 'in' ? doc.view.depth : 0;
        Object.assign(doc.view, over);
        if (doc.view.arrange === 'grow') doc.view.open = {};
        else delete doc.view.open;
        doc.name = path.basename(uri.path, '.gaffy');
        let target = uri;
        if (!cfg().get<boolean>('saveViews')) {
            target = uri.with({ scheme: 'untitled' });
            const untitled = await vscode.workspace.openTextDocument(target);
            // whole text replaced: else a document bound to this path holds two views
            const edit = new vscode.WorkspaceEdit();
            edit.replace(target, new vscode.Range(new vscode.Position(0, 0), untitled.lineAt(Math.max(0, untitled.lineCount - 1)).range.end), serializeDoc(doc));
            await vscode.workspace.applyEdit(edit);
        } else await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeDoc(doc)));
        const beside = fromEditor && (cfg().get<boolean>('openDefinitions') ?? true);
        await vscode.commands.executeCommand('vscode.openWith', target, GaffyEditor.viewType,
            { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active });
    };

    /**
     * VS Code call hierarchy at the cursor, References view (`gaffy.openCallHierarchy`). No `getCommands` check:
     * it omits inactive extensions' commands; running the command activates the extension.
     */
    const showCallHierarchy = async (direction: Direction) => {
        if (!cfg().get<boolean>('openCallHierarchy')) return;
        try {
            await vscode.commands.executeCommand('references-view.showCallHierarchy');
            await vscode.commands.executeCommand(direction === 'out' ? 'references-view.showOutgoingCalls' : 'references-view.showIncomingCalls');
        } catch { /* the view is optional */ }
    };

    const graphAtCursor = async (direction: Direction) => {
        const s = await seedAtCursor();
        await showCallHierarchy(direction);
        const doc = emptyDoc(s.node.name, { seeds: [s.key], direction, depth: cfg().get<number>('depth') ?? 4 });
        doc.graph.nodes = s.acc;
        await createView(s.uri, s.node.name, doc, {}, true);
    };

    reg('gaffy.graphCallers', () => graphAtCursor('in'));
    reg('gaffy.graphCallees', () => graphAtCursor('out'));

    reg('gaffy.addToView', async () => {
        const sess = active();
        const s = await seedAtCursor();
        await showCallHierarchy(sess.doc().view.direction === 'out' ? 'out' : 'in');
        await sess.refresh((d) => {
            Object.assign(d.graph.nodes, s.acc);
            if (!d.view.seeds.includes(s.key)) d.view.seeds.push(s.key);
        });
    });

    reg('gaffy.graphFile', async (uri?: vscode.Uri) => {
        uri ??= vscode.window.activeTextEditor?.document.uri;
        if (!uri) throw new Error('no file');
        const syms = await provider.symbolsOf(uri);
        const fnKinds = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
        const targets: vscode.DocumentSymbol[] = [];
        const walk = (ss: vscode.DocumentSymbol[]) => ss.forEach((x) => {
            if (fnKinds.has(x.kind)) targets.push(x);
            else if (x.kind === vscode.SymbolKind.Class) walk(x.children);
        });
        walk(syms);
        const acc: Record<NodeKey, GNode> = {};
        const seeds: NodeKey[] = [];
        for (const t of targets.slice(0, 60)) {
            const it = (await provider.prepare(uri, t.selectionRange.start))[0];
            const key = it && (await provider.describe(it, acc));
            if (key) seeds.push(key);
        }
        if (!seeds.length) throw new Error(syms.length ? `no function in this file has call hierarchy: ${noHierarchyHint(uri.path)}` : `no functions found in this file: ${serverHint(uri.path)}`);
        // file functions and their callers: one level, all shown (full layout)
        const doc = emptyDoc('', { seeds, direction: 'in', depth: 1 });
        doc.graph.nodes = acc;
        await createView(uri, path.basename(uri.path).replace(/\.[^.]+$/, ''), doc, { arrange: 'auto', depthUp: 1, depthDown: 0 });
    });

    // ---- view commands ------------------------------------------------------------------------------
    reg('gaffy.refresh', () => active().refresh(undefined, 'revalidate'));
    reg('gaffy.clearCache', () => { for (const c of editor.allCaches()) c.clear(); void vscode.window.showInformationMessage('gaffy: call cache cleared'); });
    reg('gaffy.toggleEdges', async () => {
        const s = active();
        const st = await editor.styles.get(s.folder);
        await s.update((d) => { d.view.edges = (d.view.edges ?? st.edges.mode) === 'glyph' ? 'vector' : 'glyph'; });
    });
    reg('gaffy.unhideAll', () => active().update((d) => { d.view.hidden = []; }));
    // namespace frames hug their content (view.tight)
    const tightBoxes = async () => {
        const s = active();
        const st = await editor.styles.get(s.folder);
        await s.update((d) => { d.view.tight = !(d.view.tight ?? st.boxes.tight); });
    };
    reg('gaffy.tightBoxes', tightBoxes);
    reg('gaffy.tightBoxes.checked', tightBoxes);
    const toggleBoxes = async () => {
        const s = active();
        const st = await editor.styles.get(s.folder);
        await s.update((d) => { d.view.boxes = !(d.view.boxes ?? st.boxes.enabled); });
    };
    reg('gaffy.toggleBoxes', toggleBoxes);
    reg('gaffy.toggleBoxes.checked', toggleBoxes);

    // commands needing layout or selection run in the webview
    const forward = (cmd: string) => (arg?: NodeArg) => {
        const s = active();
        void s.panel.webview.postMessage({ type: 'cmd', cmd, key: arg?.key, unit: arg?.unit, to: arg?.to });
    };
    reg('gaffy.node.openCallers', forward('openUp'));
    reg('gaffy.node.openCalls', forward('openDown'));
    reg('gaffy.node.closeCallers', forward('closeUp'));
    reg('gaffy.node.closeCalls', forward('closeDown'));
    reg('gaffy.edge.straighten', forward('straighten'));
    reg('gaffy.edge.subtree', forward('callSubtree'));
    reg('gaffy.edge.path', forward('callPath'));
    reg('gaffy.edge.callSite', forward('callSite'));
    reg('gaffy.edge.callee', forward('callee'));
    reg('gaffy.resetLayout', forward('resetLayout'));
    reg('gaffy.rearrange', forward('rearrange'));
    reg('gaffy.unlockAll', forward('unlockAll'));
    reg('gaffy.expandAll', forward('expandAll'));
    reg('gaffy.showAll', forward('showAll'));
    reg('gaffy.resetView', forward('resetView'));
    reg('gaffy.isolateSelection', forward('isolateSelection'));
    reg('gaffy.node.lock', forward('lock'));
    reg('gaffy.node.unlock', forward('unlock'));
    reg('gaffy.node.showHidden', forward('showHidden'));
    reg('gaffy.sel.upstream', forward('upstream'));
    reg('gaffy.sel.downstream', forward('downstream'));
    reg('gaffy.sel.through', forward('through'));
    reg('gaffy.sel.between', forward('between'));
    reg('gaffy.sel.hide', forward('hideSelection'));
    reg('gaffy.sel.rearrange', forward('rearrangeSelection'));
    reg('gaffy.sel.clear', forward('clearSelection'));

    const excludes = (s: Session) => (vscode.workspace.getConfiguration('gaffy', s.document.uri).get<string[]>('exclude') ?? []).map(globMatcher);
    const external = (s: Session) => {
        const c = vscode.workspace.getConfiguration('gaffy', s.document.uri);
        return { external: c.get<boolean>('includeExternal') ?? false, standard: c.get<boolean>('includeStandardLibrary') ?? false };
    };

    const exportView = async (s: Session) => {
        const doc = s.doc();
        const style = await editor.styles.get(s.folder);
        const sc = buildScene(doc, style, excludes(s), external(s));
        const gs = glyphSet(style);
        const outDir = gaffyDir(s.folder);
        await noLinks(s.folder, outDir);
        await vscode.workspace.fs.createDirectory(outDir);
        const href = (key: NodeKey) => {
            const n = nodeOf(doc, key);
            if (!n?.uri) return undefined;
            /* secure tooling: links start with ./ or ../, so no path reads as a command */
            const p = path.posix.relative(outDir.path, vscode.Uri.parse(n.uri).path);
            const rel = p.startsWith('.') ? p : `./${p}`;
            return n.line !== undefined && n.kind !== 'package' && n.kind !== 'folder' ? `${rel}#L${n.line + 1}` : rel;
        };
        const md = `# ${doc.name}\n\n<pre>\n${toHtmlPre(sc.grid, gs, href, (k) => doc.view.seeds.includes(k))}\n</pre>\n`;
        const seed = doc.view.seeds[0];
        const sym = ((seed && nodeOf(doc, seed)?.name) || s.name).replace(/[^\w.-]+/g, '_');
        // .gaffy/<symbol>_<short commit hash, or date>.md, .txt; repeats per symbol and commit: _2, _3, …
        const base = `${sym}_${(await gitShort(s.folder.fsPath)) ?? dateSlug()}`;
        let n = 0;
        try {
            for (const [f] of await vscode.workspace.fs.readDirectory(outDir)) {
                if (f === `${base}.md`) n = Math.max(n, 1);
                const m = f.startsWith(`${base}_`) ? /^(\d+)\.md$/.exec(f.slice(base.length + 1)) : null;
                if (m) n = Math.max(n, Number(m[1]));
            }
        } catch { /* new folder */ }
        const stem = n ? `${base}_${n + 1}` : base;
        const mdUri = vscode.Uri.joinPath(outDir, `${stem}.md`);
        const txtUri = vscode.Uri.joinPath(outDir, `${stem}.txt`);
        await noLinks(s.folder, mdUri);
        await noLinks(s.folder, txtUri);
        await vscode.workspace.fs.writeFile(mdUri, new TextEncoder().encode(md.replace(`# ${doc.name}`, `# ${stem}`)));
        await vscode.workspace.fs.writeFile(txtUri, new TextEncoder().encode(toText(sc.grid, gs) + '\n'));
        await vscode.commands.executeCommand('markdown.showPreviewToSide', mdUri);
        void vscode.window.showInformationMessage(plain(`gaffy: exported .gaffy/${stem}.md and .gaffy/${stem}.txt`), 'Reveal in Explorer')
            .then((pick) => pick && vscode.commands.executeCommand('revealInExplorer', txtUri));
    };
    reg('gaffy.export', () => exportView(active()));

    // unsaved view: saved to its bound .gaffy/views/ path
    reg('gaffy.view.save', async () => {
        const s = active();
        if (!(await vscode.workspace.save(s.document.uri))) throw new Error(`${s.name} was not saved`);
    });
    // two menu entries per toggle (`✓ …` when on): webview menus show no checkmark for `toggled`
    const toggleSaveViews = async () => {
        const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await cfg().update('saveViews', !cfg().get<boolean>('saveViews'), target);
    };
    reg('gaffy.toggleSaveViews', toggleSaveViews);
    reg('gaffy.toggleSaveViews.checked', toggleSaveViews);

    reg('gaffy.editStyle', async () => {
        const folder = editor.active?.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!folder) throw new Error('no workspace folder');
        const uri = vscode.Uri.joinPath(gaffyDir(folder), 'style.json');
        await noLinks(folder, uri);
        try { await vscode.workspace.fs.stat(uri); } catch {
            await vscode.workspace.fs.createDirectory(gaffyDir(folder));
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(DEFAULT_STYLE, null, 2) + '\n'));
        }
        await vscode.window.showTextDocument(uri);
    });

    // ---- node commands (webview context menu) -------------------------------------------------------
    const node = (fn: (s: Session, doc: ViewDoc, key: NodeKey) => unknown) => async (arg?: NodeArg) => {
        const s = active();
        if (!arg?.key) throw new Error('no node under the pointer');
        await fn(s, s.doc(), arg.key);
    };

    reg('gaffy.node.open', node((s, d, k) => openNode(nodeOf(d, k), s, true, besideGraph(s))));
    reg('gaffy.node.editorMenu', node(async (s, d, k) => {
        if (await openNode(nodeOf(d, k), s, true, besideGraph(s))) await vscode.commands.executeCommand('editor.action.showContextMenu');
    }));
    reg('gaffy.node.references', node(async (s, d, k) => {
        if (await openNode(nodeOf(d, k), s, true, besideGraph(s))) await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
    }));
    reg('gaffy.node.callHierarchy', node(async (s, d, k) => {
        if (await openNode(nodeOf(d, k), s, true, besideGraph(s))) await vscode.commands.executeCommand('references-view.showCallHierarchy');
    }));


    const collapse = (kinds: string[], label: string) => node((s, d, k) => {
        const c = containerOfKind(d, k, kinds);
        if (!c) throw new Error(`no enclosing ${label}`);
        return s.update((doc) => { if (!doc.view.collapsed.includes(c)) doc.view.collapsed.push(c); });
    });
    reg('gaffy.node.collapseClass', collapse(['class'], 'class'));
    reg('gaffy.node.collapseFile', collapse(['module', 'file'], 'file or module'));
    reg('gaffy.node.collapsePackage', collapse(['package', 'folder'], 'package or folder'));
    // namespace grouping: box a module, dissolve a box, box every module inside a box
    reg('gaffy.node.groupModule', node((s, d, k) => {
        const m = containerOfKind(d, k, ['module', 'file']);
        if (!m) throw new Error('no enclosing module');
        return s.update((doc) => { doc.view.ungroup = doc.view.ungroup.filter((x) => x !== m); if (!doc.view.group.includes(m)) doc.view.group.push(m); dropMovesWithin(doc, m); });
    }));
    reg('gaffy.node.ungroup', node((s, _d, k) =>
        s.update((doc) => { doc.view.group = doc.view.group.filter((x) => x !== k); if (!doc.view.ungroup.includes(k)) doc.view.ungroup.push(k); dropMovesWithin(doc, k); })));
    reg('gaffy.node.groupInside', node((s, d, k) => {
        const nodes = d.graph.nodes;
        const mods = Object.values(nodes).filter((n) => (n.kind === 'module' || n.kind === 'file') && ancestors(nodes, n.key).includes(k)).map((n) => n.key);
        return s.update((doc) => {
            doc.view.ungroup = doc.view.ungroup.filter((x) => !mods.includes(x));
            for (const m of mods) { if (!doc.view.group.includes(m)) doc.view.group.push(m); dropMovesWithin(doc, m); }
        });
    }));
    reg('gaffy.node.expandContainer', node((s, _d, k) =>
        s.update((doc) => { doc.view.collapsed = doc.view.collapsed.filter((c) => c !== k); })));
    // seeds change in the webview (function keeps its place); the edit asks for missing calls
    reg('gaffy.node.makeSeed', forward('makeSeed'));
    reg('gaffy.node.removeSeed', forward('removeSeed'));
    reg('gaffy.node.tag', node(async (s, d, k) => {
        const v = await vscode.window.showInputBox({ prompt: 'tag (empty removes)', value: d.view.tags[k] ?? '' });
        if (v === undefined) return;
        await s.update((doc) => { if (v) doc.view.tags[k] = v; else delete doc.view.tags[k]; });
    }));

    const move = (delta: -1 | 1) => node(async (s, d, k) => {
        const sc = buildScene(d, await editor.styles.get(s.folder), excludes(s), external(s));
        const { slot, list } = siblingsOf(sc, k);
        const i = list.indexOf(k);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        const next = [...list];
        [next[i], next[j]] = [next[j], next[i]];
        await s.update((doc) => { doc.view.sibling[slot ?? ROOTS] = next; });
    });
    reg('gaffy.node.moveUp', move(-1));
    reg('gaffy.node.moveDown', move(1));

    reg('gaffy.node.revealInExplorer', node(async (s, d, k) => {
        const u = await nodeUri(nodeOf(d, k), s);
        if (u && readable(u)) await vscode.commands.executeCommand('revealInExplorer', u);
    }));
    reg('gaffy.node.copyPath', node(async (_s, d, k) => {
        const n = nodeOf(d, k);
        if (n?.path) await vscode.env.clipboard.writeText(n.line !== undefined ? `${n.path}:${n.line + 1}` : n.path);
    }));
    reg('gaffy.node.copyQualname', node(async (_s, d, k) => {
        const n = nodeOf(d, k);
        if (n) await vscode.env.clipboard.writeText(n.qual ? `${n.module}.${n.qual}` : n.module);
    }));

    // ---- webview messages that need the host ----------------------------------------------------------
    editor.onMessage = async (s, m) => {
        const key = typeof m.key === 'string' ? m.key as NodeKey : undefined;
        switch (m.type) {
            // function click: definition beside the graph (gaffy.openDefinitions)
            case 'open': if (cfg().get<boolean>('openDefinitions') ?? true) await openNode(key ? nodeOf(s.doc(), key) : undefined, s, false, besideGraph(s)); break;
            case 'openAt': {
                const n = key ? nodeOf(s.doc(), key) : undefined;
                const line = Number.isInteger(m.line) && (m.line as number) >= 0 ? m.line as number : undefined;
                await openNode(n && line !== undefined ? { ...n, line, character: 0 } : n, s, false, besideGraph(s));
                break;
            }
            case 'expand': if (key && Object.hasOwn(s.doc().graph.nodes, key)) await s.expand(key, m.dir === 'in' ? 'in' : 'out'); break;
            case 'refresh': await s.refresh(undefined, 'revalidate'); break;
            case 'export': await exportView(s); break;
            case 'save': await vscode.commands.executeCommand('gaffy.view.save'); break;
            // webview command missing its operand (selection, call, function): warning
            case 'warn': void vscode.window.showWarningMessage(plain(`gaffy: ${String(m.text ?? '').slice(0, 300)}`)); break;
            case 'editStyle': await vscode.commands.executeCommand('gaffy.editStyle'); break;
            case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${ctx.extension.id}`); break;
            case 'setting': {
                // Options > Settings: workspace settings (user settings without a workspace)
                // listed keys only, boolean values only
                const k = m.key as string;
                const ok = (k === 'includeExternal' || k === 'includeStandardLibrary' || k === 'saveViews') && typeof m.value === 'boolean';
                if (!ok) break;
                const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                await vscode.workspace.getConfiguration('gaffy').update(k, m.value, target);
                // external code on: re-ask answers fetched without it (on screen now, rest when opened)
                // standard library on: its on-screen functions get markers
                if (k === 'includeStandardLibrary' && m.value === true) for (const x of new Set(editor.sessions.values())) void x.ensure();
                if (k === 'includeExternal' && m.value === true) {
                    for (const c of editor.allCaches()) c.clear();
                    for (const x of new Set(editor.sessions.values())) void x.refresh(undefined, 'revalidate');
                }
                break;
            }
            case 'hiddenNeighbors': {
                const doc = s.doc();
                const keys = Array.isArray(m.keys) ? m.keys.filter((k): k is NodeKey => typeof k === 'string').slice(0, 1000) : [];
                const items = keys.map((k) => {
                    const n = nodeOf(doc, k);
                    return { label: visible(n ? (n.qual ? `${n.module}.${n.qual}` : n.module) : k), description: n?.path && visible(n.path), key: k, picked: true };
                });
                const pick = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Unhide neighbors', placeHolder: 'selected entries become visible' });
                if (!pick?.length) break;
                // a neighbor hides directly or through a hidden container
                const unhide = new Set<NodeKey>();
                for (const p of pick) { unhide.add(p.key); for (const a of ancestors(doc.graph.nodes, p.key)) unhide.add(a); }
                await s.update((d) => { d.view.hidden = d.view.hidden.filter((h) => !unhide.has(h)); });
                break;
            }
        }
    };
}
