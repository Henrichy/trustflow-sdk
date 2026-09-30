import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { MultiSigEscrowClient } from '../src/escrow/multisig';
import { submitTransaction } from '../src/stellar/transaction';
import type {
  AddSignatureParams,
  InitMultiSigParams,
  MultiSigStatus,
  MultiSigStateSnapshot,
} from '../src/types/multisig';
import type { ContractConfig } from '../src/types/contract';

jest.mock('../src/stellar/transaction', () => ({
  submitTransaction: jest.fn(),
}));

const submitTransactionMock = submitTransaction as jest.MockedFunction<typeof submitTransaction>;

const NETWORK = Networks.TESTNET;
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const ESCROW_ID = 'escrow-1';

const signers = {
  a: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)),
  b: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)),
  c: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)),
  outsider: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)),
};

const SIGNER_ADDRESSES = [signers.a.publicKey(), signers.b.publicKey(), signers.c.publicKey()];

/**
 * Builds the base (unsigned) transaction every test signs. It uses
 * `signers.a` as the transaction source, so `a`'s signature can also be
 * pre-applied to the base envelope when a test needs one.
 */
function baseTransaction(): TransactionBuilder {
  return new TransactionBuilder(new Account(signers.a.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.payment({
        destination: signers.c.publicKey(),
        asset: Asset.native(),
        amount: '10',
      }),
    )
    .setTimeout(0);
}

function makeClient(options?: ConstructorParameters<typeof MultiSigEscrowClient>[1]) {
  return new MultiSigEscrowClient({ networkPassphrase: NETWORK } as ContractConfig, options);
}

function initParams(overrides: Partial<InitMultiSigParams> = {}): InitMultiSigParams {
  return {
    escrowId: ESCROW_ID,
    signers: SIGNER_ADDRESSES,
    threshold: 2,
    operationType: 'release',
    unsignedXdr: baseTransaction().build().toEnvelope().toXDR('base64'),
    networkPassphrase: NETWORK,
    ...overrides,
  };
}

function initOperation(
  client: MultiSigEscrowClient,
  overrides: Partial<InitMultiSigParams> = {},
): string {
  const result = client.initMultiSigOperation(initParams(overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data.operationId;
}

/**
 * Builds a real fee-bump envelope: the base transaction is signed by
 * `innerSigner` and the envelope itself is signed by the fee source. The
 * installed SDK exposes no fee-bump builder, so the envelope is assembled from
 * its XDR parts and re-read through `FeeBumpTransaction` to sign it.
 */
function feeBumpEnvelope(
  innerSigner: Keypair,
  feeSource: Keypair,
): { unsigned: string; signed: string } {
  const inner = baseTransaction().build();
  inner.sign(innerSigner);
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
  const unsigned = envelope.toXDR('base64');
  const transaction = new FeeBumpTransaction(unsigned, NETWORK);
  transaction.sign(feeSource);
  return { unsigned, signed: transaction.toEnvelope().toXDR('base64') };
}

/** Fully signed envelope for `keypair` over the shared base transaction. */
function signedXdrFor(keypair: Keypair): string {
  const tx = baseTransaction().build();
  tx.sign(keypair);
  return tx.toEnvelope().toXDR('base64');
}

function addSignature(
  client: MultiSigEscrowClient,
  operationId: string,
  keypair: Keypair,
): ReturnType<MultiSigEscrowClient['addSignature']> {
  const params: AddSignatureParams = {
    operationId,
    signerAddress: keypair.publicKey(),
    signedXdr: signedXdrFor(keypair),
  };
  return client.addSignature(params);
}

function statusOf(result: ReturnType<MultiSigEscrowClient['getMultiSigStatus']>): MultiSigStatus {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

beforeEach(() => {
  submitTransactionMock.mockReset();
});

describe('MultiSigEscrowClient against the real client', () => {
  // ── initMultiSigOperation ────────────────────────────────────────────────

  describe('initMultiSigOperation validation', () => {
    it('creates an operation from valid parameters', () => {
      const client = makeClient();
      const result = client.initMultiSigOperation(initParams());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.data.operationId).toContain(`msig-${ESCROW_ID}-`);

      const status = statusOf(client.getMultiSigStatus(result.data.operationId));
      expect(status).toMatchObject({
        escrowId: ESCROW_ID,
        operationType: 'release',
        threshold: 2,
        signaturesCollected: 0,
        signersAuthorised: SIGNER_ADDRESSES,
        signersSigned: [],
        signersRemaining: SIGNER_ADDRESSES,
        isReady: false,
        status: 'pending',
      });
    });

    it('rejects a missing escrowId', () => {
      const result = makeClient().initMultiSigOperation(initParams({ escrowId: '' }));

      expect(result).toEqual({ ok: false, error: 'escrowId is required' });
    });

    it('rejects an empty signers array', () => {
      const result = makeClient().initMultiSigOperation(initParams({ signers: [], threshold: 1 }));

      expect(result).toEqual({ ok: false, error: 'At least one signer is required' });
    });

    it('rejects a threshold below 1', () => {
      const result = makeClient().initMultiSigOperation(initParams({ threshold: 0 }));

      expect(result).toEqual({ ok: false, error: 'threshold must be at least 1' });
    });

    it('rejects a threshold above signers.length', () => {
      const result = makeClient().initMultiSigOperation(initParams({ threshold: 4 }));

      expect(result).toEqual({
        ok: false,
        error: 'threshold (4) cannot exceed the number of signers (3)',
      });
    });

    it('accepts a threshold exactly equal to signers.length', () => {
      const result = makeClient().initMultiSigOperation(initParams({ threshold: 3 }));

      expect(result.ok).toBe(true);
    });

    it('rejects a missing unsignedXdr', () => {
      const result = makeClient().initMultiSigOperation(initParams({ unsignedXdr: '' }));

      expect(result).toEqual({ ok: false, error: 'unsignedXdr is required' });
    });

    it('rejects a missing networkPassphrase', () => {
      const result = makeClient().initMultiSigOperation(initParams({ networkPassphrase: '' }));

      expect(result).toEqual({ ok: false, error: 'networkPassphrase is required' });
    });

    it('rejects a networkPassphrase that does not match the client config', () => {
      const result = makeClient().initMultiSigOperation(
        initParams({ networkPassphrase: 'MISMATCHED_NETWORK_PASSPHRASE' }),
      );

      expect(result).toEqual({
        ok: false,
        error: `networkPassphrase mismatch: expected "${NETWORK}"`,
      });
    });

    it('rejects duplicate signer addresses', () => {
      const result = makeClient().initMultiSigOperation(
        initParams({ signers: [signers.a.publicKey(), signers.a.publicKey()], threshold: 2 }),
      );

      expect(result).toEqual({
        ok: false,
        error: 'Duplicate signer addresses are not allowed',
      });
    });

    it('rejects a threshold that is not an integer (#285)', () => {
      // `NaN < 1` and `NaN > signers.length` are both false, so a NaN
      // threshold used to produce an operation that could never be ready.
      const nan = makeClient().initMultiSigOperation(initParams({ threshold: NaN }));
      const fractional = makeClient().initMultiSigOperation(initParams({ threshold: 1.5 }));
      const infinite = makeClient().initMultiSigOperation(initParams({ threshold: Infinity }));

      expect(nan).toEqual({ ok: false, error: 'threshold must be an integer' });
      expect(fractional).toEqual({ ok: false, error: 'threshold must be an integer' });
      expect(infinite).toEqual({ ok: false, error: 'threshold must be an integer' });
    });

    it('rejects a signer that is not a valid Stellar address (#285)', () => {
      const result = makeClient().initMultiSigOperation(
        initParams({ signers: ['not-an-address', 'zzz'], threshold: 2 }),
      );

      expect(result).toEqual({
        ok: false,
        error: 'signers[0] is not a valid Stellar address: not-an-address',
      });
    });

    it('rejects an operationType outside the allowed set (#285)', () => {
      const unknown = makeClient().initMultiSigOperation(
        initParams({ operationType: 'arbitrary' as unknown as 'release' }),
      );
      // A caller with no type checking (e.g. JSON.parse) can also pass nothing.
      const missing = makeClient().initMultiSigOperation(
        initParams({ operationType: undefined as unknown as 'release' }),
      );

      expect(unknown).toEqual({
        ok: false,
        error: 'operationType must be one of: release, cancel, dispute',
      });
      expect(missing).toEqual({
        ok: false,
        error: 'operationType must be one of: release, cancel, dispute',
      });
    });

    it('rejects an unsignedXdr that is not a transaction envelope (#285)', () => {
      const result = makeClient().initMultiSigOperation(initParams({ unsignedXdr: 'garbage' }));

      expect(result).toEqual({
        ok: false,
        error: 'unsignedXdr is not a valid Stellar transaction envelope',
      });
    });

    it('rejects an expiresAt that is not a finite number or already in the past (#285)', () => {
      const past = makeClient().initMultiSigOperation(initParams({ expiresAt: 1 }));
      const notANumber = makeClient().initMultiSigOperation(
        initParams({ expiresAt: NaN as unknown as number }),
      );
      const infinite = makeClient().initMultiSigOperation(
        initParams({ expiresAt: Infinity as unknown as number }),
      );

      expect(past).toEqual({ ok: false, error: 'expiresAt is in the past' });
      expect(notANumber).toEqual({
        ok: false,
        error: 'expiresAt must be a finite UNIX timestamp in milliseconds',
      });
      expect(infinite).toEqual({
        ok: false,
        error: 'expiresAt must be a finite UNIX timestamp in milliseconds',
      });
    });

    it('accepts an escrowId at the length limit and rejects a longer one (#285)', () => {
      const long = 'e'.repeat(128);
      const blank = makeClient().initMultiSigOperation(initParams({ escrowId: '   ' }));
      const tooLong = makeClient().initMultiSigOperation(initParams({ escrowId: 'e'.repeat(129) }));
      const ok = makeClient().initMultiSigOperation(initParams({ escrowId: long }));

      // `escrowId` is interpolated into `operationId`, so a blank or oversized
      // value has to be refused rather than silently producing a broken id.
      expect(blank).toEqual({ ok: false, error: 'escrowId is required' });
      expect(tooLong).toEqual({ ok: false, error: 'escrowId must be at most 128 characters' });
      expect(ok.ok).toBe(true);
    });

    it('keeps operations isolated per escrow id', () => {
      const client = makeClient();
      const first = initOperation(client, { escrowId: 'escrow-a' });
      const second = initOperation(client, { escrowId: 'escrow-b' });

      expect(first).not.toBe(second);
      expect(client.listOperations('escrow-a').map((op) => op.operationId)).toEqual([first]);
      expect(client.listOperations('escrow-b').map((op) => op.operationId)).toEqual([second]);
    });
  });

  // ── addSignature ─────────────────────────────────────────────────────────

  describe('addSignature', () => {
    it('records a signature and reports progress', () => {
      const client = makeClient();
      const operationId = initOperation(client);

      const result = addSignature(client, operationId, signers.b);

      expect(result.ok).toBe(true);
      expect(
        statusOf(result as ReturnType<MultiSigEscrowClient['getMultiSigStatus']>),
      ).toMatchObject({
        signaturesCollected: 1,
        signersSigned: [signers.b.publicKey()],
        signersRemaining: [signers.a.publicKey(), signers.c.publicKey()],
        isReady: false,
        status: 'pending',
      });
    });

    it('transitions the operation to ready once the threshold is met', () => {
      const client = makeClient();
      const operationId = initOperation(client);

      addSignature(client, operationId, signers.a);
      const result = addSignature(client, operationId, signers.b);

      expect(result.ok).toBe(true);
      expect(
        statusOf(result as ReturnType<MultiSigEscrowClient['getMultiSigStatus']>),
      ).toMatchObject({
        signaturesCollected: 2,
        isReady: true,
        status: 'ready',
      });
    });

    it('fails for an unknown operation', () => {
      const result = makeClient().addSignature({
        operationId: 'msig-does-not-exist',
        signerAddress: signers.a.publicKey(),
        signedXdr: signedXdrFor(signers.a),
      });

      expect(result).toEqual({ ok: false, error: 'Operation msig-does-not-exist not found' });
    });

    it('rejects a signer that is not in the authorised list', () => {
      const client = makeClient();
      const operationId = initOperation(client);

      const result = addSignature(client, operationId, signers.outsider);

      expect(result).toEqual({
        ok: false,
        error: `${signers.outsider.publicKey()} is not an authorised signer for this operation`,
      });
    });

    it('rejects a duplicate signature from the same signer', () => {
      const client = makeClient();
      const operationId = initOperation(client);

      expect(addSignature(client, operationId, signers.a).ok).toBe(true);
      const result = addSignature(client, operationId, signers.a);

      expect(result).toEqual({
        ok: false,
        error: `${signers.a.publicKey()} has already signed this operation`,
      });
    });

    it('rejects a malformed signedXdr', () => {
      const client = makeClient();
      const operationId = initOperation(client);

      const result = client.addSignature({
        operationId,
        signerAddress: signers.a.publicKey(),
        signedXdr: 'garbage',
      });

      expect(result).toEqual({
        ok: false,
        error: 'signedXdr is not a valid Stellar transaction envelope',
      });
      expect(statusOf(client.getMultiSigStatus(operationId)).signaturesCollected).toBe(0);
    });

    it('accepts a fee-bump envelope from a signer', () => {
      const client = makeClient();
      const { signed } = feeBumpEnvelope(signers.a, signers.c);
      const operationId = initOperation(client, { threshold: 1 });

      const result = client.addSignature({
        operationId,
        signerAddress: signers.c.publicKey(),
        signedXdr: signed,
      });

      expect(result.ok).toBe(true);
    });

    it('rejects a signature added to an expired operation', () => {
      const client = makeClient();
      const expiresAt = Date.now() + 5_000;
      const operationId = initOperation(client, { expiresAt });

      jest.useFakeTimers();
      jest.setSystemTime(expiresAt + 1);
      try {
        const result = addSignature(client, operationId, signers.a);

        expect(result).toEqual({ ok: false, error: 'Operation has expired' });
        expect(statusOf(client.getMultiSigStatus(operationId)).status).toBe('expired');
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects a signature added to an already-expired operation', () => {
      const client = makeClient();
      const expiresAt = Date.now() + 5_000;
      const operationId = initOperation(client, { expiresAt });

      jest.useFakeTimers();
      jest.setSystemTime(expiresAt + 1);
      try {
        // The first attempt expires the operation...
        expect(addSignature(client, operationId, signers.a)).toEqual({
          ok: false,
          error: 'Operation has expired',
        });
        // ...so the next one is rejected on the recorded status, not the clock.
        const result = addSignature(client, operationId, signers.b);

        expect(result).toEqual({ ok: false, error: 'Operation has expired' });
      } finally {
        jest.useRealTimers();
      }
    });

    // `addSignature` trusts the claimed signer: no transaction-hash comparison
    // and no signature-to-address binding. #280 owns the fix; this test
    // documents the gap and starts passing with it.
    it('rejects an envelope signed by someone other than the claimed signer (#280)', () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 2 });
      addSignature(client, operationId, signers.a);

      // `signers.c`'s slot is filled with a signature produced by an unrelated
      // key, and an envelope for a completely different transaction.
      const impostor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 200));
      const otherTx = new TransactionBuilder(new Account(signers.a.publicKey(), '1'), {
        fee: BASE_FEE,
        networkPassphrase: NETWORK,
      })
        .addOperation(
          Operation.payment({
            destination: signers.c.publicKey(),
            asset: Asset.native(),
            amount: '999',
          }),
        )
        .setTimeout(30)
        .build();
      otherTx.sign(impostor);

      const result = client.addSignature({
        operationId,
        signerAddress: signers.c.publicKey(),
        signedXdr: otherTx.toEnvelope().toXDR('base64'),
      });

      expect(result.ok).toBe(false);
    });

    it('rejects a signature added after submission', () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 1 });
      addSignature(client, operationId, signers.a);
      submitTransactionMock.mockResolvedValue({
        hash: 'a'.repeat(64),
        ledger: 1,
        successful: true,
        status: 200,
      } as Awaited<ReturnType<typeof submitTransaction>>);

      return client.submitWhenReady(operationId, HORIZON_URL).then(() => {
        const result = addSignature(client, operationId, signers.b);
        expect(result).toEqual({ ok: false, error: 'Operation already submitted' });
      });
    });
  });

  // ── getMultiSigStatus ────────────────────────────────────────────────────

  describe('getMultiSigStatus', () => {
    it('fails for an unknown operation', () => {
      const result = makeClient().getMultiSigStatus('msig-missing');

      expect(result).toEqual({ ok: false, error: 'Operation msig-missing not found' });
    });

    it('marks a pending operation expired lazily once expiresAt has passed', () => {
      const client = makeClient();
      const expiresAt = Date.now() + 5_000;
      const operationId = initOperation(client, { expiresAt });

      jest.useFakeTimers();
      jest.setSystemTime(expiresAt + 1);
      try {
        const status = statusOf(client.getMultiSigStatus(operationId));

        expect(status.status).toBe('expired');
        expect(status.expiresAt).toBe(expiresAt);
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves a ready operation ready once expiresAt has passed', () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 1 });
      addSignature(client, operationId, signers.a);

      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + 10_000);
      try {
        const status = statusOf(client.getMultiSigStatus(operationId));
        // Lazy expiry only rewrites `pending`; a ready operation keeps its status
        // so a caller can still see it was assembled.
        expect(status.status).toBe('ready');
        expect(status.isReady).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ── getAssembledXdr ──────────────────────────────────────────────────────

  describe('getAssembledXdr', () => {
    it('fails for an unknown operation', () => {
      const result = makeClient().getAssembledXdr('msig-missing');

      expect(result).toEqual({ ok: false, error: 'Operation msig-missing not found' });
    });

    it('fails when no signatures have been collected', () => {
      const client = makeClient();
      const operationId = initOperation(client);

      expect(client.getAssembledXdr(operationId)).toEqual({
        ok: false,
        error: 'No verified signatures collected yet',
      });
    });

    it('merges signatures from several signer envelopes onto the base envelope', () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 3 });
      addSignature(client, operationId, signers.a);
      addSignature(client, operationId, signers.b);
      addSignature(client, operationId, signers.c);

      const result = client.getAssembledXdr(operationId);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const envelope = xdr.TransactionEnvelope.fromXDR(result.data.xdr, 'base64');
      expect(envelope.v1().signatures()).toHaveLength(3);
      // The transaction body is the untouched base transaction.
      expect(envelope.v1().tx().operations()).toHaveLength(1);
    });

    it('preserves signatures that were already on the base envelope', () => {
      const client = makeClient();
      const preSigned = baseTransaction().build();
      preSigned.sign(signers.c);
      const operationId = initOperation(client, {
        threshold: 1,
        unsignedXdr: preSigned.toEnvelope().toXDR('base64'),
      });

      addSignature(client, operationId, signers.a);
      const result = client.getAssembledXdr(operationId);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const envelope = xdr.TransactionEnvelope.fromXDR(result.data.xdr, 'base64');
      expect(envelope.v1().signatures()).toHaveLength(2);
    });

    it('de-duplicates identical signatures instead of counting them twice', () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 1 });
      // Both signers submit byte-identical envelopes.
      const tx = baseTransaction().build();
      tx.sign(signers.a);
      tx.sign(signers.b);
      const shared = tx.toEnvelope().toXDR('base64');
      expect(
        client.addSignature({
          operationId,
          signerAddress: signers.a.publicKey(),
          signedXdr: shared,
        }).ok,
      ).toBe(true);
      expect(
        client.addSignature({
          operationId,
          signerAddress: signers.b.publicKey(),
          signedXdr: shared,
        }).ok,
      ).toBe(true);

      const result = client.getAssembledXdr(operationId);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const envelope = xdr.TransactionEnvelope.fromXDR(result.data.xdr, 'base64');
      expect(envelope.v1().signatures()).toHaveLength(2);
    });

    it('assembles onto a fee-bump base envelope', () => {
      const client = makeClient();
      const { signed } = feeBumpEnvelope(signers.a, signers.c);
      const operationId = initOperation(client, {
        threshold: 1,
        unsignedXdr: signed,
      });

      const signedByB = baseTransaction().build();
      signedByB.sign(signers.b);
      expect(
        client.addSignature({
          operationId,
          signerAddress: signers.b.publicKey(),
          signedXdr: signedByB.toEnvelope().toXDR('base64'),
        }).ok,
      ).toBe(true);

      const result = client.getAssembledXdr(operationId);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const envelope = xdr.TransactionEnvelope.fromXDR(result.data.xdr, 'base64');
      expect(envelope.switch()).toBe(xdr.EnvelopeType.envelopeTypeTxFeeBump());
      expect(envelope.feeBump().signatures()).toHaveLength(2);
      // The inner v1 transaction keeps only its own signature.
      expect(envelope.feeBump().tx().innerTx().v1().signatures()).toHaveLength(1);
    });

    it('reports an assembly failure instead of throwing when the base envelope is unusable', () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 1 });
      addSignature(client, operationId, signers.a);
      // Corrupt the stored base envelope behind the client's back: addSignature
      // only validates the signer's envelope, so `_mergeSignatures` is where an
      // unmergeable base has to surface as an error result, not a throw.
      const stored = (
        client as unknown as { operations: Map<string, { unsignedXdr: string }> }
      ).operations.get(operationId);
      if (stored) stored.unsignedXdr = 'AAAA';

      const result = client.getAssembledXdr(operationId);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error).toContain('XDR assembly failed');
    });
  });

  // ── submitWhenReady ──────────────────────────────────────────────────────

  describe('submitWhenReady', () => {
    const submitted = {
      hash: 'b'.repeat(64),
      ledger: 2,
      successful: true,
      status: 200,
    } as Awaited<ReturnType<typeof submitTransaction>>;

    it('fails for an unknown operation', async () => {
      const result = await makeClient().submitWhenReady('msig-missing', HORIZON_URL);

      expect(result).toEqual({ ok: false, error: 'Operation msig-missing not found' });
    });

    it('fails while the threshold is not met and names how many are missing', async () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 2 });
      addSignature(client, operationId, signers.a);

      const result = await client.submitWhenReady(operationId, HORIZON_URL);

      expect(result).toEqual({
        ok: false,
        error: 'Threshold not met: need 1 more verified signature(s) before submission',
      });
      expect(submitTransactionMock).not.toHaveBeenCalled();
    });

    it('fails for an expired operation', async () => {
      const client = makeClient();
      const operationId = initOperation(client, {
        threshold: 1,
        expiresAt: Date.now() + 5_000,
      });
      addSignature(client, operationId, signers.a);
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + 10_000);
      try {
        const result = await client.submitWhenReady(operationId, HORIZON_URL);

        expect(result).toEqual({ ok: false, error: 'Operation has expired' });
        expect(submitTransactionMock).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('submits the assembled envelope and marks the operation submitted', async () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 2 });
      addSignature(client, operationId, signers.a);
      addSignature(client, operationId, signers.b);
      submitTransactionMock.mockResolvedValue(submitted);

      const result = await client.submitWhenReady(operationId, HORIZON_URL);

      expect(result).toEqual({
        ok: true,
        data: { txHash: submitted.hash, operationId, escrowId: ESCROW_ID },
      });
      expect(submitTransactionMock).toHaveBeenCalledTimes(1);
      const [assembledXdr, horizon] = submitTransactionMock.mock.calls[0];
      expect(horizon).toBe(HORIZON_URL);
      const envelope = xdr.TransactionEnvelope.fromXDR(assembledXdr, 'base64');
      expect(envelope.v1().signatures()).toHaveLength(2);
      expect(statusOf(client.getMultiSigStatus(operationId)).status).toBe('submitted');
    });

    it('keeps the operation ready when submission fails', async () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 1 });
      addSignature(client, operationId, signers.a);
      submitTransactionMock.mockRejectedValue(new Error('Horizon 503'));

      const result = await client.submitWhenReady(operationId, HORIZON_URL);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error).toContain('Submission failed');
      expect(result.error).toContain('Horizon 503');
      expect(statusOf(client.getMultiSigStatus(operationId)).status).toBe('ready');
    });

    it('surfaces an assembly failure instead of submitting anything', async () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 1 });
      addSignature(client, operationId, signers.a);
      const stored = (
        client as unknown as { operations: Map<string, { unsignedXdr: string }> }
      ).operations.get(operationId);
      if (stored) stored.unsignedXdr = 'AAAA';

      const result = await client.submitWhenReady(operationId, HORIZON_URL);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error).toContain('XDR assembly failed');
      expect(submitTransactionMock).not.toHaveBeenCalled();
    });

    // `submitWhenReady` never consults `operation.status`, so an already
    // submitted operation is broadcast a second time. #283 owns the fix; this
    // test documents the current behaviour and starts passing with it.
    it.failing('does not re-broadcast an already submitted operation (#283)', async () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 1 });
      addSignature(client, operationId, signers.a);
      submitTransactionMock.mockResolvedValue(submitted);

      await client.submitWhenReady(operationId, HORIZON_URL);
      const repeat = await client.submitWhenReady(operationId, HORIZON_URL);

      expect(repeat.ok).toBe(false);
      expect(submitTransactionMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── exportState / importState ────────────────────────────────────────────

  describe('exportState / importState', () => {
    it('round-trips an operation into a second client', () => {
      const source = makeClient();
      const operationId = initOperation(source, { threshold: 2 });
      addSignature(source, operationId, signers.a);

      const snapshot = source.exportState(operationId);
      expect(snapshot).toBeDefined();
      const target = makeClient();
      const imported = target.importState(snapshot as NonNullable<typeof snapshot>);

      expect(imported).toEqual({ ok: true, data: { operationId } });
      const status = statusOf(target.getMultiSigStatus(operationId));
      expect(status).toMatchObject({
        escrowId: ESCROW_ID,
        threshold: 2,
        signaturesCollected: 1,
        signersRemaining: [signers.b.publicKey(), signers.c.publicKey()],
        status: 'pending',
      });
      // The restored operation accepts further signatures.
      expect(addSignature(target, operationId, signers.b).ok).toBe(true);
    });

    it('carries the snapshot version and returns undefined for an unknown operation', () => {
      const client = makeClient();
      const operationId = initOperation(client);

      expect(client.exportState(operationId)?.version).toBe(1);
      expect(client.exportState('msig-missing')).toBeUndefined();
    });

    it('copies signer and signature arrays so later mutation cannot leak', () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 1 });
      addSignature(client, operationId, signers.a);
      const snapshot = client.exportState(operationId) as NonNullable<
        ReturnType<MultiSigEscrowClient['exportState']>
      >;

      snapshot.signers.push(signers.outsider.publicKey());
      snapshot.collectedSignatures.length = 0;

      const status = statusOf(client.getMultiSigStatus(operationId));
      expect(status.signersAuthorised).toEqual(SIGNER_ADDRESSES);
      expect(status.signaturesCollected).toBe(1);
    });

    it('overwrites a local operation with the same id (last write wins)', () => {
      const client = makeClient();
      const operationId = initOperation(client, { threshold: 2 });
      const snapshot = client.exportState(operationId) as MultiSigStateSnapshot;
      snapshot.threshold = 1;
      snapshot.status = 'ready';

      expect(client.importState(snapshot)).toEqual({ ok: true, data: { operationId } });
      expect(statusOf(client.getMultiSigStatus(operationId)).threshold).toBe(1);
    });

    it.each([
      ['not an object', 'snapshot must be an object'],
      ['wrong version', 'snapshot.version 2 is not supported by this SDK (expected 1)'],
      ['missing operationId', 'snapshot.operationId must be a non-empty string'],
      ['missing escrowId', 'snapshot.escrowId must be a non-empty string'],
      ['missing unsignedXdr', 'snapshot.unsignedXdr must be a non-empty string'],
      ['missing networkPassphrase', 'snapshot.networkPassphrase must be a non-empty string'],
      ['signers not an array', 'snapshot.signers must be an array'],
      ['collectedSignatures not an array', 'snapshot.collectedSignatures must be an array'],
      ['threshold below 1', 'snapshot.threshold must be a number >= 1'],
      ['bad status', 'snapshot.status must be one of: pending, ready, submitted, expired'],
    ])('rejects a snapshot with %s', (_case, error) => {
      const client = makeClient();
      const operationId = initOperation(client);
      const snapshot = client.exportState(operationId) as MultiSigStateSnapshot;

      const corrupted = { ...snapshot } as Record<string, unknown>;
      if (_case === 'not an object') {
        expect(client.importState('nope' as unknown as MultiSigStateSnapshot)).toEqual({
          ok: false,
          error,
        });
        return;
      }
      if (_case === 'wrong version') corrupted.version = 2;
      if (_case === 'missing operationId') corrupted.operationId = '';
      if (_case === 'missing escrowId') corrupted.escrowId = '';
      if (_case === 'missing unsignedXdr') corrupted.unsignedXdr = '';
      if (_case === 'missing networkPassphrase') corrupted.networkPassphrase = '';
      if (_case === 'signers not an array') corrupted.signers = 'nope';
      if (_case === 'collectedSignatures not an array') corrupted.collectedSignatures = 'nope';
      if (_case === 'threshold below 1') corrupted.threshold = 0;
      if (_case === 'bad status') corrupted.status = 'unknown';

      expect(client.importState(corrupted as unknown as MultiSigStateSnapshot)).toEqual({
        ok: false,
        error,
      });
    });
  });
});
