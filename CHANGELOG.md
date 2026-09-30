# Changelog

## [Unreleased]

### Batch simulation (#368)

- Issue #368: Added `simulateBatch` and `client.simulateBatch` to simulate envelopes and read invocations with one JSON-RPC array request, matching responses by ID and isolating individual failures.
### Ledger hardware wallet (#362)

- Issue #362: Added `LedgerWalletProvider` with WebHID connection, Stellar BIP-44 accounts, device-reviewed transaction signing, verified signatures, and mock-transport tests.
### ⚠️ Breaking Changes

- Issue #350: i128/u128 conversion helpers now throw `TrustFlowError` with code `INVALID_AMOUNT` instead of `RangeError` for invalid amounts. Decimal string bounds are checked before BigInt conversion; valid signed negatives remain supported. See [UPGRADING.md](docs/UPGRADING.md#i128u128-amount-validation-unreleased) for error-handler migration.
### Pipeline queue release on simulation failures (#354)

- Issue #354: `TransactionPipeline.run` now proves it releases its per-account queue slot when a transaction fails in the simulate step, so later runs for the same account proceed instead of hanging behind a stuck lane. Restored `simulate`/`prepare` to assemble from the parsed RPC response, which the shared simulation helper had reduced in a way that dropped the Soroban auth entries and broke every run after the first.

### Wallet SEP-0007 transaction URIs (#379)

- Issue #379: Added `generateSep7Uri` for mobile wallet deep links and QR payloads, with SEP-0007 parameter encoding and URI size validation.
### Versioning strategy and breaking change policy (#239)

- Added `docs/VERSIONING.md`: how semantic versioning applies on `0.x` and from 1.0.0, what the
  public API covers, what counts as a breaking change, the deprecation policy, and how
  `CHANGELOG.md` is maintained.
- Added `docs/UPGRADING.md` with a per-release migration guide template and the table of current
  deprecations.
- `scripts/verify-release.js` now fails a release whose `### ⚠️ Breaking Changes` changelog heading
  does not match the version bump, a 1.0.0+ major release without that heading, or a flagged
  section that does not link to `docs/UPGRADING.md` (logic in `scripts/release-policy.js`).

### Horizon URL & Network Passphrase Overrides (#208)

- Added `horizonUrl` and `networkPassphrase` overrides to `ClientConfig` and `ClientConfigSchema`, defaulting to network-derived values.
- Exposed `horizonUrl` and `networkPassphrase` in `TrustFlowClient.getConfig()` and `TrustFlowClient.getNetworkPassphrase()`.
- Validated `horizonUrl` and `rpcUrl` in `TrustFlowClient` constructor, failing fast with `TrustFlowError` (`INVALID_CONFIG`).
- Updated `fetchAccountInfo` and `TrustFlowClient.getAccountInfo` to pass and respect configured custom Horizon endpoints.

### TypeDoc Coverage & Documentation Build in CI (#219)

- Expanded TypeDoc configuration in `typedoc.json` to include subpath entry points (`src/escrow/index.ts`, `src/wallet/index.ts`, `src/utils/index.ts`, `src/testing/index.ts`).
- Added comprehensive JSDoc annotations across public types, client methods, and utilities.
- Added automated `npm run docs` build step to GitHub Actions CI workflow (`.github/workflows/ci.yml`).

### Filter & Sorting Extensions for `getGigs` (#235)

- Extended `GetGigsParams` with date range (`createdAfter`, `createdBefore`), `tokenAddress`, amount range (`minAmount`, `maxAmount`), and sort options (`sortBy`, `sortOrder`).
- Added strict parameter validation for `limit` (must be a positive integer), `depositor`, `beneficiary`, and `tokenAddress`.
- Cleanly formatted and forwarded filter parameters to backend `/gigs` queries.

### Consumer-Facing Testing Kit Subpath `@trustflow/sdk/testing` (#240)

- Published `@trustflow/sdk/testing` subpath containing test doubles and fixture builders for deterministic offline testing without live network connections or monkey-patching.
- Added `createMockHorizonServer` and `createMockSorobanServer` with canned responses.
- Added `MockWalletAdapter` simulating browser wallet extension signatures and connections.
- Added typed test fixture builders: `buildMockEscrow`, `buildMockEscrowState`, `buildMockContractEvent`.
- Added ScVal validation helpers (`isValidScVal`, `toBeValidScVal`).
- Published `docs/TESTING.md` guide covering offline integration testing strategies.

### Multi-account support

The client used to model exactly one active account, so a multi-user application had to
construct a second client per identity — duplicating the Horizon connection, the Soroban RPC
server, the balance cache and the retry budget. Accounts are now first-class:

