import { Account, Contract, Keypair, Transaction, rpc, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import { TransactionPipeline } from '../src/tx-pipeline';
import { runExclusive, queueDepth, queueKey } from '../src/tx-pipeline/queue';
import { TrustFlowClient } from '../src/client';
import { TrustFlowError } from '../src/errors';

const CONTRACT_ID = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';

function makeClient(): TrustFlowClient {
  return new TrustFlowClient({ contractId: CONTRACT_ID, network: 'TESTNET' });
}

function simSuccess(): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '500',
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Mocks a ledger where each account's sequence advances when a submitted
 * transaction is confirmed, and records the sequence of every submission.
 */
function mockLedger(gate?: Promise<void>) {
  const sequences = new Map<string, bigint>();
  const submitted: string[] = [];
  jest.spyOn(rpc.Server.prototype, 'getAccount').mockImplementation(async (id: string) => {
    return new Account(id, (sequences.get(id) ?? 100n).toString());
  });
  jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue(simSuccess());
  jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockImplementation(async (tx) => {
    const t = tx as Transaction;
    submitted.push(`${t.source}:${t.sequence}`);
    return { status: 'PENDING', hash: `${t.source}:${t.sequence}`, latestLedger: 1, latestLedgerCloseTime: 1 };
  });
  jest.spyOn(rpc.Server.prototype, 'getTransaction').mockImplementation(async (hash: string) => {
    if (gate) await gate;
    const [source, sequence] = hash.split(':');
    sequences.set(source, BigInt(sequence));
    return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 5 } as unknown as rpc.Api.GetTransactionResponse;
  });
  return { submitted };
}

function runParams(source: Keypair, extra: Record<string, unknown> = {}) {
  return {
    sourceAccount: source.publicKey(),
    operations: [new Contract(CONTRACT_ID).call('increment')],
    signers: [source],
    submit: { pollIntervalMs: 1, maxAttempts: 1 },
    ...extra,
  };
}

