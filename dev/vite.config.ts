import { defineConfig } from 'vite';
import { mockImmich } from './mock-immich';

// Preview page only (npm run preview): runs the module against a fake Immich
// album served by this dev server (dev/mock-immich.ts).
export default defineConfig({
  root: __dirname,
  esbuild: {
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  },
  plugins: [mockImmich()],
  server: { port: 5176 },
});
