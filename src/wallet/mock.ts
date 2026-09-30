import { Keypair, TransactionBuilder, Networks, Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter, WalletConnection, WalletType } from './types';

/**
 * A mock wallet adapter for headless automated browser testing (e.g. Playwright, Cypress).
 * Inject this into your dApp instead of connecting to a real wallet extension like Freighter.
 *
 * @example
 * // Playwright test example:
 * await page.evaluate(() => {
 *   window.trustflowWalletOverride = new MockWalletProvider({
 *     secretKey: 'SA...',
 *     shouldReject: false,
 *     delayMs: 500
 *   });
 * });
 */
export class MockWalletProvider implements WalletAdapter {
  type: WalletType = 'manual';
  private publicKey: string;
  private secretKey?: string;
  private network: string;
  private shouldReject: boolean;
  private delayMs: number;

  constructor(options: { secretKey?: string; publicKey?: string; network?: string; shouldReject?: boolean; delayMs?: number } = {}) {
    if (options.secretKey) {
      const kp = Keypair.fromSecret(options.secretKey);
      this.publicKey = kp.publicKey();
      this.secretKey = options.secretKey;
    } else {
      this.publicKey = options.publicKey ?? 'GAOQJGUAB7NI7K7I62ORBXMN3J4J6NBRWEINP5UX5YHMROQZ2EGE6YJQ';
    }
    this.network = options.network ?? 'TESTNET';
    this.shouldReject = options.shouldReject ?? false;
    this.delayMs = options.delayMs ?? 0;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async connect(): Promise<WalletConnection> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.shouldReject) {
      throw new Error('User rejected connection');
    }
    return {
      type: this.type,
      publicKey: this.publicKey,
      network: this.network,
    };
  }

  async sign(xdr: string, network: string): Promise<string> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.shouldReject) {
      throw new Error('User rejected signature');
    }
    if (network !== this.network) {
      throw new Error(`Network mismatch: requested ${network}, active is ${this.network}`);
    }
    if (this.secretKey) {
      const kp = Keypair.fromSecret(this.secretKey);
      const networkPassphrase = this.network === 'TESTNET' ? Networks.TESTNET : Networks.PUBLIC;
      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction;
      tx.sign(kp);
      return tx.toXDR();
    }
    return xdr;
  }

  async disconnect(): Promise<void> {
    // no-op
  }
}
