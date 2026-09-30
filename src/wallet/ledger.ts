import { Keypair, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import type Transport from '@ledgerhq/hw-transport';
import type Str from '@ledgerhq/hw-app-str';
import { TrustFlowError } from '../errors';
import { NETWORK_CONFIGS } from '../stellar/network';
import type { Network } from '../types';
import type { WalletConnection, WalletProvider } from './types';
import { isWalletRejection } from './types';

/** Configuration for a Ledger Stellar account and its transaction network. */
export interface LedgerWalletOptions {
  /** Hardened Stellar BIP-44 account index (default: 0). */
  accountIndex?: number;
  /** SDK network name (default: TESTNET). Ledger itself has no network setting. */
  network?: Network;
  /** Exact passphrase for a custom network; used instead of the network default. */
  networkPassphrase?: string;
  /** Optional transport factory for tests or an alternative Ledger transport. */
  transportFactory?: () => Promise<Transport>;
}

/**
 * Stellar hardware wallet provider using Ledger's WebHID transport.
 * Transaction signing sends the full signature base for review on the device;
 * it never falls back to blind hash signing or submits a transaction.
 *
 * @example
 * ```typescript
 * const ledger = new LedgerWalletProvider({ network: 'TESTNET' });
 * // Call connect() from a button click, then approve the address on the device.
 * const connection = await ledger.connect();
 * const signedXdr = await ledger.sign(unsignedXdr, connection.network);
 * await ledger.disconnect();
 * ```
 */
export class LedgerWalletProvider implements WalletProvider {
  readonly type = 'ledger' as const;
  private readonly path: string;
  private readonly network: Network;
  private readonly passphrase: string;
  private readonly transportFactory?: () => Promise<Transport>;
  private transport?: Transport;
  private app?: Str;
  private publicKey?: string;
  private busy = false;
  private disconnected = false;

  /**
   * Configures the account without requesting device access.
   * @param options - Account, network and optional transport configuration
   * @throws {TrustFlowError} INVALID_CONFIG for an invalid account or network
   */
  constructor(options: LedgerWalletOptions = {}) {
    const index = options.accountIndex ?? 0;
    if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
      throw new TrustFlowError(
        'Ledger accountIndex must be an integer from 0 to 2147483647',
        'INVALID_CONFIG',
      );
    }
    this.path = `44'/148'/${index}'`;
    this.network = options.network ?? 'TESTNET';
    const config = NETWORK_CONFIGS[this.network];
    if (!config || (options.networkPassphrase !== undefined && !options.networkPassphrase.trim())) {
      throw new TrustFlowError('Invalid Ledger network configuration', 'INVALID_CONFIG');
    }
    this.passphrase = options.networkPassphrase ?? config.passphrase;
    this.transportFactory = options.transportFactory;
  }

  /** @returns Whether WebHID is available in a secure browser context, or a custom transport is configured. */
  async isAvailable(): Promise<boolean> {
    return (
      !!this.transportFactory ||
      (typeof window !== 'undefined' &&
        window.isSecureContext === true &&
        typeof navigator !== 'undefined' &&
        'hid' in navigator &&
        navigator.hid != null)
    );
  }

  /**
   * Opens a Ledger and asks the user to confirm the derived address on-device.
   * Call from a browser user gesture with the device unlocked and Stellar app open.
   * @returns The confirmed public key and configured SDK network
   * @throws {TrustFlowError} UNSUPPORTED_ENVIRONMENT, USER_REJECTED or CONNECTION_ERROR
   */
  async connect(): Promise<WalletConnection> {
    return this.exclusive(async () => {
      if (this.publicKey) return this.connection();
      if (!(await this.isAvailable())) {
        throw new TrustFlowError(
          'Ledger requires WebHID in a secure Chrome, Brave or Edge context',
          'UNSUPPORTED_ENVIRONMENT',
        );
      }
      try {
        await this.closeTransport();
        // LedgerJS uses a global Buffer internally. Install its browser implementation
        // only when Ledger is used, leaving ordinary SDK imports SSR-safe.
        if (typeof globalThis.Buffer === 'undefined') {
          const { Buffer: BrowserBuffer } = await import('buffer/');
          Reflect.set(globalThis, 'Buffer', BrowserBuffer);
        }
        const { default: StellarApp } = await import('@ledgerhq/hw-app-str');
        const transport = this.transportFactory
          ? await this.transportFactory()
          : await (await import('@ledgerhq/hw-transport-webhid')).default.create();
        this.transport = transport;
        this.disconnected = false;
        transport.on('disconnect', this.onDisconnect);
        const app = new StellarApp(transport);
        const { rawPublicKey } = await app.getPublicKey(this.path, true);
        if (this.transport !== transport || this.disconnected) {
          throw new TrustFlowError('Ledger disconnected during connection', 'NOT_CONNECTED');
        }
        if (rawPublicKey.length !== 32) throw new Error('Ledger returned an invalid public key');
        this.publicKey = StrKey.encodeEd25519PublicKey(rawPublicKey);
        this.app = app;
        return this.connection();
      } catch (error) {
        await this.closeTransport().catch(() => undefined);
        throw ledgerError(error, 'CONNECTION_ERROR');
      }
    });
  }

  /**
   * Sends a transaction for device review and returns its signed envelope.
   * Existing signatures are preserved and the new signature is verified locally.
   * @param xdr - Base64 Stellar transaction envelope
   * @param network - Configured SDK network name or exact network passphrase
   * @returns Base64 envelope with the Ledger signature attached
   * @throws {TrustFlowError} NOT_CONNECTED, VALIDATION_ERROR, USER_REJECTED or SIGNING_ERROR
   */
  async sign(xdr: string, network: string): Promise<string> {
    return this.exclusive(async () => {
      const { app, publicKey } = this.requireConnection();
      if (network !== this.network && network !== this.passphrase) {
        throw TrustFlowError.signingFailed(
          'Ledger signing network does not match the configured network',
        );
      }
      let transaction;
      try {
        transaction = TransactionBuilder.fromXDR(xdr, this.passphrase);
      } catch (error) {
        throw new TrustFlowError('Invalid Stellar transaction envelope', 'VALIDATION_ERROR', error);
      }
      try {
        const { signature } = await app.signTransaction(this.path, transaction.signatureBase());
        this.verifySignature(app, publicKey, transaction.hash(), signature);
        transaction.addSignature(publicKey, signature.toString('base64'));
        return transaction.toXDR();
      } catch (error) {
        throw ledgerError(error, 'SIGNING_ERROR');
      }
    });
  }

  /**
   * Reports that Ledger's SEP-53 message signatures cannot satisfy the adapter's
   * raw UTF-8 signature contract. No device request is made.
   * @param _message - Message requested by the adapter caller
   * @returns Always rejects; raw message signing is unavailable
   * @throws {TrustFlowError} NOT_CONNECTED or SIGNING_ERROR
   */
  async signMessage(_message: string): Promise<string> {
    return this.exclusive(async () => {
      this.requireConnection();
      throw TrustFlowError.signingFailed(
        'Ledger uses SEP-53 message signatures; raw UTF-8 message signing is not supported',
      );
    });
  }

  /**
   * Clears connection state and releases the HID device; safe to call repeatedly.
   * @returns Resolves when the transport is closed
   * @throws {TrustFlowError} CONNECTION_ERROR if closing fails or a request is pending
   */
  async disconnect(): Promise<void> {
    return this.exclusive(async () => {
      try {
        await this.closeTransport();
      } catch (error) {
        throw ledgerError(error, 'CONNECTION_ERROR');
      }
    });
  }

  private connection(): WalletConnection {
    return {
      type: this.type,
      publicKey: this.requireConnection().publicKey,
      network: this.network,
    };
  }

  private requireConnection(): { app: Str; publicKey: string } {
    if (!this.app || !this.publicKey) {
      throw new TrustFlowError('Connect the Ledger before signing', 'NOT_CONNECTED');
    }
    return { app: this.app, publicKey: this.publicKey };
  }

  private verifySignature(app: Str, publicKey: string, data: Buffer, signature: Buffer): void {
    if (this.app !== app)
      throw new TrustFlowError('Ledger disconnected during signing', 'NOT_CONNECTED');
    if (signature.length !== 64 || !Keypair.fromPublicKey(publicKey).verify(data, signature)) {
      throw TrustFlowError.signingFailed('Ledger returned an invalid signature');
    }
  }

  private onDisconnect = (): void => {
    this.disconnected = true;
    this.app = undefined;
    this.publicKey = undefined;
    // Keep the transport until disconnect/reconnect can remove its listeners and close it.
  };

  private async closeTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.onDisconnect();
    if (transport) {
      transport.off('disconnect', this.onDisconnect);
      await transport.close();
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new TrustFlowError('A Ledger request is already pending', 'CONNECTION_ERROR');
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
}

function ledgerError(error: unknown, code: 'CONNECTION_ERROR' | 'SIGNING_ERROR'): TrustFlowError {
  if (error instanceof TrustFlowError) return error;
  const details = error as { name?: string; statusCode?: number; id?: string } | null;
  if (
    isWalletRejection(error) ||
    details?.statusCode === 0x6985 ||
    details?.name === 'StellarUserRefusedError' ||
    details?.name === 'TransportOpenUserCancelled' ||
    details?.name === 'NotAllowedError' ||
    details?.id === 'TransportOpenUserCancelled'
  ) {
    return TrustFlowError.userRejected('User rejected the Ledger request', error);
  }
  return TrustFlowError.wrap(error, code);
}
