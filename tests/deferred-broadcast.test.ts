/**
 * @file tests/deferred-broadcast.test.ts
 * Air-gapped signing workflow for #365.
 *
 * Covers the two halves of the deferred-broadcast path:
 *  - `inspectTransactionSignatures` / `broadcastSignedXDR` reject an envelope
 *    that is unsigned or not a transaction, *before* any network call;
 *  - a genuinely signed envelope is submitted and its result returned.
 */

import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  xdr,
} from '@stellar/stellar-sdk';
import {
  broadcastSignedXDR,
  inspectTransactionSignatures,
} from '../src/stellar/transaction';
import { TrustFlowError } from '../src/errors';

const HORIZON = 'https://horizon.example.org';
const NETWORK = 'Test SDF Network ; September 2015';
const SOURCE = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');

function unsignedTx(): ReturnType<TransactionBuilder['build']> {
  return new TransactionBuilder(SOURCE, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.payment({
      destination: Keypair.random().publicKey(),
      asset: Asset.native(),
      amount: '1',
    }))
    .setTimeout(100)
    .build();
}

function signer(): Keypair {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
}

/** Signs `tx` with `key`, matching the SDK's single-keypair `sign()` API. */
function signedOf(tx: ReturnType<TransactionBuilder['build']>, key: Keypair) {
  tx.sign(key);
  return tx;
}

/**
 * Builds a real fee-bump envelope.
 *
 * The installed SDK exposes no fee-bump builder
 * (`buildFeeBumpTransaction` throws on a `Transaction`), so the envelope is
 * assembled from its XDR parts and re-read through `FeeBumpTransaction` to sign
 * it. This mirrors the helper already used in `tests/multisig.test.ts`.
 */
function feeBumpEnvelope(
  innerSigner: Keypair,
  feeSource: Keypair,
  signInner: boolean,
): string {
  const inner = unsignedTx();
  if (signInner) inner.sign(innerSigner);
  const v1 = inner.toEnvelope().v1();
  const feeBumpTx = new xdr.FeeBumpTransaction({
    feeSource: xdr.MuxedAccount.keyTypeEd25519(feeSource.rawPublicKey()),
    innerTx: new xdr.FeeBumpTransactionInnerTx(
      xdr.EnvelopeType.envelopeTypeTx(),
      new xdr.TransactionV1Envelope({ tx: v1.tx(), signatures: v1.signatures() }),
    ),
    fee: BigInt(BASE_FEE),
    ext: new xdr.FeeBumpTransactionExt(0),
  });
  const envelope = xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
    new xdr.FeeBumpTransactionEnvelope({ tx: feeBumpTx, signatures: [] }),
  );
  if (!signInner) return envelope.toXDR('base64');
  // `FeeBumpTransaction.sign()` mutates in place and returns undefined, unlike
  // `Transaction.sign()`.
  const tx = new FeeBumpTransaction(envelope.toXDR('base64'), NETWORK);
  tx.sign(feeSource);
  return tx.toEnvelope().toXDR('base64');
}

function respond(status: number, body: string): Response {
  return new Response(body, { status });
}

async function catchError(promise: Promise<unknown>): Promise<TrustFlowError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(TrustFlowError);
    return e as TrustFlowError;
  }
  throw new Error('expected the call to reject');
}

describe('inspectTransactionSignatures', () => {
  it('reports an unsigned envelope as unsigned with no signers', () => {
    const report = inspectTransactionSignatures(unsignedTx().toXDR());
    expect(report.signed).toBe(false);
    expect(report.signatureCount).toBe(0);
    expect(report.signatureHints).toEqual([]);
    expect(report.feeBump).toBe(false);
  });

  it('reports the signer of a signed envelope', () => {
    const key = signer();
    const tx = unsignedTx();
    tx.sign(key);
    const signed = tx;
    const report = inspectTransactionSignatures(signed.toXDR());

    expect(report.signed).toBe(true);
    expect(report.signatureCount).toBe(1);
    // A hint is only 4 bytes of the signer's public key, so the report
    // exposes it as hex rather than pretending it identifies a signer.
    expect(report.signatureHints).toHaveLength(1);
    expect(report.signatureHints[0]).toHaveLength(8);
    expect(Buffer.from(key.signatureHint()).toString('hex')).toBe(
      report.signatureHints[0],
    );
  });

  it('counts every signature for a multi-signed envelope', () => {
    const a = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
    const b = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
    const tx = unsignedTx();
    tx.sign(a);
    tx.sign(b);
    const signed = tx;

    const report = inspectTransactionSignatures(signed.toXDR());
    expect(report.signatureCount).toBe(2);
    expect(report.signatureHints.sort()).toEqual(
      [a.signatureHint(), b.signatureHint()]
        .map((h) => Buffer.from(h).toString('hex'))
        .sort(),
    );
  });

  it('recognises a fee bump and counts both halves', () => {
    const inner = signer();
    const outer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
    const feeBumpXdr = feeBumpEnvelope(inner, outer, true);

    const report = inspectTransactionSignatures(feeBumpXdr);
    expect(report.feeBump).toBe(true);
    // Inner signer + fee-payer signature.
    expect(report.signatureCount).toBe(2);
    expect(report.signatureHints.sort()).toEqual(
      [inner.signatureHint(), outer.signatureHint()]
        .map((h) => Buffer.from(h).toString('hex'))
        .sort(),
    );
  });

  it('rejects a value that is not a transaction envelope', () => {
    const error = (() => {
      try {
        inspectTransactionSignatures('not-base64-xdr-at-all');
        return null;
      } catch (e) {
        return e as TrustFlowError;
      }
    })();

    expect(error).toBeInstanceOf(TrustFlowError);
    expect((error as TrustFlowError).code).toBe('SIGNING_ERROR');
  });

  it('rejects an empty string rather than reporting it as unsigned', () => {
    expect(() => inspectTransactionSignatures('')).toThrow(TrustFlowError);
  });
});

