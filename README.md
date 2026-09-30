# 📦 TrustFlow SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)

> **Type-safe TypeScript SDK for building gig-economy applications on the TrustFlow Protocol (Stellar/Soroban).**

The TrustFlow SDK provides a developer-friendly interface for interacting with TrustFlow smart contracts on the Stellar network. Build escrow systems, dispute resolution platforms, and decentralized freelance marketplaces with clean, type-safe APIs.

---

## ⚡ Quick Start.

### Installation

```bash
npm install @trustflow/sdk
# or
yarn add @trustflow/sdk
```

### 1 — Connect to the Network

```typescript
import { TrustFlowClient } from '@trustflow/sdk';

const client = new TrustFlowClient({
  contractId: process.env.TRUSTFLOW_CONTRACT_ID!,
  network: 'TESTNET', // or 'MAINNET'
});

await client.connect();
console.log('Connected to', client.network);
```

### 2 — Create an Escrow

```typescript
import { TrustFlowEscrowClient, EscrowBuilder } from '@trustflow/sdk';

const escrowClient = new TrustFlowEscrowClient({
  contractId: process.env.TRUSTFLOW_CONTRACT_ID!,
  network: 'TESTNET',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
});

const params = new EscrowBuilder()
  .setDepositor('GDEPOSITOR...')
  .setBeneficiary('GBENEFICIARY...')
  .setAmount('50') // XLM
  .setDeadline(17280) // ~1 day in ledgers
  .build();

const result = await escrowClient.createEscrow(params);
if (result.ok) {
  console.log('Escrow ID:', result.data.escrowId);
  console.log('Tx Hash:', result.data.txHash);
}
```

### 3 — Fund & Release an Escrow

```typescript
import { TrustFlowClient, TrustFlowEscrowClient } from '@trustflow/sdk';
import { createEscrow, releaseEscrow } from '@trustflow/sdk/escrow';
import { connectWallet } from '@trustflow/sdk/wallet';
import { xlmToStroops } from '@trustflow/sdk/utils';

const wallet = await connectWallet('freighter');
const client = new TrustFlowClient({
  contractId: process.env.TRUSTFLOW_CONTRACT_ID!,
  network: 'TESTNET',
});
await client.connect();

// Create
const escrow = await createEscrow(client, {
  sender: wallet.publicKey,
  recipient: 'GRECIPIENT...',
  amountStroops: xlmToStroops('50'),
  durationBlocks: 17280,
  metadata: { orderId: 'ORD-001' },
});
console.log('Escrow created:', escrow.id);

// Fund (e.g. lock USDC via its Soroban token contract instead of the native asset)
const escrowClient = new TrustFlowEscrowClient({
  contractId: process.env.TRUSTFLOW_CONTRACT_ID!,
  network: 'TESTNET',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
});
const funded = await escrowClient.fund(
  escrow.id,
  wallet.publicKey,
  xlmToStroops('50'),
  process.env.USDC_CONTRACT_ID,
);
if (funded.ok) console.log('Funded! tx:', funded.data.txHash);

// Release
const txHash = await releaseEscrow(client, {
  escrowId: escrow.id,
  caller: wallet.publicKey,
});
console.log('Released! Transaction:', txHash);
```

See [docs/QUICKSTART.md](./docs/QUICKSTART.md) for the full walkthrough including disputes, multi-sig, and pagination.

### Multi-Sig Escrow (M-of-N)

Collect signatures from multiple approvers before a release is broadcast:

```typescript
import { MultiSigEscrowClient } from '@trustflow/sdk';
import { Networks } from '@stellar/stellar-sdk';

const client = new MultiSigEscrowClient({
  contractId: process.env.TRUSTFLOW_CONTRACT_ID!,
  network: 'TESTNET',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
});

// Register a 2-of-2 release operation
const { data: { operationId } } = client.initMultiSigOperation({
  escrowId: 'esc-42',
  signers: [APPROVER_A, APPROVER_B],
  threshold: 2,
  operationType: 'release',
  unsignedXdr: UNSIGNED_RELEASE_XDR,
  networkPassphrase: Networks.TESTNET,
});

// Each approver submits their signed XDR independently
client.addSignature({ operationId, signerAddress: APPROVER_A, signedXdr: SIGNED_XDR_A });
client.addSignature({ operationId, signerAddress: APPROVER_B, signedXdr: SIGNED_XDR_B });

// Broadcast once threshold is met
const result = await client.submitWhenReady(operationId, 'https://horizon-testnet.stellar.org');
console.log('Released! tx:', result.data?.txHash);
```

