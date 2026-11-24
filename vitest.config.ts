import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Keep mocks and Flue hooks on one module instance when distribution dependencies are installed.
	resolve: {
		dedupe: ['octokit', '@flue/runtime', '@earendil-works/pi-ai', 'valibot'],
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
	},
});
