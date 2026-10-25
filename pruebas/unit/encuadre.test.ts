// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas del reencuadre (herramientas/lib/encuadre.ts, herramientas/encuadre.ts y el --encuadre de base.ts):
 * - medidas de una cara, resumen por reel y objetivo agregado (medianas por reel, filtro de cobertura);
 * - cálculo de escala y desplazamiento: nunca escala < 1, tope ×1.35, barbilla al objetivo, cara centrada,
 *   acotado sin bordes negros, enteros pares, idempotente sobre una base ya reencuadrada;
 * - recorte en px del original con rotación ±90 (y su versión en el cuadro guardado, con la convención de ffmpeg);
 * - base.ts con un clip sintético ROTADO ±90 y marcas de color: el recorte sale del original antes de escalar,
 *   en el lugar correcto, y el manifest se invalida si cambia el encuadre;
 * - el flujo del CLI (encuadre de un proyecto + --aplicar) sin Vision (cara.json sintético).
 * Corren dentro del sandbox: solo ffmpeg y carpetas temporales; no tocan proyectos/ ni estilo/.
 */
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {construirFiltro, generarBase, LIENZO_4K, resolverEncuadre, verificarBase} from '../../herramientas/base.ts';
import {aplicarEncuadre, cortesDeLaBase, encuadreDeProyecto, recorteDeLaBase, resumenEncuadre} from '../../herramientas/encuadre.ts';
import {ingerir} from '../../herramientas/ingesta.ts';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {
	agregarObjetivo,
	archivoEncuadre,
	baseAOriginal,
	calcularEncuadre,
	convertirMedidas,
	CRITERIOS_REEL,
	esIdentidad,
	estadistico,
	filtroRecorte,
	leerEncuadre,
	leerObjetivo,
	LIMITES_ENCUADRE,
	medidasDeCara,
	originalABase,
	problemasRecorte,
	recorteAlmacenado,
	recorteCompleto,
	resumirReel,
	type MedidasCara,
	type Recorte,
	type VideoOriginal,
} from '../../herramientas/lib/encuadre.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {hashearArchivo, leerManifest, registrarEtapa} from '../../herramientas/lib/manifest.ts';

let tmp: string;
beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), 'encuadre-'));
});
afterAll(() => {
	rmSync(tmp, {recursive: true, force: true});
});

function falloDe(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor');
}

async function falloAsync(p: Promise<unknown>): Promise<FalloEditor> {
	const e = await p.catch((error: unknown) => error);
	if (e instanceof FalloEditor) return e;
	throw new Error(`se esperaba un FalloEditor y llegó ${String(e)}`);
}

/** iPhone vertical sin rotación (2160×3840) y el mismo guardado de lado con rotación ±90. */
const IPHONE: VideoOriginal = {ancho: 2160, alto: 3840, rotacion: 0, ancho_visible: 2160, alto_visible: 3840};
const ROTADO = (rotacion: number): VideoOriginal => ({ancho: 3840, alto: 2160, rotacion, ancho_visible: 2160, alto_visible: 3840});

const medidas = (m: Partial<MedidasCara> = {}): MedidasCara => ({n: 100, barbilla_y: 1240, alto_cara: 300, centro_x: 520, coronilla_y: 800, ...m});

/** Cuadros sintéticos de una cara (para medidasDeCara y para un cara.json de prueba). */
function cuadrosCara(n: number, f: (j: number) => {x: number; y: number; w: number; h: number; barbilla: number; coronilla: number} | null): CaraConsultable['cuadros'] {
	return Array.from({length: n}, (_, j) => {
		const c = f(j);
		return c
			? {t: j / 30, cara: {x: c.x, y: c.y, w: c.w, h: c.h}, barbilla_y: c.barbilla, coronilla_y: c.coronilla, cabeza: {x: c.x - 20, y: c.coronilla, w: c.w + 40, h: c.barbilla - c.coronilla}}
			: {t: j / 30, cara: null, barbilla_y: null, coronilla_y: null, cabeza: null};
	});
}

/** Dentro del cuadro, enteros pares, proporción 9:16 (±1 px de redondeo). */
function esRecorteSano(r: Recorte, video: VideoOriginal): void {
	expect(problemasRecorte(r, video)).toEqual([]);
	expect(Math.abs(r.h - (r.w * 16) / 9)).toBeLessThanOrEqual(2);
}

