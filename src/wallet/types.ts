export type WalletType = 'freighter' | 'albedo' | 'xbull' | 'manual';

export interface WalletConnection {
  type: WalletType;
  publicKey: string;
  network: string;
}

export interface WalletAdapter {
  type: WalletType;
  isAvailable(): Promise<boolean>;
  connect(): Promise<WalletConnection>;
  sign(xdr: string, network: string): Promise<string>;
  /**
   * Signs an arbitrary message (not a transaction) with the wallet's keypair.
   *
   * @param message - The message to sign as a UTF-8 string
   * @returns Base64-encoded ed25519 signature of the UTF-8 message bytes
   */
  signMessage(message: string): Promise<string>;
  disconnect(): Promise<void>;
}

/**
 * Determines whether an unknown error corresponds to a user declining or rejecting
 * a wallet connection or signing prompt.
 */
export function isWalletRejection(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && (error as any).code === 'USER_REJECTED') return true;
    if ('code' in error && (error as any).code === -32000) return true;
    if ('code' in error && (error as any).code === 4001) return true;
  }
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && 'message' in error
      ? String((error as any).message)
      : '';

  const lower = msg.toLowerCase();
  return (
    lower.includes('user rejected') ||
    lower.includes('user declined') ||
    lower.includes('user canceled') ||
    lower.includes('user cancelled') ||
    lower.includes('declined by user') ||
    lower.includes('rejected by user') ||
    lower.includes('denied') ||
    lower.includes('user denied')
  );
}
