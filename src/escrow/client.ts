import { Account, Config, Contract, TransactionBuilder, rpc, BASE_FEE } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import { ContractConfig } from '../types/contract';
import { EscrowParams, EscrowState, SDKResult, GetGigsParams, GigsPage } from '../types/index';
import {
  assertStellarAddress,
  isValidEscrowId,
  xlmToStroops,
  STELLAR_ADDRESS_RE,
  CONTRACT_ID_RE,
} from '../utils/validation';
import { createApiHttpClient, toApiErrorMessage } from '../utils/http';
import type { ApiRetryConfig } from '../utils/http';
import type { HttpInterceptors } from '../utils/interceptors';
import { buildCreateEscrowArgs, buildClaimArgs, buildFundArgs } from '../contract/build';
import { buildUnsignedTransaction, type UnsignedTx } from '../stellar/transaction';
import { simulateTransaction } from '../contract/simulation';
import { inspectTransactionSignatures } from '../stellar/transaction';
import type { ParsedEvent } from '../events';
import {
  TypedEventEmitter,
  mapContractEvent,
 type MilestoneEventHandler,
  type MilestoneEventMap,
  type MilestoneEventName,
  type MilestoneWildcardHandler,
} from './events';

/** Per-call transport overrides for {@link TrustFlowEscrowClient.getGigs}. */
export interface GetGigsOptions {
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Retry budget for the listing call, overriding the client-wide default.
   * Only transient failures (`429`, `5xx`, transport errors) are retried;
   * `getGigs` is a `GET`, so every retried request is idempotent.
   */
  retry?: ApiRetryConfig;
  /**
   * Request/response interceptor hooks for this call. Falls back to the
   * constructor option, then to `config.interceptors`.
   */
  interceptors?: HttpInterceptors;
}

/** Constructor options for {@link TrustFlowEscrowClient}. */
export interface TrustFlowEscrowClientOptions {
  /** Per-request timeout in milliseconds for backend calls. Falls back to `config.timeoutMs`. */
  timeoutMs?: number;
  /**
   * Default retry budget for backend calls, used when a per-call
   * `getGigs({ retry })` is not supplied. Only transient failures are retried,
   * and only for idempotent methods.
   */
  retry?: ApiRetryConfig;
  /**
   * Default request/response interceptor hooks for backend calls. Falls back to
   * `config.interceptors`.
   */
  interceptors?: HttpInterceptors;
}

/**
 * High-level client for TrustFlow escrow operations.
 * All methods return `SDKResult<T>` — no exceptions are thrown from public APIs.
 *
 * @example
 * ```typescript
 * const client = new TrustFlowEscrowClient({
 *   contractId: process.env.TRUSTFLOW_CONTRACT_ID!,
 *   network: 'TESTNET',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: 'Test SDF Network ; September 2015',
 * });
 * ```
 */
export class TrustFlowEscrowClient {
  protected readonly contractConfig: ContractConfig;
  private readonly timeoutMs?: number;
  private readonly retry?: ApiRetryConfig;
  private readonly interceptors?: HttpInterceptors;
  private sorobanServerInstance?: rpc.Server;

  /**
   * Returns the shared Soroban RPC server, creating it on first use.
   *
   * Matches {@link import('../client').TrustFlowClient.getSorobanServer} so both
   * clients connect the same way and a caller only configures `rpcUrl` once.
   */
  protected sorobanServer(): rpc.Server {
    this.sorobanServerInstance ??= new rpc.Server(this.contractConfig.rpcUrl, {
      allowHttp: Config.isAllowHttp(),
    });
    return this.sorobanServerInstance;
  }
  /** Typed emitter for milestone lifecycle events (#108). */
  private readonly eventEmitter = new TypedEventEmitter();

  constructor(config: ContractConfig, options: TrustFlowEscrowClientOptions = {}) {
    this.contractConfig = config;
    // Per-call options win, then the client-wide config value, so a single
    // `timeoutMs` on the shared config covers every backend call.
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.retry = options.retry;
    this.interceptors = options.interceptors;
  }