describe('medidas de la cara y objetivo de tus reels', () => {
	it('medidasDeCara: medianas de los cuadros con cara (barbilla, alto de la caja, centro x, coronilla)', () => {
		const cuadros = cuadrosCara(5, (j) => (j === 2 ? null : {x: 400 + j * 10, y: 700, w: 200, h: 180 + j * 10, barbilla: 1000 + j * 20, coronilla: 600 - j}));
		// Con cara: j = 0, 1, 3, 4.
		expect(medidasDeCara({cuadros})).toEqual({n: 4, barbilla_y: 1040, alto_cara: 200, centro_x: 520, coronilla_y: 598});
		expect(medidasDeCara({cuadros: cuadrosCara(3, () => null)})).toBeNull();
	});

	it('resumirReel: aporta solo con cara en ≥ 30 % de los cuadros y en ≥ 300 cuadros', () => {
		const reel = {shortCode: 'X', grupo: 'recientes', mp4: '/x/X.mp4', fps: 30, duracion_s: 20};
		const bien = resumirReel(reel, {cuadros: cuadrosCara(600, () => ({x: 440, y: 700, w: 200, h: 220, barbilla: 1050, coronilla: 560}))});
		expect(bien).toMatchObject({incluido: true, motivo: null, cobertura: 1, cuadros_con_cara: 600, barbilla_y_p50: 1050, alto_cara_p50: 220, centro_x_p50: 540, coronilla_y_p50: 560});
		const poca = resumirReel(reel, {cuadros: cuadrosCara(2000, (j) => (j < 500 ? {x: 440, y: 700, w: 200, h: 220, barbilla: 1050, coronilla: 560} : null))});
		expect(poca.incluido).toBe(false);
		expect(poca.motivo).toMatch(/25\.0 %/);
		const corta = resumirReel(reel, {cuadros: cuadrosCara(299, () => ({x: 440, y: 700, w: 200, h: 220, barbilla: 1050, coronilla: 560}))});
		expect(corta.incluido).toBe(false);
		expect(corta.motivo).toMatch(/299 cuadros/);
		expect(resumirReel(reel, {cuadros: cuadrosCara(400, () => null)}).motivo).toMatch(/no vio/);
		expect(CRITERIOS_REEL).toEqual({cobertura_min: 0.3, cuadros_con_cara_min: 300});
	});

	it('estadistico y agregarObjetivo: mediana entre reels (cada reel pesa igual), p10/p90 y n; los que no aportan no cuentan', () => {
		expect(estadistico([1000, 1010, 1020, 1030, 1040])).toEqual({valor: 1020, p10: 1004, p90: 1036, n: 5});
		expect(estadistico([])).toEqual({valor: null, p10: null, p90: null, n: 0});
		const reel = (b: number, h: number, incluido = true) => ({
			shortCode: `R${b}`,
			grupo: 'recientes',
			mp4: '',
			fps: 30,
			duracion_s: 60,
			cuadros: 1800,
			cuadros_con_cara: 1800,
			cobertura: 1,
			barbilla_y_p50: b,
			alto_cara_p50: h,
			centro_x_p50: 530,
			coronilla_y_p50: b - 500,
			incluido,
			motivo: incluido ? null : 'poca cara',
		});
		const ag = agregarObjetivo([reel(1000, 300), reel(1100, 400), reel(1060, 380), reel(1500, 900, false)]);
		expect(ag.n_reels).toBe(3);
		expect(ag.barbilla_y).toMatchObject({valor: 1060, n: 3});
		expect(ag.alto_cara).toMatchObject({valor: 380, n: 3});
		expect(ag.centro_x.valor).toBe(530);
	});

	it('leerObjetivo: código 2 si falta, no es JSON o no trae barbilla y alto medidos', () => {
		const ruta = join(tmp, 'objetivo.json');
		expect(falloDe(() => leerObjetivo(join(tmp, 'no-existe.json'))).codigo).toBe(2);
		writeFileSync(ruta, '{no es json');
		expect(falloDe(() => leerObjetivo(ruta)).codigo).toBe(2);
		const e = {valor: null, p10: null, p90: null, n: 0};
		writeFileSync(ruta, JSON.stringify({version: 1, fuente: 'medido', barbilla_y: e, alto_cara: e, centro_x: e, coronilla_y: e, n_reels: 0}));
		expect(falloDe(() => leerObjetivo(ruta)).codigo).toBe(2);
		const s = (valor: number) => ({valor, p10: valor - 50, p90: valor + 50, n: 18});
		writeFileSync(ruta, JSON.stringify({version: 1, fuente: 'medido', barbilla_y: s(1062), alto_cara: s(393), centro_x: {valor: null, p10: null, p90: null, n: 0}, coronilla_y: s(518), n_reels: 18, extra: 'se respeta'}));
		const o = leerObjetivo(ruta);
		expect(o.objetivo).toEqual({barbilla_y: 1062, alto_cara: 393, centro_x: 540}); // sin centro medido: 540
		expect((o as Record<string, unknown>).extra).toBe('se respeta');
	});
});

