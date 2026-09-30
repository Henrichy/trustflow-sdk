import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import axios from 'axios';
import {
  Account,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { TrustFlowClient } from '../src/client';
import { createApiHttpClient } from '../src/utils/http';
import { TransactionPipeline } from '../src/tx-pipeline';

const CONTRACT_ID = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';
const source = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const contextManager = new AsyncLocalStorageContextManager();

function createProvider(exporter: InMemorySpanExporter): BasicTracerProvider {
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  return provider;
}

function buildTransaction(): Transaction {
  return new TransactionBuilder(new Account(source, '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(CONTRACT_ID).call('increment'))
    .setTimeout(30)
    .build();
}

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
  contextManager.disable();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('OpenTelemetry instrumentation', () => {
  it('uses the injected provider and records span lifecycle, attributes, and duration', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = createProvider(exporter);
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue({
      id: '1',
      latestLedger: 100,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: '1000',
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    });

    const client = new TrustFlowClient({ contractId: CONTRACT_ID, tracerProvider: provider });
    const result = await new TransactionPipeline(client).prepare(buildTransaction());

    expect(result.ok).toBe(true);
    const spans = exporter.getFinishedSpans();
    const prepare = spans.find((span) => span.name === 'trustflow.tx.prepare');
    const simulation = spans.find((span) => span.name === 'trustflow.rpc.simulate');

    expect(prepare).toBeDefined();
    expect(prepare?.status.code).toBe(SpanStatusCode.OK);
    expect(prepare?.attributes['stellar.network']).toBe('TESTNET');
    expect(typeof prepare?.attributes.duration_ms).toBe('number');
    expect(simulation?.parentSpanId).toBe(prepare?.spanContext().spanId);
    expect(simulation?.attributes['rpc.method']).toBe('simulateTransaction');

    await provider.shutdown();
  });

  it('marks failed stages with error metadata and error status', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = createProvider(exporter);
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue({
      id: '1',
      latestLedger: 100,
      events: [],
      _parsed: true,
      error: 'contract rejected simulation',
    });

    const client = new TrustFlowClient({ contractId: CONTRACT_ID, tracerProvider: provider });
    const result = await new TransactionPipeline(client).prepare(buildTransaction());

    expect(result.ok).toBe(false);
    const prepare = exporter
      .getFinishedSpans()
      .find((span) => span.name === 'trustflow.tx.prepare');
    expect(prepare?.status.code).toBe(SpanStatusCode.ERROR);
    expect(prepare?.attributes['error.type']).toBe('TrustFlowError');
    expect(String(prepare?.attributes['error.message'])).toContain('contract rejected simulation');
    expect(typeof prepare?.attributes.duration_ms).toBe('number');

    await provider.shutdown();
  });

  it('records signing and submit spans for a confirmed pipeline run', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = createProvider(exporter);
    const signer = Keypair.random();
    const signerAddress = signer.publicKey();
    jest
      .spyOn(rpc.Server.prototype, 'getAccount')
      .mockResolvedValue(new Account(signerAddress, '100'));
    jest.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue({
      id: '1',
      latestLedger: 100,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: '1000',
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    });
    jest.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue({
      status: 'PENDING',
      hash: 'deadbeef',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });
    jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 42,
    } as unknown as rpc.Api.GetTransactionResponse);

    const client = new TrustFlowClient({ contractId: CONTRACT_ID, tracerProvider: provider });
    const result = await new TransactionPipeline(client).run({
      sourceAccount: signerAddress,
      operations: [new Contract(CONTRACT_ID).call('increment')],
      fee: BASE_FEE,
      signers: [signer],
      submit: { pollIntervalMs: 1 },
    });

    expect(result.ok).toBe(true);
    const spans = exporter.getFinishedSpans();
    const signing = spans.find((span) => span.name === 'trustflow.tx.sign');
    const submit = spans.find((span) => span.name === 'trustflow.tx.submit');
    expect(signing?.status.code).toBe(SpanStatusCode.OK);
    expect(signing?.attributes['signer.count']).toBe(1);
    expect(submit?.status.code).toBe(SpanStatusCode.OK);
    expect(submit?.attributes['rpc.method']).toBe('sendTransaction');
    expect(submit?.attributes['transaction.hash']).toBe('deadbeef');
    expect(typeof submit?.attributes.duration_ms).toBe('number');

    await provider.shutdown();
  });

  it('propagates W3C traceparent to Horizon and backend HTTP requests', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = createProvider(exporter);
    const client = new TrustFlowClient({
      contractId: CONTRACT_ID,
      tracerProvider: provider,
      horizonServer: new Horizon.Server('https://horizon-testnet.stellar.org'),
    });
    const receivedTraceparents: string[] = [];
    const adapter = async (config: import('axios').InternalAxiosRequestConfig) => {
      const header = config.headers.get('traceparent');
      if (typeof header === 'string') receivedTraceparents.push(header);
      return { data: 'ok', status: 200, statusText: 'OK', headers: {}, config };
    };
    const backend = createApiHttpClient({ baseURL: 'https://api.trustflow.test' });
    backend.defaults.adapter = adapter;
    (client.getServer().httpClient as unknown as import('axios').AxiosInstance).defaults.adapter =
      adapter;

    await provider.getTracer('trace-test').startActiveSpan('parent', async (span) => {
      try {
        await Promise.all([backend.get('/trace'), client.getServer().httpClient.get('/trace')]);
      } finally {
        span.end();
      }
    });

    expect(receivedTraceparents).toHaveLength(2);
    expect(receivedTraceparents).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i),
      ]),
    );
    await provider.shutdown();
  });
});
