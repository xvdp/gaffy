/** @xvdp
 * Language providers: per language with workspace files, the VS Code extension answering document symbols and call
 * hierarchy (`PROVIDERS`, core/langs.ts), its state (installed, enabled, active) and, on demand, a live probe of one
 * file (document symbols, call hierarchy at the first function). Start-up check once per workspace and gaffy version
 * (missing servers, until "Don't show again"); report on demand (`gaffy: List Language Providers`); warning with
 * actions when a file's provider answers nothing (`warnNoProvider`).
 *
 * "MISSING provider" is not a gaffy message: VS Code's References view throws it when it is shown (often restored
 * after a reload) without a call hierarchy input (references-view `_assertProvider`, VS Code 1.147). Closing the
 * References view ends it; `gaffy.openCallHierarchy` (off by default) is the only way gaffy opens that view.
 */
import * as vscode from 'vscode';
import { Provider, PROVIDERS, providerOf } from '../core/langs';

const SKIP = '{**/node_modules/**,**/.git/**,**/.venv/**,**/venv/**,**/site-packages/**,**/target/**,**/_deps/**}';
const FNS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);

/** Extension state of a provider: first installed id of `any`, enabled, active. */
export interface State { served: string | undefined; active: boolean; restart: string | undefined }

export interface Finding extends State {
    label: string; install: string; optional?: string;
    file?: vscode.Uri; symbols?: number; hierarchy?: boolean;   // live probe (report only)
}

async function stateOf(p: Provider, commands?: Set<string>): Promise<State> {
    const ext = p.any.map((id) => vscode.extensions.getExtension(id)).find(Boolean);
    const cmds = commands ?? new Set(await vscode.commands.getCommands(true));
    return { served: ext?.id, active: !!ext?.isActive, restart: p.restart.find((c) => cmds.has(c)) };
}

/** Document symbols of `uri`, and whether the first function has a call hierarchy item; undefined: no answer. */
async function probe(uri: vscode.Uri): Promise<{ symbols: number; hierarchy: boolean }> {
    const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri).then((x) => x ?? [], () => []);
    const flat: vscode.DocumentSymbol[] = [];
    const walk = (ss: vscode.DocumentSymbol[]) => ss.forEach((s) => { flat.push(s); walk(s.children ?? []); });
    walk(syms);
    const fn = flat.find((s) => FNS.has(s.kind));
    if (!fn) return { symbols: flat.length, hierarchy: false };
    const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, fn.selectionRange.start)
        .then((x) => x ?? [], () => []);
    return { symbols: flat.length, hierarchy: items.length > 0 };
}

/** Workspace languages with files, their provider state; `live`: also a probe of one file each. */
export async function checkServers(live = false): Promise<Finding[]> {
    const commands = new Set(await vscode.commands.getCommands(true));
    const out: Finding[] = [];
    for (const p of PROVIDERS) {
        const [file] = await vscode.workspace.findFiles(p.glob, SKIP, 1);
        if (!file) continue;
        const f: Finding = { label: p.label, install: p.install, optional: p.optional, file, ...(await stateOf(p, commands)) };
        if (live && f.served) Object.assign(f, await probe(file));
        out.push(f);
    }
    return out;
}

