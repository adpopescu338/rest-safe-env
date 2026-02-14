import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  if (mode === 'cli') {
    return {
      build: {
        ssr: './src/cli/index.ts',
        emptyOutDir: false,
        outDir: 'dist',
        target: 'node20',
        rollupOptions: {
          output: {
            entryFileNames: 'cli.js',
            format: 'es',
          },
        },
      },
    };
  }

  return {
    plugins: [react()],

    build: {
      rollupOptions: {
        input: ['session.html'],
      },
    },
  };
});
