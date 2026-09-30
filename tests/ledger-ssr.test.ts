import { LedgerWalletProvider } from '../src/wallet';

jest.mock('@ledgerhq/hw-app-str', () => {
  throw new Error('Ledger app must load only on connection');
});
jest.mock('@ledgerhq/hw-transport-webhid', () => {
  throw new Error('WebHID must load only on connection');
});

it('can import and construct the wallet provider without browser globals or loading Ledger', async () => {
  expect(typeof window).toBe('undefined');
  const provider = new LedgerWalletProvider();
  expect(await provider.isAvailable()).toBe(false);
  await expect(provider.connect()).rejects.toMatchObject({ code: 'UNSUPPORTED_ENVIRONMENT' });
  await provider.disconnect();
});
