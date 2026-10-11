/**
 * El motor del estilo (herramientas/lib/perfil-estilo.ts → leerPerfilMotor): MOTOR_NEUTRO sin creador.json ni estilo,
 * mezcla de un `motor` parcial, errores con código 2, cortes.ts tomando velocidad y aires del perfil (o de sus
 * archivos de respaldo) y el perfil del estilo activo del repo cuadrando con los valores que antes estaban fijos.
 */
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {preferenciasDeCortes} from '../../herramientas/cortes.ts';
import {leerCreador} from '../../herramientas/lib/creador.ts';
import {estiloDesde} from '../../herramientas/lib/director/estilo.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {RAIZ} from '../../herramientas/lib/manifest.ts';
import {leerPerfilMotor, MOTOR_NEUTRO, ZONA_NEUTRA} from '../../herramientas/lib/perfil-estilo.ts';

const tmp = mkdtempSync(join(tmpdir(), 'perfil-motor-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

let n = 0;
/** Raíz temporal con creador.json (si `estilo`), su perfil (si `perfil`) y archivos de estilo/ (si `archivos`). */
function raiz(op: {estilo?: string | null; perfil?: unknown; archivos?: Record<string, unknown>} = {}): string {
	const r = join(tmp, `r${n++}`);
	mkdirSync(join(r, 'proyectos'), {recursive: true});
	if (op.estilo !== undefined) writeFileSync(join(r, 'creador.json'), JSON.stringify({handle: 'creador-demo', estilo_activo: op.estilo}));
	if (op.estilo && op.perfil !== undefined) {
		mkdirSync(join(r, 'estilo', 'estilos', op.estilo), {recursive: true});
		writeFileSync(join(r, 'estilo', 'estilos', op.estilo, 'perfil.json'), typeof op.perfil === 'string' ? op.perfil : JSON.stringify(op.perfil));
	}
	for (const [nombre, datos] of Object.entries(op.archivos ?? {})) {
		mkdirSync(join(r, 'estilo'), {recursive: true});
		writeFileSync(join(r, 'estilo', nombre), JSON.stringify(datos));
	}
	return r;
}

function falloDe(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor');
}

describe('leerPerfilMotor', () => {
	it('sin creador.json o sin estilo activo: MOTOR_NEUTRO (×1, zona neutra, ritmo medido)', () => {
		for (const r of [raiz(), raiz({estilo: null})]) {
			const m = leerPerfilMotor({raiz: r});
			expect(m).toEqual(MOTOR_NEUTRO);
			expect(m.velocidad?.factor).toBe(1);
			expect(m.aires).toMatchObject({hueco_minimo_s: 0.3, umbral_sobre_piso_db: 12, quitar_sueltos_s: 0});
			expect(m.zona).toEqual(ZONA_NEUTRA);
			expect(m.ritmo).toBeNull();
			expect(m.origen).toEqual({estilo: null, archivo: null, claves: []});
		}
	});

	it('un perfil sin `motor` da el neutro con su origen; un `motor` parcial se mezcla campo por campo en la zona', () => {
		const sin = leerPerfilMotor({raiz: raiz({estilo: 'demo', perfil: {id: 'demo'}})});
		expect(sin.zona).toEqual(ZONA_NEUTRA);
		expect(sin.origen).toEqual({estilo: 'demo', archivo: 'estilo/estilos/demo/perfil.json', claves: []});
		const m = leerPerfilMotor({raiz: raiz({estilo: 'demo', perfil: {motor: {velocidad: {factor: 1.1, decision: 'prueba'}, zona: {subtitulos_y: 1500, bajada_capas_px: 10}}}})});
		expect(m.velocidad).toEqual({factor: 1.1, decision: 'prueba'});
		expect(m.aires).toEqual(MOTOR_NEUTRO.aires);
		expect(m.zona).toEqual({...ZONA_NEUTRA, subtitulos_y: 1500, bajada_capas_px: 10});
		expect(m.origen.claves).toEqual(['velocidad', 'zona']);
	});

	it('`estilo` en las opciones manda sobre creador.json', () => {
		const r = raiz({estilo: 'demo', perfil: {motor: {ritmo: {tarjetas_por_min: 12, stickers_por_min: 4, fuente: 'prueba'}}}});
		expect(leerPerfilMotor({raiz: r, estilo: 'demo'}).ritmo?.tarjetas_por_min).toBe(12);
		expect(falloDe(() => leerPerfilMotor({raiz: r, estilo: 'otro'})).codigo).toBe(2);
	});

	it('código 2: estilo inexistente, id inválido, perfil que no es JSON o `motor` con forma mala', () => {
		expect(falloDe(() => leerPerfilMotor({raiz: raiz({estilo: 'no-existe'})})).codigo).toBe(2);
		expect(falloDe(() => leerPerfilMotor({raiz: raiz(), estilo: '../fuera'})).codigo).toBe(2);
		expect(falloDe(() => leerPerfilMotor({raiz: raiz({estilo: 'demo', perfil: '{'})})).codigo).toBe(2);
		expect(falloDe(() => leerPerfilMotor({raiz: raiz({estilo: 'demo', perfil: {motor: {velocidad: {factor: 5, decision: 'x'}}}})})).codigo).toBe(2);
		expect(falloDe(() => leerPerfilMotor({raiz: raiz({estilo: 'demo', perfil: {motor: {zona: {tarjeta_letra: -1}}}})})).codigo).toBe(2);
	});

	it('la zona del perfil llega al estilo del director (decisión como objeto)', () => {
		const m = leerPerfilMotor({raiz: raiz({estilo: 'demo', perfil: {motor: {zona: {bajada_capas_px: 20, puede_tapar_cara: true, margen_boca_px: -1920, nota_cara: 'prueba'}}}})});
		const con = estiloDesde({decision: m.zona});
		const sin = estiloDesde({decision: false});
		expect(con.tarjeta.y.valor).toBeCloseTo(sin.tarjeta.y.valor + 20, 6);
		expect(con.cabeza.margen_boca.valor).toBe(-1920);
	});
});

describe('cortes.ts: velocidad y aires del perfil, con sus archivos de respaldo', () => {
	const vel = {factor: 1.2, decision: 'archivo de respaldo'};
	const aires = {hueco_minimo_s: 0.15, umbral_sobre_piso_db: 20, decision: 'archivo de respaldo'};

	it('sin creador.json: los archivos estilo/velocidad.json y estilo/aires.json (o nada)', () => {
		expect(preferenciasDeCortes(join(raiz(), 'proyectos'))).toEqual({velocidad: null, aires: null});
		const r = raiz({archivos: {'velocidad.json': vel, 'aires.json': aires}});
		const p = preferenciasDeCortes(join(r, 'proyectos'));
		expect(p.velocidad?.factor).toBe(1.2);
		expect(p.aires).toMatchObject({huecoMinimoS: 0.15, umbralSobrePisoDb: 20});
	});

	it('el perfil manda sobre los archivos; lo que el perfil no trae sale de ellos', () => {
		const r = raiz({estilo: 'demo', perfil: {motor: {velocidad: {factor: 1.05, decision: 'del perfil'}}}, archivos: {'velocidad.json': vel, 'aires.json': aires}});
		const p = preferenciasDeCortes(join(r, 'proyectos'));
		expect(p.velocidad?.factor).toBe(1.05);
		expect(p.velocidad?.decision).toMatch(/del perfil/);
		expect(p.aires?.huecoMinimoS).toBe(0.15);
		const r2 = raiz({estilo: 'demo', perfil: {motor: {aires: {hueco_minimo_s: 0.12, umbral_sobre_piso_db: 24, quitar_sueltos_s: 0.6, decision: 'del perfil'}}}});
		expect(preferenciasDeCortes(join(r2, 'proyectos')).aires).toMatchObject({huecoMinimoS: 0.12, umbralSobrePisoDb: 24, quitarSueltosS: 0.6});
	});
});

describe('el estilo activo del repo', () => {
	const activo = leerCreador().estilo_activo;

	const leer = (nombre: string): Record<string, unknown> | null => (existsSync(join(RAIZ, 'estilo', nombre)) ? JSON.parse(readFileSync(join(RAIZ, 'estilo', nombre), 'utf8')) : null);
	// Los archivos de respaldo de antes del motor (estilo/velocidad.json y aires.json) solo existen en el repo que
	// tenía esos valores fijos en el código; la plantilla no los trae y ahí esta regresión no aplica.
	const heredado = leer('velocidad.json') !== null && leer('aires.json') !== null;

	it.runIf(activo !== null)('su motor cuadra con los archivos de respaldo que existan', () => {
		const m = leerPerfilMotor();
		expect(m.origen.estilo).toBe(activo);
		const vel = leer('velocidad.json');
		if (vel && m.velocidad) expect(m.velocidad.factor).toBe(vel.factor);
		const aires = leer('aires.json');
		if (aires && m.aires) expect(m.aires).toMatchObject({hueco_minimo_s: aires.hueco_minimo_s, umbral_sobre_piso_db: aires.umbral_sobre_piso_db, quitar_sueltos_s: aires.quitar_sueltos_s});
	});

	it.runIf(activo !== null && heredado)('trae velocidad, aires, zona y ritmo con los valores que antes estaban fijos en el código', () => {
		const m = leerPerfilMotor();
		expect(m.origen.claves).toEqual(expect.arrayContaining(['velocidad', 'aires', 'zona', 'ritmo']));
		// La zona que antes estaba fija en src/estilo/zona-segura.ts.
		expect(m.zona).toMatchObject({subtitulos_y: 1545, bajada_capas_px: 46.5, tarjeta_letra: 0.88, tarjeta_relleno: 0.65, prompt_letra: 0.94, ancho_max: 810, puede_tapar_cara: true, margen_boca_px: -1920});
		expect(m.ritmo).toMatchObject({tarjetas_por_min: 15, stickers_por_min: 5, tarjetas_con_emoji: 0.25});
		expect(preferenciasDeCortes().velocidad?.factor).toBe(m.velocidad?.factor);
	});
});
