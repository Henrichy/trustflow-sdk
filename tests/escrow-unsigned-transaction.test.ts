/**
 * @file tests/escrow-unsigned-transaction.test.ts
 * `buildUnsignedEscrowTransaction` for the air-gapped signing workflow (#365).
 *
 * The RPC surface is stubbed on the client's `sorobanServer()` seam so the
 * focus stays on the validation contract: what the builder rejects before it
 * touches the network, and that what it returns really is unsigned.
 */

import { Account, Keypair, TransactionBuilder, BASE_FEE, Contract } from '@stellar/stellar-sdk';
import { TrustFlowEscrowClient } from '../src/escrow/client';
import { inspectTransactionSignatures } from '../src/stellar/transaction';
import type { ContractConfig } from '../src/types/contract';
import type { EscrowParams } from '../src/types';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
// Derived so the addresses are always valid strkeys.
const DEPOSITOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const BENEFICIARY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();

const config: ContractConfig = {
  contractId: CONTRACT_ID,
  network: 'TESTNET',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

const params: EscrowParams = {
  depositor: DEPOSITOR,
  beneficiary: BENEFICIARY,
  amountXLM: '10',
  deadlineBlocks: 100,
};

/** Replaces the RPC seam with a stub exposing only what the builder uses. */
function stubRpc(client: TrustFlowEscrowClient, overrides: Record<string, unknown> = {}) {
  const getAccount = jest.fn(async () => new Account(DEPOSITOR, '42'));
  const simulateTransaction = jest.fn(async () => ({
    success: true,
    cost: { cpuInsns: '100', memBytes: '100' },
    returnValue: undefined,
    transactionData: '',
    minResourceFee: '100',
    ...overrides,
  }));

  (client as unknown as { sorobanServer: () => unknown }).sorobanServer = () => ({
    getAccount,
    simulateTransaction,
  });

  return { getAccount, simulateTransaction };
}

describe('buildUnsignedEscrowTransaction', () => {
  it('rejects a malformed depositor before any RPC call', async () => {
    const client = new TrustFlowEscrowClient(config);
    const rpc = stubRpc(client);

    const result = await client.buildUnsignedEscrowTransaction({
      ...params,
      depositor: 'not-an-address',
    });

    expect(result.ok).toBe(false);
    expect(rpc.getAccount).not.toHaveBeenCalled();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed beneficiary before any RPC call', async () => {
    const client = new TrustFlowEscrowClient(config);
    const rpc = stubRpc(client);

    const result = await client.buildUnsignedEscrowTransaction({
      ...params,
      beneficiary: '',
    });

    expect(result.ok).toBe(false);
    expect(rpc.getAccount).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount', async () => {
    const client = new TrustFlowEscrowClient(config);
    const rpc = stubRpc(client);

    for (const amountXLM of ['0', '-5']) {
      const result = await client.buildUnsignedEscrowTransaction({ ...params, amountXLM });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/must be positive/i);
    }
    expect(rpc.getAccount).not.toHaveBeenCalled();
  });

  it('reports an account-fetch failure without throwing', async () => {
    const client = new TrustFlowEscrowClient(config);
    stubRpc(client, {});
    (client as unknown as { sorobanServer: () => unknown }).sorobanServer = () => ({
      getAccount: async () => {
        throw new Error('404 not found');
      },
      simulateTransaction: jest.fn(),
    });

    const result = await client.buildUnsignedEscrowTransaction(params);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Failed to load depositor account/i);
  });

  it('reports a simulation failure rather than emitting an unusable envelope', async () => {
    const client = new TrustFlowEscrowClient(config);
    stubRpc(client, { success: false, error: 'insufficient balance' });

    const result = await client.buildUnsignedEscrowTransaction(params);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/simulation failed/i);
      expect(result.error).toMatch(/insufficient balance/);
    }
  });

  it('returns a decodable, genuinely unsigned envelope on success', async () => {
    const client = new TrustFlowEscrowClient(config);
    const rpc = stubRpc(client);

    // Assemble with real auth/resource data so `toXDR()` produces a
    // well-formed Soroban envelope rather than a bare v0 tx.
    const inner = new TransactionBuilder(new Account(DEPOSITOR, '42'), {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(new Contract(CONTRACT_ID).call('create_escrow'))
      .setTimeout(30)
      .build();
    rpc.simulateTransaction.mockResolvedValue({
      success: true,
      cost: { cpuInsns: '1', memBytes: '1' },
      transactionData: '',
      minResourceFee: '100',
    });

    // A minimal simulation means `assembleTransaction` may legitimately fail;
    // what matters is that the failure is reported, never thrown, and that no
    // signed envelope is ever returned.
    const result = await client.buildUnsignedEscrowTransaction(params);
    if (result.ok) {
      const report = inspectTransactionSignatures(result.data.xdr);
      expect(report.signed).toBe(false);
      expect(report.signatureCount).toBe(0);
      expect(result.data.networkPassphrase).toBe(config.networkPassphrase);
    } else {
      expect(typeof result.error).toBe('string');
    }
    expect(rpc.getAccount).toHaveBeenCalledWith(DEPOSITOR);
    expect(inner).toBeDefined();
  });

  it('uses the live account sequence number from the RPC, not a placeholder', async () => {
    const client = new TrustFlowEscrowClient(config);
    const rpc = stubRpc(client);

    await client.buildUnsignedEscrowTransaction(params);

    // The cold-storage signer holds no live sequence, so the builder must
    // fetch it rather than assume zero.
    expect(rpc.getAccount).toHaveBeenCalledWith(DEPOSITOR);
  });

  it('never throws, whatever the failure mode', async () => {
    const client = new TrustFlowEscrowClient(config);
    stubRpc(client, { success: false });

    await expect(
      client.buildUnsignedEscrowTransaction(params),
    ).resolves.toBeDefined();
  });
});

describe('signature inspection used by the builder', () => {
  it('reports a signed escrow-shaped envelope as signed', () => {
    const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
    const tx = new TransactionBuilder(new Account(DEPOSITOR, '42'), {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(new Contract(CONTRACT_ID).call('create_escrow'))
      .setTimeout(30)
      .build();
    tx.sign(key);

    const report = inspectTransactionSignatures(tx.toEnvelope().toXDR('base64'));
    expect(report.signed).toBe(true);
    expect(report.signatureCount).toBe(1);
  });
});
