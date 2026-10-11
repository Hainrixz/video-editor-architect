/**
 * Pruebas de herramientas/lib/gasto.ts: sin `--si-gasto=<monto>` (o con un monto que no alcanza)
 * no se gasta nada y se sale con 3 ANTES de tocar la red.
 */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {exigirSiGasto, montoParaAprobar, parsearSiGasto} from '../../herramientas/lib/gasto.ts';

const FORMATO = /^No pude [^:\n]+: [^\n]+\. Siguiente paso: [^\n]+\.$/;
const GEMINI = {servicio: 'Gemini', estimadoUsd: 1.9};

/** Corre `fn` y devuelve el FalloEditor que lanzó; si no lanza uno, la prueba falla. */
function capturar(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no se lanzó nada');
}

/** Generador con semilla fija (mulberry32): las pruebas de propiedad siempre ven los mismos números. */
function azarConSemilla(semilla: number): () => number {
	let a = semilla >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('parsearSiGasto', () => {
	it('devuelve null si la bandera no viene', () => {
		expect(parsearSiGasto([])).toBeNull();
		expect(parsearSiGasto(['/usr/local/bin/node', 'herramientas/estilo/semantica.ts', '--reels=25'])).toBeNull();
	});

	it('lee el monto con process.argv completo o recortado', () => {
		expect(parsearSiGasto(['--si-gasto=0.05'])).toBe(0.05);
		expect(parsearSiGasto(['node', 'semantica.ts', '--reels=25', '--si-gasto=1.90'])).toBe(1.9);
		expect(parsearSiGasto(['--si-gasto=2'])).toBe(2);
		expect(parsearSiGasto(['--si-gasto=.5'])).toBe(0.5);
		expect(parsearSiGasto(['--si-gasto=0'])).toBe(0);
	});

	it('ignora lo que va después de "--" (son datos, no opciones)', () => {
		expect(parsearSiGasto(['node', 'x.ts', '--', '--si-gasto=100'])).toBeNull();
	});

	it.each([
		['vacío', '--si-gasto='],
		['con letras', '--si-gasto=abc'],
		['negativo', '--si-gasto=-1'],
		['con coma decimal', '--si-gasto=1,5'],
		['con exponente', '--si-gasto=1e3'],
		['Infinity', '--si-gasto=Infinity'],
		['NaN', '--si-gasto=NaN'],
		['hexadecimal', '--si-gasto=0x10'],
		['con signo de pesos', '--si-gasto=$5'],
		['con espacio', '--si-gasto= 5'],
		['tan grande que Number() da Infinity', `--si-gasto=${'9'.repeat(400)}`],
	])('rechaza un monto %s con código 2 (entrada inválida)', (_caso, arg) => {
		const error = capturar(() => parsearSiGasto([arg]));
		expect(error.codigo).toBe(2);
		expect(error.message).toMatch(FORMATO);
		expect(error.message).toContain('--si-gasto=0.05');
	});

	it('rechaza la bandera sin signo igual o repetida con código 2', () => {
		expect(capturar(() => parsearSiGasto(['--si-gasto', '5'])).codigo).toBe(2);
		const repetida = capturar(() => parsearSiGasto(['--si-gasto=0.01', '--si-gasto=5']));
		expect(repetida.codigo).toBe(2);
		expect(repetida.message).toBe(
			'No pude leer --si-gasto: viene 2 veces y no sé cuál vale. Siguiente paso: déjalo una sola vez, como --si-gasto=0.05.',
		);
	});
});

describe('exigirSiGasto', () => {
	const fetchFalso = vi.fn(async () => new Response('{}'));

	/** Una herramienta de mentira que hace lo que debe: primero el candado, después la red. */
	async function herramientaQueGasta(argv: string[]): Promise<void> {
		exigirSiGasto(argv, GEMINI);
		await fetch('https://generativelanguage.googleapis.com/v1beta/models');
	}

	beforeEach(() => {
		fetchFalso.mockClear();
		vi.stubGlobal('fetch', fetchFalso);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sin --si-gasto lanza código 3 con el monto estimado y no llama a la red', async () => {
		const error = await herramientaQueGasta(['node', 'semantica.ts']).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(3);
		expect((error as FalloEditor).message).toBe(
			'No pude usar Gemini: el gasto estimado es US$1.90 y no tengo tu sí (falta --si-gasto). ' +
				'Siguiente paso: dime sí a US$1.90 y lo corro con --si-gasto=1.90.',
		);
		expect(fetchFalso).not.toHaveBeenCalled();
	});

	it('lanza de forma síncrona: no hace falta ni un await para frenar el gasto', () => {
		expect(() => exigirSiGasto([], GEMINI)).toThrow(FalloEditor);
	});

	it('con un monto menor al estimado lanza código 3 y no llama a la red', async () => {
		const error = await herramientaQueGasta(['--si-gasto=1']).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(3);
		expect((error as FalloEditor).message).toBe(
			'No pude usar Gemini: el gasto estimado es US$1.90 y solo aprobaste US$1.00. ' +
				'Siguiente paso: dime sí a US$1.90 y lo corro con --si-gasto=1.90.',
		);
		expect(fetchFalso).not.toHaveBeenCalled();
	});

	it('con un monto igual o mayor al estimado pasa, devuelve lo aprobado y entonces sí llama a la red', async () => {
		await herramientaQueGasta(['--si-gasto=1.90']);
		expect(fetchFalso).toHaveBeenCalledTimes(1);
		expect(exigirSiGasto(['--si-gasto=1.90'], GEMINI)).toBe(1.9);
		expect(exigirSiGasto(['--si-gasto=5'], GEMINI)).toBe(5);
	});

	it('no se confunde con el punto flotante (0.1 + 0.2 aprobado como 0.30)', () => {
		expect(exigirSiGasto(['--si-gasto=0.30'], {servicio: 'Apify', estimadoUsd: 0.1 + 0.2})).toBe(0.3);
	});

	it('con un estimado de fracción de centavo muestra el estimado y pide el centavo completo', () => {
		const error = capturar(() => exigirSiGasto([], {servicio: 'Apify', estimadoUsd: 0.0026}));
		expect(error.codigo).toBe(3);
		expect(error.message).toBe(
			'No pude usar Apify: el gasto estimado es US$0.0026 y no tengo tu sí (falta --si-gasto). ' +
				'Siguiente paso: dime sí a US$0.01 y lo corro con --si-gasto=0.01.',
		);
		expect(exigirSiGasto(['--si-gasto=0.01'], {servicio: 'Apify', estimadoUsd: 0.0026})).toBe(0.01);
	});

	it.each([
		['NaN', Number.NaN],
		['negativo', -1],
		['Infinity', Number.POSITIVE_INFINITY],
		['un texto', '1.90' as unknown as number],
	])('con un estimado roto (%s) falla con código 1 aunque haya un sí enorme', (_caso, estimadoUsd) => {
		const error = capturar(() => exigirSiGasto(['--si-gasto=1000'], {servicio: 'Gemini', estimadoUsd}));
		expect(error.codigo).toBe(1);
		expect(error.message).toMatch(FORMATO);
	});

	it('sin nombre de servicio falla con código 1', () => {
		expect(capturar(() => exigirSiGasto(['--si-gasto=1'], {servicio: '  ', estimadoUsd: 0.5})).codigo).toBe(1);
	});

	it('una bandera mal escrita gana a todo lo demás con código 2 y tampoco gasta', async () => {
		const error = await herramientaQueGasta(['--si-gasto=1,90']).then(
			() => null,
			(e: unknown) => e,
		);
		expect((error as FalloEditor).codigo).toBe(2);
		expect(fetchFalso).not.toHaveBeenCalled();
	});
});

describe('montoParaAprobar', () => {
	it('redondea hacia arriba al centavo, con mínimo de un centavo si cuesta algo', () => {
		expect(montoParaAprobar(0)).toBe('0.00');
		expect(montoParaAprobar(1.9)).toBe('1.90');
		expect(montoParaAprobar(0.3)).toBe('0.30');
		expect(montoParaAprobar(0.1 + 0.2)).toBe('0.30');
		expect(montoParaAprobar(0.301)).toBe('0.31');
		expect(montoParaAprobar(0.0001)).toBe('0.01');
		expect(montoParaAprobar(0.78)).toBe('0.78');
	});

	it('propiedad (200 estimados con semilla fija): el sí que pide el mensaje pasa y un centavo menos no', () => {
		const azar = azarConSemilla(20261003);
		for (let n = 0; n < 200; n++) {
			// Mezcla montos chicos (fracciones de centavo) y grandes, con muchos decimales.
			const estimadoUsd = n % 2 === 0 ? azar() * 0.05 : azar() * 60;
			const error = capturar(() => exigirSiGasto([], {servicio: 'Gemini', estimadoUsd}));
			const pedido = /--si-gasto=(\d+\.\d{2})\.$/.exec(error.message)?.[1];
			expect(pedido).toBe(montoParaAprobar(estimadoUsd));
			expect(exigirSiGasto([`--si-gasto=${pedido}`], {servicio: 'Gemini', estimadoUsd})).toBe(Number(pedido));
			if (pedido === '0.00') continue; // estimado de menos de una millonésima de centavo: no hay "un centavo menos"
			const unoMenos = ((Math.round(Number(pedido) * 100) - 1) / 100).toFixed(2);
			expect(capturar(() => exigirSiGasto([`--si-gasto=${unoMenos}`], {servicio: 'Gemini', estimadoUsd})).codigo).toBe(3);
		}
	});
});

describe('de punta a punta: una herramienta real con correr() (npx tsx)', () => {
	const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const TSX = join(RAIZ, 'node_modules', 'tsx', 'dist', 'cli.mjs');
	let carpeta = '';
	let marca = '';
	let script = '';

	beforeAll(() => {
		carpeta = mkdtempSync(join(tmpdir(), 'editor-gasto-'));
		marca = join(carpeta, 'red-tocada.txt');
		script = join(carpeta, 'herramienta.mts');
		writeFileSync(
			script,
			[
				"import {writeFileSync} from 'node:fs';",
				`import {correr} from '${pathToFileURL(join(RAIZ, 'herramientas', 'lib', 'fallo.ts')).href}';`,
				`import {exigirSiGasto} from '${pathToFileURL(join(RAIZ, 'herramientas', 'lib', 'gasto.ts')).href}';`,
				// fetch de mentira: si alguien lo llama, deja una marca en disco. No sale nada a internet.
				`globalThis.fetch = (async () => { writeFileSync(${JSON.stringify(marca)}, 'red'); return new Response('{}'); }) as typeof fetch;`,
				'void correr(async () => {',
				"\texigirSiGasto(process.argv.slice(2), {servicio: 'Gemini', estimadoUsd: 1.9});",
				"\tawait fetch('https://generativelanguage.googleapis.com/v1beta/models');",
				'});',
			].join('\n'),
		);
	});

	afterAll(() => {
		if (carpeta) rmSync(carpeta, {recursive: true, force: true});
	});

	function correrHerramienta(args: string[]) {
		rmSync(marca, {force: true});
		const entorno: Record<string, string> = {};
		for (const nombre of ['PATH', 'HOME', 'TMPDIR']) {
			const valor = process.env[nombre];
			if (valor !== undefined) entorno[nombre] = valor;
		}
		const r = spawnSync(process.execPath, [TSX, script, ...args], {cwd: carpeta, env: entorno, encoding: 'utf8', timeout: 30_000});
		return {codigo: r.status, stderr: r.stderr, tocoLaRed: existsSync(marca)};
	}

	it('sin --si-gasto sale con 3 y nunca llega a fetch', () => {
		const r = correrHerramienta([]);
		expect(r.codigo).toBe(3);
		expect(r.stderr).toBe(
			'No pude usar Gemini: el gasto estimado es US$1.90 y no tengo tu sí (falta --si-gasto). ' +
				'Siguiente paso: dime sí a US$1.90 y lo corro con --si-gasto=1.90.\n',
		);
		expect(r.tocoLaRed).toBe(false);
	});

	it('con un monto que no alcanza sale con 3 y nunca llega a fetch', () => {
		const r = correrHerramienta(['--si-gasto=1.89']);
		expect(r.codigo).toBe(3);
		expect(r.tocoLaRed).toBe(false);
	});

	it('con el sí completo sale con 0 y entonces sí llega a fetch', () => {
		const r = correrHerramienta(['--si-gasto=1.90']);
		expect(r.codigo).toBe(0);
		expect(r.stderr).toBe('');
		expect(r.tocoLaRed).toBe(true);
	});
});
