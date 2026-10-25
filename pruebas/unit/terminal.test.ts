// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de la terminal animada (Fase 7): funciones puras de src/estilo/terminal.ts.
 *
 * Lo que se prueba es lo mismo que dibuja src/reel/TerminalAnimada.tsx: qué caracteres se ven en cada cuadro,
 * cuándo aparece cada línea, el cursor, el desplazamiento y el modo claude-code. Corren dentro del sandbox
 * (sin Chrome); el render real lo revisa pruebas/integracion/f7-terminal.ts.
 *
 * Usan la fuente real de biblioteca/fuentes/jetbrains-mono/. Si falta: `sh biblioteca/fuentes/jetbrains-mono/preparar.sh`.
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {RAIZ} from '../../herramientas/lib/manifest.ts';
import {
	COBERTURA_FUENTE,
	DURACION_DESPLAZAMIENTO,
	DemoTerminalEsquema,
	ESCRITURA,
	FUENTE_TERMINAL,
	GIRO_PENSANDO,
	GLIFOS_DIBUJADOS,
	GuionEsquema,
	MARGEN_CAJA,
	PARPADEO,
	PAUSAS_POR_DEFECTO,
	SEGUNDOS_GIRO,
	TERMINAL_POR_DEFECTO,
	ajustesDeDemo,
	altoNecesarioTerminal,
	FILAS_MINIMAS_AJUSTADA,
	anchoCaracter,
	caracteresEscritos,
	caracteresSinGlifo,
	crearLineaDeTiempo,
	envolver,
	envolverPalabras,
	erroresDemo,
	erroresGuion,
	estadoEn,
	geometriaTerminal,
	grafemas,
	intervaloTecla,
	mezclarColor,
	opacidadCursor,
	prepararTerminal,
	resolverColor,
	textoDeCeldas,
	textoEnPantalla,
	tieneGlifo,
	tiemposDeTeclas,
	tiemposEscritura,
	type Celda,
	type LineaDeTiempo,
	type Paso,
} from '../../src/estilo/terminal.ts';
import {HAY_FUENTES} from './requisitos.ts';

const FPS = 30;
const celdas = (texto: string): Celda[] => grafemas(texto).map((ch, k) => ({ch, ancho: anchoCaracter(ch), color: '#FFFFFF', negrita: false, origen: k}));
const filasTexto = (filas: Celda[][]): string[] => filas.map((f) => textoDeCeldas(f));
const cuadros = (desde: number, hasta: number): number[] => Array.from({length: Math.round((hasta - desde) * FPS) + 1}, (_, i) => desde + i / FPS);

const GUION: Paso[] = [
	{tipo: 'comando', texto: 'npm run render'},
	{tipo: 'salida', lineas: ['', '> reel@1.0.0 render', [{texto: '✓ ', color: 'verde'}, {texto: 'listo'}]]},
	{tipo: 'espera', s: 0.5},
	{tipo: 'comando', texto: 'open final.mp4'},
];

function lt(guion: Paso[] = GUION, extra: Partial<Parameters<typeof crearLineaDeTiempo>[1]> = {}): LineaDeTiempo {
	return crearLineaDeTiempo(guion, {columnas: 44, filasVisibles: 12, ...extra});
}

// ───────────────────────────── contrato ─────────────────────────────