- `client.accounts` is an `AccountManager` holding any number of `AccountContext`s, each with an
  `id`, a `G...` `address`, an optional `label`, an optional per-account `apiKey`, `roles`, and a
  free-form `data` bag. Register them up front with `ClientConfig.accounts`, or later with
  `client.addAccount()`.
- `client.useAccount(id)` switches the active account with a single field write — no client is
  rebuilt and no network connection is reopened — and `client.asAccount(id, fn)` scopes a block
  of calls, restoring the previous selection even if `fn` throws. Lookups accept an id *or* a
  `G...` address, and `client.onAccountChange(listener)` emits `added` / `updated` / `removed` /
  `activated`.
- Every account-scoped method accepts an optional `account` (id or address), so one call can
  target a non-active account: `getBalance`, `getAccountInfo`, `getAuthHeaders`, `getSession`,
  `setSession`, `clearSession`, `readContractState`, `simulateContractCall`, `invokeContract`, and
  `TransactionPipeline.run({ account })`.
- State is isolated per account: session tokens are namespaced by account id
  (`saveSession`/`loadSession`/`clearSession` gained an optional `scope`), the opt-in balance cache
  is keyed by account as well as address, a per-account `apiKey` overrides the client-wide key,
  and the selected account is identified on backend requests via `X-TrustFlow-Account`.
  `AccountManager.exportState()` / `importState()` round-trip the account set, versioned by
  `ACCOUNT_SNAPSHOT_VERSION`.
- New `TrustFlowErrorCode` values: `ACCOUNT_NOT_FOUND`, surfaced by
  `TrustFlowError.accountNotFound(ref)`.
- **Compatibility:** with no `accounts` configured the client behaves exactly as before — single
  account, no context, and `resolveAccount()` returns `null` rather than throwing, so existing
  integrations need no changes. An *explicitly named* account that is not registered does throw,
  because that is always a caller bug. A runnable tour is `examples/multi-account.ts`
  (`npm run examples:multi-account`).

### WebCrypto feature detection and graceful failure

A browser without `crypto.subtle` — Safari < 15.4, or any page served over plain `http://`,
where the subtle interface is hidden because WebCrypto is restricted to secure contexts —
crashed deep inside the Stellar SDK with a bare `ReferenceError` or a silently skipped signature.
Now:

- `src/utils/environment.ts` adds `detectFeatures()`, `detectRuntime()`, `hasWebCrypto()`,
  `assertFeatureSupport()` and `assertWebCryptoSupport()`, plus the `FeatureSupport` /
  `EnvironmentReport` / `RuntimeKind` types. All are pure: they never throw on import, never
  install a polyfill, and are safe in SSR, a worker, or a test.
- Missing required capabilities raise a `TrustFlowError` with the new `UNSUPPORTED_ENVIRONMENT`
  code that names the missing API, explains the *insecure context* cause (the usual reason it
  works on `localhost` and fails in staging), lists the supported browser versions, and links to
  the new compatibility doc. Optional gaps (`fetch`, `localStorage`, `subtle-crypto`,
  `text-encoder`) are reported without marking the environment unsupported, so a read-only
  contract viewer is never blocked by a missing `localStorage`.
- `client.getEnvironment()` and `client.assertCryptoSupport(feature)` expose the same report bound
  to a client instance.
- Browser compatibility, polyfill guidance (including the fact that a polyfill *cannot* fix an
  insecure context), SSR caveats and a common-problems table are documented in
  `docs/BROWSER_COMPATIBILITY.md`.

### Bundler compatibility: no Node polyfills required

`src/utils/connection-pool.ts` imported Node's `http`/`https` and was re-exported from the package
root, so every browser consumer had to configure `resolve.fallback` before the SDK would build —
and the `platform: 'neutral'` build failed outright with
`Could not resolve "http"`. Fixed by splitting the module by environment:

- `@trustflow/sdk/node` (new `src/node/index.ts` entry) owns `createHttpAgent`,
  `createHttpsAgent` and `configureAxiosConnectionPool`. It is the only module graph in the
  package that references `node:http` / `node:https`, and those specifiers are marked `external`
  in `tsup.config.ts`. The root entry deliberately does not re-export it.
- The root/`/utils` entry keeps the environment-agnostic half — `PoolConfig`, `PoolStats`, the new
  structural `PooledAgent` type, `getHttpAgentStats`, `monitorPoolHealth`, `destroyPoolAgent` —
  which works against any agent-shaped object and needs no Node types.