describe('runExclusive', () => {
  it('runs tasks for one key in order and reports queue depth', async () => {
    const order: number[] = [];
    const first = deferred();
    const a = runExclusive('k', async () => {
      await first.promise;
      order.push(1);
    });
    const b = runExclusive('k', async () => {
      order.push(2);
    });

    expect(queueDepth('k')).toBe(2);
    first.resolve();
    await Promise.all([a, b]);

    expect(order).toEqual([1, 2]);
    expect(queueDepth('k')).toBe(0);
  });

  it('does not make different keys wait for each other', async () => {
    const block = deferred();
    const slow = runExclusive('slow', () => block.promise);
    const fast = await runExclusive('fast', async () => 'done');

    expect(fast).toBe('done');
    block.resolve();
    await slow;
  });

  it('releases the lane when a task throws', async () => {
    await expect(
      runExclusive('boom', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    await expect(runExclusive('boom', async () => 'ok')).resolves.toBe('ok');
    expect(queueDepth('boom')).toBe(0);
  });

  it('times out with a typed error without running the task, and later waiters still wait for the holder', async () => {
    const holder = deferred();
    const events: string[] = [];
    const first = runExclusive('t', async () => {
      await holder.promise;
      events.push('first');
    });
    const skipped = jest.fn();
    const timedOut = await runExclusive('t', async () => skipped(), 5).catch((e) => e);
    const third = runExclusive('t', async () => {
      events.push('third');
    });

    expect(timedOut).toBeInstanceOf(TrustFlowError);
    expect(timedOut.code).toBe('TIMEOUT');
    expect(skipped).not.toHaveBeenCalled();
    expect(queueDepth('t')).toBe(2);

    holder.resolve();
    await Promise.all([first, third]);
    expect(events).toEqual(['first', 'third']);
    expect(queueDepth('t')).toBe(0);
  });

  it('runs immediately when the wait timeout is not reached', async () => {
    await expect(runExclusive('quick', async () => 1, 1000)).resolves.toBe(1);
  });
});

describe('TransactionPipeline.run serialization', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds different sequence numbers for concurrent runs of one account', async () => {
    const source = Keypair.random();
    const { submitted } = mockLedger();
    const client = makeClient();

    const results = await Promise.all([
      new TransactionPipeline(client).run(runParams(source)),
      new TransactionPipeline(client).run(runParams(source)),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(submitted).toEqual([`${source.publicKey()}:101`, `${source.publicKey()}:102`]);
  });

  it('collides on the sequence number when serialize is false', async () => {
    const source = Keypair.random();
    const { submitted } = mockLedger();
    const pipeline = new TransactionPipeline(makeClient());

    await Promise.all([
      pipeline.run(runParams(source, { serialize: false })),
      pipeline.run(runParams(source, { serialize: false })),
    ]);

    expect(submitted).toEqual([`${source.publicKey()}:101`, `${source.publicKey()}:101`]);
  });

  it('makes the second run wait for the first and exposes the queue depth', async () => {
    const source = Keypair.random();
    const gate = deferred();
    const { submitted } = mockLedger(gate.promise);
    const pipeline = new TransactionPipeline(makeClient());

    const first = pipeline.run(runParams(source));
    const second = pipeline.run(runParams(source));
    await new Promise((r) => setTimeout(r, 20));

    expect(submitted).toHaveLength(1);
    expect(pipeline.queueDepth(source.publicKey())).toBe(2);

    gate.resolve();
    await Promise.all([first, second]);
    expect(submitted).toHaveLength(2);
    expect(pipeline.queueDepth(source.publicKey())).toBe(0);
  });

  it('does not let different accounts block each other', async () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const gate = deferred();
    const { submitted } = mockLedger(gate.promise);
    const pipeline = new TransactionPipeline(makeClient());

    const runA = pipeline.run(runParams(a));
    const runB = pipeline.run(runParams(b));
    await new Promise((r) => setTimeout(r, 20));

    expect(submitted.sort()).toEqual([`${a.publicKey()}:101`, `${b.publicKey()}:101`].sort());
    gate.resolve();
    await Promise.all([runA, runB]);
  });

  it('releases the queue after a failed run so the next run proceeds', async () => {
    const source = Keypair.random();
    mockLedger();
    jest
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValue(simSuccess());
    const pipeline = new TransactionPipeline(makeClient());

    const failed = await pipeline.run(runParams(source, { prepare: { maxAttempts: 1 } }));
    const next = await pipeline.run(runParams(source));

    expect(failed.ok).toBe(false);
    expect(next.ok).toBe(true);
    expect(pipeline.queueDepth(source.publicKey())).toBe(0);
  });

  it('releases the queue when a run throws unexpectedly', async () => {
    const source = Keypair.random();
    mockLedger();
    const pipeline = new TransactionPipeline(makeClient());

    await expect(
      pipeline.run({ ...runParams(source), signers: [null as unknown as Keypair] }),
    ).rejects.toThrow();

    expect(pipeline.queueDepth(source.publicKey())).toBe(0);
    await expect(pipeline.run(runParams(source))).resolves.toMatchObject({ ok: true });
  });

  it('releases the queue when confirmation polling times out', async () => {
    const source = Keypair.random();
    mockLedger();
    jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as unknown as rpc.Api.GetTransactionResponse);
    const pipeline = new TransactionPipeline(makeClient());

    const result = await pipeline.run(
      runParams(source, { submit: { pollIntervalMs: 1, pollAttempts: 2, maxAttempts: 1 } }),
    );

    expect(result.ok).toBe(false);
    expect(pipeline.queueDepth(source.publicKey())).toBe(0);
  });

  it('returns a typed TIMEOUT result when queued behind a stuck run for too long', async () => {
    const source = Keypair.random();
    const gate = deferred();
    mockLedger(gate.promise);
    const pipeline = new TransactionPipeline(makeClient());

    const stuck = pipeline.run(runParams(source));
    const waiting = await pipeline.run(runParams(source, { queueTimeoutMs: 10 }));

    expect(waiting.ok).toBe(false);
    if (!waiting.ok) {
      expect(waiting.error.code).toBe('TIMEOUT');
    }
    gate.resolve();
    await stuck;
  });

  it('keys the queue by network passphrase and source account', () => {
    expect(queueKey('Test', 'GA')).not.toBe(queueKey('Public', 'GA'));
    expect(queueKey('Test', 'GA')).not.toBe(queueKey('Test', 'GB'));
  });
});
