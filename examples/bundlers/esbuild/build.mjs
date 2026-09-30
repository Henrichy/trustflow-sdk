/**
 * esbuild browser build of the TrustFlow SDK.
 *
 * ## The point of this file
 *
 * esbuild has no Node polyfills either: for `platform: 'browser'` it refuses to
 * resolve a Node built-in unless the bundle explicitly declares it, and it
 * resolves the `browser` export condition, so `@stellar/stellar-sdk` resolves to
 * its prebundled browser build.
 *
 * There is nothing SDK-specific in the settings below — `platform: 'browser'`
 * and `format: 'esm'` are esbuild defaults for a browser bundle. The
 * `NODE_BUILTINS` list is only used by the post-build scan in
 * `verify-bundlers.mjs`.
 *
 * Run with: npm run test:bundlers
 */
export const options = {
  entryPoints: [new URL('../shared-entry.ts', import.meta.url).pathname],
  outfile: new URL('dist/bundle.js', import.meta.url).pathname,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  // Load the example's TypeScript through esbuild itself — no plugins needed.
  loader: { '.ts': 'ts' },
  // No `external`, no `inject`, no `define` for Node globals. If a Node built-in
  // ever reached this graph, esbuild would fail rather than polyfill it.
  logLevel: 'silent',
};

/** Node core modules that must never appear in a browser bundle. */
export const NODE_BUILTINS = [
  'assert', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events',
  'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'tls',
  'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
];
