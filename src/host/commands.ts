/**
 * Commands: graph creation from the editor and explorer, view commands, and node commands invoked from
 * the webview context menu. A `webview/context` command receives the merged `data-vscode-context`
 * object of the clicked element: `{ webviewSection, key, webview }`.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { toHtmlPre, toText } from '../core/grid';
import { ancestors, GNode, NodeKey } from '../core/model';
import { buildScene, siblingsOf } from '../core/scene';
import { DEFAULT_STYLE, glyphSet } from '../core/style';
import { Direction, emptyDoc, ROOTS, serializeDoc, ViewDoc } from '../core/viewdoc';
import { GaffyEditor, Session } from './editor';
import { folderOf, gaffyDir } from './style';

interface NodeArg { key?: NodeKey; unit?: string; to?: NodeKey; webviewSection?: string }

const cfg = () => vscode.workspace.getConfiguration('gaffy');

function nodeOf(doc: ViewDoc, key: NodeKey): GNode | undefined {
  return doc.graph.nodes[key];
}

async function uniqueUri(dir: vscode.Uri, stem: string, ext: string): Promise<vscode.Uri> {
  const safe = stem.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'view';
  for (let i = 1; ; i++) {
    const u = vscode.Uri.joinPath(dir, `${safe}${i > 1 ? `-${i}` : ''}${ext}`);
    try { await vscode.workspace.fs.stat(u); } catch { return u; }
  }
}

async function openNode(n: GNode | undefined, focus: boolean): Promise<vscode.TextEditor | undefined> {
  if (!n?.uri) return undefined;
  const uri = vscode.Uri.parse(n.uri);
  if (n.kind === 'package' || n.kind === 'folder') {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return undefined;
  }
  const pos = new vscode.Position(n.line ?? 0, n.character ?? 0);
  return vscode.window.showTextDocument(uri, {
    viewColumn: cfg().get<boolean>('openBeside') ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    selection: new vscode.Range(pos, pos),
    preserveFocus: !focus,
    preview: true,
  });
}

/** Innermost container of `key` (or `key` itself) whose kind is in `kinds`. */
function containerOfKind(doc: ViewDoc, key: NodeKey, kinds: string[]): NodeKey | undefined {
  const nodes = doc.graph.nodes;
  for (const k of [key, ...ancestors(nodes, key)]) if (kinds.includes(nodes[k]?.kind)) return k;
  return undefined;
}

