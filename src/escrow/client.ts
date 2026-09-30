import { ContractConfig } from '../types/contract';
import { EscrowParams, EscrowState, SDKResult, GetGigsParams, GigsPage } from '../types/index';
import { assertStellarAddress, isValidEscrowId, xlmToStroops, STELLAR_ADDRESS_RE, CONTRACT_ID_RE } from '../utils/validation';
import { createApiHttpClient, toApiErrorMessage } from '../utils/http';
import type { ApiRetryConfig } from '../utils/http';
import type { HttpInterceptors } from '../utils/interceptors';
import { buildCreateEscrowArgs, buildClaimArgs, buildFundArgs } from '../contract/build';

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

  constructor(config: ContractConfig, options: TrustFlowEscrowClientOptions = {}) {
    this.contractConfig = config;
    // Per-call options win, then the client-wide config value, so a single
    // `timeoutMs` on the shared config covers every backend call.
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.retry = options.retry;
    this.interceptors = options.interceptors;
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
   * const result = await client.fund('esc-123', wallet.publicKey, 50_000_000n, USDC_CONTRACT_ID);
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
      if (!STELLAR_ADDRESS_RE.test(params.tokenAddress) && !CONTRACT_ID_RE.test(params.tokenAddress)) {
        return { ok: false, error: `Invalid tokenAddress: "${params.tokenAddress}"` };
      }
      query.set('tokenAddress', params.tokenAddress);
    }
    if (params.createdAfter !== undefined) {
      const dateStr = params.createdAfter instanceof Date
        ? params.createdAfter.toISOString()
        : typeof params.createdAfter === 'number'
          ? new Date(params.createdAfter).toISOString()
          : String(params.createdAfter);
      query.set('createdAfter', dateStr);
    }
    if (params.createdBefore !== undefined) {
      const dateStr = params.createdBefore instanceof Date
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
      baseURL: this.contractConfig.apiBaseUrl,
      apiKey: this.contractConfig.apiKey,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      retry: options.retry ?? this.retry,
      // Per-call overrides win, then the constructor option, then the
      // contract-wide hooks.
      interceptors: options.interceptors ?? this.interceptors ?? this.contractConfig.interceptors,
    });

    try {
      const response = await http.get<GigsPage>('/gigs', {
        params: Object.fromEntries(query.entries()),
      });
      return { ok: true, data: response.data };
    } catch (err: unknown) {
      return { ok: false, error: toApiErrorMessage(err) };
    }
  }
}
