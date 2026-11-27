/** @xvdp
 * Web links of exports (setting gaffy.exportWebLinks): the git remote as an https base, blob links per host.
 * `git@host:owner/repo.git`, `ssh://git@host/owner/repo.git`, `https://user:token@host/owner/repo.git` =>
 * `https://host/owner/repo` (credentials dropped: an export never carries them). Blob links pin a commit:
 * GitHub and others `<base>/blob/<commit>/<path>#L<line>`, GitLab `<base>/-/blob/...`, Bitbucket
 * `<base>/src/<commit>/<path>#lines-<line>`.
 */

/** https base of a git remote URL; undefined when it is not a recognised remote. */
export function webBase(remote: string): string | undefined {
    const r = remote.trim();
    let host: string, repo: string;
    const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(r);                      // git@github.com:owner/repo.git
    if (scp) [host, repo] = [scp[1], scp[2]];
    else {
        let u: URL;
        try { u = new URL(r); } catch { return undefined; }
        if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return undefined;
        [host, repo] = [u.hostname, u.pathname];
    }
    repo = repo.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9.-]+$/.test(host) || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) return undefined;
    return `https://${host}/${repo}`;
}

/** Link to `path` (relative to the repository root) at `commit`, line `line` (1-based) when given. */
export function blobLink(base: string, commit: string, path: string, line?: number): string {
    const host = new URL(base).hostname;
    const p = path.split('/').map(encodeURIComponent).join('/');
    if (host === 'bitbucket.org') return `${base}/src/${commit}/${p}${line ? `#lines-${line}` : ''}`;
    const blob = host === 'gitlab.com' || host.startsWith('gitlab.') ? '-/blob' : 'blob';
    return `${base}/${blob}/${commit}/${p}${line ? `#L${line}` : ''}`;
}
