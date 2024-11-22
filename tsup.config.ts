import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    './src/index.ts',
    './src/auto.ts',
    './src/rsc-shim.ts',
    './src/core/native/index.ts',
  ],
  outDir: './dist',
  splitting: false,
  sourcemap: false,
  format: ['cjs', 'esm', 'iife'],
  target: 'esnext',
  platform: 'browser',
  treeshake: true,
  dts: true,
  minify: 'terser',
  env: {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  },
  external: ['react', 'react-dom', 'react-reconciler'],
  esbuildOptions: (options) => {
    options.external = [
      'react-native',
      '@shopify/react-native-skia',
      'react-native-reanimated',
    ];
  },
  outExtension({ format }) {
    return {
      js: `.${format === 'esm' ? 'mjs' : 'js'}`,
    };
  },
});
