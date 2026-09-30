import { Keypair, TransactionBuilder, Networks, SorobanRpc, Transaction } from '@stellar/stellar-sdk';
import { MultiSigEscrowClient } from '../src/escrow/multisig';

describe('MultiSigEscrow Integration Tests (2-of-3 and 3-of-5)', () => {
    let client: MultiSigEscrowClient;
    const NETWORK_PASSPHRASE = Networks.TESTNET;
    
    // Setup signers for 2-of-3
    const kp2of3 = [Keypair.random(), Keypair.random(), Keypair.random()];
    
    // Setup signers for 3-of-5
    const kp3of5 = [Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random()];

    beforeEach(() => {
        // Create a basic client - we mock RPC parts that would require real network,
        // but test the real signature logic of MultiSigEscrowClient
        client = new MultiSigEscrowClient({
            networkPassphrase: NETWORK_PASSPHRASE,
        } as any);

        // We patch submitWhenReady so it doesn't actually hit the real network, 
        // but we ensure the atomic verification logic runs.
        (client as any).submitWhenReady = jest.fn().mockResolvedValue({ ok: true, data: { hash: 'MOCK_HASH' } });
    });

    it('should complete a 2-of-3 multisig flow successfully', async () => {
        // 1. Initialize 2-of-3 operation
        const signers = kp2of3.map(k => k.publicKey());
        const initResult = client.initMultiSigOperation({
            escrowId: 'escrow_2_3',
            signers,
            threshold: 2,
            operationType: 'release',
            unsignedXdr: 'AAAA...MOCK...XDR...',
            networkPassphrase: NETWORK_PASSPHRASE
        });
        expect(initResult.ok).toBe(true);
        const opId = (initResult as any).data.operationId;

        // 2. Add signature 1
        const res1 = client.addSignature(opId, kp2of3[0].publicKey(), 'SIG1');
        expect(res1.ok).toBe(true);

        // 3. Add signature 2 (threshold reached)
        const res2 = client.addSignature(opId, kp2of3[1].publicKey(), 'SIG2');
        expect(res2.ok).toBe(true);

        // The mock would have been called since threshold is 2
        expect((client as any).submitWhenReady).toHaveBeenCalled();
    });

    it('should complete a 3-of-5 multisig flow successfully', async () => {
        // 1. Initialize 3-of-5 operation
        const signers = kp3of5.map(k => k.publicKey());
        const initResult = client.initMultiSigOperation({
            escrowId: 'escrow_3_5',
            signers,
            threshold: 3,
            operationType: 'release',
            unsignedXdr: 'AAAA...MOCK...XDR...',
            networkPassphrase: NETWORK_PASSPHRASE
        });
        expect(initResult.ok).toBe(true);
        const opId = (initResult as any).data.operationId;

        // 2. Add signatures up to threshold
        client.addSignature(opId, kp3of5[0].publicKey(), 'SIG1');
        client.addSignature(opId, kp3of5[2].publicKey(), 'SIG2');
        
        expect((client as any).submitWhenReady).not.toHaveBeenCalled();

        // 3. Final signature
        client.addSignature(opId, kp3of5[4].publicKey(), 'SIG3');
        expect((client as any).submitWhenReady).toHaveBeenCalled();
    });

    it('should reject unauthorized signers', async () => {
        const signers = kp2of3.map(k => k.publicKey());
        const initResult = client.initMultiSigOperation({
            escrowId: 'escrow_auth',
            signers,
            threshold: 2,
            operationType: 'release',
            unsignedXdr: 'AAAA...MOCK...XDR...',
            networkPassphrase: NETWORK_PASSPHRASE
        });
        const opId = (initResult as any).data.operationId;

        const rogueKp = Keypair.random();
        const res = client.addSignature(opId, rogueKp.publicKey(), 'BAD_SIG');
        expect(res.ok).toBe(false);
    });
});
