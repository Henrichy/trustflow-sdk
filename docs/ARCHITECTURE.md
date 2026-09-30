# TrustFlow SDK Architecture

## Module Overview

The SDK is organized around five conceptual layers: client setup, type definitions, feature modules, contract operations, and cross-cutting utilities. Each `src/` subdirectory corresponds to a feature domain; top-level `.ts` files provide cross-cutting concerns or main entry points.

### Complete Module Map

```
src/
├── client.ts              # TrustFlowClient: main entry point, network config, RPC/Horizon servers
├── accounts/              # Multi-account: AccountManager + AccountContext (identity & per-account state)
│   ├── manager.ts         # Register / switch / remove, per-account data, export & import state
│   ├── types.ts           # AccountContext, AccountOptions, AddAccountInput, change events
│   └── index.ts           # Exports
├── errors.ts              # TrustFlowError (24+ error codes) and factory methods
├── types.ts               # Top-level types: ClientConfig, Network, Escrow, EscrowStatus
├── types/                 # Escrow domain types: EscrowParams, EscrowState, SDKResult<T>
├── constants.ts           # Network URLs, passphrases, defaults
├── events.ts              # Event parsing: parseEvent, parseEvents, isTrustFlowEvent
├── schemas.ts             # Zod runtime validation schemas
│
├── escrow/                # Escrow operations & state management
│   ├── client.ts          # TrustFlowEscrowClient (class-based, returns SDKResult)
│   ├── builder.ts         # EscrowBuilder (fluent builder pattern)
│   ├── monitor.ts         # EscrowMonitor (polling, event subscriptions)
│   ├── dispute.ts         # DisputeClient (dispute management)
│   ├── multisig.ts        # MultiSigEscrowClient (M-of-N signature collection)
│   ├── create.ts          # createEscrow function (throws TrustFlowError)
│   ├── release.ts         # releaseEscrow function (throws TrustFlowError)
│   ├── cancel.ts          # cancelEscrow, getEscrow functions
│   └── index.ts           # Exports
│
├── auth/                  # Authentication & session management
│   ├── challenge.ts       # requestChallenge, verifyAndGetToken (backend integration)
│   ├── session.ts         # Session storage: saveSession, loadSession, configureSessionStorage
│   └── index.ts           # Exports
│
├── wallet/                # Wallet integration & connection
│   ├── connect.ts         # connectWallet, disconnectWallet (returns WalletConnection)
│   ├── freighter.ts       # Freighter adapter & detection
│   ├── albedo.ts          # Albedo adapter
│   ├── types.ts           # WalletType, WalletConnection, WalletAdapter interfaces
│   └── index.ts           # Exports
│
├── contract/              # Soroban contract interaction
│   ├── build.ts           # Argument builders: buildCreateEscrowArgs, buildReleaseArgs, etc.
│   ├── invoke.ts          # invokeContract (single contract call with simul ation)
│   ├── abstract.ts        # AbstractContractClient base class
│   ├── bindings.ts        # SorobanContractClient, createContractBinding
│   ├── spec.ts            # SorobanSpec utilities
│   ├── read.ts            # Contract read-only queries
│   ├── simulate.ts        # Simulation helpers
│   └── index.ts           # Exports
│
├── tx-pipeline/           # Transaction assembly, simulation, and submission
│   └── pipeline.ts        # TransactionPipeline (PipelineResult<T>, never throws)
│
├── juror/                 # Dispute resolution via juror voting
│   ├── client.ts          # JurorClient
│   └── index.ts           # Exports
│
├── profile/               # User profiles
│   ├── client.ts          # ProfileClient
│   └── index.ts           # Exports
│
├── storage/               # IPFS file uploads
│   └── index.ts           # IPFSStorage (available on client.storage)
│
├── stellar/               # Network & Horizon utilities
│   ├── network.ts         # Network type (string union: 'TESTNET' | 'MAINNET')
│   └── index.ts           # Exports
│
├── utils/                 # Cross-cutting helpers
│   ├── validation.ts      # Stellar address, contract ID, amount validation
│   ├── format.ts          # xlmToStroops, stroopsToXlm
│   ├── i128.ts            # BigInt serialization helpers
│   ├── retry.ts           # Generic retry helper (backoff, shouldRetry, jitter)
│   ├── transient.ts       # Shared "is this failure worth retrying?" classifier
│   ├── node-retry.ts      # withTransientRetry: the one Horizon/RPC/fetch primitive
│   ├── http.ts            # Axios client + idempotent retry interceptor
│   ├── environment.ts     # WebCrypto / feature detection (no polyfills installed)
│   ├── connection-pool.ts# Agent-agnostic pooling config + observability
│   ├── cache.ts           # SimpleCache (used for balance caching)
│   ├── logger.ts          # SDKLogger (side effect: console output)
│   └── index.ts           # Exports
│
├── node/                  # Node-only entry: @trustflow/sdk/node
│   ├── agents.ts          # The ONLY node:http / node:https imports in the package
│   └── index.ts           # Exports
│
├── hooks/                 # React hooks (optional peer dependency)
│   ├── useWallet.ts       # Wallet connection state
│   ├── useBalance.ts      # Balance tracking
│   ├── useTransaction.ts  # Transaction state
│   ├── useEscrow.ts       # Escrow wrapper with loading/error
│   └── index.ts           # Exports (only imported if @trustflow/sdk/react is used)
│
└── index.ts               # Main entry point (re-exports all public APIs)
```

