import { describe, expect, it } from 'vitest';
import { blobLink, webBase } from '../src/core/weblinks';

describe('export web links', () => {
    it('remote URLs become https bases; credentials and .git dropped; other forms refused', () => {
        expect(webBase('git@github.com:foo/moo.git')).toBe('https://github.com/foo/moo');
        expect(webBase('https://github.com/foo/moo.git')).toBe('https://github.com/foo/moo');
        expect(webBase('https://user:secret@github.com/foo/moo')).toBe('https://github.com/foo/moo');
        expect(webBase('ssh://git@gitlab.com/goo/sub/moo.git')).toBe('https://gitlab.com/goo/sub/moo');
        expect(webBase('/home/somebody/moo')).toBeUndefined();
        expect(webBase('file:///tmp/moo')).toBeUndefined();
        expect(webBase('javascript:alert(1)')).toBeUndefined();
    });

    it('blob links pin the commit and the line, per host', () => {
        expect(blobLink('https://github.com/foo/moo', 'abc123', 'src/a b.py', 12)).toBe('https://github.com/foo/moo/blob/abc123/src/a%20b.py#L12');
        expect(blobLink('https://gitlab.com/goo/moo', 'abc123', 'src/a.py', 3)).toBe('https://gitlab.com/goo/moo/-/blob/abc123/src/a.py#L3');
        expect(blobLink('https://bitbucket.org/goo/moo', 'abc123', 'src/a.py', 3)).toBe('https://bitbucket.org/goo/moo/src/abc123/src/a.py#lines-3');
        expect(blobLink('https://github.com/foo/moo', 'abc123', 'src')).toBe('https://github.com/foo/moo/blob/abc123/src');
    });
});
