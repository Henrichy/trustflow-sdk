export * from './types';
// `./types` resolves to the sibling `types.ts` file (Node/TS module
// resolution prefers an exact file match over a same-named directory), so
// `types/index.ts` was never actually reachable through the package root —
// its `EscrowState`/`EscrowParams`/`EscrowId` types silently shadowed by
// nothing, just unexported. Explicit path re-exports both without collision
// since none of its names overlap with the flat `Escrow` in types.ts (#80).
export * from './types/index';
export * from './types/contract';
export * from './types/events';
// Parser functions (the types come via ./types/events above) so consumers can
// call parseEvent/parseEvents and get discriminated-union narrowing (#112).
export { parseEvent, parseEvents, isTrustFlowEvent } from './events';
export * from './types/multisig';
export * from './types/juror';
export * from './types/profile';
export * from './constants';
export * from './accounts';
export * from './escrow';
export * from './juror';
export * from './profile';
export * from './storage';
export * from './auth';
export * from './stellar';
export * from './utils/validation';
export * from './utils/format';
export * from './utils/i128';
export * from './utils/timezone';
export * from './utils/request-validation';
export * from './utils/connection-pool';
export * from './utils/circuit-breaker';
export * from './utils/environment';
export * from './utils/transient';
export * from './utils/retry';
export * from './utils/interceptors';
export * from './tx-pipeline';
export { isTrustFlowEvent, parseEvent, parseEvents } from './events';
export type { RawContractEvent, ParsedEvent, EscrowCreatedData, EscrowReleasedData, DisputeRaisedData } from './events';
export { SorobanSpec } from './contract/spec';
export type { SorobanSpecInput, SorobanUnionValue } from './contract/spec';
export * from './wallet/mock';
export { TrustFlowClient } from './client';
export type { GetBalanceOptions } from './client';
export { simulateBatch } from './contract/simulate';
export type { ContractInvocation, SimulateBatchOptions, SimulationResult } from './contract/simulate';
export * from './errors';

// Zod runtime validation schemas (#45) — re-exported by name rather than
// `export *` because `Network` and `ClientConfig` already exist as plain
// TS types from './types'; only the schema objects and the composite
// "*Input" types are exposed here to avoid ambiguous re-exports.
export {
  StellarAddressSchema,
  ContractIdSchema,
  StroopsSchema,
  NetworkSchema,
  CreateEscrowSchema,
  ReleaseEscrowSchema,
  DisputeEscrowSchema,
  ClaimEscrowSchema,
  FundEscrowSchema,
  VoteSchema,
  ClientConfigSchema,
  CidSchema,
  parseRpcResponse,
} from './schemas';
export type { CreateEscrowInput, ReleaseEscrowInput, DisputeEscrowInput, ClaimEscrowInput, FundEscrowInput, VoteInput } from './schemas';