## API Styles: Class-Based vs Function-Based

The SDK exposes two complementary API styles:

### Class-Based (OOP, Stateful)
- **TrustFlowClient** — Network setup, RPC connections, balance caching. Entry point for most applications.
  - Methods: `connect()`, `getBalance()`, `getNetworkPassphrase()`, `createContractBinding()`
  - Error handling: Throws `TrustFlowError` on initialization; connection/balance queries return results or throw
  
- **TrustFlowEscrowClient** — High-level escrow lifecycle operations.
  - Methods: `createEscrow()`, `releaseEscrow()`, `fund()`, `claim()`, `getEscrow()`, `getGigs()`
  - Error handling: All public methods return `SDKResult<T>` (never throw)
  - Network details provided at construction time; suitable for long-lived request handlers or services
  
- **TransactionPipeline** — Multi-stage transaction orchestration (assemble, simulate, prepare, fee-bump, submit, confirm).
  - Methods: `assemble()`, `simulate()`, `prepare()`, `buildFeeBump()`, `submit()`, `run()`
  - Error handling: All methods return `PipelineResult<T>` (never throw); errors include typed code and cause
  - Retry logic: Built-in exponential backoff for RPC transience
  
- **MultiSigEscrowClient**, **DisputeClient**, **JurorClient**, **ProfileClient** — Domain-specific high-level operations.
  - All return `SDKResult` (no exceptions) or `PipelineResult` for multi-stage workflows

### Function-Based (Procedural, Stateless)
- **escrow functions** — `createEscrow(client, params)`, `releaseEscrow(client, params)`, `cancelEscrow(client, escrowId)`, `disputeEscrow(client, params)`
  - Error handling: **Throw** `TrustFlowError` on any failure
  - Simpler for one-off operations or scripts; no state reuse
  
- **auth functions** — `requestChallenge(apiUrl, address)`, `verifyAndGetToken(apiUrl, address, signature)`
  - Error handling: **Throw** `TrustFlowError` on failure (connection issues, auth failure)
  - Suitable for session establishment flows
  
- **wallet functions** — `connectWallet(type)`, `disconnectWallet()`, `isFreighterInstalled()`, `getFreighter()`
  - Error handling: **Throw** `TrustFlowError` on failure (wallet not installed, connection failed)
  
- **session functions** — `saveSession()`, `loadSession()`, `isSessionExpired()`, `clearSession()`
  - Error handling: Return `null` or boolean; do not throw

## Error Handling Patterns (Three Styles)

The SDK uses three distinct error handling patterns depending on the API layer:

### Pattern A: Throws `TrustFlowError`
- **When:** Function-style APIs, client initialization, wallet setup, auth flow
- **APIs:** `createEscrow()`, `releaseEscrow()`, `connectWallet()`, `requestChallenge()`, `TrustFlowClient.connect()`
- **Why:** These are usually one-off operations where an error should halt execution
- **Error codes available:** 24+ codes (see [docs/API.md](./API.md))

### Pattern B: Returns `SDKResult<T>` (Discriminated Union)
```typescript
type SDKResult<T> = { ok: true; data: T } | { ok: false; error: string };
```
- **When:** High-level class-based APIs where "failure" is expected and normal (e.g. escrow lookup fails, API returns 404)
- **APIs:** `TrustFlowEscrowClient` methods, `DisputeClient`, `ProfileClient`
- **Why:** Avoids try/catch overhead; encourages explicit error handling
- **Limitation:** Errors are strings, not error codes, so callers can't branch on code type

### Pattern C: Returns `PipelineResult<T>` (Typed Error Codes)
```typescript
type PipelineResult<T> = 
  | { ok: true; data: T } 
  | { ok: false; error: TrustFlowError };
```
- **When:** Multi-stage complex operations (assemble → simulate → fee-bump → submit) where error code matters
- **APIs:** `TransactionPipeline` (assemble, simulate, prepare, buildFeeBump, submit, run)
- **Why:** Callers can branch on error.code to implement retries, fee escalation, or user guidance
- **Error codes:** ASSEMBLY_ERROR, SIMULATION_ERROR, FEE_BUMP_ERROR, SUBMISSION_ERROR, RETRY_EXHAUSTED, plus common codes like VALIDATION_ERROR, UNAUTHORIZED

## Transaction Flow: Client → Contract Build → Pipeline → Soroban RPC