describe('geometría original ↔ base', () => {
	it('sin encuadre, un original 2160×3840 es la base ×2; ida y vuelta exacta con cualquier recorte', () => {
		const completo = recorteCompleto(IPHONE);
		expect(originalABase({x: 1080, y: 2476}, completo)).toEqual({x: 540, y: 1238});
		const r: Recorte = {x: 180, y: 640, w: 1800, h: 3200};
		const p = {x: 1234.5, y: 2345.25};
		const ida = originalABase(p, r);
		expect(ida.x).toBeCloseTo((1234.5 - 180) * 0.6, 9);
		expect(baseAOriginal(ida, r).x).toBeCloseTo(p.x, 9);
		expect(baseAOriginal(ida, r).y).toBeCloseTo(p.y, 9);
	});

	it('convertirMedidas lleva la cara de una base a otra (alto por la razón de escalas)', () => {
		const r: Recorte = {x: 180, y: 640, w: 1800, h: 3200};
		const m = convertirMedidas(medidas({barbilla_y: 1240, alto_cara: 300, centro_x: 520, coronilla_y: 800}), recorteCompleto(IPHONE), r);
		expect(m.barbilla_y).toBeCloseTo((2480 - 640) * 0.6, 1);
		expect(m.alto_cara).toBeCloseTo(360, 1);
		expect(m.centro_x).toBeCloseTo((1040 - 180) * 0.6, 1);
		expect(m.coronilla_y).toBeCloseTo((1600 - 640) * 0.6, 1);
	});

	it('recorteAlmacenado con rotación ±90 sigue la convención de ffmpeg 8.1 (medida con una marca roja en un clip de 320×180)', () => {
		// Guardado 320×180 con una marca en (0,0)–(40,20). +90 → se ve en (0,280)–(20,320); −90 → en (160,0)–(180,40).
		expect(recorteAlmacenado({x: 0, y: 280, w: 20, h: 40}, {ancho: 320, alto: 180, rotacion: 90})).toEqual({x: 0, y: 0, w: 40, h: 20});
		expect(recorteAlmacenado({x: 160, y: 0, w: 20, h: 40}, {ancho: 320, alto: 180, rotacion: -90})).toEqual({x: 0, y: 0, w: 40, h: 20});
		expect(recorteAlmacenado({x: 10, y: 20, w: 30, h: 40}, {ancho: 320, alto: 180, rotacion: 180})).toEqual({x: 280, y: 120, w: 30, h: 40});
		expect(recorteAlmacenado({x: 10, y: 20, w: 30, h: 40}, {ancho: 320, alto: 180, rotacion: 0})).toEqual({x: 10, y: 20, w: 30, h: 40});
		// Un recorte vertical 1800×3200 de un iPhone guardado 3840×2160: queda acostado y dentro del cuadro guardado.
		for (const rot of [90, -90]) {
			const a = recorteAlmacenado({x: 180, y: 640, w: 1800, h: 3200}, ROTADO(rot));
			expect(a.w).toBe(3200);
			expect(a.h).toBe(1800);
			expect(a.x >= 0 && a.y >= 0 && a.x + a.w <= 3840 && a.y + a.h <= 2160).toBe(true);
		}
	});

	it('problemasRecorte: fuera del cuadro, impares o vacíos', () => {
		expect(problemasRecorte({x: 0, y: 0, w: 2160, h: 3840}, IPHONE)).toEqual([]);
		expect(problemasRecorte({x: 2, y: 0, w: 2160, h: 3840}, IPHONE).join(' ')).toMatch(/bordes negros/);
		expect(problemasRecorte({x: 1, y: 0, w: 1800, h: 3200}, IPHONE).join(' ')).toMatch(/pares/);
		expect(esIdentidad({x: 0, y: 0, w: 2160, h: 3840}, IPHONE)).toBe(true);
		// El cuadro completo sirve aunque mida impar (no se recorta nada).
		expect(problemasRecorte({x: 0, y: 0, w: 1081, h: 1921}, {ancho_visible: 1081, alto_visible: 1921})).toEqual([]);
		expect(filtroRecorte({x: 180, y: 640, w: 1800, h: 3200})).toBe('crop=1800:3200:180:640');
	});
});

