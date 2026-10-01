export { useWallet } from './useWallet';
export { useBalance } from './useBalance';
export { useTransaction } from './useTransaction';
export { useEscrow } from './useEscrow';

// `useEscrow` calls the free functions `createEscrow(client, params)` /
// `releaseEscrow(client, params)`. Both are re-exported by
// `src/escrow/index.ts` (from `create.ts` / `release.ts`) and both take a
// `client: TrustFlowClient` and work through `invokeContract`, so the hook
// type-checks and its create / release paths hit the real functions (#107).
// Like the other hooks it ships only from the `@trustflow/sdk/react` subpath,
// not the package root, so non-React consumers aren't forced to install
// `react` (#81).
export { TrustFlowError } from '../errors';