describe('guion (contrato Zod)', () => {
	it('acepta los tres tipos de paso, con segmentos de color y negrita', () => {
		const r = GuionEsquema.safeParse([
			{tipo: 'comando', texto: 'ls -la', velocidad: 30},
			{tipo: 'salida', lineas: ['a', {texto: 'b', color: 'verde'}, [{texto: 'c', negrita: true}, {texto: 'd', color: '#FF00AA'}]], color: 'tenue', ritmo: 0.1},
			{tipo: 'espera', s: 1.5},
		]);
		expect(r.success).toBe(true);
	});

	it.each([
		['comando vacío', [{tipo: 'comando', texto: ''}]],
		['comando con salto de línea', [{tipo: 'comando', texto: 'a\nb'}]],
		['salida con tabulador', [{tipo: 'salida', lineas: ['a\tb']}]],
		['espera de 0 s', [{tipo: 'espera', s: 0}]],
		['velocidad absurda', [{tipo: 'comando', texto: 'ls', velocidad: 2}]],
		['color sin nombre', [{tipo: 'salida', lineas: ['a'], color: 'morado'}]],
		['campo de más', [{tipo: 'espera', s: 1, extra: true}]],
		['tipo desconocido', [{tipo: 'pausa', s: 1}]],
		['guion vacío', []],
	])('rechaza %s', (_nombre, guion) => {
		expect(GuionEsquema.safeParse(guion).success).toBe(false);
		expect(erroresGuion(guion).length).toBeGreaterThan(0);
	});

	it('los errores dicen dónde están, en español, una frase cada uno', () => {
		const errores = erroresGuion([{tipo: 'comando', texto: 'ok'}, {tipo: 'salida', lineas: ['x'], color: 'morado'}]);
		expect(errores.join(' ')).toMatch(/guion\[1\]\.color: el color va como nombre/);
		expect(erroresGuion([{tipo: 'comando', texto: ''}])).toEqual(['guion[0].texto: no puede ir vacío']);
		expect(erroresGuion([{tipo: 'espera', s: 0}])).toEqual(['guion[0].s: debe ser mayor que 0']);
		expect(erroresGuion([{tipo: 'espera', s: 'dos'}])).toEqual(['guion[0].s: debe ser un número']);
		expect(erroresGuion([{tipo: 'pausa', s: 1}])).toEqual(['guion[0].tipo: "tipo" debe ser "comando", "salida", "espera"']);
		expect(erroresGuion([{tipo: 'espera', s: 1, extra: 1}])).toEqual(['guion[0]: trae campos que no conozco (extra)']);
		expect(erroresGuion([])).toEqual(['guion: debe tener al menos 1 elemento']);
		expect(erroresDemo({version: 2, guion: [{tipo: 'comando', texto: 'ok'}]})).toEqual(['demo.version: debe ser 1']);
	});

	it('crearLineaDeTiempo se niega a un guion inválido con un mensaje en español', () => {
		expect(() => crearLineaDeTiempo([{tipo: 'espera', s: -1}] as unknown as Paso[], {columnas: 40, filasVisibles: 10})).toThrow(/guion de la terminal no es válido/);
	});

	it('archivo de demo: modo terminal por defecto y versión 1', () => {
		const r = DemoTerminalEsquema.safeParse({version: 1, guion: [{tipo: 'comando', texto: 'ls'}]});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.modo).toBe('terminal');
		expect(DemoTerminalEsquema.safeParse({version: 2, guion: [{tipo: 'comando', texto: 'ls'}]}).success).toBe(false);
		expect(DemoTerminalEsquema.safeParse({version: 1, guion: [{tipo: 'comando', texto: 'ls'}], llave_rara: 1}).success).toBe(false);
	});

	it('colores: por nombre o #RRGGBB; mezclar va de un color al otro', () => {
		expect(resolverColor('verde', '#000000')).toBe('#5BD67D');
		expect(resolverColor('#ff00aa', '#000000')).toBe('#FF00AA');
		expect(resolverColor(undefined, '#123456')).toBe('#123456');
		expect(mezclarColor('#000000', '#FFFFFF', 0)).toBe('#000000');
		expect(mezclarColor('#000000', '#FFFFFF', 1)).toBe('#FFFFFF');
		expect(mezclarColor('#000000', '#FFFFFF', 0.5)).toBe('#808080');
	});
});

// ───────────────────────────── fuente ─────────────────────────────

type FuenteFk = {unitsPerEm: number; characterSet: number[]; glyphForCodePoint(cp: number): {advanceWidth: number}};
const fontkit = createRequire(import.meta.url)('fontkit') as {openSync(ruta: string): FuenteFk};

