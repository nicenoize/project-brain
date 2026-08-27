import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built bundle is served by scripts/brain-serve.mjs from ui/dist at /.
// base './' keeps asset URLs relative so the daemon can serve from any port.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: false }
});
