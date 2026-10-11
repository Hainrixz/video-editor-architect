import {defineConfig} from 'vitest/config';

// Pruebas unitarias del editor: corren en Node, sin red y sin tocar tus archivos originales.
// Las pruebas largas de integración no van aquí: son scripts en pruebas/integracion/.
export default defineConfig({
	test: {
		include: ['pruebas/unit/**/*.test.ts'],
		environment: 'node',
		testTimeout: 60_000,
	},
});