- **Removed the `axios-retry` dependency.** It is CommonJS-only, and its
  `import isRetryAllowed from 'is-retry-allowed'` breaks Rollup's strict-ESM output with
  `"default" is not exported by ...`, forcing every Rollup consumer to add
  `@rollup/plugin-commonjs`. `src/utils/http.ts` now installs an equivalent response interceptor
  (`installApiRetryInterceptor`), which is also the only way to apply the method-idempotency gate,
  the `Retry-After` hint and jitter exactly as documented. `axios` itself is already browser-safe.
- **Fixed a real runtime bug**: `agent.keepSocketAlive = true` assigned a boolean over what is a
  *method* on Node ≥ 19's `http.Agent`, which would have broken keep-alive. The property assignment
  is gone; `keepAliveTimeoutMs` is now documented accurately as a server-side knob a client agent
  does not apply.
- **Fixed the build**: `src/utils/request-validation.ts` wrote through a read-only generic
  (`truncated[key] = …`, TS2862), which failed the `dts` rollup and so produced a `dist/` with no
  `.d.ts` files at all. `tsconfig.json` now declares `"types": ["node"]` so the `/node` entry's
  `node:` imports type-check in both `tsc` and tsup's independent dts resolution.
- Verified example projects and a regression check under `examples/bundlers/`: one shared entry
  that touches every browser entry, a Webpack 5 config with no `resolve.fallback` /
  `ProvidePlugin` / `node:` alias plus a `NoNodeBuiltinsPlugin` that turns a Node core module in the
  browser bundle into a build failure, a Rollup config, an esbuild config, and
  `npm run test:bundlers` (`examples/bundlers/verify-bundlers.mjs`) which builds all three and then
  scans the output for Node built-in specifiers. `tests/bundler-compat.test.ts` asserts the same
  invariant statically at the source level.
- Rollup still needs `@rollup/plugin-commonjs` — required by `@stellar/stellar-sdk`, whose browser
  build is UMD rather than ESM. That is not a polyfill and is documented as such.

### Retry coverage and policy

Horizon and Soroban RPC reads bypassed `axios-retry` and `TransactionPipeline`'s local
`withRetry`, the raw-`fetch` helpers had no retry at all, and `retry()` had no way to say "this
failure is not worth another attempt" — so the pipeline replayed deterministic failures such as
simulation errors, node `ERROR` rejections and on-chain `FAILED` results, and `http.ts` retried
non-idempotent `POST`s on `5xx`. The gap analysis is in the issue; the implementation:

- `ClientConfig.retry` (an `ApiRetryConfig`: `retries`, `retryDelayMs`, `maxRetryDelayMs`,
  `jitter`) configures **every** network call the client makes, reusing the existing shape rather
  than introducing a third. `retries` counts extra attempts, so `retries: 0` disables retrying.
  The same block is threaded through `DisputeClientOptions`, `ProfileClientOptions`, `IPFSConfig`,
  `AuthRequestOptions` and `getGigs(params, options)`; `TrustFlowEscrowClient` takes it as a
  constructor option.
- `RetryOptions` gained `shouldRetry(error, attempt)` — returning `false` stops the loop and
  rethrows that error unchanged — and `jitter`, which is `false` by default so existing callers
  keep exactly their current delays. `DelayStrategy` now also receives the error, which is how a
  caller lets a `Retry-After` header win over its own schedule
  (`backoffHonouringRetryAfter`). `retry(fn, 3, delayMs)` is unchanged.
- `src/utils/transient.ts` is the single classifier every retried call site shares:
  `classifyFailure` / `isTransientError` / `markTransient` / `readRetryAfterMs` /
  `parseRetryAfterMs`, with a `TransientFailureKind` of `network | timeout | throttled | server |
  node-busy | deterministic | unknown`. It reads the HTTP status and `Retry-After` off a wrapped
  `TrustFlowError`'s `cause` as well as the error itself, and re-classifies a `RETRY_EXHAUSTED`
  wrapper from the failure it wraps.
- `src/utils/node-retry.ts` adds `withTransientRetry(fn, options, retryConfig, label)` — the one
  primitive behind every Horizon read, Soroban RPC call and raw-`fetch` helper — plus
  `resolveNodeRetryPolicy` and `DEFAULT_NODE_RETRY_CONFIG` (2 retries, 300ms base, 5s cap).
- Now wrapped: `TrustFlowClient.connect` and `getBalance`, `readContractState`,
  `simulateContractCall`, `invokeContract` (`getAccount` and `simulateTransaction`),
  `TransactionPipeline.assemble` / `simulate` / the confirmation poll (which now accepts
  per-call `RetryPolicy`), `fetchAccountInfo` and `submitTransaction`. Simulation errors, node
  `ERROR` and on-chain `FAILED` are not retried; `TRY_AGAIN_LATER` and a confirmation-poll timeout
  are, because in both cases the node never accepted the envelope.