describe('calcularEncuadre', () => {
	const objetivo = {barbilla_y: 1062, alto_cara: 393, centro_x: 540};

	it('cara chica: acerca a alto objetivo / alto medido, la barbilla queda en el objetivo y la cara centrada', () => {
		const r = calcularEncuadre({medidas: medidas({barbilla_y: 1150, alto_cara: 330, centro_x: 500, coronilla_y: 820}), objetivo, video: IPHONE});
		expect(r.escala_pedida).toBeCloseTo(393 / 330, 4);
		expect(r.escala).toBeCloseTo(393 / 330, 4);
		expect(r.limite_escala).toBeNull();
		esRecorteSano(r.recorte, IPHONE);
		expect(r.acotado).toEqual({x: null, y: null});
		expect(Math.abs(r.despues.barbilla_y - 1062)).toBeLessThanOrEqual(3); // redondeo a pares × escala
		expect(Math.abs(r.despues.centro_x - 540)).toBeLessThanOrEqual(3);
		expect(r.despues.alto_cara / 393).toBeCloseTo(1, 2);
		expect(r.escala_efectiva).toBeCloseTo(r.escala, 2);
		expect(r.identidad).toBe(false);
		// Lo predicho sale de llevar las medidas por el original con el recorte entero.
		expect(r.despues.barbilla_y).toBeCloseTo(convertirMedidas(r.antes, recorteCompleto(IPHONE), r.recorte).barbilla_y, 6);
	});

	it('nunca escala < 1: con la cara más grande que el objetivo, la ventana es el cuadro completo (identidad) y lo avisa', () => {
		const r = calcularEncuadre({medidas: medidas({barbilla_y: 1238, alto_cara: 591, centro_x: 520, coronilla_y: 443}), objetivo, video: IPHONE});
		expect(r.escala_pedida).toBeCloseTo(393 / 591, 4);
		expect(r.escala).toBe(1);
		expect(r.limite_escala).toBe('min');
		expect(r.recorte).toEqual({x: 0, y: 0, w: 2160, h: 3840});
		expect(r.identidad).toBe(true);
		expect(r.despues.barbilla_y).toBeCloseTo(1238, 1);
		expect(r.acotado.y).toBe('abajo'); // para subir la barbilla, la ventana tendría que salirse por abajo
		expect(r.avisos.join(' ')).toMatch(/alejar/);
	});

	it('tope ×1.35: una cara muy chica no se acerca más (y lo dice)', () => {
		const r = calcularEncuadre({medidas: medidas({barbilla_y: 1100, alto_cara: 200, centro_x: 540, coronilla_y: 800}), objetivo, video: IPHONE});
		expect(r.escala_pedida).toBeCloseTo(1.965, 3);
		expect(r.escala).toBe(LIMITES_ENCUADRE.escala_max);
		expect(r.limite_escala).toBe('max');
		esRecorteSano(r.recorte, IPHONE);
		expect(r.recorte.w).toBe(1600);
		expect(r.despues.alto_cara).toBeCloseTo(270, 0);
		expect(r.avisos.join(' ')).toMatch(/máximo/);
	});

	it('acotado sin bordes negros: si la barbilla objetivo pide salirse del cuadro, la ventana se queda en la orilla', () => {
		// Barbilla muy abajo (1700): para subirla a 1062 con ×1.19 la ventana tendría que salirse por abajo.
		const r = calcularEncuadre({medidas: medidas({barbilla_y: 1700, alto_cara: 330, centro_x: 540, coronilla_y: 1300}), objetivo, video: IPHONE});
		esRecorteSano(r.recorte, IPHONE);
		expect(r.acotado.y).toBe('abajo');
		expect(r.recorte.y + r.recorte.h).toBe(3840);
		expect(r.despues.barbilla_y).toBeGreaterThan(1062);
		// Es lo más arriba que se puede: con la ventana pegada abajo.
		expect(r.despues.barbilla_y).toBeCloseTo(1920 - (1920 - 1700) * r.escala_efectiva, 0);
		// Y de lado: una cara pegada a la izquierda.
		const l = calcularEncuadre({medidas: medidas({barbilla_y: 1240, alto_cara: 330, centro_x: 120}), objetivo, video: IPHONE});
		expect(l.recorte.x).toBe(0);
		expect(l.acotado.x).toBe('izquierda');
		expect(l.despues.centro_x).toBeLessThan(540);
	});

	it('propiedad: con 500 entradas al azar el recorte siempre cabe, es par, 9:16 y s ∈ [1, 1.35]', () => {
		let semilla = 7;
		const azar = () => {
			semilla = (semilla * 1103515245 + 12345) % 2 ** 31;
			return semilla / 2 ** 31;
		};
		const videos = [IPHONE, ROTADO(90), ROTADO(-90), {ancho: 1080, alto: 1920, rotacion: 0, ancho_visible: 1080, alto_visible: 1920}, {ancho: 1440, alto: 1920, rotacion: 0, ancho_visible: 1440, alto_visible: 1920}];
		for (let i = 0; i < 500; i++) {
			const video = videos[i % videos.length];
			const r = calcularEncuadre({
				medidas: medidas({barbilla_y: 200 + azar() * 1700, alto_cara: 80 + azar() * 900, centro_x: azar() * 1080, coronilla_y: azar() * 1000}),
				objetivo: {barbilla_y: 700 + azar() * 600, alto_cara: 200 + azar() * 400, centro_x: 400 + azar() * 280},
				video,
			});
			expect(problemasRecorte(r.recorte, video)).toEqual([]);
			expect(r.escala).toBeGreaterThanOrEqual(1);
			expect(r.escala).toBeLessThanOrEqual(1.35);
			expect(r.escala_efectiva).toBeGreaterThanOrEqual(1 - 1e-6);
			expect(r.escala_efectiva).toBeLessThanOrEqual(1.35 + 0.01);
			if (!r.acotado.y) expect(Math.abs(r.diferencia.barbilla_y)).toBeLessThanOrEqual(4);
		}
	});

	it('con rotación ±90 el recorte es del cuadro visible (2160×3840) y da lo mismo que sin rotar', () => {
		const m = medidas({barbilla_y: 1240, alto_cara: 330, centro_x: 500});
		const recto = calcularEncuadre({medidas: m, objetivo, video: IPHONE});
		for (const rot of [90, -90]) {
			const r = calcularEncuadre({medidas: m, objetivo, video: ROTADO(rot)});
			expect(r.recorte).toEqual(recto.recorte);
			esRecorteSano(r.recorte, ROTADO(rot));
			expect(r.recorte_almacenado).toEqual(recorteAlmacenado(r.recorte, ROTADO(rot)));
			expect(r.recorte_almacenado.w).toBe(r.recorte.h);
			expect(r.recorte_almacenado.x + r.recorte_almacenado.w).toBeLessThanOrEqual(3840);
			expect(r.recorte_almacenado.y + r.recorte_almacenado.h).toBeLessThanOrEqual(2160);
		}
	});

	it('original que no es 9:16 (1440×1920): con s = 1 usa lo que el cover recortaba de los lados para centrar la cara', () => {
		const video = {ancho: 1440, alto: 1920, rotacion: 0, ancho_visible: 1440, alto_visible: 1920};
		// centro_x 400 en la base = x 580 del original (el cover tira 180 px de cada lado).
		const r = calcularEncuadre({medidas: medidas({barbilla_y: 1062, alto_cara: 393, centro_x: 400}), objetivo, video});
		expect(r.escala).toBe(1);
		expect(r.recorte).toEqual({x: 40, y: 0, w: 1080, h: 1920});
		expect(r.recorte.x).toBeLessThan(180); // el cover lo dejaba en 180
		expect(Math.abs(r.despues.centro_x - 540)).toBeLessThanOrEqual(2);
		expect(r.identidad).toBe(false);
	});

	it('sobre una base ya reencuadrada da el mismo recorte (no acumula zoom), acotado o no', () => {
		for (const barbilla of [1150, 1240]) {
			const primero = calcularEncuadre({medidas: medidas({barbilla_y: barbilla, alto_cara: 330, centro_x: 500, coronilla_y: 820}), objetivo, video: IPHONE});
			// La cara medida sobre la base nueva es (idealmente) lo predicho.
			const segundo = calcularEncuadre({medidas: primero.despues, objetivo, video: IPHONE, recorteActual: primero.recorte});
			expect(segundo.recorte).toEqual(primero.recorte);
			expect(segundo.antes.barbilla_y).toBeCloseTo(primero.antes.barbilla_y, 0);
		}
	});

	it('entradas inválidas: código 2', () => {
		expect(falloDe(() => calcularEncuadre({medidas: medidas({alto_cara: 0}), objetivo, video: IPHONE})).codigo).toBe(2);
		expect(falloDe(() => calcularEncuadre({medidas: medidas(), objetivo, video: IPHONE, recorteActual: {x: 0, y: 0, w: 4000, h: 3840}})).codigo).toBe(2);
		expect(falloDe(() => calcularEncuadre({medidas: medidas(), objetivo: {...objetivo, alto_cara: 0}, video: IPHONE})).codigo).toBe(2);
	});
});