See [examples/multisig-escrow.ts](./examples/multisig-escrow.ts) for the full walkthrough.

### Juror Voting

Cast a juror's vote on a dispute, either in the open or as ciphertext (e.g. for a commit-reveal
scheme — the SDK does not perform the encryption itself, `ciphertext` must already be
base64-encoded by the caller):

```typescript
import { JurorClient } from '@trustflow/sdk';

const jurors = new JurorClient({
  contractId: process.env.TRUSTFLOW_CONTRACT_ID!,
  network: 'TESTNET',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
});

// Plaintext vote
const result = await jurors.vote({
  disputeId: 'dsp-1',
  jurorAddress: 'GJUROR...',
  vote: { encrypted: false, choice: 'approve' },
});

// Encrypted vote (commit-reveal style)
const encryptedResult = await jurors.vote({
  disputeId: 'dsp-1',
  jurorAddress: 'GJUROR...',
  vote: { encrypted: true, ciphertext: myCiphertext.toString('base64') },
});

if (result.ok) console.log('Voted! tx:', result.data.txHash);
```

### Claiming Escrow Funds

Once an escrow has cleared for release, the beneficiary can withdraw funds directly with
`claim` — a shortcut that doesn't require a separate release step from the depositor:

```typescript
const result = await escrowClient.claim('esc-42', 'GBENEFICIARY...');
if (result.ok) console.log('Claimed! tx:', result.data.txHash);
```

### User Profiles

`ProfileClient` wraps the backend's `/profiles` endpoints with the same retry-aware transport
as `DisputeClient`/`JurorClient`:

```typescript
import { ProfileClient } from '@trustflow/sdk';

const profiles = new ProfileClient(process.env.TRUSTFLOW_API_URL!, authToken);

const result = await profiles.getProfile(wallet.publicKey);
if (result.ok) console.log(result.data.displayName);

await profiles.updateProfile(wallet.publicKey, { bio: 'Building on Stellar' });
```

### IPFS Storage

Every `TrustFlowClient` exposes a built-in `storage.upload()` helper for pinning files to
IPFS (evidence attachments, gig deliverables, dispute exhibits, etc.):

```typescript
import { TrustFlowClient } from '@trustflow/sdk';

const client = new TrustFlowClient({
  contractId: process.env.TRUSTFLOW_CONTRACT_ID!,
  ipfs: { apiKey: process.env.IPFS_API_KEY },
});

const result = await client.storage.upload(fileBuffer, { filename: 'contract.pdf' });
if (result.ok) console.log('Uploaded:', result.data.url);
```

`upload()` accepts a `Buffer`, `Uint8Array`, `ArrayBuffer`, `Blob` or a browser `File` directly
(e.g. from an `<input type="file">`); a `File`'s name and type are forwarded as the default
filename and content type. The request is sent to `apiUrl` exactly as configured.

`IPFSStorage` can also be used standalone via `new IPFSStorage(config)`, and points at a
web3.storage-compatible raw-body upload API by default — pass `apiUrl` to target a different
IPFS pinning service.

### Session Storage (Browser vs Node)

`saveSession` / `loadSession` / `clearSession` detect their environment per call (via
`typeof localStorage`), so no setup is needed in either place:

- **Browser**: uses `localStorage` automatically — sessions survive page reloads.
- **Node / CLI / backend**: falls back to an in-memory store scoped to the current process.
  This **does not survive process restarts.** If you need durability (a long-running server, a
  CLI invoked repeatedly), inject your own adapter:

  ```typescript
  import { configureSessionStorage } from '@trustflow/sdk';

  configureSessionStorage({
    get: (key) => myFileOrRedisStore.get(key),
    set: (key, value) => myFileOrRedisStore.set(key, value),
    remove: (key) => myFileOrRedisStore.delete(key),
  });
  ```

- **SSR / bundler edge cases** (Next.js, Remix, etc.): `typeof localStorage` can be ambiguous
  when server and client code share a module graph. If session calls run on the server during
  SSR, they'll silently use the in-memory fallback for that request rather than throwing — which
  is usually not what you want. Call `configureSessionStorage()` explicitly with a no-op or
  server-appropriate adapter for server-rendered code paths, and only rely on the automatic
  `localStorage` detection in code you know runs client-side.