- `fetchAccountInfo` no longer swallows every failure and reports `isActive: false` — a
  two-second Horizon outage was indistinguishable from an unfunded account, so callers told users
  to fund an account that already had money. A `404` still means `isActive: false`; anything else
  throws `NOT_FOUND` or `CONNECTION_ERROR`. New `TrustFlowClient.getAccountInfo({ account? })`.
- `http.ts` limits `429`/`408`/`5xx` and transport retries to idempotent methods
  (`GET`/`HEAD`/`OPTIONS`/`PUT`/`DELETE`), honours `Retry-After` (capped by `maxRetryDelayMs`),
  and adds equal jitter (`delay / 2 … delay`), so `POST`s such as `DisputeClient.raiseDispute` are
  no longer replayed. A call can opt in with `{ trustflowRetry: true }`.
- `submitTransaction` (a `POST`) retries only the genuinely ambiguous cases — transport error,
  `429`, `408`, `5xx` — and never a Horizon response carrying result codes. The replayed envelope is
  byte-identical, so a retry cannot double-spend.
- **Composes with `HttpInterceptors`** (#323). `createApiHttpClient` accepts both `retry` and
  `interceptors`, and registers the interceptor chain *before* the retry handler, so request hooks
  run once per transport attempt (including retries) and response hooks observe the outcome the SDK
  actually returns rather than every intermediate `5xx`. `retry` and `interceptors` are likewise
  both accepted by `DisputeClientOptions`, `ProfileClientOptions`, `IPFSConfig`,
  `AuthRequestOptions` and `getGigs` — on `getGigs`, an explicit `interceptors` wins over the
  constructor option, which wins over `config.interceptors`.

**Behaviour change to be aware of:** `TransactionPipeline` now returns the *specific* error for a
terminal failure (`SIMULATION_ERROR`, `SUBMISSION_ERROR`) instead of wrapping it in
`RETRY_EXHAUSTED`, which is now reserved for a stage that really was retried and really did run
out of budget, with the last error as `cause`. Callers that matched on `RETRY_EXHAUSTED` should
branch on the specific code instead — which is what `PipelineResult` was documented to enable. This
also fixes #245: an on-chain `FAILED` result no longer re-sends the same signed transaction (its
`it.failing` test is now a passing `it`).

### Session storage is account-scoped

`saveSession`, `loadSession` and `clearSession` gained an optional `scope`, so two accounts signed
in on the same origin no longer overwrite each other's token. Omitting the scope keeps the legacy
unscoped key, so sessions written by earlier SDK versions still load.

### Multi-sig operation input validation

- Issue #285: `initMultiSigOperation` accepted input it could not honour, and the failures
  surfaced much later — as an operation that never became ready, or as an assembly error after
  every signer had already signed. It now refuses, with a message naming the offending field:
  - a non-integer `threshold` (`threshold must be an integer`) — `NaN` satisfies both
    `threshold < 1` and `threshold > signers.length`, and a fraction silently rounded the
    M-of-N requirement;
  - a `signers` entry that is not a valid Stellar address (`signers[2] is not a valid Stellar
    address: …`), checked with `isValidStellarAddress` like every other entry point;
  - a blank or over-long `escrowId` (max 128 characters), which is interpolated into
    `operationId`;
  - an `operationType` outside `release | cancel | dispute` — the union is erased at runtime, so
    an untyped caller (or `JSON.parse`) previously stored anything, including `undefined`;
  - an `unsignedXdr` that is not a parseable transaction envelope for the network
    (`unsignedXdr is not a valid Stellar transaction envelope`), now checked up front through the
    same helper `addSignature` uses, instead of at assembly time;
  - a non-finite or already-past `expiresAt` (`expiresAt must be a finite UNIX timestamp in
    milliseconds` / `expiresAt is in the past`).
- Duplicate signers, the M-of-N bounds, the required-field checks and the network-passphrase
  check are unchanged, and so are the error strings for all of them. `unsignedXdr` is parsed
  before a signature can be added, so a valid `signedXdr` still assembles.

### EscrowMonitor handler typing

