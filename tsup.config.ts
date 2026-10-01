import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/hooks/index.ts',
    // Subpath build targets so the README's documented imports
    // (`@trustflow/sdk/escrow` etc.) resolve against the published package (#100).
    'src/escrow/index.ts',
    'src/wallet/index.ts',
    'src/utils/index.ts',
    'src/testing/index.ts',
    // Node-only entry. The only module graph in the package that reaches for
    // `http`/`https`, which is what keeps every other entry polyfill-free in a
    // browser bundle (#webpack5).
    'src/node/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  // Shared chunks keep a single copy of TrustFlowError, logger and the escrow classes
  // across the root and subpath entries (#304).
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  outDir: 'dist',
  target: 'es2020',
  // `neutral` (rather than `node`) so no entry silently gains Node built-ins.
  // Node's own `http`/`https` stay external — they are runtime globals of the
  // process, not dependencies to bundle.
  platform: 'neutral',
  external: ['http', 'https', 'node:http', 'node:https'],
});