describe('broadcastSignedXDR', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  describe('signature validation happens before any network call', () => {
    it('refuses an unsigned envelope without contacting Horizon', async () => {
      const error = await catchError(
        broadcastSignedXDR(unsignedTx().toXDR(), HORIZON),
      );

      expect(error.code).toBe('SIGNING_ERROR');
      expect(error.message).toMatch(/carries no signatures/i);
      // The whole point: no round trip, so no fee can be spent.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a malformed envelope without contacting Horizon', async () => {
      const error = await catchError(broadcastSignedXDR('garbage', HORIZON));
      expect(error.code).toBe('SIGNING_ERROR');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an empty or whitespace-only envelope', async () => {
      await expect(broadcastSignedXDR('', HORIZON)).rejects.toThrow(TrustFlowError);
      await expect(broadcastSignedXDR('   ', HORIZON)).rejects.toThrow(/required/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports an unsigned fee bump distinctly from an unsigned tx', async () => {
      const unsignedBump = feeBumpEnvelope(signer(), signer(), false);
      const error = await catchError(broadcastSignedXDR(unsignedBump, HORIZON));

      expect(error.code).toBe('SIGNING_ERROR');
      expect(error.message).toMatch(/fee bump/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('submitting a signed envelope', () => {
    it('broadcasts a signed envelope and returns the submission result', async () => {
      const signed = signedOf(unsignedTx(), signer());
      fetchMock.mockResolvedValue(
        respond(200, JSON.stringify({ hash: 'abc123', successful: true, ledger: 42 })),
      );

      const result = await broadcastSignedXDR(signed.toXDR(), HORIZON);

      expect(result).toEqual({ hash: 'abc123', successful: true, ledger: 42 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${HORIZON}/transactions`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
    });

    it('sends the exact envelope it was given, url-encoded', async () => {
      const signed = signedOf(unsignedTx(), signer());
      const xdr = signed.toXDR();
      fetchMock.mockResolvedValue(
        respond(200, JSON.stringify({ hash: 'h', successful: true, ledger: 1 })),
      );

      await broadcastSignedXDR(xdr, HORIZON);

      const [, init] = fetchMock.mock.calls[0];
      expect((init as RequestInit).body).toBe(`tx=${encodeURIComponent(xdr)}`);
    });

    it('surfaces a Horizon rejection as SUBMISSION_ERROR', async () => {
      const signed = signedOf(unsignedTx(), signer());
      fetchMock.mockResolvedValue(
        respond(400, JSON.stringify({
          title: 'Transaction Failed',
          extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } },
        })),
      );

      const error = await catchError(broadcastSignedXDR(signed.toXDR(), HORIZON));
      expect(error.code).toBe('SUBMISSION_ERROR');
      expect(error.message).toMatch(/tx_failed/);
      expect(error.message).toMatch(/op_underfunded/);
    });

    it('tolerates a trailing slash on the Horizon URL', async () => {
      const signed = signedOf(unsignedTx(), signer());
      fetchMock.mockResolvedValue(
        respond(200, JSON.stringify({ hash: 'h', successful: true, ledger: 1 })),
      );

      await broadcastSignedXDR(signed.toXDR(), `${HORIZON}///`);
      expect(fetchMock.mock.calls[0][0]).toBe(`${HORIZON}/transactions`);
    });
  });

  describe('end-to-end air-gapped workflow', () => {
    it('builds unsigned, inspects, signs offline, then broadcasts', async () => {
      // 1. Build on the online machine — envelope has no signature yet.
      const unsigned = unsignedTx();
      expect(inspectTransactionSignatures(unsigned.toXDR()).signed).toBe(false);

      // 2. Sign on the offline machine.
      const key = signer();
      const signed = unsigned.sign(key) ?? unsigned;
      const signedXdr = signed.toXDR();

      // 3. Inspect before shipping it back out, to catch a signing mistake
      //    locally rather than paying a round trip for `tx_missing_signature`.
      const report = inspectTransactionSignatures(signedXdr);
      expect(report.signed).toBe(true);
      expect(report.signatureHints).toEqual([
        Buffer.from(key.signatureHint()).toString('hex'),
      ]);

      // 4. Broadcast from the online machine.
      fetchMock.mockResolvedValue(
        respond(200, JSON.stringify({ hash: 'final', successful: true, ledger: 99 })),
      );
      const result = await broadcastSignedXDR(signedXdr, HORIZON);

      expect(result.hash).toBe('final');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
