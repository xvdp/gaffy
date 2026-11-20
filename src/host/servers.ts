/**
 * Language servers for the languages of a workspace: which VS Code extensions give gaffy document
 * symbols and call hierarchy, which are installed and enabled, and what to install.
 *
 * Run once per workspace and gaffy version after start-up (a notification only when a language with
 * files has no server, until "Don't show again"), and on demand: `gaffy: Check Language Servers`.
 * Files are probed with one `findFiles` per language (limit 1); extensions through `vscode.extensions.all`
 * (installed and enabled), compared without case.
 */
import * as vscode from 'vscode';

interface Need {
    label: string;
    glob: string;
    any: string[];           // any one of these extensions serves the language
    install: string;         // the one to suggest
    optional?: string;       // gaffy works without it, with this caveat
}

const NEEDS: Need[] = [
    { label: 'Python', glob: '**/*.{py,pyi}', any: ['ms-python.vscode-pylance', 'ms-pyright.pyright', 'detachhead.basedpyright'], install: 'ms-python.vscode-pylance' },
    { label: 'Rust', glob: '**/*.rs', any: ['rust-lang.rust-analyzer'], install: 'rust-lang.rust-analyzer' },
    { label: 'C, C++, CUDA', glob: '**/*.{c,cc,cpp,cxx,cu,cuh,h,hh,hpp,hxx}', any: ['ms-vscode.cpptools', 'llvm-vs-code-extensions.vscode-clangd'], install: 'ms-vscode.cpptools' },
    { label: 'TypeScript, JavaScript', glob: '**/*.{ts,tsx,js,jsx,mjs,cjs}', any: ['vscode.typescript-language-features'], install: 'vscode.typescript-language-features' },
    { label: 'Go', glob: '**/*.go', any: ['golang.go'], install: 'golang.go' },
    { label: 'Java', glob: '**/*.java', any: ['redhat.java'], install: 'redhat.java' },
    { label: 'C#', glob: '**/*.cs', any: ['ms-dotnettools.csdevkit', 'ms-dotnettools.csharp'], install: 'ms-dotnettools.csdevkit' },
    { label: 'Dart', glob: '**/*.dart', any: ['dart-code.dart-code'], install: 'Dart-Code.dart-code' },
    { label: 'Slang', glob: '**/*.{slang,slangh}', any: ['shader-slang.slang-language-extension'], install: 'shader-slang.slang-language-extension',
        optional: 'gaffy finds Slang calls in the text without it; with it, go to definition makes them exact' },
    { label: 'GLSL', glob: '**/*.{glsl,vert,frag,comp,geom,tesc,tese}', any: ['raczzalan.webgl-glsl-editor'], install: 'raczzalan.webgl-glsl-editor',
        optional: 'gaffy finds GLSL calls in the text without it' },
];

const SKIP = '{**/node_modules/**,**/.git/**,**/.venv/**,**/venv/**,**/site-packages/**,**/target/**,**/_deps/**}';

export interface Finding { label: string; present: boolean; served: string | undefined; install: string; optional?: string }

/** Languages with files in the workspace, and the installed extension serving each (undefined: none). */
export async function checkServers(): Promise<Finding[]> {
    const installed = new Set(vscode.extensions.all.map((e) => e.id.toLowerCase()));
    const out: Finding[] = [];
    for (const n of NEEDS) {
        const present = (await vscode.workspace.findFiles(n.glob, SKIP, 1)).length > 0;
        if (!present) continue;
        out.push({ label: n.label, present, served: n.any.find((id) => installed.has(id.toLowerCase())), install: n.install, optional: n.optional });
    }
    return out;
}

/** Markdown report of the findings, with install commands. */
export function report(found: Finding[]): string {
    const lines = ['# gaffy: language servers', '',
        'gaffy draws calls from each language server\'s call hierarchy. Languages with files in this workspace:', '',
        '| Language | Extension | Status |', '|---|---|---|'];
    for (const f of found) lines.push(`| ${f.label} | \`${f.served ?? f.install}\` | ${f.served ? 'installed' : f.optional ? `missing (optional: ${f.optional})` : 'missing'} |`);
    const missing = found.filter((f) => !f.served);
    if (missing.length) {
        lines.push('', 'Install from the command line:', '', '```sh', ...missing.map((f) => `code --install-extension ${f.install}`), '```');
    }
    lines.push('', 'Rust: rust-analyzer gives no call hierarchy for code under an inactive `#[cfg]` (for example a module behind a Cargo feature that is off); `"rust-analyzer.cargo.features": ["<feature>"]` or `"all"` in the workspace settings turns it on.',
        'Python: Pylance and Pyright resolve imports through the selected interpreter; a package installed from a source folder of the workspace resolves into that folder with an editable install or `python.analysis.extraPaths`.');
    return lines.join('\n') + '\n';
}

/** Opens the report as an unsaved Markdown document. */
export async function showReport(found?: Finding[]): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report(found ?? (await checkServers())) });
    await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * After start-up: once per workspace and gaffy version, a notification when a language with files has no
 * server (required ones only), with Install, Show Report, and Don't Show Again.
 */
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
    else if (pick === 'Show Report') await showReport(found);
    else if (pick === "Don't Show Again") await ctx.workspaceState.update('gaffy.servers.dismissed', true);
}