```
[User Application Code]
        ↓
[TrustFlowClient] — Sets up network config, RPC endpoints, balance cache
        ↓
[Escrow/Contract API] — High-level operation (createEscrow, releaseEscrow, etc.)
        ↓
[Contract Build Layer] — Pure functions encode operation arguments to Soroban ScVal
        ↓ (buildCreateEscrowArgs, buildReleaseArgs, etc.)
        ↓
[TransactionPipeline] — Orchestrates multi-stage transaction lifecycle:
        ├─ assemble() — Fetch source account, build unsigned tx
        ├─ simulate() — Call Soroban RPC, get footprint & resource fee
        ├─ prepare() — Fold simulation results back onto tx, apply safety multiplier
        ├─ buildFeeBump() — (Optional) Wrap in fee-bump envelope
        └─ submit() — Sign, broadcast, poll for confirmation with retries
        ↓
[Soroban RPC Server] — Execute contract, collect fees, record transaction
        ↓
[Horizon Server] — Archive and index transaction events
        ↓
[Return Result: PipelineResult<T>]
```

### Request Flow by API Style

**Class-Based (TrustFlowEscrowClient):**
```
User → createEscrow(params) → build args → invoke contract → return SDKResult
```
- All errors caught and wrapped in SDKResult (never throws)

**Function-Based (createEscrow function):**
```
User → createEscrow(client, params) → build args → invoke contract → throws or returns Escrow
```
- Validation errors and auth errors throw synchronously
- Network errors and contract failures throw TrustFlowError

**Pipeline (TransactionPipeline):**
```
User → pipeline.run(sourceAccount, ops, signers) 
  → assemble (fetch account) 
  → prepare (simulate, fold resource fee)
  → submit (sign, broadcast, poll)
  → return PipelineResult with error.code for branching
```
- All stages return PipelineResult; retry logic with exponential backoff

## Entry Points & Distribution

The SDK publishes six entry points via `tsup`, built from distinct source files:

| Export | Source | Contents | Use Case |
|--------|--------|----------|----------|
| `@trustflow/sdk` | `src/index.ts` | Everything below, plus the client, accounts and all sub-clients | General use, backend |
| `@trustflow/sdk/escrow` | `src/escrow/index.ts` | Escrow operations only | Escrow-specific modules |
| `@trustflow/sdk/wallet` | `src/wallet/index.ts` | Wallet adapters & connection | Frontend wallet logic |
| `@trustflow/sdk/utils` | `src/utils/index.ts` | Validation, formatting, retry, feature detection | Shared utilities |
| `@trustflow/sdk/react` | `src/hooks/index.ts` | React hooks (requires react peer dep) | React applications |
| `@trustflow/sdk/node` | `src/node/index.ts` | **Node only** — `http`/`https` keep-alive agent factories | Long-running Node servers |

Each entry point shares common classes (TrustFlowError, logger) via `tsup`'s chunk splitting to avoid duplication.

Only the first five are browser-safe. `src/node/` is the sole module graph that references
`node:http` / `node:https`, and those specifiers are declared `external` in `tsup.config.ts` so
the neutral build never tries to bundle them. Everything reachable from the other five entries is
asserted to be free of Node built-ins by `tests/bundler-compat.test.ts`, and proven end-to-end on
Webpack 5, Rollup and esbuild by `npm run test:bundlers`. See
`docs/BROWSER_COMPATIBILITY.md`.

## Design Principles

1. **No thrown exceptions in class-based APIs** — `TrustFlowClient` and `TrustFlowEscrowClient` methods return `SDKResult<T>` or `PipelineResult<T>`, never throw
2. **Function-style APIs throw `TrustFlowError`** — Simpler for scripts and one-off operations
3. **Typed error codes** — `PipelineResult` and `TrustFlowError` include an actionable `code` field for branching retry logic
4. **Type safety** — All public APIs use TypeScript strict mode; Zod schemas validate runtime inputs
5. **Side effects isolated** — Retry logic, logging, caching are opt-in or explicit; contract arguments are pure functions
6. **Network agnostic** — Accept `Network` type (string union 'TESTNET' | 'MAINNET', not an enum), support custom RPC URLs
7. **One client, many accounts** — `AccountManager` holds every account a client can act as. `useAccount(id)` is a field write, not a re-initialisation, and per-account state (session, balance cache, API key, caller data) is namespaced by account id, so a switch can never leak one account's credentials into another's request
8. **One retry policy** — `classifyFailure` is the single retry classifier and `withTransientRetry` the single retry primitive behind every Horizon, Soroban RPC and raw-`fetch` call. Transient failures are retried with capped, jittered backoff; deterministic ones are not retried, and a non-idempotent request is not replayed unless the call opts in
9. **Detect, never polyfill** — `utils/environment.ts` reports missing web-platform capabilities and raises a named `UNSUPPORTED_ENVIRONMENT` error instead of installing a polyfill or degrading silently
10. **Builder pattern for complex params** — `EscrowBuilder` provides fluent construction; `build()` returns an independent snapshot, so a builder can be reused as a template and earlier results are never mutated by later `set*` calls
