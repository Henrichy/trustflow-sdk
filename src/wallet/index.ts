export { getFreighter, isFreighterInstalled } from './freighter';
export { getAlbedo } from './albedo';
export { connectWallet, disconnectWallet } from './connect';
export { generateSep7Uri, SEP7_MAX_URI_LENGTH } from './sep7';
export type { Sep7Options } from './sep7';
export type { WalletType, WalletConnection, WalletAdapter, WalletProvider } from './types';
export { LedgerWalletProvider } from './ledger';
export type { LedgerWalletOptions } from './ledger';
export {
  signWithFreighter,
  signMessageWithFreighter,
  signMessageWithKeypair,
} from '../stellar/signing';
export type {
  SignableTransaction,
  SignedTransaction,
  SignWithFreighterOptions,
} from '../stellar/signing';
// Re-exported like the escrow, utils and react entries so a caller that only
// imports `@trustflow/sdk/wallet` can still `instanceof` the errors thrown by
// these functions against the same class the root entry exports (#304).
export { TrustFlowError } from '../errors';
