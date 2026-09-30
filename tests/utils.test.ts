import { stroopsToXLM, truncateAddress } from '../src/utils/format';
import { xlmToStroops } from '../src/utils/validation';
import { retry } from '../src/utils/retry';


describe('format', () => {
  it('converts stroops to XLM', () => { expect(stroopsToXLM(10_000_000n)).toBe('1'); });
  it('converts XLM to stroops', () => { expect(xlmToStroops('1')).toBe(10_000_000n); });
  it('truncates long address', () => { expect(truncateAddress('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toContain('...'); });
});


describe('retry', () => {
  it('resolves on first success', async () => {
    const result = await retry(async () => 'ok', 3, 100);
    expect(result).toBe('ok');
  });
});
