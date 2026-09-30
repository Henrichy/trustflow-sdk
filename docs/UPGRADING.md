# Upgrading

Migration steps for each release that contains breaking changes, newest first. What counts as a
breaking change, and when deprecated APIs are removed, is defined in
[VERSIONING.md](./VERSIONING.md).

To upgrade across several releases, apply each section in turn, starting from the oldest release
newer than the one you are on. Read the matching [CHANGELOG.md](../CHANGELOG.md) section as well;
it lists the non-breaking additions this page leaves out.

## Current deprecations

These still work, but will be removed in a future breaking release. Switching now makes that
upgrade a no-op.

| Deprecated | Use instead | Deprecated in |
|------------|-------------|---------------|
| `new DisputeClient(apiUrl, token, options?)` | `new DisputeClient(config, options?)`, with `apiBaseUrl` and `apiKey` set on the `ContractConfig` | 0.2.x |
| `EscrowMonitor.on(name, handler)` / `off(name, handler)` with a plain `string` name | A `TrustFlowEventType` literal, or a `MonitorEventName` value | 0.2.x |

## Upgrade guides

No release has shipped breaking changes yet. The following change is pending release.

### i128/u128 amount validation (Unreleased)

`toI128ScVal` and `toU128ScVal` now throw `TrustFlowError` with code `INVALID_AMOUNT`
instead of `RangeError` for invalid, unsafe or out-of-range inputs. Update handlers that
check `error instanceof RangeError` to check
`error instanceof TrustFlowError && error.code === 'INVALID_AMOUNT'`.
The shared range guard used by the decoding helpers also reports `INVALID_AMOUNT`.

Valid signed negatives (including `-1` and `-(2 ** 127)`) remain supported by i128;
u128 rejects negative amounts. Use a `bigint` or base-10 integer string for amounts
outside JavaScript's safe-integer range. Valid amounts and XDR round trips are unchanged.

<!--
Template for a new section. Copy it above this comment, newest first.

## Upgrading to X.Y.0

Released YYYY-MM-DD. Breaking changes: N.

### <Short name of the change>

**What changed:** One or two sentences, including why.

**Who is affected:** Which callers, and how they will notice (a type error, a
`TrustFlowErrorCode`, or a behaviour change).

Before:

```ts
// old usage
```

After:

```ts
// new usage
```
-->
