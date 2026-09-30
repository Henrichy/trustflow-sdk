import {
  Contract,
  nativeToScVal,
  SorobanDataBuilder,
  StrKey,
  rpc,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { TrustFlowClient } from '../src/client';
import { simulateBatch, simulateContractCall } from '../src/contract/simulate';
import type { ContractInvocation } from '../src/contract/simulate';

const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const transactionData = new SorobanDataBuilder().build().toXDR('base64');

function success(id: number, value: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      latestLedger: 42,
      minResourceFee: '100',
      transactionData,
      results: [{ auth: [], xdr: nativeToScVal(value).toXDR('base64') }],
    },
  };
}

describe('simulateBatch', () => {
  let client: TrustFlowClient;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const invocations: ContractInvocation[] = [{ xdr: 'first-envelope' }, { xdr: 'second-envelope' }];

  function respond(payload: unknown, status = 200) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status }));
  }

  beforeEach(() => {
    client = new TrustFlowClient({
      contractId,
      rpcUrl: 'https://custom-rpc.example/rpc',
      retry: { retries: 0 },
    });
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('sends one JSON-RPC array request and matches reversed responses by ID', async () => {
    respond([success(1, 'second'), success(0, 'first')]);
    const results = await client.simulateBatch(invocations);
    expect(results.map((result) => result.returnValue)).toEqual(['first', 'second']);
    expect(results.every((result) => result.success)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(client.rpcUrl);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual(
      invocations.map((invocation, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'simulateTransaction',
        params: { transaction: 'xdr' in invocation ? invocation.xdr : '' },
      })),
    );
  });

  it('builds a read envelope locally using the configured contract and network', async () => {
    respond([success(0, 7)]);
    const arg = nativeToScVal('escrow-1');
    const results = await simulateBatch(client, [{ method: 'get_escrow', args: [arg] }]);
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)[0];
    const tx = TransactionBuilder.fromXDR(request.params.transaction, client.networkPassphrase);
    expect(
      tx
        .toEnvelope()
        .v1()
        .tx()
        .operations()
        .map((operation) => operation.toXDR('base64')),
    ).toEqual([new Contract(contractId).call('get_escrow', arg).toXDR('base64')]);
    expect(results[0]).toMatchObject({ success: true, returnValue: 7n });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('supports per-invocation contract overrides and default empty arguments', async () => {
    respond([success(0, true)]);
    const otherContract = StrKey.encodeContract(Buffer.alloc(32, 1));
    await client.simulateBatch([{ method: 'get_count', contractId: otherContract }]);
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)[0];
    const tx = TransactionBuilder.fromXDR(request.params.transaction, client.networkPassphrase);
    expect(
      tx
        .toEnvelope()
        .v1()
        .tx()
        .operations()
        .map((operation) => operation.toXDR('base64')),
    ).toEqual([new Contract(otherContract).call('get_count').toXDR('base64')]);
  });

  it('isolates JSON-RPC and contract errors without replaying successes', async () => {
    respond([
      { jsonrpc: '2.0', id: 0, error: { code: -32602, message: 'Invalid params' } },
      { jsonrpc: '2.0', id: 1, result: { latestLedger: 42, error: 'Error(Contract, #4)' } },
      success(2, false),
    ]);
    const results = await client.simulateBatch([...invocations, { xdr: 'third' }]);
    expect(results[0]).toMatchObject({ success: false, error: 'Invalid params' });
    expect(results[1]).toMatchObject({ success: false, error: 'Error(Contract, #4)' });
    expect(results[2]).toMatchObject({ success: true, returnValue: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves restore requirements as serializable XDR', async () => {
    const restore = success(0, 'restored');
    respond([
      {
        ...restore,
        result: { ...restore.result, restorePreamble: { minResourceFee: '500', transactionData } },
      },
      success(1, 'ok'),
    ]);
    const results = await client.simulateBatch(invocations);
    expect(results[0]).toMatchObject({
      success: false,
      needsRestore: true,
      restorePreamble: { minResourceFee: '500', transactionData },
    });
    expect(results[1].success).toBe(true);
  });

  it('isolates invalid XDR in a response from healthy siblings', async () => {
    const malformed = success(0, 'bad');
    malformed.result.results[0].xdr = 'not-XDR';
    respond([malformed, success(1, 'ok')]);
    const results = await client.simulateBatch(invocations);
    expect(results[0].success).toBe(false);
    expect(results[1]).toMatchObject({ success: true, returnValue: 'ok' });
  });

  it('marks missing and duplicate IDs as failures and ignores unknown IDs', async () => {
    respond([success(0, 'a'), success(0, 'b'), success(2, 'ok'), success(99, 'unknown'), null]);
    const results = await client.simulateBatch([...invocations, { xdr: 'third' }]);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      success: false,
      error: 'Duplicate batch response for invocation 0',
    });
    expect(results[1]).toMatchObject({
      success: false,
      error: 'Missing batch response for invocation 1',
    });
    expect(results[2]).toMatchObject({ success: true, returnValue: 'ok' });
  });

  it.each([
    { id: 0, result: {} },
    { jsonrpc: '2.0', id: 0, result: {} },
    { jsonrpc: '2.0', id: 0, result: { latestLedger: 42 } },
    { jsonrpc: '2.0', id: 0, error: null },
  ])('isolates malformed response %j', async (malformed) => {
    respond([malformed, success(1, 'ok')]);
    const results = await client.simulateBatch(invocations);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
  });

  it('isolates local construction errors without renumbering successful requests', async () => {
    respond([success(1, 'ok')]);
    const results = await client.simulateBatch([
      { method: 'read', contractId: 'invalid' },
      { xdr: 'valid' },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
    expect(
      JSON.parse(fetchMock.mock.calls[0][1]?.body as string).map(
        (entry: { id: number }) => entry.id,
      ),
    ).toEqual([1]);
  });

  it('makes no request for empty or entirely invalid inputs', async () => {
    expect(await client.simulateBatch([])).toEqual([]);
    expect(await client.simulateBatch([{ xdr: '' }])).toEqual([
      expect.objectContaining({ success: false }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported batch response rather than issuing individual requests', async () => {
    respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    await expect(client.simulateBatch(invocations)).rejects.toMatchObject({
      code: 'SIMULATION_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient HTTP failure as one unchanged batch', async () => {
    respond({}, 503);
    respond([success(0, 1), success(1, 2)]);
    const results = await client.simulateBatch(invocations, {
      retry: { attempts: 2, baseDelayMs: 0 },
    });
    expect(results.every((result) => result.success)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
  });

  it('does not retry non-transient HTTP failures', async () => {
    respond({}, 400);
    await expect(
      client.simulateBatch(invocations, { retry: { attempts: 3 } }),
    ).rejects.toMatchObject({ code: 'SIMULATION_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('wraps exhausted transport failures', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(client.simulateBatch(invocations)).rejects.toMatchObject({
      code: 'SIMULATION_ERROR',
    });
  });

  it('uses the client deadline and preserves TIMEOUT', async () => {
    jest.useFakeTimers();
    client = new TrustFlowClient({ contractId, timeoutMs: 50, retry: { retries: 0 } });
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const pending = client.simulateBatch(invocations);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await jest.advanceTimersByTimeAsync(50);
    await assertion;
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it('lets a per-batch deadline override the client deadline', async () => {
    jest.useFakeTimers();
    client = new TrustFlowClient({ contractId, timeoutMs: 1000, retry: { retries: 0 } });
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const pending = client.simulateBatch(invocations, { timeoutMs: 20 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await jest.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it('resolves a named account once for the shared batch', async () => {
    const resolveAccount = jest.spyOn(client, 'resolveAccount').mockReturnValue(null);
    respond([success(0, 'a'), success(1, 'b')]);
    await client.simulateBatch(invocations, { account: 'named-account' });
    expect(resolveAccount).toHaveBeenCalledTimes(1);
    expect(resolveAccount).toHaveBeenCalledWith('named-account');
  });

  it('keeps the single-call restore preamble serializable too', async () => {
    const raw = success(0, 'restored').result;
    const restored = rpc.parseRawSimulation({
      ...raw,
      id: '0',
      restorePreamble: { minResourceFee: '500', transactionData },
    });
    const server = { simulateTransaction: jest.fn().mockResolvedValue(restored) };
    jest.spyOn(client, 'getSorobanServer').mockReturnValue(server as unknown as rpc.Server);
    const result = await simulateContractCall(client, 'envelope');
    expect(result).toMatchObject({
      success: false,
      needsRestore: true,
      restorePreamble: { minResourceFee: '500', transactionData },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