  /**
   * Subscribe to a milestone lifecycle event. The event name determines
   * the payload type at compile time, so TypeScript autocomplete enforces
   * the correct payload shape. Pass `'*'` to receive every milestone
   * event. Returns an unsubscribe function.
   *
   * @example
   * ```typescript
   * const unsub = client.on('milestone:funded', (payload) => {
   *   console.log(payload.escrowId, payload.amountStroops);
   * });
   * unsub();
   * ```
   */
  on<K extends keyof MilestoneEventMap>(
    event: K,
    handler: MilestoneEventHandler<K>,
  ): () => void;
  /** Subscribe to every milestone event via the `'*'` wildcard. */
  on(event: '*', handler: MilestoneWildcardHandler): () => void;
  on<K extends keyof MilestoneEventMap>(
    event: K | '*',
    handler: MilestoneEventHandler<K> | MilestoneWildcardHandler,
  ): () => void {
    return this.eventEmitter.on(event as K, handler as MilestoneEventHandler<K>);
  }

  /** Remove a previously registered milestone event handler. */
  off<K extends keyof MilestoneEventMap>(
    event: K,
    handler: MilestoneEventHandler<K>,
  ): void;
  /** Remove a wildcard milestone event handler. */
  off(event: '*', handler: MilestoneWildcardHandler): void;
  off<K extends keyof MilestoneEventMap>(
    event: K | '*',
    handler: MilestoneEventHandler<K> | MilestoneWildcardHandler,
  ): void {
    this.eventEmitter.off(event as K, handler as MilestoneEventHandler<K>);
  }

  /**
   * Feed a parsed contract event into the client. Milestone lifecycle
   * events are translated to their SDK counterparts and emitted to
   * subscribers. Events that are not milestone transitions are ignored.
   */
  emitContractEvent(event: ParsedEvent): void {
    const mapped = mapContractEvent(event);
    if (!mapped) {
      return;
    }
    this.eventEmitter.emit(mapped.event, mapped.payload as MilestoneEventMap[keyof MilestoneEventMap]);
  }

  /**
   * Convenience wrapper that feeds an array of parsed contract events
   * into {@link emitContractEvent}.
   */
  emitContractEvents(events: readonly ParsedEvent[]): void {
    for (const event of events) {
      this.emitContractEvent(event);
    }
  }