describe('encuadre.json y base.ts', () => {
	const sondeoIphone = {video: {anchoVisible: 2160, altoVisible: 3840}} as Parameters<typeof resolverEncuadre>[2];
	const escribir = (nombre: string, r: ReturnType<typeof calcularEncuadre>, video: VideoOriginal, sha?: string) => {
		const ruta = join(tmp, nombre);
		const a = archivoEncuadre(r, {slug: '_x', video, fuente: {cara: 'cara.json', objetivo: 'estilo/encuadre.json'}});
		if (sha) (a.original as Record<string, unknown>).sha256 = sha;
		writeFileSync(ruta, JSON.stringify(a));
		return ruta;
	};

	it('el filtro pone el crop del original justo después de la entrada (ya rotada) y antes de fps, trim y scale', () => {
		const tramos = [{inicio: 300, fin: 390}];
		const con = construirFiltro(tramos, {video: 0, audio: 1}, {x: 180, y: 640, w: 1800, h: 3200});
		expect(con).toContain('[0:0]crop=1800:3200:180:640,fps=30:start_time=0,split=1[vs0]');
		expect(con).toContain('[vc]scale=1440:2560:force_original_aspect_ratio=increase:flags=lanczos,crop=1440:2560');
		// Sin encuadre queda igual que siempre.
		expect(construirFiltro(tramos, {video: 0, audio: 1})).toBe(construirFiltro(tramos, {video: 0, audio: 1}, null));
		expect(construirFiltro(tramos, {video: 0, audio: 1})).toContain('[0:0]fps=30:start_time=0,split=1[vs0]');
	});

	it('--4k: el mismo filtro (tramos, velocidad y encuadre) escala a 2160×3840 y la verificación lo pide así', () => {
		const tramos = [{inicio: 300, fin: 390}];
		const recorte = {x: 180, y: 640, w: 1800, h: 3200};
		const normal = construirFiltro(tramos, {video: 0, audio: 1}, recorte, 1.14);
		const cuatroK = construirFiltro(tramos, {video: 0, audio: 1}, recorte, 1.14, LIENZO_4K);
		expect(cuatroK).toContain('scale=2160:3840:force_original_aspect_ratio=increase:flags=lanczos,crop=2160:3840');
		expect(cuatroK.replaceAll('2160:3840', '1440:2560')).toBe(normal);
		const sondeo = {video: {ancho: 2160, alto: 3840, rotacion: 0, rFrameRate: '30/1', codec: 'h264', pixFmt: 'yuv420p', cuadros: 90, duracion: 3}, audio: {duracion: 3}, duracion: 3} as unknown as Parameters<typeof verificarBase>[0];
		expect(verificarBase(sondeo, 90, LIENZO_4K).problemas.filter((p) => p.includes('mide'))).toEqual([]);
		expect(verificarBase(sondeo, 90).problemas.some((p) => p.includes('no 1440×2560'))).toBe(true);
	});

	it('leerEncuadre y resolverEncuadre: identidad = sin recorte; otro tamaño u otro original: código 2', () => {
		const objetivo = {barbilla_y: 1062, alto_cara: 393, centro_x: 540};
		const acercar = calcularEncuadre({medidas: medidas({alto_cara: 330}), objetivo, video: IPHONE});
		const identidad = calcularEncuadre({medidas: medidas({alto_cara: 591}), objetivo, video: IPHONE});
		const rA = escribir('a.json', acercar, IPHONE, 'f'.repeat(64));
		expect(leerEncuadre(rA).recorte).toEqual(acercar.recorte);
		expect(resolverEncuadre(rA, {sha256: 'f'.repeat(64)}, sondeoIphone)).toMatchObject({recorte: acercar.recorte, identidad: false});
		expect(resolverEncuadre(escribir('i.json', identidad, IPHONE), {sha256: 'a'.repeat(64)}, sondeoIphone)).toMatchObject({recorte: null, identidad: true, escala_efectiva: 1});
		expect(falloDe(() => resolverEncuadre(rA, {sha256: 'e'.repeat(64)}, sondeoIphone)).codigo).toBe(2);
		expect(falloDe(() => resolverEncuadre(rA, {sha256: 'f'.repeat(64)}, {video: {anchoVisible: 1080, altoVisible: 1920}} as typeof sondeoIphone)).codigo).toBe(2);
		expect(resolverEncuadre(null, {sha256: 'f'.repeat(64)}, sondeoIphone)).toBeNull();
		writeFileSync(join(tmp, 'roto.json'), JSON.stringify({...JSON.parse(readFileSync(rA, 'utf8')), recorte: {x: 1, y: 0, w: 1800, h: 3200}}));
		expect(falloDe(() => leerEncuadre(join(tmp, 'roto.json'))).codigo).toBe(2);
		expect(falloDe(() => leerEncuadre(join(tmp, 'no-existe.json'))).codigo).toBe(2);
	});
});

