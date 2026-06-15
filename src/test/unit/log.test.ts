import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../../lib/log';

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\u001b[32mCompiling\u001b[0m foo \u001b[1;31merror\u001b[0m')).toBe('Compiling foo error');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain line 123')).toBe('plain line 123');
  });

  it('strips cursor/erase control sequences', () => {
    expect(stripAnsi('a\u001b[2Kb\u001b[1Gc')).toBe('abc');
  });

  it('handles an empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});
