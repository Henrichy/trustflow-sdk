import { Keypair } from '@stellar/stellar-sdk';
import { JurorClient, createVoteCommitment, revealVote, DISPUTE_METADATA_UNAVAILABLE } from '../src/juror/client';

import type { ContractConfig } from '../src/types/contract';

const JUROR_ADDRESS = Keypair.random().publicKey();

const CONFIG: ContractConfig = {
  contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  network: 'TESTNET',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

describe('JurorClient.vote', () => {
  it('accepts a plaintext vote', async () => {
    const jurors = new JurorClient(CONFIG);
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: false, choice: 'approve' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.disputeId).toBe('dsp-1');
      expect(result.data.jurorAddress).toBe(JUROR_ADDRESS);
      expect(result.data.encrypted).toBe(false);
      expect(result.data.txHash).toMatch(/^vote-/);
    }
  });

  it('accepts an encrypted vote with base64 ciphertext', async () => {
    const jurors = new JurorClient(CONFIG);
    const ciphertext = Buffer.from('hidden-choice').toString('base64');
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: true, ciphertext },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.encrypted).toBe(true);
    }
  });

  it('rejects a missing disputeId', async () => {
    const jurors = new JurorClient(CONFIG);
    const result = await jurors.vote({
      disputeId: '',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: false, choice: 'approve' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Validation failed.*disputeId/i);
    }
  });

  it('rejects an invalid juror address', async () => {
    const jurors = new JurorClient(CONFIG);
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: 'not-a-stellar-address',
      vote: { encrypted: false, choice: 'approve' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Validation failed.*jurorAddress/i);
    }
  });

  it('rejects an invalid plaintext choice', async () => {
    const jurors = new JurorClient(CONFIG);
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      // @ts-expect-error deliberately invalid choice for the runtime check
      vote: { encrypted: false, choice: 'maybe' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/vote.choice/);
    }
  });

  it('rejects a non-base64 ciphertext', async () => {
    const jurors = new JurorClient(CONFIG);
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: true, ciphertext: 'not base64!!' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Validation failed.*vote/i);
    }
  });

  it('rejects an empty ciphertext', async () => {
    const jurors = new JurorClient(CONFIG);
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: true, ciphertext: '' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Validation failed.*vote/i);
    }
  });

  it('handles missing IPFS dispute metadata gracefully', async () => {
    const jurors = new JurorClient(CONFIG, {
      fetchDisputeMetadata: async () => null,
    });
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: false, choice: 'approve' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.disputeId).toBe('dsp-1');
      expect(result.data.metadata).toBeUndefined();
    }
  });

  it('handles 404 IPFS dispute metadata gracefully', async () => {
    const jurors = new JurorClient(CONFIG, {
      fetchDisputeMetadata: async () => {
        const err: any = new Error('Not Found');
        err.status = 404;
        throw err;
      },
    });
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: false, choice: 'approve' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.disputeId).toBe('dsp-1');
    }
  });

  it('returns DISPUTE_METADATA_UNAVAILABLE when metadata is required but missing', async () => {
    const jurors = new JurorClient(CONFIG, {
      fetchDisputeMetadata: async () => null,
    });
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: false, choice: 'approve' },
      requireMetadata: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/DISPUTE_METADATA_UNAVAILABLE/);
      expect(result.code).toBe(DISPUTE_METADATA_UNAVAILABLE);
    }
  });

  it('returns DISPUTE_METADATA_UNAVAILABLE for invalid IPFS metadata payloads', async () => {
    const jurors = new JurorClient(CONFIG, {
      fetchDisputeMetadata: async () => ({ invalid: true }) as any,
    });
    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: false, choice: 'approve' },
      requireMetadata: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/DISPUTE_METADATA_UNAVAILABLE/);
      expect(result.code).toBe(DISPUTE_METADATA_UNAVAILABLE);
    }
  });
});