export function registerCommands(ctx: vscode.ExtensionContext, editor: GaffyEditor): void {
  const provider = editor.provider;
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...a: any[]) => {
      try { await fn(...a); } catch (e) { void vscode.window.showErrorMessage(`gaffy: ${(e as Error).message}`); }
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
    if (!items.length) throw new Error('no call hierarchy item at the cursor (language server without call hierarchy?)');
    const acc: Record<NodeKey, GNode> = {};
    const key = await provider.describe(items[0], acc);
    if (!key) throw new Error('symbol outside the workspace (gaffy.includeExternal is off)');
    return { key, acc, uri: ed.document.uri, node: acc[key] };
  };

  const createView = async (base: vscode.Uri, stem: string, doc: ViewDoc) => {
    const views = vscode.Uri.joinPath(gaffyDir(folderOf(base)), 'views');
    await vscode.workspace.fs.createDirectory(views);
    const uri = await uniqueUri(views, stem, '.gaffy');
    doc.name = path.basename(uri.path, '.gaffy');
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeDoc(doc)));
    await vscode.commands.executeCommand('vscode.openWith', uri, GaffyEditor.viewType,
      { viewColumn: vscode.ViewColumn.Active });
  };

  const graphAtCursor = async (direction: Direction) => {
    const s = await seedAtCursor();
    const doc = emptyDoc(s.node.name, { seeds: [s.key], direction, depth: cfg().get<number>('depth') ?? 4 });
    doc.graph.nodes = s.acc;
    await createView(s.uri, `${s.node.name}.${direction === 'in' ? 'callers' : direction === 'out' ? 'callees' : 'calls'}`, doc);
  };

  reg('gaffy.graphCallers', () => graphAtCursor('in'));
  reg('gaffy.graphCallees', () => graphAtCursor('out'));
  reg('gaffy.graphBoth', () => graphAtCursor('both'));

  reg('gaffy.addToView', async () => {
    const sess = active();
    const s = await seedAtCursor();
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
    if (!seeds.length) throw new Error('no functions with call hierarchy in this file');
    const doc = emptyDoc('', { seeds, direction: 'out', depth: 1 });
    doc.graph.nodes = acc;
    await createView(uri, path.basename(uri.path), doc);
  });

  // ---- view commands ------------------------------------------------------------------------------
  reg('gaffy.refresh', () => active().refresh(undefined, 'revalidate'));
  reg('gaffy.clearCache', () => { for (const c of editor.allCaches()) c.clear(); void vscode.window.showInformationMessage('gaffy: call cache cleared'); });
  reg('gaffy.toggleOrder', () => active().update((d) => { d.view.order = d.view.order === 'callees' ? 'callers' : 'callees'; }));
  reg('gaffy.toggleEdges', async () => {
    const s = active();
    const st = await editor.styles.get(s.folder);
    await s.update((d) => { d.view.edges = (d.view.edges ?? st.edges.mode) === 'glyph' ? 'vector' : 'glyph'; });
  });
  reg('gaffy.unhideAll', () => active().update((d) => { d.view.hidden = []; }));
  reg('gaffy.toggleBoxes', async () => {
    const s = active();
    const st = await editor.styles.get(s.folder);
    await s.update((d) => { d.view.boxes = !(d.view.boxes ?? st.boxes.enabled); });
  });
  reg('gaffy.rearrange', () => active().update((d) => { d.view.offset = {}; }));
  reg('gaffy.unlockAll', () => active().update((d) => { d.view.lock = {}; }));

  // commands that need the layout or the selection run in the webview
  const forward = (cmd: string) => (arg?: NodeArg) => {
    const s = active();
    void s.panel.webview.postMessage({ type: 'cmd', cmd, key: arg?.key, unit: arg?.unit, to: arg?.to });
  };
  reg('gaffy.node.fold', forward('fold'));
  reg('gaffy.edge.subtree', forward('callSubtree'));
  reg('gaffy.edge.path', forward('callPath'));
  reg('gaffy.edge.callSite', forward('callSite'));
  reg('gaffy.edge.callee', forward('callee'));
  reg('gaffy.resetLayout', forward('resetLayout'));
  reg('gaffy.showAll', forward('showAll'));
  reg('gaffy.node.lock', forward('lock'));
  reg('gaffy.node.unlock', forward('unlock'));
  reg('gaffy.node.showHidden', forward('showHidden'));
  reg('gaffy.sel.upstream', forward('upstream'));
  reg('gaffy.sel.downstream', forward('downstream'));
  reg('gaffy.sel.through', forward('through'));
  reg('gaffy.sel.between', forward('between'));
  reg('gaffy.sel.hide', forward('hideSelection'));
  reg('gaffy.sel.isolate', forward('isolate'));
  reg('gaffy.sel.clear', forward('clearSelection'));

  const exportView = async (s: Session) => {
    const doc = s.doc();
    const style = await editor.styles.get(s.folder);
    const sc = buildScene(doc, style);
    const gs = glyphSet(style);
    const outDir = vscode.Uri.joinPath(gaffyDir(s.folder), 'export');
    await vscode.workspace.fs.createDirectory(outDir);
    const href = (key: NodeKey) => {
      const n = nodeOf(doc, key);
      if (!n?.uri) return undefined;
      const rel = path.posix.relative(outDir.path, vscode.Uri.parse(n.uri).path);
      return n.line !== undefined && n.kind !== 'package' && n.kind !== 'folder' ? `${rel}#L${n.line + 1}` : rel;
    };
    const md = `# ${doc.name}\n\n<pre>\n${toHtmlPre(sc.grid, gs, href)}\n</pre>\n`;
    const mdUri = vscode.Uri.joinPath(outDir, `${s.name}.md`);
    await vscode.workspace.fs.writeFile(mdUri, new TextEncoder().encode(md));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(outDir, `${s.name}.txt`),
      new TextEncoder().encode(toText(sc.grid, gs) + '\n'));
    await vscode.commands.executeCommand('markdown.showPreviewToSide', mdUri);
  };
  reg('gaffy.export', () => exportView(active()));

  reg('gaffy.editStyle', async () => {
    const folder = editor.active?.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) throw new Error('no workspace folder');
    const uri = vscode.Uri.joinPath(gaffyDir(folder), 'style.json');
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

  reg('gaffy.node.open', node((_s, d, k) => openNode(nodeOf(d, k), true)));
  reg('gaffy.node.editorMenu', node(async (_s, d, k) => {
    if (await openNode(nodeOf(d, k), true)) await vscode.commands.executeCommand('editor.action.showContextMenu');
  }));
  reg('gaffy.node.references', node(async (_s, d, k) => {
    if (await openNode(nodeOf(d, k), true)) await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
  }));
  reg('gaffy.node.callHierarchy', node(async (_s, d, k) => {
    if (await openNode(nodeOf(d, k), true)) await vscode.commands.executeCommand('references-view.showCallHierarchy');
  }));

  const expand = (dir: 'in' | 'out') => node((s, _d, k) => s.refresh((doc) => {
    const prev = doc.view.expanded[k];
    doc.view.expanded[k] = prev && prev !== dir ? 'both' : dir;
  }));
  reg('gaffy.node.expandCallers', expand('in'));
  reg('gaffy.node.expandCallees', expand('out'));

  const collapse = (kinds: string[], label: string) => node((s, d, k) => {
    const c = containerOfKind(d, k, kinds);
    if (!c) throw new Error(`no enclosing ${label}`);
    return s.update((doc) => { if (!doc.view.collapsed.includes(c)) doc.view.collapsed.push(c); });
  });
  reg('gaffy.node.collapseClass', collapse(['class'], 'class'));
  reg('gaffy.node.collapseFile', collapse(['module', 'file'], 'file or module'));
  reg('gaffy.node.collapsePackage', collapse(['package', 'folder'], 'package or folder'));
  reg('gaffy.node.expandContainer', node((s, _d, k) =>
    s.update((doc) => { doc.view.collapsed = doc.view.collapsed.filter((c) => c !== k); })));
  reg('gaffy.node.hide', node((s, _d, k) => s.update((doc) => { if (!doc.view.hidden.includes(k)) doc.view.hidden.push(k); })));
  reg('gaffy.node.makeSeed', node((s, _d, k) => s.refresh((doc) => { if (!doc.view.seeds.includes(k)) doc.view.seeds.push(k); })));
  reg('gaffy.node.removeSeed', node((s, _d, k) => s.refresh((doc) => { doc.view.seeds = doc.view.seeds.filter((x) => x !== k); })));
  reg('gaffy.node.tag', node(async (s, d, k) => {
    const v = await vscode.window.showInputBox({ prompt: 'tag (empty removes)', value: d.view.tags[k] ?? '' });
    if (v === undefined) return;
    await s.update((doc) => { if (v) doc.view.tags[k] = v; else delete doc.view.tags[k]; });
  }));

  const move = (delta: -1 | 1) => node(async (s, d, k) => {
    const sc = buildScene(d, await editor.styles.get(s.folder));
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

  reg('gaffy.node.revealInExplorer', node(async (_s, d, k) => {
    const n = nodeOf(d, k);
    if (n?.uri) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse(n.uri));
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
    const key = m.key as NodeKey | undefined;
    switch (m.type) {
      case 'open': await openNode(key ? nodeOf(s.doc(), key) : undefined, false); break;
      case 'openAt': {
        const n = key ? nodeOf(s.doc(), key) : undefined;
        const line = m.line as number | undefined;
        await openNode(n && line !== undefined ? { ...n, line, character: 0 } : n, false);
        break;
      }
      case 'expand': if (key) await s.refresh((doc) => {
        const dir = (m.dir as Direction | undefined) ?? doc.view.direction;
        const prev = doc.view.expanded[key];
        doc.view.expanded[key] = prev && prev !== dir ? 'both' : dir;
      }); break;
      case 'refresh': await s.refresh(undefined, 'revalidate'); break;
      case 'export': await exportView(s); break;
      case 'editStyle': await vscode.commands.executeCommand('gaffy.editStyle'); break;
      case 'hiddenNeighbors': {
        const doc = s.doc();
        const keys = (m.keys as NodeKey[] | undefined) ?? [];
        const items = keys.map((k) => {
          const n = nodeOf(doc, k);
          return { label: n ? (n.qual ? `${n.module}.${n.qual}` : n.module) : k, description: n?.path, key: k, picked: true };
        });
        const pick = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Unhide neighbors', placeHolder: 'selected entries become visible' });
        if (!pick?.length) break;
        // a neighbor can be hidden itself or through a hidden container
        const unhide = new Set<NodeKey>();
        for (const p of pick) { unhide.add(p.key); for (const a of ancestors(doc.graph.nodes, p.key)) unhide.add(a); }
        await s.update((d) => { d.view.hidden = d.view.hidden.filter((h) => !unhide.has(h)); });
        break;
      }
    }
  };
}