describe('fuente JetBrains Mono (OFL)', () => {
	const pesos = Object.keys(FUENTE_TERMINAL.archivos).map(Number) as Array<keyof typeof FUENTE_TERMINAL.archivos>;

	it.runIf(HAY_FUENTES)('los .ttf existen y su sha256 es el registrado (biblioteca/licencias/terminal.md)', () => {
		for (const p of pesos) {
			const {ruta, sha256} = FUENTE_TERMINAL.archivos[p];
			const absoluta = join(RAIZ, ruta);
			expect(existsSync(absoluta), `falta ${ruta}: corre sh biblioteca/fuentes/jetbrains-mono/preparar.sh`).toBe(true);
			expect(createHash('sha256').update(readFileSync(absoluta)).digest('hex')).toBe(sha256);
		}
	});

	it('trae su OFL.txt', () => {
		const ofl = readFileSync(join(RAIZ, 'biblioteca/fuentes/jetbrains-mono/OFL.txt'), 'utf8');
		expect(ofl).toMatch(/SIL Open Font License, Version 1\.1/);
		expect(ofl).toMatch(/JetBrains Mono Project Authors/);
	});

	it.runIf(HAY_FUENTES)('la tabla de cobertura de terminal.ts es exactamente la de la fuente (en los 3 pesos)', () => {
		for (const p of pesos) {
			const f = fontkit.openSync(join(RAIZ, FUENTE_TERMINAL.archivos[p].ruta));
			const cps = [...f.characterSet].sort((a, b) => a - b);
			const rangos: string[] = [];
			let ini = cps[0];
			let prev = cps[0];
			for (const cp of cps.slice(1)) {
				if (cp === prev + 1) {
					prev = cp;
					continue;
				}
				rangos.push(ini === prev ? ini.toString(16) : `${ini.toString(16)}-${prev.toString(16)}`);
				ini = prev = cp;
			}
			rangos.push(ini === prev ? ini.toString(16) : `${ini.toString(16)}-${prev.toString(16)}`);
			expect(rangos.join(',')).toBe(COBERTURA_FUENTE);
		}
	});

	it.runIf(HAY_FUENTES)('rejilla exacta: todo glifo de 1 celda avanza 600/1000 em (las 3 flechas largas, 1200 = 2 celdas)', () => {
		const f = fontkit.openSync(join(RAIZ, FUENTE_TERMINAL.archivos[FUENTE_TERMINAL.pesoNormal].ruta));
		expect(f.unitsPerEm).toBe(1000);
		for (const cp of f.characterSet) {
			const ch = String.fromCodePoint(cp);
			const avance = f.glyphForCodePoint(cp).advanceWidth;
			if (avance === 0) continue; // marcas combinantes (van pegadas a su letra)
			expect(avance, `U+${cp.toString(16)}`).toBe(anchoCaracter(ch) * 600);
		}
		expect(FUENTE_TERMINAL.avance).toBe(0.6);
	});

	it('la fuente trae lo que usa la interfaz y NO trae lo que se dibuja en SVG', () => {
		for (const ch of ['❯', '●', '·', '…', '─', '│', '╭', '╯', '–', 'ñ', 'á', '¿']) expect(tieneGlifo(ch.codePointAt(0)!), ch).toBe(true);
		for (const ch of GLIFOS_DIBUJADOS) expect(tieneGlifo(ch.codePointAt(0)!), ch).toBe(false);
		for (const ch of GIRO_PENSANDO) expect(ch === '·' || GLIFOS_DIBUJADOS.has(ch), ch).toBe(true);
	});
});

// ───────────────────────────── caracteres y envoltura ─────────────────────────────

describe('anchos y envoltura', () => {
	it('anchos: ASCII y glifos de la fuente 1; CJK y emoji 2; flechas largas 2; dibujados 1', () => {
		expect(anchoCaracter('a')).toBe(1);
		expect(anchoCaracter('❯')).toBe(1);
		expect(anchoCaracter('ñ')).toBe(1);
		expect(anchoCaracter('漢')).toBe(2);
		expect(anchoCaracter('🚀')).toBe(2);
		expect(anchoCaracter('⟶')).toBe(2);
		expect(anchoCaracter('✓')).toBe(1);
	});

	it('grafemas: une acentos combinados (NFC) y emoji compuestos', () => {
		expect(grafemas('café')).toEqual(['c', 'a', 'f', 'é']);
		expect(grafemas('👍🏽!')).toHaveLength(2);
	});

	it('caracteresSinGlifo avisa lo que se vería con otra fuente', () => {
		const faltan = caracteresSinGlifo([{tipo: 'comando', texto: 'echo 🚀 漢 ж ✓ ok'}]);
		expect(faltan).toContain('🚀');
		expect(faltan).toContain('漢');
		expect(faltan).not.toContain('ж');
		expect(faltan).not.toContain('✓');
	});

	it('envolver (comandos): parte por caracteres y un carácter ancho no se parte', () => {
		expect(filasTexto(envolver(celdas('abcdefgh'), 3))).toEqual(['abc', 'def', 'gh']);
		expect(filasTexto(envolver(celdas('ab漢c'), 3))).toEqual(['ab', '漢c']);
		expect(filasTexto(envolver(celdas('abcdef'), 4, 2))).toEqual(['abcd', '  ef']);
		expect(envolver([], 10)).toEqual([[]]);
	});

	it('envolverPalabras (salida): parte en espacios, respeta la sangría inicial y corta palabras larguísimas', () => {
		expect(filasTexto(envolverPalabras(celdas('hola mundo cruel'), 10))).toEqual(['hola mundo', 'cruel']);
		expect(filasTexto(envolverPalabras(celdas('  ⎿  archivo.json listo'), 14))).toEqual(['  ⎿', 'archivo.json', 'listo']);
		expect(filasTexto(envolverPalabras(celdas('  ⎿  a.json listo'), 14))).toEqual(['  ⎿  a.json', 'listo']);
		expect(filasTexto(envolverPalabras(celdas('abcdefghijk'), 4))).toEqual(['abcd', 'efgh', 'ijk']);
		expect(filasTexto(envolverPalabras(celdas('uno dos tres'), 8, 2))).toEqual(['uno dos', '  tres']);
	});
});