describe('commit-reveal voting helpers (Issue #373)', () => {
  it('constructs commitment matching contract sha256(vote_byte ++ 32_byte_salt) layout for true', () => {
    const zeroSalt = new Uint8Array(32);
    const commitment = createVoteCommitment(true, zeroSalt);

    // sha256(0x01 ++ 32 bytes of 0x00)
    expect(commitment.commitmentHex).toBe(
      '1a7dfdeaffeedac489287e85be5e9c049a2ff6470f55cf30260f55395ac1b159',
    );
    expect(commitment.voteForDepositor).toBe(true);
    expect(commitment.salt).toEqual(zeroSalt);
    expect(commitment.commitment.length).toBe(32);
    expect(Buffer.from(commitment.ciphertext, 'base64')).toEqual(
      Buffer.from(commitment.commitment),
    );
  });

  it('constructs commitment matching contract sha256(vote_byte ++ 32_byte_salt) layout for false', () => {
    const zeroSalt = new Uint8Array(32);
    const commitment = createVoteCommitment(false, zeroSalt);

    // Expected sha256(0x00 ++ 32 bytes of 0x00)
    const expectedHash = require('crypto')
      .createHash('sha256')
      .update(Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 0)]))
      .digest('hex');

    expect(commitment.commitmentHex).toBe(expectedHash);
    expect(commitment.voteForDepositor).toBe(false);
  });

  it('automatically generates 32 cryptographically secure random bytes if salt is omitted', () => {
    const commitment1 = createVoteCommitment(true);
    const commitment2 = createVoteCommitment(true);

    expect(commitment1.salt.length).toBe(32);
    expect(commitment2.salt.length).toBe(32);
    // Two random salts must not be identical
    expect(commitment1.saltHex).not.toBe(commitment2.saltHex);
    expect(commitment1.commitmentHex).not.toBe(commitment2.commitmentHex);
  });

  it('rejects salt that is not exactly 32 bytes', () => {
    expect(() => createVoteCommitment(true, new Uint8Array(31))).toThrow(
      /Salt must be exactly 32 bytes/,
    );
    expect(() => createVoteCommitment(true, new Uint8Array(33))).toThrow(
      /Salt must be exactly 32 bytes/,
    );
    expect(() => createVoteCommitment(true, new Uint8Array(0))).toThrow(
      /Salt must be exactly 32 bytes/,
    );
  });

  it('reveals vote matching the created commitment', () => {
    const commitment = createVoteCommitment(true);
    const reveal = revealVote(true, commitment.salt);

    expect(reveal.voteForDepositor).toBe(true);
    expect(reveal.voteByte).toBe(1);
    expect(reveal.salt).toEqual(commitment.salt);
    expect(reveal.commitmentHex).toBe(commitment.commitmentHex);
    expect(reveal.commitment).toEqual(commitment.commitment);
  });

  it('stores salts locally on JurorClient instance and allows retrieval', () => {
    const jurors = new JurorClient(CONFIG);
    const commitment = jurors.createVoteCommitment(false);

    const storedSalt = jurors.getStoredSalt(commitment.commitmentHex);
    expect(storedSalt).toEqual(commitment.salt);

    const storedSaltFromBytes = jurors.getStoredSalt(commitment.commitment);
    expect(storedSaltFromBytes).toEqual(commitment.salt);

    jurors.clearStoredSalts();
    expect(jurors.getStoredSalt(commitment.commitmentHex)).toBeUndefined();
  });

  it('can be used directly to cast an encrypted vote with JurorClient', async () => {
    const jurors = new JurorClient(CONFIG);
    const commitment = jurors.createVoteCommitment(true);

    const result = await jurors.vote({
      disputeId: 'dsp-1',
      jurorAddress: JUROR_ADDRESS,
      vote: { encrypted: true, ciphertext: commitment.ciphertext },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.encrypted).toBe(true);
    }
  });
});
