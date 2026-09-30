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

No release has shipped breaking changes yet. The first section will be added by the PR that
introduces one, using the template below.

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