// ───────────────────────── de punta a punta con un clip rotado (ffmpeg) ─────────────────────────

/** Marcas de color en el cuadro VISIBLE de 360×640 (lo que se ve ya rotado). */
const MARCAS = [
	{nombre: 'roja', color: 'red', rgb: [255, 0, 0], x: 100, y: 400, w: 40, h: 40},
	{nombre: 'azul', color: 'blue', rgb: [0, 0, 255], x: 220, y: 150, w: 40, h: 40},
	{nombre: 'verde', color: 'lime', rgb: [0, 255, 0], x: 300, y: 590, w: 40, h: 40},
] as const;

/**
 * Clip de 1 s con audio: el cuadro visible (360×640, gris con las marcas) se guarda girado y con la matriz de
 * rotación que lo endereza al verlo (+90: guardado girado a la derecha; −90: a la izquierda), como un iPhone.
 */
function clipRotado(ruta: string, rotacion: 90 | -90): void {
	const marcas = MARCAS.map((m) => `drawbox=x=${m.x}:y=${m.y}:w=${m.w}:h=${m.h}:color=${m.color}:t=fill`).join(',');
	const plano = `${ruta}.plano.mp4`;
	const girar = rotacion === 90 ? 'transpose=clock' : 'transpose=cclock';
	const a = spawnSync(
		'ffmpeg',
		['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=360x640:r=30:d=1,${marcas},${girar}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', plano],
		{encoding: 'utf8'},
	);
	expect(a.status, a.stderr).toBe(0);
	const b = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-display_rotation', String(rotacion), '-i', plano, '-c', 'copy', ruta], {encoding: 'utf8'});
	expect(b.status, b.stderr).toBe(0);
	rmSync(plano, {force: true});
}

/** Primer cuadro de un video reducido a 360×640, en RGB. */
function primerCuadro(video: string): Buffer {
	const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', video, '-frames:v', '1', '-vf', 'scale=360:640:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {maxBuffer: 1 << 24});
	expect(r.status, r.stderr?.toString()).toBe(0);
	return r.stdout;
}

/** ¿El pixel (x, y) del cuadro de 360×640 se parece al color? */
function colorEn(cuadro: Buffer, x: number, y: number): [number, number, number] {
	const i = (Math.round(y) * 360 + Math.round(x)) * 3;
	return [cuadro[i], cuadro[i + 1], cuadro[i + 2]];
}
const parecido = (a: readonly number[], b: readonly number[]) => a.every((v, k) => Math.abs(v - b[k]) <= 60);
/** Dónde debe caer el centro de una marca en el cuadro de 360×640 de la base hecha con ese recorte. */
function dondeCae(m: (typeof MARCAS)[number], r: Recorte): {x: number; y: number} {
	const p = originalABase({x: m.x + m.w / 2, y: m.y + m.h / 2}, r); // px base 1080×1920
	return {x: p.x / 3, y: p.y / 3};
}

