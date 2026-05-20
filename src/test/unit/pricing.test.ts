import { describe, it, expect } from 'vitest';
import { satoshiToDisplay } from '../../sdk/pricing';

describe('Pricing SDK Unit Tests', () => {
  describe('satoshiToDisplay', () => {
    it('should convert standard satoshi values to display strings', () => {
      // 10^12 satoshi = 1 ACU
      expect(satoshiToDisplay('1000000000000')).toBe('1');
    });

    it('should handle decimal fractional values correctly', () => {
      // 5 * 10^11 satoshi = 0.5 ACU
      expect(satoshiToDisplay('500000000000')).toBe('0.5');
      // 1.23 * 10^14 satoshi = 123 ACU
      expect(satoshiToDisplay('123000000000000')).toBe('123');
    });

    it('should handle zero correctly', () => {
      expect(satoshiToDisplay('0')).toBe('0');
    });

    it('should handle small fractional values (less than 1 ACU)', () => {
      // 1 satoshi = 1e-12 ACU
      expect(satoshiToDisplay('1')).toBe('0.000000000001');
    });
  });
});
