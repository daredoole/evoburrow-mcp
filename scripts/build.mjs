import { build } from "esbuild";

await build({
  entryPoints: ["server.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["node-pty"],
  outfile: "dist/server.mjs",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
