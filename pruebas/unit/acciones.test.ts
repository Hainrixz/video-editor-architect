// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/grabador/acciones.ts (y de las partes puras de estudio.ts que deciden qué se permite):
 * - Un paso que no es de lectura sale con 3 ANTES de ejecutarse si el guion no trae tu sí.
 * - Un paso de gasto necesita además costo_usd y --si-gasto=<monto>.
 * - Las teclas se registran solo como {tipo: "tecla"}: el texto nunca llega a los eventos ni a los mensajes.
 * - sitios.txt: una URL fuera de la lista no se navega (código 2).
 * - Ventana: Retina si hay; si no, DSF forzado (y se dice).
 * Corren dentro del sandbox: sin navegador, sin red.
 */
import {mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {crearEjecutor, describirPaso, ejecutarGuion, Paso, revisarGuion, revisarRiesgo, validarGuion, type Ejecutor, type Guion} from '../../herramientas/grabador/acciones.ts';
import {elegirUbicacion, pantallasDeCocoa, parsearArgs, prepararPerfil, resumirSystemProfiler, revisarPerfil, urlPermitida, leerSitios} from '../../herramientas/grabador/estudio.ts';

function capturar(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no se lanzó nada');
}

async function capturarAsync(p: Promise<unknown>): Promise<FalloEditor> {
	try {
		await p;
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no se lanzó nada');
}

const FORMATO = /^No pude [^:\n]+: [^\n]+\. Siguiente paso: [^\n]+\.$/;

const lectura = (extra: Partial<Paso> = {}): Paso => ({accion: 'esperar', ms: 10, riesgo: 'lectura', ...extra}) as Paso;
const guion = (pasos: Paso[], aprobado = false): Guion => validarGuion({version: 1, aprobado, pasos});

describe('formato del guion', () => {
	it('acepta un guion de lectura (como el de la demo de GitHub)', () => {
		const g = validarGuion({
			version: 1,
			pasos: [
				{accion: 'ir', url: 'https://github.com/latent-spaces/brag', riesgo: 'lectura'},
				{accion: 'scroll', px: 700, duracion_ms: 1500, riesgo: 'lectura'},
				{accion: 'clic', rol: 'button', nombre: 'Code', riesgo: 'lectura'},
				{accion: 'esperar', ms: 1200, riesgo: 'lectura'},
			],
		});
		expect(g.aprobado).toBe(false);
		expect(g.pasos).toHaveLength(4);
	});

	it.each([
		['sin riesgo', {accion: 'clic', selector: '#a'}],
		['riesgo desconocido', {accion: 'clic', selector: '#a', riesgo: 'borrar'}],
		['clic sin selector ni rol', {accion: 'clic', riesgo: 'lectura'}],
		['rol sin nombre', {accion: 'clic', rol: 'button', riesgo: 'lectura'}],
		['gasto sin costo_usd', {accion: 'clic', selector: '#pagar', riesgo: 'gasto'}],
		['acción desconocida', {accion: 'descargar', riesgo: 'lectura'}],
		['campo de más', {accion: 'clic', selector: '#a', riesgo: 'lectura', texto_oculto: 'x'}],
	])('rechaza un paso %s con código 2', (_nombre, paso) => {
		const e = capturar(() => validarGuion({version: 1, pasos: [paso]}));
		expect(e.codigo).toBe(2);
		expect(e.message).toMatch(FORMATO);
	});

	it('rechaza un guion sin pasos o de otra versión', () => {
		expect(capturar(() => validarGuion({version: 1, pasos: []})).codigo).toBe(2);
		expect(capturar(() => validarGuion({version: 2, pasos: [lectura()]})).codigo).toBe(2);
	});

	it('tema: oscuro por defecto (como tus pantallas), y solo oscuro, oscuro-forzado o claro', () => {
		expect(validarGuion({version: 1, pasos: [lectura()]}).tema).toBe('oscuro');
		expect(validarGuion({version: 1, tema: 'oscuro-forzado', pasos: [lectura()]}).tema).toBe('oscuro-forzado');
		expect(validarGuion({version: 1, tema: 'claro', pasos: [lectura()]}).tema).toBe('claro');
		expect(capturar(() => validarGuion({version: 1, tema: 'sepia', pasos: [lectura()]})).codigo).toBe(2);
		expect(parsearArgs(['captura', 'https://x.com', '--tema', 'claro']).opciones.get('--tema')).toBe('claro');
	});

	it('idioma: opcional, con código BCP 47 corto ("es", "es-MX")', () => {
		expect(validarGuion({version: 1, pasos: [lectura()]}).idioma).toBeUndefined();
		expect(validarGuion({version: 1, idioma: 'es-MX', pasos: [lectura()]}).idioma).toBe('es-MX');
		expect(capturar(() => validarGuion({version: 1, idioma: 'español', pasos: [lectura()]})).codigo).toBe(2);
	});
});

describe('candado de riesgo (criterio del plan)', () => {
	const escribir: Paso = {accion: 'escribir', selector: '#nota', texto: 'hola', riesgo: 'escritura'};
	const publicar: Paso = {accion: 'clic', rol: 'button', nombre: 'Publicar', riesgo: 'publica'};
	const pagar: Paso = {accion: 'clic', selector: '#pagar', riesgo: 'gasto', costo_usd: 0.5};

	it('un paso de lectura siempre pasa', () => {
		expect(() => revisarRiesgo(lectura(), 0, {aprobado: false}, [])).not.toThrow();
	});

	it.each([
		['escritura', escribir],
		['publica', publicar],
		['gasto', pagar],
	])('un paso de %s sin aprobado: true sale con 3', (_n, paso) => {
		const e = capturar(() => revisarRiesgo(paso, 4, {aprobado: false}, ['--si-gasto=100']));
		expect(e.codigo).toBe(3);
		expect(e.message).toMatch(FORMATO);
		expect(e.message).toContain('paso 5');
	});

	it('con tu sí, escritura y publica pasan', () => {
		expect(() => revisarRiesgo(escribir, 0, {aprobado: true}, [])).not.toThrow();
		expect(() => revisarRiesgo(publicar, 0, {aprobado: true}, [])).not.toThrow();
	});

	it('un gasto con tu sí necesita además --si-gasto que cubra el costo', () => {
		expect(capturar(() => revisarRiesgo(pagar, 0, {aprobado: true}, [])).codigo).toBe(3);
		expect(capturar(() => revisarRiesgo(pagar, 0, {aprobado: true}, ['--si-gasto=0.10'])).codigo).toBe(3);
		expect(() => revisarRiesgo(pagar, 0, {aprobado: true}, ['--si-gasto=0.50'])).not.toThrow();
	});

	it('sale con 3 ANTES de ejecutar cualquier paso (el ejecutor no se llama)', async () => {
		const llamados: number[] = [];
		const ejecutor: Ejecutor = async (_p, i) => {
			llamados.push(i);
			return [];
		};
		const g = guion([lectura(), lectura(), pagar, lectura()]);
		const e = await capturarAsync(ejecutarGuion(g, [], ejecutor));
		expect(e.codigo).toBe(3);
		expect(llamados).toEqual([]);
		expect(capturar(() => revisarGuion(g, [])).codigo).toBe(3);
	});

	it('con tu sí corre todos los pasos en orden', async () => {
		const llamados: number[] = [];
		const g = guion([lectura(), escribir, lectura()], true);
		await ejecutarGuion(g, [], async (_p, i) => {
			llamados.push(i);
			return [];
		});
		expect(llamados).toEqual([0, 1, 2]);
	});
});

describe('teclas sin texto', () => {
	it('describirPaso nunca muestra lo que se teclea', () => {
		const p: Paso = {accion: 'escribir', selector: '#q', texto: 'mi-clave-123', riesgo: 'lectura'};
		expect(describirPaso(p)).not.toContain('mi-clave-123');
		expect(describirPaso(p)).toContain('12 caracteres');
		const sensible: Paso = {accion: 'escribir', selector: '#q', texto: 'mi-clave-123', sensible: true, riesgo: 'lectura'};
		expect(describirPaso(sensible)).not.toMatch(/12|mi-clave/);
		expect(describirPaso({accion: 'tecla', texto: 'Enter', sensible: true, riesgo: 'lectura'})).toBe('tecla sensible');
	});

	it('escribir deja un evento {tipo: "tecla"} con la caja del campo y sin el texto', async () => {
		const {pagina, llamadas} = paginaFalsa();
		const ejecutor = crearEjecutor({pagina, reloj: relojFalso(), escala: async () => 2, permitido: () => true, pausaMs: 0});
		const eventos = await ejecutor({accion: 'escribir', selector: '#q', texto: 'mi-clave-123', riesgo: 'lectura'}, 0);
		expect(eventos.map((e) => e.tipo)).toEqual(['clic', 'tecla']);
		const tecla = eventos[1];
		expect(Object.keys(tecla).sort()).toEqual(['caja', 'dur', 'escala', 'reloj', 'tipo']);
		expect(tecla.caja).toEqual({x: 100, y: 200, w: 80, h: 30});
		expect(JSON.stringify(eventos)).not.toContain('mi-clave-123');
		expect(llamadas).toContain('teclear:12');
	});

	it('un clic mueve el mouse al centro de la caja y registra el evento', async () => {
		const {pagina, llamadas} = paginaFalsa();
		const ejecutor = crearEjecutor({pagina, reloj: relojFalso(), escala: async () => 2, permitido: () => true, pausaMs: 0});
		const eventos = await ejecutor({accion: 'clic', rol: 'button', nombre: 'Code', riesgo: 'lectura'}, 0);
		expect(eventos).toHaveLength(1);
		expect(eventos[0]).toMatchObject({tipo: 'clic', caja: {x: 100, y: 200, w: 80, h: 30}, escala: 2});
		expect(llamadas).toContain('getByRole:button:Code');
		expect(llamadas).toContain('mover:140,215');
		expect(llamadas.indexOf('bajar')).toBeLessThan(llamadas.indexOf('subir'));
	});

	it('"ir" a un sitio fuera de la lista sale con 2 sin navegar', async () => {
		const {pagina, llamadas} = paginaFalsa();
		const sitios = ['github.com'];
		const ejecutor = crearEjecutor({pagina, reloj: relojFalso(), escala: async () => 2, permitido: (u) => urlPermitida(u, sitios), pausaMs: 0});
		const e = await capturarAsync(ejecutor({accion: 'ir', url: 'https://evil.example.com/robar', riesgo: 'lectura'}, 0));
		expect(e.codigo).toBe(2);
		expect(llamadas.some((l) => l.startsWith('ir:'))).toBe(false);
		await ejecutor({accion: 'ir', url: 'https://github.com/latent-spaces/brag', riesgo: 'lectura'}, 1);
		expect(llamadas).toContain('ir:https://github.com/latent-spaces/brag');
	});
});

describe('sitios.txt', () => {
	const dir = mkdtempSync(join(tmpdir(), 'acciones-sitios-'));
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it('permite el dominio y sus subdominios, y nada más', () => {
		const s = ['github.com', '127.0.0.1:8080'];
		expect(urlPermitida('https://github.com/latent-spaces/brag', s)).toBe(true);
		expect(urlPermitida('https://gist.github.com/x', s)).toBe(true);
		expect(urlPermitida('https://notgithub.com/x', s)).toBe(false);
		expect(urlPermitida('https://github.com.evil.io/x', s)).toBe(false);
		expect(urlPermitida('http://127.0.0.1:8080/a.html', s)).toBe(true);
		expect(urlPermitida('http://127.0.0.1:9090/a.html', s)).toBe(false);
		expect(urlPermitida('file:///etc/passwd', s)).toBe(false);
		expect(urlPermitida('javascript:alert(1)', s)).toBe(false);
		expect(urlPermitida('about:blank', s)).toBe(true);
	});

	it('lee un dominio por línea, con comentarios', () => {
		writeFileSync(join(dir, 'sitios.txt'), '# demo\nGitHub.com\nhttps://docs.github.com/es\n\n');
		expect(leerSitios(dir)).toEqual(['github.com', 'docs.github.com']);
	});

	it('un sitios.txt vacío es un error tuyo (código 2); sin archivo devuelve null', () => {
		const vacio = join(dir, 'vacio');
		mkdirSync(vacio);
		expect(leerSitios(vacio)).toBeNull();
		writeFileSync(join(vacio, 'sitios.txt'), '# nada\n');
		expect(capturar(() => leerSitios(vacio)).codigo).toBe(2);
	});
});

describe('ventana del estudio', () => {
	// Tu Mac el 2026-10-03: LG 2560×1080 a 1× (principal) y la Retina 1512×982 pt a 2× debajo.
	const cocoa = [
		{nombre: 'LG ULTRAGEAR', x: 0, y: 0, w: 2560, h: 1080, vx: 0, vy: 0, vw: 2560, vh: 1050, escala: 1},
		{nombre: 'Built-in Retina Display', x: 563, y: -982, w: 1512, h: 982, vx: 563, vy: -917, vw: 1512, vh: 885, escala: 2},
	];

	it('pasa las coordenadas de Cocoa a las de Chrome (origen arriba-izquierda)', () => {
		const p = pantallasDeCocoa(cocoa);
		expect(p[1]).toMatchObject({x: 563, y: 1080, w: 1512, h: 982, escala: 2, principal: false});
		expect(p[1].visible).toEqual({x: 563, y: 1112, w: 1512, h: 885});
		expect(p[0].visible).toEqual({x: 0, y: 30, w: 2560, h: 1050});
	});

	it('elige la Retina y centra la ventana arriba de su área visible', () => {
		const u = elegirUbicacion(pantallasDeCocoa(cocoa));
		expect(u.modo).toBe('retina');
		if (u.modo === 'retina') expect([u.x, u.y]).toEqual([679, 1112]);
	});

	it('sin Retina (tapa cerrada) usa DSF forzado y lo dice', () => {
		const u = elegirUbicacion(pantallasDeCocoa([cocoa[0]]));
		expect(u.modo).toBe('forzado');
		expect(u.nota).toContain('--force-device-scale-factor=2');
		expect(elegirUbicacion(null).modo).toBe('forzado');
	});

	it('lee system_profiler: la integrada es Retina y la LG no', () => {
		const p = resumirSystemProfiler({
			SPDisplaysDataType: [
				{
					spdisplays_ndrvs: [
						{_name: 'LG ULTRAGEAR', _spdisplays_pixels: '2560 x 1080', _spdisplays_resolution: '2560 x 1080 @ 144.00Hz', spdisplays_main: 'spdisplays_yes'},
						{_name: 'Color LCD', _spdisplays_pixels: '3024 x 1964', _spdisplays_resolution: '1512 x 982 @ 120.00Hz', spdisplays_connection_type: 'spdisplays_internal', spdisplays_pixelresolution: 'spdisplays_3024x1964Retina'},
					],
				},
			],
		});
		expect(p.map((x) => [x.nombre, x.retina, x.integrada, x.principal])).toEqual([
			['LG ULTRAGEAR', false, false, true],
			['Color LCD', true, true, false],
		]);
	});
});

describe('perfil del estudio', () => {
	it('se crea con permisos 700, sin guardar contraseñas ni autollenar, y respeta lo demás', () => {
		const dir = join(mkdtempSync(join(tmpdir(), 'acciones-perfil-')), 'estudio-chrome');
		mkdirSync(join(dir, 'Default'), {recursive: true});
		writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({credentials_enable_service: true, intl: {accept_languages: 'es-MX'}}));
		prepararPerfil(dir);
		const r = revisarPerfil(dir);
		expect(r).toEqual({permisos: '700', credenciales_apagadas: true, autollenado_apagado: true});
		const pref = JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'));
		expect(pref.intl.accept_languages).toBe('es-MX');
		expect((statSync(join(dir, 'Default', 'Preferences')).mode & 0o777).toString(8)).toBe('600');
		rmSync(join(dir, '..'), {recursive: true, force: true});
	});
});

describe('argumentos del CLI', () => {
	it('separa posicionales, opciones con valor y banderas; ignora --si-gasto (lo lee gasto.ts)', () => {
		const a = parsearArgs(['grabar', 'demo-1', '--guion', 'demos/demo-1/guion.json', '--sin-sesion', '--formato=png', '--si-gasto=0.50']);
		expect(a.posicionales).toEqual(['grabar', 'demo-1']);
		expect(a.opciones.get('--guion')).toBe('demos/demo-1/guion.json');
		expect(a.opciones.get('--formato')).toBe('png');
		expect(a.banderas.has('--sin-sesion')).toBe(true);
	});

	it('una opción desconocida o sin valor es código 2', () => {
		expect(capturar(() => parsearArgs(['grabar', 'x', '--perfil', '/tmp/x'])).codigo).toBe(2);
		expect(capturar(() => parsearArgs(['grabar', 'x', '--guion'])).codigo).toBe(2);
	});
});

// ───────────────────────── ayudantes ─────────────────────────

function relojFalso(): () => number {
	let t = 1_000;
	return () => (t += 0.1);
}

/** Página falsa: registra lo que se le pide (sin guardar el texto tecleado, solo su largo). */
function paginaFalsa() {
	const llamadas: string[] = [];
	const caja = {x: 100, y: 200, width: 80, height: 30};
	const loc: Record<string, unknown> = {};
	Object.assign(loc, {
		filter: () => loc,
		first: () => loc,
		waitFor: async () => {
			llamadas.push('esperar');
		},
		boundingBox: async () => caja,
		evaluate: async () => undefined,
		scrollIntoViewIfNeeded: async () => undefined,
	});
	const pagina = {
		getByRole: (rol: string, op: {name: string}) => {
			llamadas.push(`getByRole:${rol}:${op.name}`);
			return loc;
		},
		locator: (sel: string) => {
			llamadas.push(`locator:${sel}`);
			return loc;
		},
		mouse: {
			move: async (x: number, y: number) => {
				llamadas.push(`mover:${x},${y}`);
			},
			down: async () => {
				llamadas.push('bajar');
			},
			up: async () => {
				llamadas.push('subir');
			},
		},
		keyboard: {
			type: async (texto: string) => {
				llamadas.push(`teclear:${[...texto].length}`);
			},
			press: async (tecla: string) => {
				llamadas.push(`presionar:${tecla}`);
			},
		},
		evaluate: async () => ({x: 0, y: 0, w: 1280, h: 800}),
		goto: async (url: string) => {
			llamadas.push(`ir:${url}`);
		},
		waitForLoadState: async () => undefined,
		waitForTimeout: async () => undefined,
	};
	return {pagina: pagina as unknown as Parameters<typeof crearEjecutor>[0]['pagina'], llamadas};
}
