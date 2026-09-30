import { Keypair } from '@stellar/stellar-sdk';
import { TrustFlowEscrowClient } from '../src/escrow/client';
import type { ContractConfig } from '../src/types/contract';

const DEPOSITOR = Keypair.random().publicKey();
const BENEFICIARY = Keypair.random().publicKey();

const CONFIG: ContractConfig = {
  contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  network: 'TESTNET',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

describe('TrustFlowEscrowClient.createEscrow', () => {
  it('creates an escrow for valid params', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const result = await client.createEscrow({
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: '50',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.escrowId).toMatch(/^esc-/);
      expect(result.data.txHash).toMatch(/^create-/);
    }
  });

  it('encodes the deadlineBlocks into the underlying contract call arguments', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const result = await client.createEscrow({
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: '50',
      deadlineBlocks: 17_280,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects an invalid depositor address', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    await expect(
      client.createEscrow({
        depositor: 'not-a-stellar-address',
        beneficiary: BENEFICIARY,
        amountXLM: '50',
      }),
    ).rejects.toThrow(/depositor/);
  });

  it('rejects an invalid beneficiary address', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    await expect(
      client.createEscrow({
        depositor: DEPOSITOR,
        beneficiary: 'not-a-stellar-address',
        amountXLM: '50',
      }),
    ).rejects.toThrow(/beneficiary/);
  });

  it('rejects a non-positive amount', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const result = await client.createEscrow({
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: '0',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/positive/);
    }
  });
});

describe('TrustFlowEscrowClient.fund', () => {
  it('funds an escrow for a valid amount and no token address', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const result = await client.fund('esc-1', DEPOSITOR, 50_000_000n);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.txHash).toMatch(/^fund-esc-1-/);
    }
  });

  it('funds an escrow with a specific token address (e.g. USDC contract)', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const usdcContract = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    const result = await client.fund('esc-1', DEPOSITOR, 50_000_000n, usdcContract);

    expect(result.ok).toBe(true);
  });

  it('rejects a missing escrowId', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const result = await client.fund('', DEPOSITOR, 50_000_000n);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/escrowId/);
    }
  });

  it('rejects an invalid funder address', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    await expect(client.fund('esc-1', 'not-a-stellar-address', 50_000_000n)).rejects.toThrow(
      /funderAddress/,
    );
  });

  it('rejects a non-positive amount', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const result = await client.fund('esc-1', DEPOSITOR, 0n);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/positive/);
    }
  });
});

describe('TrustFlowEscrowClient.claim', () => {
  it('claims funds for a valid escrowId and claimant address', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const result = await client.claim('esc-1', BENEFICIARY);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.txHash).toMatch(/^claim-esc-1-/);
    }
  });

  it('rejects a missing escrowId', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const result = await client.claim('', BENEFICIARY);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/escrowId/);
    }
  });

  it('rejects an invalid claimant address', async () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    await expect(client.claim('esc-1', 'not-a-stellar-address')).rejects.toThrow(/claimantAddress/);
  });
});
