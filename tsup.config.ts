import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['./src/index.ts', './src/auto.ts', './src/rsc-shim.ts'],
  outDir: './dist',
  splitting: false,
  sourcemap: false,
  format: ['cjs', 'esm', 'iife'],
  target: 'esnext',
  platform: 'browser',
  treeshake: true,
  dts: true,
  minify: false,
  env: {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  },
  external: ['react', 'react-dom', 'react-reconciler'],
});