Sessions can be scoped to an account. `saveSession` / `loadSession` / `clearSession` take an
optional fourth/second `scope` argument; `client.setSession(token, { account })` /
`client.getSession({ account })` / `client.clearSession({ account })` pass the account id for you,
so two accounts signed in on the same origin never overwrite each other's token. Omitting the
scope keeps the legacy single-session key, so sessions written by earlier versions still load.

Sessions also carry an `expiresAt`, checked via `isSessionExpired()`. This is a **best-effort,
client-side value** — the backend does not currently return a token TTL (tracked in
[#82](https://github.com/trustflow-protocol/trustflow-sdk/issues/82)), so treat it as a lower
bound, not a guarantee, and still handle a `401` from the backend even when
`isSessionExpired()` returns `false`.

### Multiple Accounts in One Client

A `TrustFlowClient` can act as many accounts. Register them on `client.accounts`, then switch
with `client.useAccount(id)` — a field write, not a re-initialisation: the Horizon server,
the Soroban RPC server, the retry budget and the IPFS helper are all shared and stay warm.

```typescript
const client = new TrustFlowClient({
  contractId,
  accounts: [
    { id: 'alice', address: ALICE, label: 'Alice', roles: ['depositor'] },
    { id: 'bob',   address: BOB,   label: 'Bob',   roles: ['beneficiary'] },
  ],
});

client.useAccount('bob');                       // switch — no reconnect
await client.getAccountInfo();                  // Bob's balance + sequence

await client.getAccountInfo({ account: 'alice' });  // one call, active unchanged
```

Every account-scoped method takes an optional `account`, so a single call can target an account
other than the active one. Per-account state is namespaced by account id, so switching can never
leak one account's session or credentials into another's request:

```typescript
client.setSession('bob-token', { account: 'bob' });
client.getSession({ account: 'alice' });   // null — a different account's session

// Per-account API keys override the client-wide one; the selected account is
// identified on the request.
client.accounts.update('carol', { apiKey: 'carol-backend-token' });
client.getAuthHeaders({ account: 'carol' });   // Authorization: Bearer carol-backend-token

// Scope a block of calls, then restore the previous selection (even on throw).
await client.asAccount('alice', async () => { /* … */ });

// Persist and restore across reloads.
localStorage.setItem('accounts', JSON.stringify(client.accounts.exportState()));
client.accounts.importState(JSON.parse(localStorage.getItem('accounts')!));
```

Naming an unregistered account throws a `TrustFlowError` with code `ACCOUNT_NOT_FOUND`. With **no**
accounts configured the client behaves exactly as before — single account, no context, no new
errors — so existing integrations need no changes. A runnable tour is in
[`examples/multi-account.ts`](./examples/multi-account.ts) (`npm run examples:multi-account`).

### Retry Behaviour

Horizon reads, Soroban RPC calls and raw `fetch` helpers retry **only transient** failures
(network errors, timeouts, `429`, `5xx`, Soroban `TRY_AGAIN_LATER`) with capped exponential
backoff, jitter, and a `Retry-After` header honoured when the server sends one. `4xx`, simulation
errors, node `ERROR` rejections and on-chain `FAILED` results fail fast. One `retry` block
configures all of them:

```typescript
const client = new TrustFlowClient({
  contractId,
  retry: { retries: 4, retryDelayMs: 500, maxRetryDelayMs: 10_000 },
});
```

`retries` counts *extra* attempts, so `retries: 0` disables retrying. Non-idempotent requests
(`POST`/`PATCH`) are not replayed on `5xx` or a transport error by default, because the server
may have processed the request before the response was lost; opt a specific call in with
`{ trustflowRetry: true }`. `DisputeClientOptions`, `ProfileClientOptions`, `IPFSConfig`,
`AuthRequestOptions` and `getGigs(params, options)` all accept the same `retry` block.

### Multisig Cross-Process Coordination

`MultiSigEscrowClient` keeps operation state in-memory per process. To coordinate signers running
in separate processes today, round-trip state through your own store with `exportState()` /
`importState()`:

```typescript
// Process A (initiator)
const snapshot = client.exportState(operationId); // -> hand this to your own backend/queue

// Process B (a signer), after fetching that snapshot from your store
const imported = client.importState(snapshot);
if (!imported.ok) {
  throw new Error(imported.error); // malformed/corrupted snapshot
}
client.addSignature({ operationId, signerAddress, signedXdr });
const reExported = client.exportState(operationId); // hand the updated state back to your store
```

`importState` overwrites any existing local operation with the same `operationId` — **last write
wins.** If two processes both mutate after diverging from the same snapshot and both re-export,
importing one after the other discards the first's signatures rather than merging them.
Serializing concurrent writes (e.g. one writer at a time through your store) is the caller's
responsibility until a native, backend-backed `MultiSigStateStore` lands — tracked in
[#83](https://github.com/trustflow-protocol/trustflow-sdk/issues/83).

---

## ✨ Features

### Current Capabilities

- **🔐 Escrow Management**: Create, fund, release, and monitor escrows
- **🚀 Transaction Pipeline**: Assemble, simulate, auto-adjust resource fees, fee-bump, and retry Soroban transactions via `TransactionPipeline`, with typed `PipelineResult<T>` errors
- **✍️ Multi-Sig Escrows**: M-of-N signature collection for shared backend Escrows via `MultiSigEscrowClient`
- **⚖️ Dispute Resolution**: Raise and track disputes with on-chain governance
- **🗳️ Juror Voting**: Cast plaintext or encrypted votes on disputes via `JurorClient`
- **📦 IPFS Storage**: Upload files to IPFS via `client.storage.upload()` or standalone `IPFSStorage`
- **🔁 Transient-Only Retries**: Horizon, Soroban RPC, backend and IPFS calls all retry network errors, timeouts, `429`/`5xx` and node deferrals with capped, jittered backoff — and never replay a `4xx`, a simulation error or an on-chain failure. Configured once via `ClientConfig.retry`
- **🧑️ Multiple Accounts**: One client, many accounts — switch with `useAccount(id)`, target one with `{ account }`, per-account sessions/caches/keys via `client.accounts`
- **🌐 Browser-Ready**: Bundles for Webpack 5, Rollup, esbuild and Vite with **no Node polyfill configuration**; explicit WebCrypto detection with actionable errors
- **🔑 Wallet Integration**: Built-in support for Freighter wallet
- **📱 Mobile wallet links**: `generateSep7Uri` from `@trustflow/sdk/wallet` encodes prepared transaction XDR as a SEP-0007 deep link or QR text payload (see [wallet API](docs/API.md#sep-0007-transaction-deep-links-and-qr-data)).
- **📊 Event Monitoring**: Real-time escrow state change tracking
- **🛡️ Type Safety**: Full TypeScript support with Zod validation schemas
- **🧪 Test Coverage**: Comprehensive Jest test suite

### Architecture Highlights

- **No thrown exceptions in class APIs** — `TrustFlowEscrowClient` returns `SDKResult<T>` (never throws) for safe, predictable error handling
- **Multi-stage pipeline** — `TransactionPipeline` orchestrates assemble → simulate → prepare → fee-bump → submit with typed `PipelineResult<T>` errors and built-in exponential backoff retries
- **Two API styles** — Class-based for long-lived services, function-based for scripts (throws `TrustFlowError` on failure)
- **Typed error codes** — Branch on `error.code` (ASSEMBLY_ERROR, SIMULATION_ERROR, etc.) instead of message strings
- **Builder snapshots** — `EscrowBuilder.build()` returns an independent copy of its params, so a builder can be reused as a template and earlier results are never mutated by later `set*` calls
- **Network Agnostic**: Easily switch between Testnet and Mainnet with custom RPC URLs
- **Pure Utilities**: Side-effect-free helper functions for formatting and validation

Read more in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

---

## ⚛️ React Hooks

React hooks for wallet, balance, and transaction state are available from the `@trustflow/sdk/react` subpath, kept separate from the main entrypoint so non-React (Node/CLI) consumers aren't forced to install `react`:

```ts
import { useWallet, useBalance, useTransaction } from '@trustflow/sdk/react';
```

`react` (`^18.0.0 || ^19.0.0`) is a peer dependency, required only if you import from `/react`. `useEscrow` is exported here too — it wraps the standalone `createEscrow` / `releaseEscrow` functions with loading / error state.

**This entry is a client module.** It uses `useState`, `useEffect` and `useCallback`, so `dist/hooks/index.js` and `dist/hooks/index.mjs` are emitted with a leading `'use client'` directive. In the Next.js App Router that means you can import the hooks straight from a Server Component without wrapping them in your own client file:

```tsx
// app/page.tsx — a Server Component, no 'use client' needed
import { useWallet } from '@trustflow/sdk/react';

export default function Page() {
  /* ... */
}
```

The other entries — the root, `/escrow`, `/wallet` and `/utils` — are deliberately **not** marked as client modules, so they stay usable on the server. The directive is injected into the build output rather than written in the source, because bundlers drop module-level directives; `npm run build` runs `scripts/inject-use-client.js` after `tsup` to do it, and `tests/use-client-directive.test.ts` fails the build if it ever goes missing or spreads to a non-React entry.

The `@trustflow/sdk/escrow`, `@trustflow/sdk/wallet`, and `@trustflow/sdk/utils` subpaths used in the Quick Start above are declared in `package.json`'s `exports` and built as their own targets, so those imports resolve against the published package as well as from source.

---

## 📚 Documentation

- **[Quick Start Guide](./docs/QUICKSTART.md)** — Get up and running in 5 minutes
- **[API Reference](./docs/API.md)** — Complete API documentation
- **[Contract Bindings](./docs/CONTRACT_BINDINGS.md)** — Spec-driven contract clients and the JS-to-Soroban type mapping
- **[Architecture](./docs/ARCHITECTURE.md)** — Design principles and module structure
- **[Browser & Bundler Compatibility](./docs/BROWSER_COMPATIBILITY.md)** — Supported browsers, WebCrypto detection and polyfills, and which bundlers need no configuration
- **[Versioning Policy](./docs/VERSIONING.md)** — Semantic versioning, what counts as a breaking change, and the deprecation policy
- **[Upgrading](./docs/UPGRADING.md)** — Migration steps for releases with breaking changes, and current deprecations
- **[Examples](./examples/)** — Working code examples for common use cases
- **API reference (generated)** — run `npm run docs` to build a browsable HTML API reference
  from JSDoc comments into `docs/reference/` (not committed; regenerate locally or in CI)

---

## 🗺️ Roadmap

The SDK is under active development. Here's what's coming:

### In Progress
- [x] Tsup bundler configuration for ESM/CJS exports
- [x] NPM publishing pipeline with provenance
- [x] Simulation wrappers for transaction cost estimation (`TransactionPipeline`)
- [x] Auto-retry logic for backend API endpoints (`axios-retry`)

### Planned Features
- [x] Multi-signature support for corporate escrows
- [x] IPFS storage helpers for file uploads
- [ ] Pagination support for high-volume queries
- [ ] Event parsing utilities for XDR decoding
- [x] Juror voting system integration

See our [GitHub Issues](https://github.com/trustflow-protocol/trustflow-sdk/issues) for detailed progress tracking.

---

## 🤝 Contributing

We welcome contributions! To get started:

1. Fork the repository
2. Install dependencies: `npm install`
3. Run tests: `npm test`
4. Submit a PR

**New contributors**: Start with [CONTRIBUTING.md](./CONTRIBUTING.md) for a complete setup guide, development workflow, and conventions. It covers:
- Node.js setup and available npm commands
- Running tests and checking coverage
- Code style and documentation requirements
- Branch naming, commit messages, and changelog entries
- How to get listed in [CONTRIBUTORS.md](./CONTRIBUTORS.md)

For detailed issue and PR templates, see [.github/ISSUE_TEMPLATE/](./.github/ISSUE_TEMPLATE/) and [.github/PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md).

---

## 🔒 Security

We take security seriously. This SDK builds and signs financial transactions on Stellar.

**Report security issues privately** via [SECURITY.md](./SECURITY.md) — do not open public issues for vulnerabilities.

Security features:
- **Strict Linting**: ESLint strict mode enforced across the codebase
- **Input Validation**: All parameters validated with Zod schemas
- **Type Safety**: TypeScript strict mode prevents runtime errors
- **Test Coverage**: Critical paths covered by Jest integration tests
- **Supported versions**: See [SECURITY.md](./SECURITY.md) for versioning and expected response times

For the full security policy, including scope, supported versions, and responsible disclosure guidelines, see [SECURITY.md](./SECURITY.md).

---

## 📜 License

MIT License - Copyright (c) 2026 TrustFlow Protocol

See [LICENSE](./LICENSE) for details.

---

## 🌟 Community

- **Issues**: [Report bugs or request features](https://github.com/trustflow-protocol/trustflow-sdk/issues)
- **Contributors**: See [CONTRIBUTORS.md](./CONTRIBUTORS.md)
- **Changelog**: See [CHANGELOG.md](./CHANGELOG.md)

---

*Securing the future of work, one transaction at a time.*
