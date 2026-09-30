/**
 * Offline signing workflow tests (#365).
 *
 * Covers `buildUnsignedTransaction`, `hasSignature` and `broadcastSignedXDR`:
 * building an envelope that carries no key material, verifying signature
 * completeness before a network call is made, and only then submitting.
 */

import {
  Account,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';

import {
  buildUnsignedTransaction,
  broadcastSignedXDR,
  hasSignature,
} from '../src/stellar/transaction';
import { TrustFlowError } from '../src/errors';

const HORIZON = 'https://horizon.example.org';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYMC3R3MQ7X2NA4I4FLWEW6RSOW4QVMF5W2YT5C';

/** Builds an unsigned envelope from a local account; needs no network. */
function buildUnsignedEnvelope(source: Keypair): string {
  return new TransactionBuilder(new Account(source.publicKey(), '0'), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '1' }))
    .setTimeout(30)
    .build()
    .toXDR();
}

/** The same envelope, signed locally by `source`. */
function buildSignedEnvelope(source: Keypair): string {
  const tx = TransactionBuilder.fromXDR(buildUnsignedEnvelope(source), 'base64') as Transaction;
  tx.sign(source);
  return tx.toXDR();
}

describe('buildUnsignedTransaction', () => {
  it('returns a bundle carrying the signing context', () => {
    const unsigned = buildUnsignedTransaction(
      'AAAAAQ==',
      PASSPHRASE,
      '100',
      'GDEPOSITORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      CONTRACT_ID,
      'create_escrow',
    );
    expect(unsigned.xdr).toBe('AAAAAQ==');
    expect(unsigned.networkPassphrase).toBe(PASSPHRASE);
    expect(unsigned.fee).toBe('100');
    expect(unsigned.method).toBe('create_escrow');
    expect(unsigned.contractId).toBe(CONTRACT_ID);
    expect(unsigned.sourceAccount).toBe(
      'GDEPOSITORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
  });

  it('trims surrounding whitespace from the XDR', () => {
    const unsigned = buildUnsignedTransaction('  AAAFAQ==  ', PASSPHRASE, '100', 'GABC', CONTRACT_ID, 'm');
    expect(unsigned.xdr).toBe('AAAF AQ=='.replace(' ', ''));
  });

  it.each([
    ['empty XDR', '', PASSPHRASE, 'GABC'],
    ['non-base64 XDR', 'not base64!!', PASSPHRASE, 'GABC'],
    ['empty passphrase', 'AAAAAQ==', '   ', 'GABC'],
    ['empty source account', 'AAAAAQ==', PASSPHRASE, '  '],
  ])('rejects %s', (_label, xdr, passphrase, source) => {
    expect(() => buildUnsignedTransaction(xdr, passphrase, '100', source, CONTRACT_ID, 'm')).toThrow(
      TrustFlowError,
    );
  });

  it('reports a typed INVALID_CONFIG error', () => {
    try {
      buildUnsignedTransaction('', PASSPHRASE, '100', 'GABC', CONTRACT_ID, 'm');
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TrustFlowError);
      expect((e as TrustFlowError).code).toBe('INVALID_CONFIG');
    }
  });
});

describe('hasSignature', () => {
  it('is false for an unsigned envelope', () => {
    expect(hasSignature(buildUnsignedEnvelope(Keypair.random()))).toBe(false);
  });

  it('is true once signed', () => {
    const source = Keypair.random();
    const signed = buildSignedEnvelope(source);
    expect(hasSignature(signed)).toBe(true);
  });

  it('is false for empty, non-base64, and undecodable input', () => {
    expect(hasSignature('')).toBe(false);
    expect(hasSignature('   ')).toBe(false);
    expect(hasSignature('not base64!!')).toBe(false);
    // Valid base64 but not a Stellar envelope: must not be reported as signed.
    expect(hasSignature('AAAAAAAAAAAAAAAAAAAAAA==')).toBe(false);
  });
});

describe('broadcastSignedXDR', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('submits a signed envelope and returns the hash', async () => {
    const signed = buildSignedEnvelope(Keypair.random());
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ hash: 'abc123', successful: true, ledger: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await broadcastSignedXDR(signed, HORIZON);
    expect(result.hash).toBe('abc123');
    expect(result.successful).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${HORIZON}/transactions`);
    expect(init.method).toBe('POST');
    expect(decodeURIComponent(init.body)).toBe(`tx=${signed}`);
  });

  // The acceptance criterion: an envelope with no signature must never reach
  // the network, so the failure is local and actionable rather than a Horizon
  // rejection that looks like a ledger fault.
  it('refuses an unsigned envelope without calling the network', async () => {
    const unsignedEnvelope = buildUnsignedEnvelope(Keypair.random());
    expect(hasSignature(unsignedEnvelope)).toBe(false);

    await expect(broadcastSignedXDR(unsignedEnvelope, HORIZON)).rejects.toThrow(
      /contains no signature/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['non-base64', 'not base64!!'],
  ])('rejects %s XDR before any request', async (_label, xdr) => {
    await expect(broadcastSignedXDR(xdr, HORIZON)).rejects.toThrow(TrustFlowError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a Horizon rejection as SUBMISSION_ERROR', async () => {
    const signed = buildSignedEnvelope(Keypair.random());
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'Transaction Failed',
          detail: 'tx failed',
          extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(broadcastSignedXDR(signed, HORIZON)).rejects.toThrow(/tx_failed/);
  });
});

describe('offline workflow end to end', () => {
  it('builds, signs offline, then broadcasts', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ hash: 'deadbeef', successful: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    // 1. Build on a networked machine.
    const unsigned = buildUnsignedTransaction(
      'AAAAAQ==',
      PASSPHRASE,
      '100',
      'GDEPOSITORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      CONTRACT_ID,
      'create_escrow',
    );
    expect(hasSignature(unsigned.xdr)).toBe(false);

    // 2. Sign on the air-gapped host.
    const signed = buildSignedEnvelope(Keypair.random());
    expect(hasSignature(signed)).toBe(true);

    // 3. Broadcast from anywhere with a network.
    const submitted = await broadcastSignedXDR(signed, HORIZON);
    expect(submitted.hash).toBe('deadbeef');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
  });
});
