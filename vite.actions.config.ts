import { defineConfig } from 'vite';

// Only the Actions entry is reachable. No worker routes or unrelated agents are scanned.
export default defineConfig({
	build: {
		ssr: 'actions/index.ts',
		outDir: 'actions/dist',
		emptyOutDir: true,
		rollupOptions: { output: { entryFileNames: 'index.mjs' } },
	},
});