// ───────────────────────────── tecleo ─────────────────────────────

describe('tecleo: carácter por carácter, 25–40 car/s, determinista', () => {
	const texto = 'claude "agrega subtítulos de dos y tres palabras al reel de hoy" --modelo opus';
	const grafs = grafemas(texto);

	it('sin velocidad: cada intervalo entre 1/40 y 1/25 s y el promedio entre 25 y 40 car/s', () => {
		const t = tiemposEscritura(texto, 0, undefined, 7, 0);
		const intervalos = t.slice(1).map((v, i) => v - t[i]);
		for (const iv of intervalos) {
			expect(iv).toBeGreaterThanOrEqual(1 / ESCRITURA.maximo - 1e-12);
			expect(iv).toBeLessThanOrEqual(1 / ESCRITURA.minimo + 1e-12);
		}
		const ritmo = intervalos.length / (t[t.length - 1] - t[0]);
		expect(ritmo).toBeGreaterThanOrEqual(25);
		expect(ritmo).toBeLessThanOrEqual(40);
		// Hay variación (no es un metrónomo).
		expect(new Set(intervalos.map((v) => v.toFixed(4))).size).toBeGreaterThan(intervalos.length / 2);
	});

	it('con velocidad: el promedio se queda a ±10 % y cada intervalo entre 0.8 y 1.2 veces 1/velocidad', () => {
		const t = tiemposEscritura(texto, 2, 60, 3, 4);
		expect(t[0]).toBe(2);
		const intervalos = t.slice(1).map((v, i) => v - t[i]);
		for (const iv of intervalos) {
			expect(iv).toBeGreaterThanOrEqual(0.8 / 60 - 1e-12);
			expect(iv).toBeLessThanOrEqual(1.2 / 60 + 1e-12);
		}
		const ritmo = intervalos.length / (t[t.length - 1] - t[0]);
		expect(Math.abs(ritmo - 60) / 60).toBeLessThan(0.1);
	});

	it('determinista: misma semilla → mismos tiempos; otra semilla → otros', () => {
		expect(tiemposEscritura(texto, 0, undefined, 7, 0)).toEqual(tiemposEscritura(texto, 0, undefined, 7, 0));
		expect(tiemposEscritura(texto, 0, undefined, 8, 0)).not.toEqual(tiemposEscritura(texto, 0, undefined, 7, 0));
		expect(intervaloTecla(grafs, 5, undefined, 7, 0)).toBe(intervaloTecla(grafs, 5, undefined, 7, 0));
	});

	it('la primera tecla llega justo después de la pausa antes de escribir', () => {
		const l = lt();
		expect(l.comandos[0].inicio).toBeCloseTo(PAUSAS_POR_DEFECTO.terminal.antesDeEscribir, 10);
		expect(caracteresEscritos(l, 0, l.comandos[0].inicio - 1e-6)).toBe(0);
		expect(caracteresEscritos(l, 0, l.comandos[0].inicio)).toBe(1);
	});

	it('cuadro por cuadro: los caracteres visibles nunca bajan y el prompt muestra justo esos caracteres', () => {
		const l = lt();
		const c = l.comandos[0];
		let anterior = 0;
		for (const t of cuadros(0, c.enter + 0.2)) {
			const n = caracteresEscritos(l, 0, t);
			expect(n).toBeGreaterThanOrEqual(anterior);
			anterior = n;
			const visible = grafemas(c.texto).slice(0, n).join('');
			const fila = textoEnPantalla(l, t, 0)[0] ?? '';
			expect(fila.replace(/^❯ ?/, '')).toBe(visible.replace(/ +$/, ''));
		}
		expect(anterior).toBe(grafemas(c.texto).length);
	});

	it('tiemposDeTeclas: una tecla por carácter y un enter por comando, en orden', () => {
		const l = lt();
		const teclas = tiemposDeTeclas(l);
		expect(teclas.filter((x) => x.tipo === 'enter')).toHaveLength(2);
		expect(teclas.filter((x) => x.tipo === 'tecla')).toHaveLength(grafemas('npm run render').length + grafemas('open final.mp4').length);
		for (let i = 1; i < teclas.length; i++) expect(teclas[i].t).toBeGreaterThanOrEqual(teclas[i - 1].t);
	});
});

