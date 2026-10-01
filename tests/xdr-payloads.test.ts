import { Keypair, xdr } from '@stellar/stellar-sdk';
import './support/scval-matchers';
import {
    buildCreateEscrowArgs,
    buildReleaseArgs,
    buildClaimArgs,
    buildFundArgs,
    buildDisputeArgs,
    buildVoteArgs,
} from '../src/contract/build';

const ADDR_A = Keypair.random().publicKey();
const ADDR_B = Keypair.random().publicKey();

describe('contract argument XDR payloads', () => {
    it('buildCreateEscrowArgs returns XDR-decodable ScVal values', () => {
        const args = buildCreateEscrowArgs({
            sender: ADDR_A,
            recipient: ADDR_B,
            amountStroops: 1_000_000n,
            durationBlocks: 42,
        });

        expect(args).toHaveLength(4);
        args.forEach((value) => expect(value).toBeValidScVal());
    });

    it('buildReleaseArgs returns XDR-decodable ScVal values', () => {
        const args = buildReleaseArgs('escrow-1', ADDR_A);

        expect(args).toHaveLength(2);
        args.forEach((value) => expect(value).toBeValidScVal());
    });

    it('buildClaimArgs returns XDR-decodable ScVal values', () => {
        const args = buildClaimArgs('escrow-1', ADDR_A);

        expect(args).toHaveLength(2);
        args.forEach((value) => expect(value).toBeValidScVal());
    });

    it('buildFundArgs returns XDR-decodable ScVal values without a token address', () => {
        const args = buildFundArgs('escrow-1', ADDR_A, 50_000_000n);

        expect(args).toHaveLength(3);
        args.forEach((value) => expect(value).toBeValidScVal());
    });

    it('buildFundArgs includes the token address when provided', () => {
        const args = buildFundArgs('escrow-1', ADDR_A, 50_000_000n, ADDR_B);

        expect(args).toHaveLength(4);
        args.forEach((value) => expect(value).toBeValidScVal());
    });

    it('buildDisputeArgs returns XDR-decodable ScVal values', () => {
        const args = buildDisputeArgs('escrow-1', 'work quality dispute');

        expect(args).toHaveLength(2);
        args.forEach((value) => expect(value).toBeValidScVal());
    });

    it('buildVoteArgs returns XDR-decodable ScVal values for a plaintext vote', () => {
        const args = buildVoteArgs('dispute-1', ADDR_A, { encrypted: false, choice: 'approve' });

        expect(args).toHaveLength(4);
        args.forEach((value) => expect(value).toBeValidScVal());
    });

    it('buildVoteArgs returns XDR-decodable ScVal values for an encrypted vote', () => {
        const args = buildVoteArgs('dispute-1', ADDR_A, {
            encrypted: true,
            ciphertext: Buffer.from('secret-choice').toString('base64'),
        });

        expect(args).toHaveLength(4);
        args.forEach((value) => expect(value).toBeValidScVal());
    });

    it('buildVoteArgs encodes the encrypted flag distinctly from the vote payload', () => {
        const plaintextArgs = buildVoteArgs('dispute-1', ADDR_A, { encrypted: false, choice: 'reject' });
        const encryptedArgs = buildVoteArgs('dispute-1', ADDR_A, {
            encrypted: true,
            ciphertext: Buffer.from('reject').toString('base64'),
        });

        const plaintextFlag = plaintextArgs[2] as xdr.ScVal;
        const encryptedFlag = encryptedArgs[2] as xdr.ScVal;
        expect(plaintextFlag.b()).toBe(false);
        expect(encryptedFlag.b()).toBe(true);
    });
});
