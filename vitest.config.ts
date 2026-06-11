import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'src/**/*.test.ts',
			'src/**/__tests__/**/*.test.ts',
			'tests/**/*.test.ts',
			'parity/**/*.test.ts',
			'bench/**/*.test.ts',
		],
		environment: 'node',
		globals: true,
		testTimeout: 10000,
		pool: 'threads',
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
			thresholds: {
				statements: 70,
				functions: 70,
				lines: 70,
				branches: 65,
			},
		},
	},
});