describe('base.ts con encuadre sobre un clip rotado ±90 (ffmpeg real, carpeta temporal)', () => {
	it.each([90, -90] as const)('rotación %i: sin encuadre se ve igual que el visible; con encuadre el recorte sale del original y en su lugar', async (rotacion) => {
		const proyectos = join(tmp, `rot${rotacion}`);
		mkdirSync(proyectos, {recursive: true});
		const clip = join(tmp, `clip${rotacion}.mp4`);
		clipRotado(clip, rotacion);
		const slug = `_rot${rotacion === 90 ? 'mas' : 'menos'}90`;
		await ingerir({ruta: clip, slug, proyectos});

		// Sin encuadre: la base es el visible ×4 (cover de 360×640 a 1440×2560).
		const sin = await generarBase({slug, proyectos});
		expect(sin.verificacion).toMatchObject({ok: true, ancho: 1440, alto: 2560, rotacion: 0});
		expect(sin.encuadre).toBeNull();
		const c0 = primerCuadro(sin.salida);
		for (const m of MARCAS) expect(parecido(colorEn(c0, m.x + m.w / 2, m.y + m.h / 2), m.rgb), `marca ${m.nombre} sin encuadre`).toBe(true);
		const parametrosSin = leerManifest(slug, proyectos)!.etapas.base.parametros;
		expect(parametrosSin.encuadre).toBeUndefined();

		// Con encuadre ×1.25: ventana de 288×512 en (36, 116) del visible.
		const video: VideoOriginal = {ancho: 640, alto: 360, rotacion, ancho_visible: 360, alto_visible: 640};
		const recorte: Recorte = {x: 36, y: 116, w: 288, h: 512};
		const r = calcularEncuadre({medidas: medidas({barbilla_y: 1150, alto_cara: 200, centro_x: 540, coronilla_y: 820}), objetivo: {barbilla_y: 1000, alto_cara: 250, centro_x: 540}, video});
		expect(r.recorte).toEqual(recorte);
		expect(r.recorte_almacenado).toEqual(recorteAlmacenado(recorte, video));
		const ruta = join(proyectos, slug, 'encuadre.json');
		writeFileSync(ruta, JSON.stringify(archivoEncuadre(r, {slug, video, fuente: {cara: 'prueba', objetivo: 'prueba'}})));

		const con = await generarBase({slug, proyectos}); // lo toma solo porque existe proyectos/<slug>/encuadre.json
		expect(con.reutilizada).toBe(false);
		expect(con.encuadre).toMatchObject({recorte, identidad: false});
		expect(con.verificacion).toMatchObject({ok: true, ancho: 1440, alto: 2560, rotacion: 0, cuadros: 30});
		const c1 = primerCuadro(con.salida);
		const roja = dondeCae(MARCAS[0], recorte);
		const verde = dondeCae(MARCAS[2], recorte);
		expect(roja).toEqual({x: (120 - 36) * 1.25, y: (420 - 116) * 1.25});
		expect(parecido(colorEn(c1, roja.x, roja.y), MARCAS[0].rgb), `marca roja en (${roja.x}, ${roja.y})`).toBe(true);
		expect(parecido(colorEn(c1, verde.x, verde.y), MARCAS[2].rgb), `marca verde en (${verde.x}, ${verde.y})`).toBe(true);
		// La azul (y = 150–190) queda dentro de la ventana (y ≥ 116), cerca de arriba: (255, 67.5).
		const azul = dondeCae(MARCAS[1], recorte);
		expect(azul).toEqual({x: 255, y: 67.5});
		expect(parecido(colorEn(c1, azul.x, azul.y), MARCAS[1].rgb)).toBe(true);
		// Y donde la base sin encuadre tenía la roja ahora hay gris (el recorte de verdad movió la imagen).
		expect(parecido(colorEn(c1, 120, 420), MARCAS[0].rgb)).toBe(false);

		// Manifest: el recorte va en los parámetros; mismo encuadre → se reutiliza; --sin-encuadre → se rehace.
		const etapa = leerManifest(slug, proyectos)!.etapas.base;
		expect(etapa.parametros.encuadre).toEqual({recorte: [36, 116, 288, 512], cuadro: [360, 640]});
		expect((await generarBase({slug, proyectos})).reutilizada).toBe(true);
		const otra = await generarBase({slug, proyectos, encuadre: null});
		expect(otra.reutilizada).toBe(false);
		expect(leerManifest(slug, proyectos)!.etapas.base.parametros.encuadre).toBeUndefined();
	}, 120_000);
});