- Issue #287: `EscrowMonitor.on` / `off` are now overloaded, so a handler is contextually typed by
  the event name it registers for:

  ```typescript
  monitor.on('escrow_created', (e) => console.log(e.data.escrowId, e.data.amount));
  monitor.on('*', (e) => console.log('any event', e.type));
  ```

  `e.data` is the payload for that event — `EscrowCreatedData`, `EscrowReleasedData` or
  `DisputeRaisedData` — with no second `if (e.type === ...)` narrowing, and `off` takes the same
  literal so a narrowed handler is removed without a cast. `monitor.on('escrow_cancelled', e =>
  …)` still receives `Record<string, unknown>`, which is what the untyped events carry.
- New exported types: `MonitorEventName` (`TrustFlowEventType | '*'`, including the wildcard that
  was previously discoverable only by reading `deliver`), `EventHandlerFor<T>` and
  `ParsedEventForType<T>`.
- **Behaviour change to be aware of:** a *literal* event name the parser never emits is now a
  compile error (`monitor.on('escrow_create', …)`, `monitor.on('escrow.created', …)`). It used to
  compile and register a handler that silently never fired. A name held in a `string` variable
  still works — that fallback overload is kept and marked deprecated — so
  `monitor.on(nameFromConfig, …)` compiles until you type the variable as `MonitorEventName`.
- No runtime change: `on`, `off` and `deliver` behave exactly as before, wildcard dispatch
  included.

### Multi-sig tests against the real client

- Issue #288: `tests/multisig.test.ts` stubbed both the client and `stellar-sdk`, so it asserted
  against hand-written fixtures — including a placeholder XDR and a mock address that the
  validation above no longer accepts. It is rebuilt on deterministic keypairs, real transaction,
  fee-bump and signed envelopes, a mocked Horizon and the real `MultiSigEscrowClient`, with one
  case per validation rule, coverage of the lazy-expiry and envelope-type paths, and
  `src/escrow/multisig.ts` at 100% line coverage. Two `it.failing` cases document the known
  #280 (a signature is accepted from a claimed signer without verifying it against the envelope)
  and #283 (submitting an already-submitted operation re-broadcasts it) gaps and start passing
  when those are fixed.

### Contract event ground truth (spike, no behaviour change)

- Issue #286: the SDK's event vocabulary was compared against what the contract actually
  publishes. The contract emits **thirteen** events, each as a `namespace`/`verb` symbol pair in
  `topic[1]`/`topic[2]` with the payload as a `#[contracttype]` struct in `value`. `src/events.ts`
  declares six underscore-separated names, of which **none** exists on chain: it reads the event
  name from `topic[0]`, which in an RPC response is the contract id, so `parseEvent` returns
  `type` set to a base64 blob with an empty payload for every real event. The three typed payload
  shapes match nothing, and the "canonical convention" comment in `src/events.ts` is wrong.
  The findings, the full topic/payload table, and the recommendation are in
  `docs/spikes/issue-286-event-ground-truth.md`.
- Recommendation: type all thirteen real events and derive the vocabulary from the contract spec
  (`scSpecEntryEventV0` is currently dropped by `SorobanSpec.indexEntries()`) rather than
  hardcoding it again. The decoder rewrite is #282.
- No runtime behaviour changes here. `tests/fixtures/contract-events.json` holds the captures
  (generated by running the contract's own `Env` against the `soroban-sdk` version its
  `Cargo.lock` pins), and `tests/contract-events-fixture.test.ts` re-decodes them so the documented
  vocabulary fails the build if the contract's events change.

## [Unreleased] — previous
- The `@trustflow/sdk/react` entry is now emitted as a client module: `dist/hooks/index.js` and
  `dist/hooks/index.mjs` start with a `'use client'` directive. The entry exports hooks that call
  `useState`, `useEffect` and `useCallback`, so in the Next.js App Router importing it from a
  Server Component — or from any file that is not itself marked `'use client'` — failed, forcing
  every consumer to re-wrap the hooks in their own client file. The repo's own `.env.example` uses
  `NEXT_PUBLIC_*` variables, so App Router consumers are the expected audience. The root, `/escrow`,
  `/wallet` and `/utils` entries are deliberately left unmarked so they stay server-safe. The
  directive is injected into the build output by `scripts/inject-use-client.js`, run after `tsup`
  in `npm run build`, because a module-level directive does not survive bundling — a `'use client'`
  in `src/hooks/index.ts` is dropped by tsup and by any consumer's bundler. `tsup.config.ts` is
  unchanged: a per-entry `banner` was tried and rejected, because tsup runs the configs of an array
  in parallel against a single `outDir`, so the second config races the first one's `clean` and
  leaks the banner onto `dist/index.js` ("Module level directives cause errors when bundled, "use
  client" in "dist/index.js" was ignored") — the opposite of what the entry split is for.
  `tests/use-client-directive.test.ts` (15 cases) fails the build if the directive goes missing,
  reaches a non-React entry or a shared chunk, or is injected twice.