// ───────────────────────────── modo terminal ─────────────────────────────

describe('línea de tiempo (modo terminal)', () => {
	it('prompt al inicio si el guion empieza con un comando; tras la salida; y al final con el cursor', () => {
		const l = lt();
		const c0 = l.comandos[0];
		expect(textoEnPantalla(l, 0.2)).toEqual(['❯']);
		// Mientras imprime: sin cursor.
		const e = estadoEn(l, c0.enter + 0.05);
		expect(e.cursor).toBeNull();
		// Después de la salida y de la espera: prompt nuevo con cursor.
		const tFin = l.comandos[1].enter + 0.3;
		const fin = estadoEn(l, tFin);
		expect(fin.cursor).not.toBeNull();
		expect(textoEnPantalla(l, tFin)).toEqual(['❯ npm run render', '', '> reel@1.0.0 render', '✓ listo', '❯ open final.mp4', '❯']);
		expect(l.duracion).toBeGreaterThan(l.comandos[1].enter);
	});

	it('un guion que empieza con salida (un banner) no muestra prompt hasta que termina', () => {
		const l = lt([{tipo: 'salida', lineas: ['bienvenido', 'versión 1']}, {tipo: 'comando', texto: 'ls'}]);
		expect(textoEnPantalla(l, 0.01, 0)).toEqual(['bienvenido']);
		expect(textoEnPantalla(l, 0.5)).toEqual(['bienvenido', 'versión 1', '❯']);
	});

	it('las líneas de salida salen en orden, una por una, con el ritmo pedido (±25 %)', () => {
		const lineas = Array.from({length: 8}, (_, i) => `línea ${i}`);
		const l = lt([{tipo: 'comando', texto: 'ls'}, {tipo: 'salida', lineas, ritmo: 0.1}]);
		const bloques = l.bloques.filter((b) => b.tipo === 'texto');
		expect(bloques).toHaveLength(8);
		const t0 = l.comandos[0].enter + PAUSAS_POR_DEFECTO.terminal.despuesDeEnter;
		expect(bloques[0].aparece).toBeCloseTo(t0, 10);
		for (let i = 1; i < bloques.length; i++) {
			const d = bloques[i].aparece - bloques[i - 1].aparece;
			expect(d).toBeGreaterThanOrEqual(0.075 - 1e-9);
			expect(d).toBeLessThanOrEqual(0.125 + 1e-9);
		}
	});

	it('un comando sin salida deja un prompt nuevo enseguida', () => {
		const l = lt([{tipo: 'comando', texto: 'cd demo'}, {tipo: 'comando', texto: 'ls'}]);
		const prompts = l.bloques.filter((b) => b.tipo === 'prompt');
		expect(prompts).toHaveLength(3);
		expect(prompts[1].aparece).toBeCloseTo(l.comandos[0].enter + PAUSAS_POR_DEFECTO.terminal.promptTrasEnter, 10);
	});

	it('con carpeta: "<carpeta> ❯ " antes de cada comando', () => {
		const l = lt([{tipo: 'comando', texto: 'ls'}], {directorio: '~/mi-reel'});
		expect(textoEnPantalla(l, l.comandos[0].enter - 0.01)).toEqual(['~/mi-reel ❯ ls']);
	});

	it('un comando largo se parte por caracteres y el cursor baja de fila', () => {
		const l = crearLineaDeTiempo([{tipo: 'comando', texto: 'x'.repeat(30)}], {columnas: 20, filasVisibles: 5});
		const c = l.comandos[0];
		const t = c.tiempos[25] + 0.001;
		const e = estadoEn(l, t);
		expect(textoEnPantalla(l, t, 0)).toEqual([`❯ ${'x'.repeat(18)}`, 'x'.repeat(8)]);
		expect(e.cursor?.col).toBe(8);
		expect(Math.round(e.cursor?.fila ?? -1)).toBe(1);
	});
});

