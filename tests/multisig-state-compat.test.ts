import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { MultiSigEscrowClient } from "../src/escrow/multisig";

const NETWORK = Networks.TESTNET;
const testKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const TEST_SIGNER = testKeypair.publicKey();

const tx = new TransactionBuilder(new Account(TEST_SIGNER, "1"), {
  fee: BASE_FEE,
  networkPassphrase: NETWORK,
})
  .addOperation(
    Operation.payment({
      destination: Keypair.random().publicKey(),
      asset: Asset.native(),
      amount: "10",
    }),
  )
  .setTimeout(30)
  .build();
const XDR = tx.toEnvelope().toXDR("base64");


describe('MultiSigEscrowClient state import/export backward compatibility', () => {
  function makeClient(): MultiSigEscrowClient {
    return new MultiSigEscrowClient({ networkPassphrase: NETWORK } as any);
  }

  it('imports a snapshot without verified fields and treats signatures as unverified', () => {
    const client = makeClient();

    // Create a snapshot that mimics the old format (without verified/verifiedAt fields)
    const oldSnapshot = {
      version: 1,
      operationId: 'msig-test-123',
      escrowId: 'escrow-1',
      operationType: 'release' as const,
      unsignedXdr: XDR,
      networkPassphrase: NETWORK,
      collectedSignatures: [
        {
          signerAddress: TEST_SIGNER,
          signedXdr: XDR,
          addedAt: Date.now() - 1000,
          // No verified or verifiedAt fields
        },
      ],
      threshold: 1,
      signers: [TEST_SIGNER],
      status: 'pending' as const,
      createdAt: Date.now() - 2000,
    };

    const importResult = client.importState(oldSnapshot);
    expect(importResult.ok).toBe(true);

    // The imported signature should be treated as unverified
    const status = client.getMultiSigStatus('msig-test-123');
    expect(status.ok).toBe(true);
    if (status.ok) {
      // signaturesCollected should count verified signatures, which is 0
      expect(status.data.signaturesCollected).toBe(0);
      expect(status.data.isReady).toBe(false);
      expect(status.data.signersSigned).toHaveLength(0);
      expect(status.data.signersRemaining).toContain(
        TEST_SIGNER,
      );
    }
  });

  it('imports a snapshot with verified fields correctly', () => {
    const client = makeClient();

    const newSnapshot = {
      version: 1,
      operationId: 'msig-test-456',
      escrowId: 'escrow-1',
      operationType: 'release' as const,
      unsignedXdr: XDR,
      networkPassphrase: NETWORK,
      collectedSignatures: [
        {
          signerAddress: TEST_SIGNER,
          signedXdr: XDR,
          addedAt: Date.now() - 1000,
          verified: true,
          verifiedAt: Date.now() - 500,
        },
      ],
      threshold: 1,
      signers: [TEST_SIGNER],
      status: 'ready' as const,
      createdAt: Date.now() - 2000,
    };

    const importResult = client.importState(newSnapshot);
    expect(importResult.ok).toBe(true);

    const status = client.getMultiSigStatus('msig-test-456');
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.data.signaturesCollected).toBe(1);
      expect(status.data.isReady).toBe(true);
      expect(status.data.signersSigned).toContain(
        TEST_SIGNER,
      );
    }
  });

  it('exports state with verified fields', () => {
    const client = makeClient();
    const initResult = client.initMultiSigOperation({
      escrowId: 'escrow-1',
      signers: [TEST_SIGNER],
      threshold: 1,
      operationType: 'release',
      unsignedXdr: XDR,
      networkPassphrase: NETWORK,
    });
    expect(initResult.ok).toBe(true);
    if (!initResult.ok) return;
    const operationId = initResult.data.operationId;

    // Manually add a verified signature (simulating a verified addSignature)
    const op = (client as any).operations.get(operationId);
    op.collectedSignatures.push({
      signerAddress: TEST_SIGNER,
      signedXdr: XDR,
      addedAt: Date.now(),
      verified: true,
      verifiedAt: Date.now(),
    });

    const snapshot = client.exportState(operationId);
    expect(snapshot).toBeDefined();
    if (snapshot) {
      expect(snapshot.collectedSignatures[0].verified).toBe(true);
      expect(snapshot.collectedSignatures[0].verifiedAt).toBeDefined();
    }
  });
});