- Added the MIT `LICENSE` file. `package.json` declared `"license": "MIT"` and the README linked
  to `./LICENSE`, but no such file existed, so the link was dead, the published tarball carried no
  license text, and `scripts/verify-release.js` — which has always required a `LICENSE` in the
  package — would have failed every release.
- Completed the package metadata. Added `repository`, `bugs`, `homepage`, `author` and `keywords`
  (npm provenance validates the published package's `repository` against the GitHub repo the
  release workflow runs in), `engines.node: ">=20"` (the floor `@stellar/stellar-sdk` requires and
  the versions CI tests) and `"type": "commonjs"`, which matches the `.js`/`.mjs` output split and
  stops Node from having to detect the package type. `publint` now reports 1 warning and 0
  suggestions, down from 1 warning and 3 suggestions; the remaining warning is the pre-existing
  ambiguity of a single `types` condition in `exports` alongside both `.d.ts` and `.d.mts` output,
  which is a type-resolution concern rather than missing metadata. The README's TypeScript badge
  said `5.0` while `devDependencies` pins `typescript@^6.0.3`; it now reads `6.0`.
- Declared `"sideEffects": false` so bundlers can tree-shake the SDK. Audited every module-level
  statement in `src/` first: they are all pure declarations — `const`/`let` bindings, regexes,
  `new Set([...])`, `new Map()`, and `new SDKLogger()` in `src/utils/logger.ts`. The state in
  `src/auth/session.ts` (`override`, `inMemoryFallback`) and `src/tx-pipeline/queue.ts` (`lanes`)
  is module-local and, in session.ts, deliberately resolved lazily rather than at import time, so
  dropping an otherwise-unused module has no observable effect. No module performs I/O, touches a
  global or registers a handler on import.
- Fixed `SorobanSpec.valToScVal` emitting `scvMap` arguments whose keys were not sorted (#266).
  The Soroban runtime requires a map's entries to be in strictly increasing key order, so a struct
  whose fields were not declared alphabetically (`{ zeta, alpha }` encoded as `['zeta', 'alpha']`)
  and any map passed with unsorted keys — a `Map`'s insertion order, or a plain object's — produced
  an argument the host rejects, which is every argument `SorobanContractClient.invoke` encodes.
  `scSpecTypeMap` and UDT structs are now both emitted through a host-order comparator: the key
  type's discriminant first, then the value, numerically for integer keys (`2` before `10`, `-9`
  before `-1`) and bytewise for `Symbol`/`String`/`Bytes` keys (`Zeta` before `alpha`). `xdr.scvSortedMap`
  is deliberately not used — it is best-effort by its own comment and orders string-like keys with
  `localeCompare`, which is not a bytewise order. Entries that encode to the same key are now
  rejected with `INVALID_CONTRACT_CALL` instead of producing an invalid map. Decoding is unchanged:
  `scValToNative` turns a map into an object, so round-tripping is unaffected. The `Map<K, V>` and
  UDT struct rows in `docs/CONTRACT_BINDINGS.md` are no longer marked as gaps.