// ───────────────────────────── desplazamiento ─────────────────────────────

describe('desplazamiento cuando se llena la ventana', () => {
	const lineas = Array.from({length: 12}, (_, i) => `salida ${i + 1}`);
	const l = crearLineaDeTiempo([{tipo: 'comando', texto: 'ls'}, {tipo: 'salida', lineas, ritmo: 0.08}], {columnas: 40, filasVisibles: 5});

	it('al final se ven las últimas filas (las primeras ya subieron)', () => {
		expect(textoEnPantalla(l, l.duracion)).toEqual(['salida 9', 'salida 10', 'salida 11', 'salida 12', '❯']);
		expect(estadoEn(l, l.duracion).desplazamiento).toBeCloseTo(9, 6);
	});

	it('es suave: nunca negativo, nunca baja, y avanza menos de una fila por cuadro', () => {
		let anterior = 0;
		let fraccionarios = 0;
		for (const t of cuadros(0, l.duracion)) {
			const d = estadoEn(l, t).desplazamiento;
			expect(d).toBeGreaterThanOrEqual(0);
			expect(d).toBeGreaterThanOrEqual(anterior - 1e-9);
			expect(d - anterior).toBeLessThan(1);
			if (Math.abs(d - Math.round(d)) > 0.05) fraccionarios++;
			anterior = d;
		}
		// Hay cuadros a medio camino: el contenido se desliza, no salta.
		expect(fraccionarios).toBeGreaterThan(3);
	});

	it(`cada fila nueva abre su espacio en ${DURACION_DESPLAZAMIENTO} s`, () => {
		// Líneas separadas (ritmo 0.5 s) para ver una sola fila abrirse.
		const lento = crearLineaDeTiempo([{tipo: 'comando', texto: 'ls'}, {tipo: 'salida', lineas: ['a', 'b', 'c'], ritmo: 0.5}], {columnas: 40, filasVisibles: 5});
		const ultima = lento.bloques.filter((b) => b.tipo === 'texto').at(-1)!;
		const antes = estadoEn(lento, ultima.aparece).altoDocumento;
		const despues = estadoEn(lento, ultima.aparece + DURACION_DESPLAZAMIENTO).altoDocumento;
		expect(despues - antes).toBeCloseTo(1, 6);
		const medio = estadoEn(lento, ultima.aparece + DURACION_DESPLAZAMIENTO / 2).altoDocumento - antes;
		expect(medio).toBeGreaterThan(0.5);
		expect(medio).toBeLessThan(1);
	});
});

// ───────────────────────────── cursor ─────────────────────────────

describe('cursor', () => {
	it('parpadea: prendido 0.53 s, apagado 0.53 s, con rampas cortas', () => {
		expect(opacidadCursor(10, 10)).toBe(1);
		expect(opacidadCursor(10.3, 10)).toBe(1);
		expect(opacidadCursor(10 + PARPADEO + 0.1, 10)).toBe(0);
		expect(opacidadCursor(10 + 2 * PARPADEO + 0.1, 10)).toBe(1);
		const rampa = opacidadCursor(10 + PARPADEO - 0.025, 10);
		expect(rampa).toBeGreaterThan(0);
		expect(rampa).toBeLessThan(1);
	});

	it('fijo mientras se teclea (cada tecla lo reinicia)', () => {
		const l = lt();
		const c = l.comandos[0];
		for (const t of cuadros(c.inicio, c.tiempos[c.tiempos.length - 1])) expect(estadoEn(l, t).cursor?.opacidad).toBe(1);
	});

	it('se apaga y se prende con el prompt quieto', () => {
		const l = lt([{tipo: 'comando', texto: 'ls'}, {tipo: 'espera', s: 3}], {pausas: {antesDeEscribir: 0.1}});
		const prompt = l.bloques.filter((b) => b.tipo === 'prompt').at(-1)!;
		const ops = cuadros(prompt.aparece + 0.1, prompt.aparece + 2.5).map((t) => estadoEn(l, t).cursor?.opacidad ?? -1);
		expect(ops.some((o) => o === 0)).toBe(true);
		expect(ops.some((o) => o === 1)).toBe(true);
	});
});

// ───────────────────────────── modo claude-code ─────────────────────────────