describe('flujo del CLI: encuadre de un proyecto y --aplicar (sin Vision: cara.json sintético)', () => {
	/** cara.json mínimo válido: 30 cuadros con la misma cara (base 1080×1920). */
	function caraSintetica(ruta: string): void {
		const cuadros = cuadrosCara(30, () => ({x: 440, y: 900, w: 200, h: 200, barbilla: 1150, coronilla: 820}));
		writeFileSync(
			ruta,
			JSON.stringify({
				version: 1,
				fuente: 'prueba',
				fps: 30,
				fps_muestreo: 10,
				duracion_s: 1,
				base: [1080, 1920],
				cortes_s: [],
				cuadros: cuadros.map((c) => ({...c, confianza: 0.9})),
				muestras: [],
				resumen: {cobertura: 1, barbilla_y: {p50: 1150, p90: 1150, max: 1150}, cuadros_sin_cara: 0},
			}),
		);
	}
	const s = (valor: number) => ({valor, p10: valor - 40, p90: valor + 40, n: 5});

	it('escribe encuadre.json con el recorte del original (y la etapa), --aplicar rehace la base con los mismos tramos', async () => {
		const proyectos = join(tmp, 'cli');
		mkdirSync(proyectos, {recursive: true});
		const clip = join(tmp, 'clip-cli.mp4');
		clipRotado(clip, 90);
		const slug = '_cli';
		await ingerir({ruta: clip, slug, proyectos});
		const dir = join(proyectos, slug);
		const objetivo = join(tmp, 'objetivo-cli.json');
		writeFileSync(objetivo, JSON.stringify({version: 1, fuente: 'prueba', barbilla_y: s(1000), alto_cara: s(250), centro_x: s(540), coronilla_y: s(600), n_reels: 5}));

		// Sin base ni cara: código 2 con el siguiente paso.
		expect((await falloAsync(encuadreDeProyecto(slug, {objetivo, proyectos}))).codigo).toBe(2);
		const base = await generarBase({slug, proyectos});
		expect((await falloAsync(encuadreDeProyecto(slug, {objetivo, proyectos}))).message).toMatch(/cara\.ts/);

		caraSintetica(join(dir, 'cara.json'));
		registrarEtapa(slug, 'cara', {estado: 'terminada', entradas: [await hashearArchivo(base.salida)], parametros: {version: 1}, salidas: [await hashearArchivo(join(dir, 'cara.json'), dir)]}, proyectos);

		const r = await encuadreDeProyecto(slug, {objetivo, proyectos});
		expect(r.resultado.recorte).toEqual({x: 36, y: 116, w: 288, h: 512});
		expect(r.resultado.escala).toBeCloseTo(1.25, 6);
		expect(r.archivo.original).toMatchObject({ancho: 640, alto: 360, rotacion: 90, ancho_visible: 360, alto_visible: 640});
		expect(leerEncuadre(join(dir, 'encuadre.json')).recorte).toEqual({x: 36, y: 116, w: 288, h: 512});
		expect(leerManifest(slug, proyectos)!.etapas.encuadre.estado).toBe('terminada');
		expect(resumenEncuadre(r)).toMatch(/barbilla 1150 px → 100\d px/);
		expect(cortesDeLaBase(leerManifest(slug, proyectos)!)).toBeNull();

		const aplicada = await aplicarEncuadre(slug, {proyectos});
		expect(aplicada.reutilizada).toBe(false);
		expect(aplicada.encuadre?.recorte).toEqual({x: 36, y: 116, w: 288, h: 512});
		expect(recorteDeLaBase(leerManifest(slug, proyectos)!)).toEqual({x: 36, y: 116, w: 288, h: 512});
		// La cara medida era de la base anterior: el encuadre pide volver a medirla.
		expect((await falloAsync(encuadreDeProyecto(slug, {objetivo, proyectos}))).message).toMatch(/otra base/);
	}, 120_000);

	it('--aplicar no toca nada si los tramos no salen iguales a los de la base anterior (código 2)', async () => {
		const proyectos = join(tmp, 'cli-tramos');
		mkdirSync(proyectos, {recursive: true});
		const clip = join(tmp, 'clip-tramos.mp4');
		clipRotado(clip, -90);
		const slug = '_tramos';
		await ingerir({ruta: clip, slug, proyectos});
		const base = await generarBase({slug, proyectos, desde: 0, hasta: 0.5}); // la base se hizo con una ventana
		const dir = join(proyectos, slug);
		const objetivo = join(tmp, 'objetivo-tramos.json');
		writeFileSync(objetivo, JSON.stringify({version: 1, fuente: 'prueba', barbilla_y: s(1000), alto_cara: s(250), centro_x: s(540), coronilla_y: s(600), n_reels: 5}));
		caraSintetica(join(dir, 'cara.json'));
		registrarEtapa(slug, 'cara', {estado: 'terminada', entradas: [await hashearArchivo(base.salida)], parametros: {version: 1}, salidas: [await hashearArchivo(join(dir, 'cara.json'), dir)]}, proyectos);
		// --escala-max baja el tope (aquí pedía ×1.25) y queda escrito; fuera de [1, 1.35] es código 2.
		const tope = await encuadreDeProyecto(slug, {objetivo, proyectos, escalaMax: 1.1});
		expect(tope.resultado.escala).toBeCloseTo(1.1, 6);
		expect(tope.resultado.limite_escala).toBe('max');
		expect(tope.archivo.limites).toMatchObject({escala_min: 1, escala_max: 1.1});
		expect(resumenEncuadre(tope)).toMatch(/el máximo es ×1\.1/);
		for (const malo of [0.9, 1.5, Number.NaN]) expect((await falloAsync(encuadreDeProyecto(slug, {objetivo, proyectos, escalaMax: malo}))).codigo).toBe(2);
		await encuadreDeProyecto(slug, {objetivo, proyectos});
		const antes = leerManifest(slug, proyectos)!.etapas.base;
		const e = await falloAsync(aplicarEncuadre(slug, {proyectos}));
		expect(e.codigo).toBe(2);
		expect(e.message).toMatch(/tramos/);
		expect(leerManifest(slug, proyectos)!.etapas.base.parametros_sha256).toBe(antes.parametros_sha256);
	}, 120_000);
});
