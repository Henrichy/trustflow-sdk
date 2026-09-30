/** @jest-environment jsdom */
import Transport from '@ledgerhq/hw-transport';
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
} from '@stellar/stellar-sdk';
import { LedgerWalletProvider, TrustFlowError } from '../src/wallet';
import type { WalletProvider } from '../src/wallet';

const mockCreate = jest.fn();
jest.mock('@ledgerhq/hw-transport-webhid', () => ({
  __esModule: true,
  default: { create: () => mockCreate() },
}));

const signer = Keypair.random();
const recipient = Keypair.random();

/** Runs the real Ledger Stellar app against deterministic APDU replies. */
class MockTransport extends Transport {
  commands: Buffer[] = [];
  payload: Buffer = Buffer.alloc(0);
  signedPayload?: Buffer;
  corruptSignature = false;
  close = jest.fn(async () => undefined);
  setScrambleKey(): void {}
  exchange = jest.fn(async (apdu: Buffer): Promise<Buffer> => {
    this.commands.push(apdu);
    const instruction = apdu[1];
    if (instruction === 0x02) {
      return Buffer.concat([signer.rawPublicKey(), Buffer.from([0x90, 0x00])]);
    }
    this.payload =
      apdu[2] === 0 ? apdu.subarray(5) : Buffer.concat([this.payload, apdu.subarray(5)]);
    if (apdu[3] === 0x80) return Buffer.from([0x90, 0x00]);
    this.signedPayload = this.payload.subarray(13); // Three hardened BIP-44 components.
    const signature = this.corruptSignature
      ? Buffer.alloc(64)
      : signer.sign(instruction === 0x04 ? hash(this.signedPayload) : this.signedPayload);
    return Buffer.concat([signature, Buffer.from([0x90, 0x00])]);
  });
}