- Fixed `EscrowBuilder.build()` returning the builder's own internal `params` object instead of a
  copy, so a later `set*` call retroactively changed earlier results and a caller mutating a built
  object leaked back into the builder. It now returns an independent snapshot, which makes the
  documented "keep one builder as a template, call `build()` per gig" pattern actually work. The
  "immutable after `build()`" wording in `docs/ARCHITECTURE.md` was never accurate and has been
  reworded. Input validation in `build()` is unchanged (#214).
- `SorobanSpec.encodeArgs` / `valToScVal` now validate instead of coercing (#265). Missing,
  misspelled or extra named arguments (and struct fields), non-boolean `bool` values, non-integer
  or out-of-range `u32`/`i32`/64/128/256-bit integers, non-hex or wrong-length `Bytes`/`BytesN`,
  wrong tuple arity, malformed addresses and invalid symbols all raise a `TrustFlowError`
  (`INVALID_CONTRACT_CALL`) naming the parameter path (for example `args.metadata[2]`), and no raw
  `RangeError`, `SyntaxError` or `TypeError` escapes for bad input. `Option<T>` arguments may be
  omitted. **Behaviour change:** values that were previously coerced (`'false'` or `1` as a
  `bool`, a number as a `String`) are now rejected.
- Fixed `SorobanSpec.valToScVal` emitting the wrong `ScVal` type for three spec types (#264):
  `u128` is now `scvU128` (values in [2^127, 2^128) no longer overflow an i128), `duration` is
  `scvDuration` and `timepoint` is `scvTimepoint`. The misspelled `'scSpecTypeTime' as any` case
  in `spec.ts` and `bindings.ts` is now `scSpecTypeTimepoint`, so generated bindings type
  timepoint arguments as `bigint`.
- Fixed `SorobanSpec` throwing `TypeError: c.voidV0 is not a function` for any contract spec
  containing a union type: `indexEntries` now uses the typed `voidCase()` / `tupleCase()` / `.type()`
  accessors (the public `SpecUnionCase.typeList` field is unchanged) (#263). `parseEntries` now
  throws a `TrustFlowError` (`INVALID_CONTRACT_CALL`) naming the offending index for unsupported
  or undecodable entries instead of silently dropping them, and accepts duck-typed entries that
  expose `toXDR()`.
- Exported `disputeEscrow` and the `DisputeClientOptions`, `EscrowMonitorOnError`,
  `EscrowMonitorErrorContext` and `EscrowMonitorErrorPhase` types from the escrow barrel, so they
  resolve from `@trustflow/sdk` and `@trustflow/sdk/escrow` (#268). `examples/dispute.ts` now uses
  the public escrow entry point and a test fails if `disputeEscrow` is dropped from the barrels.
- Added a tag-triggered `release.yml` workflow (#305) that verifies, then publishes to npm with
  provenance and creates the GitHub Release; `scripts/verify-release.js` checks the tag,
  `package.json`, `SDK_VERSION`, the changelog heading and the `npm pack` file list. Documented in
  `docs/RELEASING.md`.
- Added an end-to-end suite (`npm run test:e2e`) and CI job that run against a local
  `stellar/quickstart` network (#306). `TrustFlowClient` and `TransactionPipeline` now honour the
  Stellar SDK's global `Config.setAllowHttp(true)` for plain-http RPC URLs.
- Added real React tests (jsdom and `@testing-library/react`) for `useWallet`, `useBalance`,
  `useTransaction` and `useEscrow`, run on React 18 and 19 in CI (#289).
- Added unit tests for `escrow/create.ts`, `cancel.ts` and `release.ts` validation and argument
  encoding (#276).
- Added `./escrow`, `./wallet`, and `./utils` subpath exports (#100) — the
  README's Quick Start (`import { createEscrow } from '@trustflow/sdk/escrow'`,
  and likewise `/wallet`, `/utils`) previously failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` for consumers of the published package
  because only `.` and `./react` were declared. Each is wired into
  `tsup.config.ts`'s `entry` and `package.json`'s `exports` with matching
  `types` / `import` / `require` conditions, and a test asserts every
  `@trustflow/sdk/*` path in the README resolves against the exports map.
- Removed the dead duplicate `submitTransaction` in `src/stellar/horizon.ts`
  (#110) — the file was orphaned (not on the `src/stellar` barrel, no import
  sites; `MultiSigEscrowClient.submitWhenReady` uses the `(xdr, horizonUrl)`
  version from `src/stellar/transaction.ts`). A test guards against a second
  implementation reappearing.
- Exported `useEscrow` from `src/hooks/index.ts` (#107) — its
  `createEscrow` / `releaseEscrow` imports resolve against the real
  re-exports in `src/escrow/index.ts`, so the hook type-checks; added tests
  for its create / release success and error paths. Still ships only from the
  `@trustflow/sdk/react` subpath (#81).
- Added a Soroban RPC smoke test for the contract-invocation layer (#104) —
  `src/contract/{invoke,read,simulate}.ts` already use `rpc` (not the
  nonexistent `SorobanRpc`) against `@stellar/stellar-sdk@15`; the test
  constructs `rpc.Server` from `src/contract/index.ts`'s dependency graph so a
  future SDK bump breaking this is caught immediately.
- Added `TrustFlowEscrowClient.fund()` (#4) — funds an existing escrow by encoding a token
  transfer (e.g. the USDC Soroban token contract) into contract call arguments via the new
  `buildFundArgs`; omit `tokenAddress` to use the escrow's native asset.
- Added `ProfileClient` (#5) — type-safe Axios methods (`getProfile`/`updateProfile`) for the
  backend's `/profiles` endpoints, following the same retry-aware `SDKResult` pattern as
  `DisputeClient`/`JurorClient`. Exported from the package root alongside `Profile` and
  `UpdateProfileParams`.
- Added `disputeEscrow()` to `src/escrow/dispute.ts` (#6) — the on-chain counterpart to
  `DisputeClient.raiseDispute` (which posts to the backend API); simplifies the XDR construction
  for alerting the smart contract of a dispute via the existing `buildDisputeArgs`. This also
  fixes `examples/dispute.ts`, which already imported `disputeEscrow` from this module even
  though it was never implemented.
- Added a Typedoc configuration (#7) — `typedoc.json` plus `npm run docs` / `docs:watch` —
  auto-generating API reference HTML from JSDoc comments into `docs/reference` (gitignored,
  generated on demand). `skipErrorChecking` is enabled so doc generation isn't blocked by
  pre-existing unrelated compiler diagnostics in legacy browser-wallet code (`window` usage
  without a DOM lib, etc.).
- Exported the Zod validation schemas from `src/schemas.ts` (`StellarAddressSchema`,
  `ContractIdSchema`, `StroopsSchema`, `NetworkSchema`, `CreateEscrowSchema`,
  `ReleaseEscrowSchema`, `DisputeEscrowSchema`, `ClientConfigSchema`, plus the `*Input` inferred
  types) from the package root (#45) so consumers — notably frontend form validation — can reuse
  the same rules the SDK enforces internally instead of duplicating them. The schemas' inferred
  `Network` and `ClientConfig` type aliases are intentionally **not** re-exported from the root
  barrel: those names already exist as plain TS types in `src/types.ts`, and re-exporting both
  via `export *` produces an ambiguous-export error; import them directly from `../schemas` if
  needed. No new runtime dependency — `zod` was already added in #45.
- **Breaking changes: none.** Everything below is additive; existing `saveSession`/`loadSession`/
  `clearSession` and `MultiSigEscrowClient` call signatures are unchanged. See the "Compatibility
  & migration" note at the top of `docs/spikes/issue-79-retry-session-multisig.md`.
- Session storage (`auth/session.ts`) is now pluggable via a `SessionStorageAdapter` and
  `configureSessionStorage()`. Node/CLI/backend usage now defaults to an in-memory adapter
  instead of silently no-op'ing; browser usage is unchanged (`localStorage`). A pre-existing
  session with no stored expiry (written before this change, or by an older SDK version) is
  treated as not-yet-expired rather than retroactively expired.
- Sessions now carry an `expiresAt`, checked via the new `isSessionExpired()`. Best-effort only —
  the backend does not yet return a token TTL (tracked in #82) — see the README's "Session
  Storage" section. A malformed/corrupted stored `expiresAt` is treated as already expired rather
  than valid forever.
- Removed `src/stellar/rpc.ts` (`simulateAndAssemble`): dead code, never referenced or exported,
  fully superseded by `TransactionPipeline.prepare`. Not part of any documented public API
  (verified via repo-wide search of `src/`, `tests/`, `examples/`, and docs).
- Added `MultiSigStateStore` (target abstraction for a future backend-backed store, #83) and
  `MultiSigEscrowClient.exportState`/`importState` (non-breaking stopgap for coordinating signers
  across processes today) to `src/types/multisig.ts` / `src/escrow/multisig.ts`. Exported
  snapshots carry a `version` field (`MULTISIG_SNAPSHOT_VERSION`) so a future schema change can be
  detected and rejected by `importState` instead of silently misinterpreted.
- Retry: `src/utils/retry.ts` kept as-is (tested public utility); consolidating it with
  `TransactionPipeline`'s internal retry loop is tracked separately (#84).
- See `docs/spikes/issue-79-retry-session-multisig.md` for the full retry/session/multisig design
  writeup this release is based on. Follow-up implementation issues: #82, #83, #84.

## [0.2.1] - 2026-06-29
- Add shared backend API transport in `src/utils/http.ts` using `axios` + `axios-retry`
- Add automatic retries for transient backend failures (`429`, `5xx`, network errors)
- Migrate backend SDK endpoints from `fetch` to shared retry-aware transport:
	- `TrustFlowEscrowClient.getGigs`
	- `DisputeClient.raiseDispute` / `DisputeClient.getDispute`
	- `requestChallenge` / `verifyAndGetToken`
- Add Jest coverage for retry policy and backend transport behavior
- Add Jest tests validating contract argument XDR payload encoding
- Architectural decision: centralize backend HTTP behavior to avoid endpoint-specific retry drift

## [0.2.0] - 2026-04-28
- Add DisputeClient for dispute management
- Add EscrowMonitor for real-time event polling
- Add typed error classes and logger
- Add comprehensive test suite (10 files, 40+ tests)

## [0.1.0] - 2026-03-01
- Initial SDK release
- EscrowClient, EscrowBuilder, AuthSession
- Stellar network helpers and validators