describe('modo claude-code', () => {
	const guion: Paso[] = [
		{tipo: 'comando', texto: 'agrega subtítulos al reel'},
		{tipo: 'salida', lineas: ['Listo: agregué 42 subtítulos.', '⎿  edicion-v2.json']},
		{tipo: 'salida', color: 'verde', lineas: ['Render terminado']},
	];
	const l = crearLineaDeTiempo(guion, {modo: 'claude-code', columnas: 44, filasVisibles: 16, directorio: '~/mi-reel'});
	const c = l.comandos[0];

	it('al inicio: encabezado naranja, recuadro de entrada con "> " y la pista', () => {
		const e = estadoEn(l, 0.1);
		expect(e.altoDocumento).toBeCloseTo(3 + 1 + 2 + 1, 6);
		expect(e.cajas.map((k) => k.tipo)).toEqual(['encabezado', 'entrada']);
		expect(e.cajas[0].color).toBe('#D97757');
		expect(textoEnPantalla(l, 0.1)).toEqual(['  Claude Code', '  ~/mi-reel', '  >', '  ? para atajos']);
		expect(e.cursor?.col).toBe(MARGEN_CAJA + 2);
	});

	it('lo que se teclea va en el recuadro; con el enter pasa a la conversación', () => {
		const t = c.tiempos[5] + 0.001;
		expect(textoEnPantalla(l, t)).toContain('  > agrega');
		const tras = c.enter + 0.3;
		const texto = textoEnPantalla(l, tras);
		expect(texto).toContain('> agrega subtítulos al reel');
		expect(texto).toContain('  >');
		expect(texto.some((s) => s.includes('Pensando…'))).toBe(true);
	});

	it(`"Pensando…" gira un asterisco cada ${SEGUNDOS_GIRO} s y dura lo pedido`, () => {
		const fila = (t: number) => estadoEn(l, t).filas.find((f) => f.celdas.some((x) => x.ch === 'P'));
		const g0 = fila(c.enter + 0.01)?.celdas[0].ch;
		const g1 = fila(c.enter + 0.01 + SEGUNDOS_GIRO)?.celdas[0].ch;
		expect(GIRO_PENSANDO).toContain(g0);
		expect(g1).not.toBe(g0);
		const primera = l.bloques.find((b) => b.tipo === 'texto' && b.clave.startsWith('r'))!;
		expect(primera.aparece).toBeCloseTo(c.enter + PAUSAS_POR_DEFECTO['claude-code'].pensando, 10);
	});

	it('la primera línea de la respuesta toma el lugar del indicador: lo de abajo no se mueve', () => {
		const primera = l.bloques.find((b) => b.tipo === 'texto' && b.clave.startsWith('r'))!;
		const alturas = cuadros(primera.aparece - 0.1, primera.aparece + 0.05).map((t) => estadoEn(l, t).altoDocumento);
		for (const a of alturas) expect(a).toBeCloseTo(alturas[0], 6);
	});

	it('respuestas con "● " y sangría de 2; una línea en blanco entre respuestas', () => {
		const texto = textoEnPantalla(l, l.duracion);
		expect(texto).toEqual([
			'  Claude Code',
			'  ~/mi-reel',
			'> agrega subtítulos al reel',
			'● Listo: agregué 42 subtítulos.',
			'  ⎿  edicion-v2.json',
			'● Render terminado',
			'  >',
			'  ? para atajos',
		]);
		const e = estadoEn(l, l.duracion);
		const y = (s: string) => e.filas.find((f) => textoDeCeldas(f.celdas) === s)!.fila;
		expect(y('● Render terminado') - y('  ⎿  edicion-v2.json')).toBeCloseTo(2, 6);
	});

	it('el recuadro crece cuando el texto no cabe y regresa a una fila con el enter', () => {
		const largo = crearLineaDeTiempo([{tipo: 'comando', texto: 'x'.repeat(60)}], {modo: 'claude-code', columnas: 30, filasVisibles: 12});
		const k = largo.comandos[0];
		const caja = (t: number) => estadoEn(largo, t).cajas.find((x) => x.tipo === 'entrada')!.alto;
		expect(caja(k.inicio)).toBeCloseTo(1.8, 6);
		expect(caja(k.enter - 0.01)).toBeCloseTo(3.8, 6);
		expect(caja(k.enter + 1)).toBeCloseTo(1.8, 6);
	});

	it('una ventana muy chica para el modo da un error claro', () => {
		expect(() => crearLineaDeTiempo(guion, {modo: 'claude-code', columnas: 40, filasVisibles: 5})).toThrow(/muy chica/);
	});
});