function buildTransaction(passphrase: string = Networks.TESTNET) {
  return new TransactionBuilder(new Account(signer.publicKey(), '10'), {
    fee: '100',
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.payment({
        destination: recipient.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(60)
    .build();
}

describe('LedgerWalletProvider', () => {
  let transport: MockTransport;
  let provider: LedgerWalletProvider;

  beforeEach(() => {
    transport = new MockTransport();
    jest.spyOn(transport, 'on');
    jest.spyOn(transport, 'off');
    provider = new LedgerWalletProvider({ transportFactory: async () => transport });
    mockCreate.mockReset().mockResolvedValue(transport);
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'hid', { configurable: true, value: {} });
  });

  afterEach(async () => {
    await provider.disconnect();
  });

  it('implements the provider contract and confirms the Stellar BIP-44 address', async () => {
    const wallet: WalletProvider = provider;
    expect(await wallet.connect()).toEqual({
      type: 'ledger',
      publicKey: signer.publicKey(),
      network: 'TESTNET',
    });
    expect(transport.commands[0]?.subarray(0, 5)).toEqual(Buffer.from([0xe0, 0x02, 0, 1, 13]));
    expect(transport.commands[0]?.subarray(5)).toEqual(
      Buffer.from('038000002c8000009480000000', 'hex'),
    );
    await wallet.connect();
    expect(transport.commands).toHaveLength(1);
  });

  it('uses the WebHID factory in a supported secure browser', async () => {
    provider = new LedgerWalletProvider({ accountIndex: 5, network: 'MAINNET' });
    expect(await provider.isAvailable()).toBe(true);
    expect(await provider.connect()).toMatchObject({ network: 'MAINNET' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(transport.commands[0]?.subarray(14)).toEqual(Buffer.from('80000005', 'hex'));
  });

  it.each([false, true])('rejects unavailable WebHID (secure=%s)', async (secure) => {
    Reflect.deleteProperty(navigator, 'hid');
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure });
    provider = new LedgerWalletProvider();
    expect(await provider.isAvailable()).toBe(false);
    await expect(provider.connect()).rejects.toMatchObject({ code: 'UNSUPPORTED_ENVIRONMENT' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an insecure context even when WebHID is present', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    provider = new LedgerWalletProvider();
    await expect(provider.connect()).rejects.toMatchObject({ code: 'UNSUPPORTED_ENVIRONMENT' });
  });

  it.each([-1, 0.5, NaN, Infinity, 0x80000000])('validates account index %s', (accountIndex) => {
    expect(() => new LedgerWalletProvider({ accountIndex })).toThrow(TrustFlowError);
  });

  it('validates network configuration', () => {
    expect(() => new LedgerWalletProvider({ networkPassphrase: ' ' })).toThrow(TrustFlowError);
    // @ts-expect-error Invalid runtime input
    expect(() => new LedgerWalletProvider({ network: 'unknown' })).toThrow(TrustFlowError);
  });

  it('transmits the complete signature base and preserves existing signatures', async () => {
    await provider.connect();
    const tx = buildTransaction();
    tx.sign(recipient);
    const original = tx.toXDR();
    const signed = TransactionBuilder.fromXDR(
      await provider.sign(original, 'TESTNET'),
      Networks.TESTNET,
    );
    expect(transport.signedPayload).toEqual(tx.signatureBase());
    expect(transport.commands.filter((c) => c[1] === 0x04).length).toBeGreaterThan(0);
    expect(transport.commands.some((c) => c[1] === 0x08)).toBe(false);
    expect(signed.hash()).toEqual(tx.hash());
    expect(signed.signatures).toHaveLength(2);
    expect(signed.signatures[0]?.toXDR()).toEqual(tx.signatures[0]?.toXDR());
    expect(signer.verify(signed.hash(), signed.signatures[1]!.signature())).toBe(true);
    expect(tx.toXDR()).toBe(original);
  });

  it('signs a fee-bump envelope with the fee source signature', async () => {
    await provider.connect();
    const inner = buildTransaction();
    inner.sign(signer);
    const tx = TransactionBuilder.buildFeeBumpTransaction(signer, '200', inner, Networks.TESTNET);
    const signed = TransactionBuilder.fromXDR(
      await provider.sign(tx.toXDR(), Networks.TESTNET),
      Networks.TESTNET,
    );
    expect(signed).toBeInstanceOf(FeeBumpTransaction);
    expect(transport.signedPayload).toEqual(tx.signatureBase());
    expect(signer.verify(tx.hash(), signed.signatures[0]!.signature())).toBe(true);
    expect((signed as FeeBumpTransaction).innerTransaction.toXDR()).toBe(inner.toXDR());
  });

  it('chunks a large transaction through the Ledger app', async () => {
    await provider.connect();
    const builder = new TransactionBuilder(new Account(signer.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    });
    for (let i = 0; i < 10; i++)
      builder.addOperation(Operation.manageData({ name: `key${i}`, value: 'x'.repeat(64) }));
    const tx = builder.setTimeout(60).build();
    await provider.sign(tx.toXDR(), 'TESTNET');
    expect(transport.commands.filter((c) => c[1] === 0x04).length).toBeGreaterThan(1);
    expect(transport.signedPayload).toEqual(tx.signatureBase());
  });

  it('binds signatures to a custom network passphrase', async () => {
    provider = new LedgerWalletProvider({
      networkPassphrase: 'Private escrow network',
      transportFactory: async () => transport,
    });
    await provider.connect();
    const tx = buildTransaction('Private escrow network');
    const signed = TransactionBuilder.fromXDR(
      await provider.sign(tx.toXDR(), 'Private escrow network'),
      'Private escrow network',
    );
    expect(signer.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
  });

  it('rejects malformed XDR and a mismatched network before asking the device', async () => {
    await provider.connect();
    await expect(provider.sign('invalid', 'TESTNET')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(provider.sign(buildTransaction().toXDR(), 'MAINNET')).rejects.toMatchObject({
      code: 'SIGNING_ERROR',
    });
    expect(transport.commands).toHaveLength(1);
  });

  it('requires connection before transaction or message signing', async () => {
    await expect(provider.sign(buildTransaction().toXDR(), 'TESTNET')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    await expect(provider.signMessage('challenge')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });

  it('rejects invalid signatures and can retry', async () => {
    await provider.connect();
    transport.corruptSignature = true;
    await expect(provider.sign(buildTransaction().toXDR(), 'TESTNET')).rejects.toMatchObject({
      code: 'SIGNING_ERROR',
    });
    transport.corruptSignature = false;
    await expect(provider.sign(buildTransaction().toXDR(), 'TESTNET')).resolves.toEqual(
      expect.any(String),
    );
  });

  it('reports the incompatible raw message signature contract without a device request', async () => {
    await provider.connect();
    const message = 'TrustFlow challenge 🔑';
    await expect(provider.signMessage(message)).rejects.toMatchObject({
      code: 'SIGNING_ERROR',
      message: expect.stringContaining('SEP-53'),
    });
    expect(transport.commands).toHaveLength(1);
  });

  it('maps on-device refusal and leaves signing retryable', async () => {
    await provider.connect();
    transport.exchange.mockRejectedValueOnce({ statusCode: 0x6985 });
    await expect(provider.sign(buildTransaction().toXDR(), 'TESTNET')).rejects.toMatchObject({
      code: 'USER_REJECTED',
    });
    await expect(provider.sign(buildTransaction().toXDR(), 'TESTNET')).resolves.toEqual(
      expect.any(String),
    );
  });

  it('propagates unsupported device operations without hash-signing fallback', async () => {
    await provider.connect();
    transport.exchange.mockRejectedValueOnce({ statusCode: 0xb005 });
    await expect(provider.sign(buildTransaction().toXDR(), 'TESTNET')).rejects.toMatchObject({
      code: 'SIGNING_ERROR',
    });
    expect(transport.commands.some((c) => c[1] === 0x08)).toBe(false);
  });

  it('cleans up after failed address confirmation and allows reconnecting', async () => {
    transport.exchange.mockRejectedValueOnce({ statusCode: 0x6985 });
    await expect(provider.connect()).rejects.toMatchObject({ code: 'USER_REJECTED' });
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(transport.off).toHaveBeenCalledWith('disconnect', expect.any(Function));
    await expect(provider.connect()).resolves.toMatchObject({ publicKey: signer.publicKey() });
  });

  it('rejects an invalid public key and releases the transport', async () => {
    transport.exchange.mockResolvedValueOnce(Buffer.from([1, 0x90, 0]));
    await expect(provider.connect()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('does not return a signature if the device disconnects during signing', async () => {
    await provider.connect();
    const tx = buildTransaction();
    transport.exchange.mockImplementationOnce(async () => {
      transport.emit('disconnect');
      return Buffer.concat([signer.sign(tx.hash()), Buffer.from([0x90, 0])]);
    });
    await expect(provider.sign(tx.toXDR(), 'TESTNET')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });

  it('provides the Buffer implementation required by LedgerJS in a browser', async () => {
    const original = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, 'Buffer');
    try {
      await provider.connect();
      expect(typeof globalThis.Buffer.from).toBe('function');
      expect(await provider.sign(buildTransaction().toXDR(), 'TESTNET')).toEqual(
        expect.any(String),
      );
    } finally {
      Reflect.set(globalThis, 'Buffer', original);
    }
  });

  it.each([
    { id: 'TransportOpenUserCancelled' },
    { name: 'TransportOpenUserCancelled' },
    { name: 'NotAllowedError' },
  ])('maps a cancelled WebHID chooser: %j', async (error) => {
    provider = new LedgerWalletProvider();
    mockCreate.mockRejectedValueOnce(error);
    await expect(provider.connect()).rejects.toMatchObject({ code: 'USER_REJECTED' });
  });

  it('clears state on unplug and closes the old transport before reconnecting', async () => {
    await provider.connect();
    transport.emit('disconnect');
    await expect(provider.signMessage('challenge')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    await provider.connect();
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(transport.off).toHaveBeenCalledTimes(1);
    expect(transport.on).toHaveBeenCalledTimes(2);
  });

  it('rejects disconnect during address confirmation', async () => {
    transport.exchange.mockImplementationOnce(async () => {
      transport.emit('disconnect');
      return Buffer.concat([signer.rawPublicKey(), Buffer.from([0x90, 0])]);
    });
    await expect(provider.connect()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('rejects concurrent device requests', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider = new LedgerWalletProvider({
      transportFactory: async () => {
        await wait;
        return transport;
      },
    });
    const pending = provider.connect();
    await expect(provider.connect()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    await expect(provider.disconnect()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    release();
    await pending;
  });

  it('clears state even when closing fails', async () => {
    await provider.connect();
    transport.close.mockRejectedValueOnce(new Error('USB close failed'));
    await expect(provider.disconnect()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
    await expect(provider.signMessage('challenge')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    await provider.disconnect();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
