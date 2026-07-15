import { describe, it, expect } from 'vitest';
import { httpsExternalUrl } from '../../lib/url';

describe('httpsExternalUrl', () => {
  it('accepts https URLs and returns the normalized string', () => {
    expect(httpsExternalUrl('https://acurast.com/donate')).toBe('https://acurast.com/donate');
    expect(httpsExternalUrl('https://processor.acurast.com/devtools?job=42')).toBe(
      'https://processor.acurast.com/devtools?job=42',
    );
  });

  it('rejects non-https schemes that openExternal must never receive', () => {
    expect(httpsExternalUrl('http://insecure.example')).toBeUndefined();
    expect(httpsExternalUrl('file:///etc/passwd')).toBeUndefined();
    expect(httpsExternalUrl('command:workbench.action.terminal.new')).toBeUndefined();
    expect(httpsExternalUrl('vscode://ms-vscode.node-debug/launch')).toBeUndefined();
    expect(httpsExternalUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('rejects empty/undefined and unparseable input', () => {
    expect(httpsExternalUrl(undefined)).toBeUndefined();
    expect(httpsExternalUrl('')).toBeUndefined();
    expect(httpsExternalUrl('not a url')).toBeUndefined();
  });
});