// ───────────────────────────── geometría y ajustes ─────────────────────────────

describe('geometría y ajustes del componente', () => {
	it('960×1100 a 34 px: 44 columnas de 20.4 px, filas de 48 px y área centrada', () => {
		const g = geometriaTerminal({ancho: 960, alto: 1100, tamanoLetra: 34});
		expect(g.columnas).toBe(44);
		expect(g.celda).toBeCloseTo(20.4, 10);
		expect(g.altoFila).toBe(48);
		expect(g.barra).toBe(54);
		expect(g.filasVisibles).toBe(Math.floor((1100 - 54 - 2 * 20) / 48));
		expect(g.area.x * 2 + g.area.w).toBeCloseTo(960, 6);
		expect(g.radio).toBe(14);
		expect(g.lineaBase).toBeGreaterThan(g.altoFila / 2);
		expect(g.lineaBase).toBeLessThan(g.altoFila);
	});

	it('prepararTerminal: centrada, retraso por defecto y título con la carpeta', () => {
		const p = prepararTerminal({guion: GUION, directorio: '~/x'});
		expect(p.x).toBe((1080 - TERMINAL_POR_DEFECTO.ancho) / 2);
		expect(p.y).toBe((1920 - TERMINAL_POR_DEFECTO.alto) / 2);
		expect(p.retraso).toBe(TERMINAL_POR_DEFECTO.retraso);
		expect(p.titulo).toBe('zsh — ~/x');
		expect(p.duracion).toBeCloseTo(p.retraso + p.lt.duracion, 10);
	});

	it('ajustesDeDemo pasa los campos del archivo al componente', () => {
		const demo = DemoTerminalEsquema.parse({
			version: 1,
			modo: 'claude-code',
			directorio: '~/d',
			tamano_letra: 30,
			semilla: 3,
			retraso_s: 0.2,
			pausas: {pensando: 0.5},
			guion: [{tipo: 'comando', texto: 'hola'}],
		});
		const a = ajustesDeDemo(demo);
		expect(a).toMatchObject({modo: 'claude-code', directorio: '~/d', tamanoLetra: 30, semilla: 3, retraso: 0.2, pausas: {pensando: 0.5}});
		expect(prepararTerminal(a).titulo).toBe('claude — ~/d');
	});

	it('altoNecesarioTerminal: la ventana mide lo que ocupa su guion (sin desplazarse), con mínimo y sin pasar del alto por defecto', () => {
		const corto = ajustesDeDemo(
			DemoTerminalEsquema.parse({version: 1, modo: 'claude-code', directorio: '~/web', guion: [{tipo: 'comando', texto: 'https://github.com/Hainrixz/claude-webkit'}, {tipo: 'espera', s: 1.2}]}),
		);
		const alto = altoNecesarioTerminal(corto);
		expect(alto).toBeLessThan(TERMINAL_POR_DEFECTO.alto * 0.7);
		const p = prepararTerminal({...corto, alto});
		expect(p.geo.filasVisibles).toBeGreaterThanOrEqual(FILAS_MINIMAS_AJUSTADA);
		for (const t of cuadros(0, p.lt.duracion)) expect(estadoEn(p.lt, t).desplazamiento).toBe(0);
		// Una fila menos ya no alcanza: el ajuste es justo.
		const justo = prepararTerminal({...corto, alto: alto - p.geo.altoFila});
		expect(cuadros(0, justo.lt.duracion).some((t) => estadoEn(justo.lt, t).desplazamiento > 0)).toBe(true);
		// Un guion largo se queda en el alto por defecto (ahí sí se desplaza, como una terminal de verdad).
		const largo = {guion: [{tipo: 'salida' as const, lineas: Array.from({length: 30}, (_, k) => `línea ${k}`)}]};
		expect(altoNecesarioTerminal(largo)).toBe(TERMINAL_POR_DEFECTO.alto);
		// Un guion de una línea no queda como tira.
		const hola = {guion: [{tipo: 'salida' as const, lineas: ['hola']}]};
		expect(prepararTerminal({...hola, alto: altoNecesarioTerminal(hola)}).geo.filasVisibles).toBe(FILAS_MINIMAS_AJUSTADA);
	});

	it('determinista: el mismo guion da la misma línea de tiempo y el mismo estado', () => {
		expect(JSON.stringify(lt())).toBe(JSON.stringify(lt()));
		const l = lt();
		expect(estadoEn(l, 1.234)).toEqual(estadoEn(l, 1.234));
	});
});