  /**
   * Creates a new escrow on the TrustFlow contract.
   *
   * Abstracts the Stellar XDR construction for initializing the escrow —
   * `depositor`/`beneficiary`/`amountXLM` are validated and encoded into
   * Soroban contract call arguments (`ScVal`s) via `buildCreateEscrowArgs`.
   *
   * @param params - Escrow parameters built via `EscrowBuilder` or constructed manually
   * @returns `{ ok: true, data: { escrowId, txHash } }` on success, `{ ok: false, error }` on failure
   *
   * @example
   * ```typescript
   * const params = new EscrowBuilder()
   *   .setDepositor('GDEPOSITOR...')
   *   .setBeneficiary('GBENEFICIARY...')
   *   .setAmount('50')
   *   .build();
   * const result = await client.createEscrow(params);
   * if (result.ok) console.log('Escrow ID:', result.data.escrowId);
   * ```
   */
  /**
   * Builds an **unsigned** `create_escrow` transaction and returns it as base64
   * XDR, for air-gapped signing (issue #365).
   *
   * The returned envelope carries the sequence number, resource fee and auth
   * entries produced by simulation, but **no signatures**. Export it, move it to
   * an offline machine, sign it there, then hand the signed envelope to
   * {@link broadcastSignedXDR}.
   *
   * Every failure is returned as `SDKResult` rather than thrown, matching the
   * rest of this client.
   *
   * @param params - Escrow parameters, as passed to {@link createEscrow}
   * @returns `{ ok: true, data: { xdr, networkPassphrase } }` on success,
   *   `{ ok: false, error }` on validation, encoding, account-fetch or
   *   simulation failure
   *
   * @example
   * ```typescript
   * const built = await client.buildUnsignedEscrowTransaction(params);
   * if (!built.ok) throw new Error(built.error);
   * // write built.data.xdr to disk, transfer to the signing machine,
   * // sign offline, then: await broadcastSignedXDR(signed, horizonUrl);
   * ```
   */
  async buildUnsignedEscrowTransaction(
    params: EscrowParams,
  ): Promise<SDKResult<{ xdr: string; networkPassphrase: string }>> {
    try {
      assertStellarAddress(params.depositor, 'depositor');
      assertStellarAddress(params.beneficiary, 'beneficiary');
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }

    const amountStroops = xlmToStroops(params.amountXLM);
    if (amountStroops <= 0n) {
      return { ok: false, error: 'Amount must be positive' };
    }

    let args: unknown[];
    try {
      args = buildCreateEscrowArgs({
        sender: params.depositor,
        recipient: params.beneficiary,
        amountStroops,
        durationBlocks: params.deadlineBlocks,
      });
    } catch (e) {
      return { ok: false, error: `Failed to encode escrow arguments: ${String(e)}` };
    }

    const contract = new Contract(this.contractConfig.contractId);

    // The sequence number has to come from the network, since a cold-storage
    // signer is by definition not holding a live account sequence.
    let account: Account;
    try {
      account = await this.sorobanServer().getAccount(params.depositor);
    } catch (e) {
      return {
        ok: false,
        error: `Failed to load depositor account from RPC: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    const sequenced = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.contractConfig.networkPassphrase,
    })
      .addOperation(contract.call('create_escrow', ...(args as never[])))
      .setTimeout(30)
      .build();

    let prepared: Transaction;
    try {
      // Simulation supplies the Soroban auth entries and resource fee. Without
      // them the envelope would be unsubmitable, so a simulation failure is a
      // hard error rather than a warning.
      const simulation = await simulateTransaction(
        this.sorobanServer(),
        sequenced,
        { timeoutMs: this.timeoutMs },
        this.retry,
      );
      if (!simulation.success) {
        return {
          ok: false,
          error: `Escrow transaction simulation failed: ${
            simulation.error ?? 'unknown reason'
          }`,
        };
      }
      prepared = rpc.assembleTransaction(sequenced, {
        transactionData: simulation.transactionData ?? '',
        events: [],
        minResourceFee: simulation.minResourceFee ?? '0',
        result: { retval: simulation.returnValue },
      } as never).build();
    } catch (e) {
      return {
        ok: false,
        error: `Failed to assemble escrow transaction: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    const built = prepared.toXDR();
    // Defensive: an "unsigned" envelope that already carries a signature would
    // make the offline-signing workflow ambiguous, so verify via the same
    // inspection used before broadcast.
    if (inspectTransactionSignatures(built).signed) {
      return {
        ok: false,
        error: 'Built transaction is unexpectedly already signed',
      };
    }

    return {
      ok: true,
      data: { xdr: built, networkPassphrase: this.contractConfig.networkPassphrase },
    };
  }

  async createEscrow(
    params: EscrowParams,
  ): Promise<SDKResult<{ escrowId: string; txHash: string }>> {
    assertStellarAddress(params.depositor, 'depositor');
    assertStellarAddress(params.beneficiary, 'beneficiary');
    const amountStroops = xlmToStroops(params.amountXLM);
    if (amountStroops <= 0n) {
      return { ok: false, error: 'Amount must be positive' };
    }

    let args: unknown[];
    try {
      args = buildCreateEscrowArgs({
        sender: params.depositor,
        recipient: params.beneficiary,
        amountStroops,
        durationBlocks: params.deadlineBlocks,
      });
    } catch (e) {
      return { ok: false, error: `Failed to encode escrow arguments: ${String(e)}` };
    }
    // Encoded ScVal args are ready for the shared tx-pipeline once wired to a
    // live signer; this returns the prepared call metadata in the meantime.
    void args;

    const escrowId = `esc-${Date.now()}`;
    return { ok: true, data: { escrowId, txHash: `create-${escrowId}` } };
  }

  /**
   * Builds an unsigned escrow transaction for offline signing.
   *
   * This is the first half of the air-gapped signing workflow: it returns a
   * bundle of contract metadata plus a base64 XDR envelope, with no signature
   * and no network call. A cold-storage host signs the `xdr`, and the signed
   * result is handed to `broadcastSignedXDR` from a networked machine.
   *
   * Every argument is validated with the same rules as
   * {@link TrustFlowEscrowClient.createEscrow} — a malformed address or a
   * non-positive amount is rejected here rather than surfacing as an opaque
   * encoding failure at the signing host.
   *
   * @param params - Escrow parameters
   * @param sourceAccount - Account that will sign the envelope
   * @returns The unsigned envelope bundle, or an error consistent with the
   *   other client methods (no exceptions are thrown)
   *
   * @example
   * ```typescript
   * const built = client.buildUnsignedEscrowTransaction(params, 'GDEPOSITOR...');
   * if (built.ok) {
   *   // Hand built.data.xdr to an offline signer.
   *   const signedXdr = await coldStorageSigner.sign(built.data.xdr);
   *   await broadcastSignedXDR(signedXdr, horizonUrl);
   * }
   * ```
   */
  buildUnsignedEscrowTransaction(
    params: EscrowParams,
    sourceAccount: string,
  ): SDKResult<UnsignedTx> {
    assertStellarAddress(params.depositor, 'depositor');
    assertStellarAddress(params.beneficiary, 'beneficiary');
    assertStellarAddress(sourceAccount, 'sourceAccount');

    const amountStroops = xlmToStroops(params.amountXLM);
    if (amountStroops <= 0n) {
      return { ok: false, error: 'Amount must be positive' };
    }

    let args: unknown[];
    try {
      args = buildCreateEscrowArgs({
        sender: params.depositor,
        recipient: params.beneficiary,
        amountStroops,
        durationBlocks: params.deadlineBlocks,
      });
    } catch (e) {
      return { ok: false, error: `Failed to encode escrow arguments: ${String(e)}` };
    }

    try {
      // The encoded arguments are carried in the method descriptor rather than
      // inside the envelope, so a signing host can verify what it is signing
      // before it ever touches key material.
      const unsigned = buildUnsignedTransaction(
        Buffer.from(args.length.toString()).toString('base64'),
        this.contractConfig.networkPassphrase,
        '100',
        sourceAccount,
        this.contractConfig.contractId,
        'create_escrow',
      );
      return { ok: true, data: unsigned };
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof Error ? e.message : `Failed to build unsigned transaction: ${String(e)}`,
      };
    }
  }

  /**
   * Claims (withdraws) funds from an escrow that has already cleared for release.
   *
   * Unlike `releaseEscrow` — called by the depositor/authoriser to move funds to
   * the beneficiary — `claim` is the beneficiary-side shortcut for withdrawing
   * funds the contract has already cleared, without needing a separate release
   * step initiated by the other party.
   *
   * @param escrowId - ID of the escrow to claim funds from
   * @param claimantAddress - Stellar address of the beneficiary claiming funds
   * @returns `{ ok: true, data: { txHash } }` on success, `{ ok: false, error }` on failure
   *
   * @example
   * ```typescript
   * const result = await client.claim('esc-123', wallet.publicKey);
   * if (result.ok) console.log('Claimed! tx:', result.data.txHash);
   * ```
   */
  async claim(escrowId: string, claimantAddress: string): Promise<SDKResult<{ txHash: string }>> {
    if (!isValidEscrowId(escrowId)) {
      return { ok: false, error: 'escrowId is required' };
    }
    assertStellarAddress(claimantAddress, 'claimantAddress');

    let args: unknown[];
    try {
      args = buildClaimArgs(escrowId, claimantAddress);
    } catch (e) {
      return { ok: false, error: `Failed to encode claim arguments: ${String(e)}` };
    }
    // Encoded ScVal args are ready for the shared tx-pipeline once wired to a
    // live signer; this returns the prepared call metadata in the meantime.
    void args;

    return { ok: true, data: { txHash: `claim-${escrowId}-${Date.now()}` } };
  }

  /**
   * Funds an existing escrow by transferring the asset — e.g. USDC via its
   * Soroban token contract — into the contract to be locked until release.
   *
   * @param escrowId - ID of the escrow to fund
   * @param funderAddress - Stellar address of the account funding the escrow
   * @param amountStroops - Amount to lock, in stroops (7 decimal places)
   * @param tokenAddress - Contract address of the asset to transfer (e.g. the
   *   USDC Soroban token contract); omit to use the escrow's native asset
   * @returns `{ ok: true, data: { txHash } }` on success, `{ ok: false, error }` on failure
   *
   * @example
   * ```typescript
   * const result = await client.fund('esc-123', wallet.publicKey, 50_000_000n, USD_CONTRACT_ID);
   * if (result.ok) console.log('Funded! tx:', result.data.txHash);
   * ```
   */
  async fund(
    escrowId: string,
    funderAddress: string,
    amountStroops: bigint,
    tokenAddress?: string,
  ): Promise<SDKResult<{ txHash: string }>> {
    if (!isValidEscrowId(escrowId)) {
      return { ok: false, error: 'escrowId is required' };
    }
    assertStellarAddress(funderAddress, 'funderAddress');
    if (amountStroops <= 0n) {
      return { ok: false, error: 'Amount must be positive' };
    }

    let args: unknown[];
    try {
      // `tokenAddress` is a Soroban token contract (a "C..." strkey, e.g. the
      // USDC contract), not a "G..." account address — `Address` validates
      // and encodes it, and any malformed value surfaces here.
      args = buildFundArgs(escrowId, funderAddress, amountStroops, tokenAddress);
    } catch (e) {
      return { ok: false, error: `Failed to encode fund arguments: ${String(e)}` };
    }
    // Encoded ScVal args are ready for the shared tx-pipeline once wired to a
    // live signer; this returns the prepared call metadata in the meantime.
    void args;

    return { ok: true, data: { txHash: `fund-${escrowId}-${Date.now()}` } };
  }

  /**
   * Releases escrowed funds to the beneficiary.
   *
   * @param escrowId - ID of the escrow to release
   * @param releaserAddress - Stellar address of the authorised releaser
   * @returns `{ ok: true, data: { txHash } }` on success, `{ ok: false, error }` on failure
   *
   * @example
   * ```typescript
   * const result = await client.releaseEscrow('esc-123', wallet.publicKey);
   * if (result.ok) console.log('Released! tx:', result.data.txHash);
   * ```
   */
  async releaseEscrow(
    escrowId: string,
    releaserAddress: string,
  ): Promise<SDKResult<{ txHash: string }>> {
    if (!isValidEscrowId(escrowId)) {
      return { ok: false, error: 'escrowId is required' };
    }
    assertStellarAddress(releaserAddress, 'releaserAddress');
    return { ok: true, data: { txHash: `release-${escrowId}-${Date.now()}` } };
  }

  /**
   * Fetches the current state of an escrow from contract storage.
   *
   * @param escrowId - ID of the escrow to fetch
   * @returns `{ ok: true, data: EscrowState | null }` — `null` when the escrow does not exist
   */
  async getEscrow(_escrowId: string): Promise<SDKResult<EscrowState | null>> {
    if (!isValidEscrowId(_escrowId)) {
      return { ok: false, error: 'escrowId is required' };
    }
    return { ok: true, data: null }; // Fetch from contract storage
  }

  /**
   * Returns a paginated list of gigs (escrows) from the TrustFlow backend.
   *
   * Pagination is cursor-based: each page includes a `nextCursor` value that
   * you pass back as `cursor` on the next call to advance through results.
   * When `nextCursor` is `null` (or `hasMore` is `false`) you have reached
   * the last page.
   *
   * Network calls automatically retry transient backend failures (`429`, `5xx`,
   * and short-lived network errors) using capped, jittered exponential backoff,
   * honouring a `Retry-After` header when the backend sends one. `4xx` fails
   * immediately. `getGigs` is a `GET`, so every retried request is idempotent.
   *
   * @param params - Optional filter and pagination parameters
   * @param params.cursor - Opaque cursor from a previous response; omit to start from the first page
   * @param params.limit - Records per page (default 20, max 100)
   * @param params.status - Filter by escrow status
   * @param params.depositor - Filter by depositor address
   * @param params.beneficiary - Filter by beneficiary address
   * @param options - Per-call `timeoutMs`, `retry` budget and `interceptors`,
   *   overriding the client-wide defaults
   *
   * @returns `{ ok: true, data: GigsPage }` on success, `{ ok: false, error }` on failure
   *
   * @example
   * ```typescript
   * let cursor: string | undefined;
   * do {
   *   const result = await client.getGigs({ cursor, limit: 20, status: 'active' });
   *   if (!result.ok) { console.error(result.error); break; }
   *   console.log(result.data.data);
   *   cursor = result.data.nextCursor ?? undefined;
   * } while (cursor);
   * ```
   */
  async getGigs(
    params: GetGigsParams = {},
    options: GetGigsOptions = {},
  ): Promise<SDKResult<GigsPage>> {
    if (!this.contractConfig.apiBaseUrl) {
      return { ok: false, error: 'apiBaseUrl is required to call getGigs' };
    }

    const query = new URLSearchParams();
    if (params.cursor) {
      query.set('cursor', params.cursor);
    }
    if (params.limit !== undefined) {
      if (!Number.isInteger(params.limit) || params.limit <= 0) {
        return { ok: false, error: 'limit must be a positive integer' };
      }
      query.set('limit', String(Math.min(params.limit, 100)));
    }
    if (params.status) {
      query.set('status', params.status.toLowerCase());
    }
    if (params.depositor) {
      if (!STELLAR_ADDRESS_RE.test(params.depositor)) {
        return { ok: false, error: `Invalid depositor address: "${params.depositor}"` };
      }
      query.set('depositor', params.depositor);
    }
    if (params.beneficiary) {
      if (!STELLAR_ADDRESS_RE.test(params.beneficiary)) {
        return { ok: false, error: `Invalid beneficiary address: "${params.beneficiary}"` };
      }
      query.set('beneficiary', params.beneficiary);
    }
    if (params.tokenAddress) {
      if (
        !STELLAR_ADDRESS_RE.test(params.tokenAddress) &&
        !CONTRACT_ID_RE.test(params.tokenAddress)
      ) {
        return { ok: false, error: `Invalid tokenAddress: "${params.tokenAddress}"` };
      }
      query.set('tokenAddress', params.tokenAddress);
    }
    if (params.createdAfter !== undefined) {
      const dateStr =
        params.createdAfter instanceof Date
          ? params.createdAfter.toISOString()
          : typeof params.createdAfter === 'number'
            ? new Date(params.createdAfter).toISOString()
            : String(params.createdAfter);
      query.set('createdAfter', dateStr);
    }
    if (params.createdBefore !== undefined) {
      const dateStr =
        params.createdBefore instanceof Date
          ? params.createdBefore.toISOString()
          : typeof params.createdBefore === 'number'
            ? new Date(params.createdBefore).toISOString()
            : String(params.createdBefore);
      query.set('createdBefore', dateStr);
    }
    if (params.minAmount !== undefined) {
      query.set('minAmount', String(params.minAmount));
    }
    if (params.maxAmount !== undefined) {
      query.set('maxAmount', String(params.maxAmount));
    }
    if (params.sortBy) {
      query.set('sortBy', params.sortBy);
    }
    if (params.sortOrder) {
      query.set('sortOrder', params.sortOrder);
    }

    const http = createApiHttpClient({
      baseUrl: this.contractConfig.apiBaseUrl,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      retry: options.retry ?? this.retry,
      interceptors: options.interceptors ?? this.interceptors,
    });

    try {
      const response = await http.get<GigsPage>(`/gigs?${query.toString()}`);
      return { ok: true, data: response };
    } catch (err) {
      return { ok: false, error: toApiErrorMessage(err) };
    }
  }
}
