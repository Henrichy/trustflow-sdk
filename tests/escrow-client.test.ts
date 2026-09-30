import { Keypair } from '@stellar/stellar-sdk';
import { TrustFlowEscrowClient } from '../src/escrow/client';
import type { ContractConfig } from '../src/types/contract';
import type { MilestoneEventMap } from '../src/escrow/client';

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

describe('TrustFlowEscrowClient typed event listeners', () => {
  it('emits milestone:funded with a typed payload when a milestone is funded', () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const received: Array<MilestoneEventMap['milestone:funded']> = [];
    const handler = (payload: MilestoneEventMap['milestone:funded']) => {
      received.push(payload);
    };

    client.on('milestone:funded', handler);
    client.emit('milestone:funded', {
      escrowId: 'esc-1',
      milestoneId: 'ms-1',
      amount: 50_000_000n,
      funder: DEPOSITOR,
    });

    expect(received).toHaveLength(1);
    expect(received[0].escrowId).toBe('esc-1');
    expect(received[0].milestoneId).toBe('ms-1');
    expect(received[0].amount).toBe(50_000_000n);
    expect(received[0].funder).toBe(DEPOSITOR);
  });

  it('emits milestone:released with a typed payload when a milestone is released', () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const received: Array<MilestoneEventMap['milestone:released']> = [];
    const handler = (payload: MilestoneEventMap['milestone:released']) => {
      received.push(payload);
    };

    client.on('milestone:released', handler);
    client.emit('milestone:released', {
      escrowId: 'esc-1',
      milestoneId: 'ms-1',
      amount: 50_000_000n,
      beneficiary: BENEFICIARY,
    });

    expect(received).toHaveLength(1);
    expect(received[0].escrowId).toBe('esc-1');
    expect(received[0].milestoneId).toBe('ms-1');
    expect(received[0].amount).toBe(50_000_000n);
    expect(received[0].beneficiary).toBe(BENEFICIARY);
  });

  it('emits dispute:opened with a typed payload when a dispute is opened', () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const received: Array<MilestoneEventMap['dispute:opened']> = [];
    const handler = (payload: MilestoneEventMap['dispute:opened']) => {
      received.push(payload);
    };

    client.on('dispute:opened', handler);
    client.emit('dispute:opened', {
      escrowId: 'esc-1',
      milestoneId: 'ms-1',
      openedBy: DEPOSITOR,
      reason: 'milestone not delivered',
    });

    expect(received).toHaveLength(1);
    expect(received[0].escrowId).toBe('esc-1');
    expect(received[0].milestoneId).toBe('ms-1');
    expect(received[0].openedBy).toBe(DEPOSITOR);
    expect(received[0].reason).toBe('milestone not delivered');
  });

  it('removes a listener with off() so it no longer receives events', () => {
    const client = new TrustFlowEscrowClient(CONFIG);
    const received: Array<MilestoneEventMap['milestone:funded']> = [];
    const handler = (payload: MilestoneEventMap['milestone:funded']) => {
      received.push(payload);
    };

    client.on('milestone:funded', handler);
    client.off('milestone:funded', handler);
    client.emit('milestone:funded', {
      escrowId: 'esc-1',
      milestoneId: 'ms-1',
      amount: 50_000_000n,
      funder: DEPOSITOR,
    });

    expect(received).toHaveLength(0);
  });
});
