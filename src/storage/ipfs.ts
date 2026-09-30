import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { isValidCid } from './cid';
import { logger } from '../utils/logger';
import type { SDKResult } from '../types/index';
import { createApiHttpClient, toApiErrorMessage } from '../utils/http';
import type { ApiRetryConfig } from '../utils/http';
import type { HttpInterceptors } from '../utils/interceptors';
import { TrustFlowError } from '../errors';

/** Default upload endpoint — a raw-body IPFS upload API (e.g. web3.storage-compatible). */
const DEFAULT_IPFS_API_URL = 'https://api.web3.storage/upload';
/** Default read gateway used to build a browsable URL from a returned CID. */
const DEFAULT_IPFS_GATEWAY = 'https://w3s.link/ipfs';
/** Secondary default IPFS gateways for automatic resolution fallback. */
const DEFAULT_FALLBACK_GATEWAYS = [
  'https://ipfs.io/ipfs',
  'https://cloudflare-ipfs.com/ipfs',
  'https://dweb.link/ipfs',
];

export interface IPFSConfig {
  /** Upload endpoint. Defaults to a web3.storage-compatible raw-body upload API. */
  apiUrl?: string;
  /** Bearer token / API key for the upload service. */
  apiKey?: string;
  /** Primary read gateway used to build returned URLs and resolve CIDs. */
  gatewayUrl?: string;
  /** Secondary IPFS gateways used for automatic fallback if the primary gateway fails. */
  fallbackGateways?: string[];
  /** Complete ordered list of gateways to use for resolution (overrides gatewayUrl + fallbackGateways). */
  gateways?: string[];
  /** Request timeout in milliseconds. Defaults to 10s. */
  timeoutMs?: number;
  /**
   * Retry budget for upload requests. Defaults to 3 retries with a 250ms base
   * delay and a 2s cap.
   */
  retry?: ApiRetryConfig;
  /** Request/response interceptor hooks applied to upload calls. */
  interceptors?: HttpInterceptors;
}

export interface IPFSUploadOptions {
  /** Original filename, forwarded to the upload service when supported. */
  filename?: string;
  /** MIME type of the file. Defaults to `application/octet-stream`. */
  contentType?: string;
}

export interface IPFSUploadResult {
  /** Content identifier of the uploaded file. */
  cid: string;
  /** Gateway URL the uploaded file can be fetched from. */
  url: string;
}

export interface IPFSResolveOptions {
  /** Request timeout in milliseconds for gateway resolution. */
  timeoutMs?: number;
}

/**
 * IPFS storage helper — uploads files and resolves JSON metadata with automatic gateway fallback.
 */
export class IPFSStorage {
  private readonly gatewayUrl: string;
  private readonly gateways: string[];
  private readonly http: AxiosInstance;
  private readonly timeoutMs: number;

  constructor(config: IPFSConfig = {}) {
    this.gatewayUrl = config.gatewayUrl ?? DEFAULT_IPFS_GATEWAY;
    this.timeoutMs = config.timeoutMs ?? 10_000;

    if (config.gateways && config.gateways.length > 0) {
      this.gateways = [...config.gateways];
    } else {
      const secondaries = config.fallbackGateways ?? DEFAULT_FALLBACK_GATEWAYS;
      this.gateways = [this.gatewayUrl, ...secondaries.filter((g) => g !== this.gatewayUrl)];
    }

    this.http = createApiHttpClient({
      baseURL: config.apiUrl ?? DEFAULT_IPFS_API_URL,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      retry: config.retry,
      interceptors: config.interceptors,
    });
  }