/** Markdown report of the findings, with install commands. */
export function report(found: Finding[]): string {
    const yes = (b: boolean | undefined) => (b === undefined ? 'not probed' : b ? 'yes' : 'no');
    const lines = ['# gaffy: language providers', '',
        'gaffy draws calls from each language server\'s call hierarchy. Languages with files in this workspace; the probe asks one file for its document symbols and for the call hierarchy of its first function:', '',
        '| Language | Extension | State | Probed file | Symbols | Call hierarchy | Restart command |', '|---|---|---|---|---|---|---|'];
    for (const f of found) {
        const state = f.served ? (f.active ? 'installed, active' : 'installed, not active yet') : f.optional ? `missing (optional: ${f.optional})` : 'missing';
        lines.push(`| ${f.label} | \`${f.served ?? f.install}\` | ${state} | ${f.file ? vscode.workspace.asRelativePath(f.file) : ''} | ${f.symbols ?? ''} | ${f.served ? yes(f.hierarchy) : ''} | ${f.restart ? `\`${f.restart}\`` : ''} |`);
    }
    const missing = found.filter((f) => !f.served);
    if (missing.length) {
        lines.push('', 'Install from the command line:', '', '```sh', ...missing.map((f) => `code --install-extension ${f.install}`), '```');
    }
    lines.push('',
        '- Installed, no call hierarchy: the server may still be indexing (wait, or run its restart command), or it treats the code as inactive.',
        '- Rust: rust-analyzer gives no call hierarchy for code under an inactive `#[cfg]` (for example a module behind a Cargo feature that is off); `"rust-analyzer.cargo.features": ["<feature>"]` or `"all"` in the workspace settings turns it on.',
        '- Python: Pylance and Pyright resolve imports through the selected interpreter; a package installed from a source folder of the workspace resolves into that folder with an editable install or `python.analysis.extraPaths`.',
        '- "MISSING provider" comes from VS Code\'s References view shown without a call hierarchy (for example restored after a reload), not from a language server: close the References view. gaffy opens that view only with `gaffy.openCallHierarchy`.',
        '- Outside VS Code: `npm run providers -- <folder>` in the gaffy repository lists the installed extensions against the same table.');
    return lines.join('\n') + '\n';
}

/** Opens the report (live probe) as an unsaved Markdown document. */
export async function showReport(found?: Finding[]): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report(found ?? (await checkServers(true))) });
    await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Warning for a file whose provider answered nothing (`what`: the request that failed): language, extension id, its
 * state, and the actions that apply (install, restart its server, report).
 */
export async function warnNoProvider(uri: vscode.Uri, what: string): Promise<void> {
    const p = providerOf(uri.path);
    if (!p) {
        void vscode.window.showWarningMessage(`gaffy: ${what}: no language provider with call hierarchy is known for .${uri.path.split('.').pop()} files.`);
        return;
    }
    const s = await stateOf(p);
    const state = !s.served ? `${p.name} (${p.install}) is not installed`
        : !s.active ? `${p.name} (${s.served}) is installed but not active yet (it starts with a file of its language)`
            : `${p.name} (${s.served}) is active but answered nothing (still indexing, or code it treats as inactive)`;
    const acts = [!s.served ? `Install ${p.install}` : undefined, s.served && s.restart ? `Restart ${p.name}` : undefined, 'List Providers']
        .filter((x): x is string => !!x);
    const pick = await vscode.window.showWarningMessage(`gaffy: ${what} (${p.label}): ${state}.`, ...acts);
    if (!pick) return;
    if (pick.startsWith('Install ')) await vscode.commands.executeCommand('workbench.extensions.installExtension', p.install);
    else if (pick.startsWith('Restart ') && s.restart) await vscode.commands.executeCommand(s.restart);
    else await showReport();
}

/** Start-up check, once per workspace and gaffy version: notification for missing required servers. */
export async function checkOnStart(ctx: vscode.ExtensionContext): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length || ctx.workspaceState.get<boolean>('gaffy.servers.dismissed')) return;
    const stamp = `gaffy.servers.checked:${ctx.extension.packageJSON.version}`;
    if (ctx.workspaceState.get<boolean>(stamp)) return;
    await ctx.workspaceState.update(stamp, true);
    const found = await checkServers();
    const missing = found.filter((f) => !f.served && !f.optional);
    if (!missing.length) return;
    const names = missing.map((f) => `${f.label} (${f.install})`).join(', ');
    const install = missing.length === 1 ? `Install ${missing[0].install}` : undefined;
    const pick = await vscode.window.showInformationMessage(
        `gaffy: no call hierarchy for ${names} in this workspace.`, ...[install, 'Show Report', "Don't Show Again"].filter((x): x is string => !!x));
    if (pick === install && install) await vscode.commands.executeCommand('workbench.extensions.installExtension', missing[0].install);
    else if (pick === 'Show Report') await showReport();
    else if (pick === "Don't Show Again") await ctx.workspaceState.update('gaffy.servers.dismissed', true);
}