  /**
   * Uploads a file to IPFS.
   */
  async upload(
    file: Buffer | Uint8Array | ArrayBuffer | Blob,
    options: IPFSUploadOptions = {},
  ): Promise<SDKResult<IPFSUploadResult>> {
    const isBlob = typeof Blob !== 'undefined' && file instanceof Blob;
    const size = isBlob
      ? (file as Blob).size
      : (file as Buffer | Uint8Array | ArrayBuffer)?.byteLength;
    if (!file || !size) {
      return {
        ok: false,
        error: 'file must be a non-empty Buffer, Uint8Array, ArrayBuffer, Blob or File',
      };
    }

    const filename = options.filename ?? (isBlob ? (file as File).name : undefined);
    const contentType =
      options.contentType || (isBlob ? (file as Blob).type : '') || 'application/octet-stream';

    logger.debug('Uploading file to IPFS', { size, filename, contentType });
    try {
      const body = isBlob
        ? new Uint8Array(await (file as Blob).arrayBuffer())
        : file instanceof ArrayBuffer
          ? new Uint8Array(file)
          : file;
      const response = await this.http.post<{ cid?: string }>('', body, {
        headers: {
          'Content-Type': contentType,
          ...(filename ? { 'X-Name': filename } : {}),
        },
      });
      const cid = response.data?.cid;
      if (!cid || typeof cid !== 'string' || cid.trim() === '') {
        logger.warn('IPFS upload returned invalid or missing CID', { cid });
        return { ok: false, error: 'Upload succeeded but response did not include a valid CID' };
      }
      logger.info('IPFS upload succeeded', { cid });
      return { ok: true, data: { cid, url: `${this.gatewayUrl}/${cid}` } };
    } catch (err) {
      logger.error('IPFS upload failed', { error: toApiErrorMessage(err) });
      return { ok: false, error: toApiErrorMessage(err) };
    }
  }

  /**
   * Resolves content from IPFS gateways by CID with automatic secondary gateway fallback.
   *
   * Handles empty 200 OK bodies, HTML error pages, invalid JSON, and network errors gracefully
   * by trying fallback gateways in order.
   *
   * @param cid - CID to resolve
   * @param options - Optional timeout override
   * @returns Parsed JSON content as type T
   * @throws {TrustFlowError} `STORAGE_GATEWAY_ERROR` when all gateways fail, or `VALIDATION_ERROR` for invalid CID.
   */
  async resolve<T = unknown>(cid: string, options: IPFSResolveOptions = {}): Promise<T> {
    if (!cid || typeof cid !== 'string' || !isValidCid(cid)) {
      throw TrustFlowError.validation('cid', `Invalid CID: "${cid}"`);
    }

    const errors: string[] = [];
    const timeout = options.timeoutMs ?? this.timeoutMs;

    for (const gateway of this.gateways) {
      const cleanGateway = gateway.replace(/\/+$/, '');
      const baseUrl = cleanGateway.includes('/ipfs') ? cleanGateway : `${cleanGateway}/ipfs`;
      const url = `${baseUrl}/${cid}`;
      try {
        logger.debug('Resolving IPFS CID from gateway', { gateway: cleanGateway, cid });
        const response = await axios.get(url, {
          timeout,
          responseType: 'text',
          transformResponse: [(d) => d],
          validateStatus: (status) => status >= 200 && status < 300,
        });

        const contentType = String(response.headers?.['content-type'] ?? '').toLowerCase();
        const rawBody = response.data;

        // Verify content-type is not HTML
        if (contentType.includes('text/html')) {
          const err = `Gateway ${cleanGateway} returned HTML instead of JSON`;
          logger.warn(err, { cid });
          errors.push(err);
          continue;
        }

        // Verify body length / non-empty
        if (
          rawBody === undefined ||
          rawBody === null ||
          (typeof rawBody === 'string' && rawBody.trim().length === 0)
        ) {
          const err = `Gateway ${cleanGateway} returned an empty body`;
          logger.warn(err, { cid });
          errors.push(err);
          continue;
        }

        // Parse JSON
        try {
          const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
          if (parsed === undefined || parsed === null) {
            const err = `Gateway ${cleanGateway} parsed JSON returned null/undefined`;
            logger.warn(err, { cid });
            errors.push(err);
            continue;
          }
          logger.info('Resolved IPFS content successfully', { gateway: cleanGateway, cid });
          return parsed as T;
        } catch (parseError: any) {
          const err = `Gateway ${cleanGateway} returned invalid JSON: ${parseError.message}`;
          logger.warn(err, { cid });
          errors.push(err);
          continue;
        }
      } catch (reqError: any) {
        const err = `Gateway ${cleanGateway} request failed: ${reqError?.message || String(reqError)}`;
        logger.warn(err, { cid });
        errors.push(err);
        continue;
      }
    }

    logger.error('All IPFS gateways failed to resolve CID', { cid, errors });
    throw new TrustFlowError(
      `Failed to resolve IPFS CID "${cid}" from gateways. Errors: ${errors.join('; ')}`,
      'STORAGE_GATEWAY_ERROR',
    );
  }
}
