// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Motion graphics flotantes "libres" (src/estilo/motion-libre.ts): contrato en la EDL y en notas-director.json, golpes
 * por palabra, líneas de tiempo, geometría dentro de la zona segura, fondo por insert, y los módulos puros que usan
 * (resorte, trazo, anclaje). Lo visual se revisó renderizando cada uno sobre un video real (el reel de referencia del diseño).
 */
import {describe, expect, it} from 'vitest';
import {leerCreador} from '../../herramientas/lib/creador.ts';
import {EdicionValidada, edicionVacia, type Edicion} from '../../src/esquema/edicion';
import {FLOTANTE, cajaFlotante, fondoDeInsert, fondoEnCuadro, tramosFlotante} from '../../src/estilo/flotante';
import {SKILLS_EJEMPLO, assetMotion, duracionMinimaMotion, resolverMotion, type Motion} from '../../src/estilo/motion';
import {
	CAJA_ANTES,
	CAJA_LIBRE,
	CUADROS_CAJA,
	CUADROS_CONVERGEN,
	ENTRADA_VENTANA,
	FOCO_SALIDA,
	FONDO_DISENO,
	GOLPES_DISENO,
	PistaEsquema,
	RETICULA_MAX,
	RETICULA_OPACIDAD,
	SALIDA_LIBRE,
	cursorVisible,
	golpesRelativos,
	lineaPantalla,
	lineaPlantilla,
	lineaPrueba,
	lugaresSkills,
	piezasComando,
	skillsVisibles,
	staggerDecreciente,
	type PantallaResuelto,
	type PlantillaResuelto,
	type PruebaResuelto,
} from '../../src/estilo/motion-libre';
import {CARRIL_CAIDA, cabezaLibre, cajaCrece, cajasLibre, intensidadLibre, lugaresPlantilla, opacidadReticula, posePantalla, poseSkill, poseVentana, tapaRostro, VENTANA} from '../../src/estilo/poses-libres';
import {cabezaEn, cabezaEnPantalla, elipseOclusion, pistaCabeza, zonaRostro, type CuadroCaraPista} from '../../src/estilo/anclaje';
import {elipsesRetrato} from '../../src/estilo/flotante';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {RESORTES, cuadrosAsentado, resorte, sobrepaso} from '../../src/estilo/resorte';
import {graficaCurva, interpolarTrazos, lineaAMano, ovaloAMano, puntoEn, superelipse, trazoDe} from '../../src/estilo/trazo';
import {anclaCabeza} from '../../src/estilo/anclaje';
import {CURVAS} from '../../src/estilo/motion';
import {fueraDeZona} from '../../src/estilo/zona-segura';
import {leerNotas} from '../../herramientas/lib/director/plan';

type InsertEdl = Edicion['inserts'][number];

const insertLibre = (motion: Motion, extra: Partial<InsertEdl> = {}): InsertEdl => ({
	id: 'b1',
	tipo: 'motion',
	desde: 7.3,
	hasta: 12.1,
	asset: assetMotion(motion.nombre),
	trim_desde: 0,
	layout: 'flotante',
	tapaCabeza: false,
	texto: null,
	eventos: null,
	audio: {modo: 'mute', ganancia_db: 0},
	sfx: null,
	motion,
	...extra,
});

const conInserts = (inserts: InsertEdl[]) => EdicionValidada.safeParse({...edicionVacia, duracion_s: 40, inserts});

/** Las entradas que se le pasan al director (como las de notas-director.json del reel de referencia). */
const M1: Motion = {
	nombre: 'prueba-corregida',
	golpes: {normal: 7.581, porque: 7.891, has: 8.274, claude: 8.676, habilidades: 9.296, diseno: 9.88, animacion: 10.719},
	origen: {x: 540, y: 940, w: 800},
	sfx: [{asset: 'biblioteca/sfx/clic/propios-clic-grave.wav', en: 10.146, ganancia_db: -14}],
};
const M2: Motion = {nombre: 'plantilla-apple', golpes: {reglas: 13.674, diseno: 14.167, apple: 14.823, para: 15.354, eso: 16.246}, ancla: {x: 537, y: 987, lado: 636}};
const M3: Motion = {
	nombre: 'pantalla-a-objeto',
	golpes: {instalas: 25.0, y: 25.61, literalmente: 25.9, vas: 26.7, claude: 27.3},
	demo: {asset: 'demos/2026-10-04-reel-referencia/toma.mp4', eventos: 'demos/2026-10-04-reel-referencia/eventos.json', trim_desde: 0, cuadro: 127, encuadre: 'vertical'},
};

describe('contrato de los motions libres', () => {
	it('acepta los tres en layout flotante (EDL)', () => {
		const r = conInserts([insertLibre(M1), insertLibre(M2, {id: 'b2', desde: 13.65, hasta: 16.5}), insertLibre(M3, {id: 'b3', desde: 24.7, hasta: 27.819})]);
		expect(r.success).toBe(true);
	});

	it('no los deja en tarjeta ni a pantalla completa (van anclados a ti)', () => {
		for (const layout of ['tarjeta', 'pantalla-completa'] as const) {
			const r = conInserts([insertLibre(M2, {layout})]);
			expect(r.success).toBe(false);
			if (!r.success) expect(r.error.issues.map((i) => i.message).join(' ')).toMatch(/layout "flotante"/);
		}
	});

	it('el asset tiene que ser motion:<nombre>', () => {
		expect(conInserts([insertLibre(M1, {asset: 'motion:plantilla-apple'})]).success).toBe(false);
	});

	it('notas-director.json los acepta tal cual', () => {
		const r = leerNotas({
			inserts: [
				{asset: 'motion:prueba-corregida', tipo: 'motion', layout: 'flotante', desde: 7.3, hasta: 12.1, motion: M1},
				{asset: 'motion:plantilla-apple', tipo: 'motion', layout: 'flotante', desde: 13.65, hasta: 16.5, motion: M2},
				{asset: 'motion:pantalla-a-objeto', tipo: 'motion', layout: 'flotante', desde: 24.7, hasta: 27.819, motion: M3},
			],
		});
		expect(r.problemas).toEqual([]);
		expect(r.notas?.inserts).toHaveLength(3);
	});

	it('rechaza props fuera de rango (golpe negativo, plantilla diminuta, etiqueta larga)', () => {
		expect(conInserts([insertLibre({nombre: 'prueba-corregida', golpes: {normal: -1}})]).success).toBe(false);
		expect(conInserts([insertLibre({nombre: 'plantilla-apple', ancla: {x: 540, y: 990, lado: 100}})]).success).toBe(false);
		expect(conInserts([insertLibre({nombre: 'prueba-corregida', etiquetas: {diseno: 'UNA ETIQUETA LARGUÍSIMA', animacion: 'ANIMACIÓN'}})]).success).toBe(false);
	});
});

describe('golpes por palabra', () => {
	it('pasan de segundos absolutos a cuadros desde que entra el insert', () => {
		const g = golpesRelativos('prueba-corregida', {normal: 7.581, diseno: 9.88}, 7.3);
		expect(g.normal).toBe(Math.round(7.581 * 30) - Math.round(7.3 * 30));
		expect(g.diseno).toBe(296 - 219);
		// Los que no vienen usan los del diseño.
		expect(g.porque).toBe(GOLPES_DISENO['prueba-corregida'].porque);
	});

	it('sin `desde` usa los del diseño; un golpe antes del insert queda en 0', () => {
		expect(golpesRelativos('plantilla-apple', {reglas: 13.674}, undefined).reglas).toBe(0);
		expect(golpesRelativos('plantilla-apple', {apple: 10}, 13.65).apple).toBe(0);
	});

	it('si cambian los cortes, la animación los sigue (mismo motion, golpes corridos 0.5 s → 15 cuadros)', () => {
		const a = resolverMotion(M2, 13.65) as PlantillaResuelto;
		const m2b: Motion = {...M2, golpes: {reglas: 14.174, diseno: 14.667, apple: 15.323, para: 15.854, eso: 16.746}};
		const b = resolverMotion(m2b, 14.15) as PlantillaResuelto;
		expect(b.golpes).toEqual(a.golpes);
	});

	it('los golpes del diseño son los del reel de referencia (cuadros relativos)', () => {
		const r = resolverMotion(M1, 7.3) as PruebaResuelto;
		expect(r.golpes).toEqual({normal: 8, porque: 18, has: 29, claude: 41, habilidades: 60, diseno: 77, animacion: 103});
		const r3 = resolverMotion(M3, 24.7) as PantallaResuelto;
		expect(r3.golpes).toEqual({instalas: 9, y: 27, literalmente: 36, vas: 60, claude: 78});
	});

	it('los SFX caen en su cuadro relativo', () => {
		const r = resolverMotion(M1, 7.3) as PruebaResuelto;
		expect(r.sfx[0].cuadro).toBe(Math.round(10.146 * 30) - 219);
	});
});

/**
 * Tu cabeza moviéndose como en el reel de referencia (sintética, para que la prueba no dependa de proyectos/): la cara se corre
 * ±70 px a los lados y ±40 px arriba y abajo, con la caja y la coronilla de las medidas reales (7.3–27.8 s).
 */
function cuadrosSinteticos(desde: number, hasta: number): CuadroCaraPista[] {
	const out: CuadroCaraPista[] = [];
	for (let t = desde - 0.5; t <= hasta + 0.5; t += 1 / 30) {
		const dx = 70 * Math.sin(2 * Math.PI * 0.4 * t);
		const dy = 40 * Math.sin(2 * Math.PI * 0.55 * t + 1);
		const x = 270 + dx;
		const y = 700 + dy;
		out.push({t, cara: {x, y, w: 580, h: 580}, coronilla_y: y - 170, barbilla_y: y + 625, boca_y: y + 480, cabeza: {x: x - 60, y: y - 170, w: 530, h: 795}});
	}
	return out;
}

const DUR = {m1: Math.round(12.1 * 30) - 219, m2: Math.round(16.9 * 30) - Math.round(13.65 * 30), m3: Math.round(27.819 * 30) - Math.round(24.7 * 30)};
const conPistaSint = (m: Motion, d: number, h: number): Motion => ({...m, pista: pistaCabeza(cuadrosSinteticos(d, h), d, h)!} as Motion);

describe('líneas de tiempo', () => {
	it('prueba-corregida: ventana → pluma → huecos → DISEÑO → ANIMACIÓN (zoom, curva, bolita) → salida → foco', () => {
		const r = resolverMotion(M1, 7.3) as PruebaResuelto;
		const lt = lineaPrueba(r, DUR.m1);
		const orden = [lt.vuelo, lt.ovalo, lt.tachon, lt.equis, lt.huecos, lt.diseno, lt.animacion, lt.zoom, lt.curva, lt.bolita, lt.salida];
		for (let i = 1; i < orden.length; i++) expect(orden[i]).toBeGreaterThan(orden[i - 1]);
		// Las piezas salen y terminan justo cuando empieza el foco de tu cuarto: nada a media opacidad sobre tu cara nítida.
		expect(lt.salida + SALIDA_LIBRE).toBe(DUR.m1 - FOCO_SALIDA);
		expect(lt.piezas.slice(1).map((v, i) => v - lt.piezas[i])).toEqual([3, 2, 2]);
		expect(duracionMinimaMotion(M1)).toBeLessThanOrEqual(12.1 - 7.3);
	});

	it('prueba-corregida: la ventana nunca se queda quieta (deriva + bolita en loop hasta la salida)', () => {
		const r = resolverMotion(M1, 7.3) as PruebaResuelto;
		const lt = lineaPrueba(r, DUR.m1);
		for (let f = 20; f < lt.salida; f += 10) {
			const a = poseVentana(r, f, DUR.m1);
			const b = poseVentana(r, f + 3, DUR.m1);
			expect(Math.hypot(a.cx - b.cx, a.cy - b.cy) + Math.abs(a.ry - b.ry)).toBeGreaterThan(0.05);
		}
	});

	it('plantilla-apple: enfoque en "reglas", líneas en "diseño", esquinas en "Apple", fichas en "para"; sale escalonado', () => {
		const r = resolverMotion(M2, 13.65) as PlantillaResuelto;
		const lt = lineaPlantilla(r, DUR.m2);
		expect(lt.foco).toBe(r.golpes.reglas);
		expect(lt.lineas[0]).toBe(r.golpes.diseno);
		expect(lt.esquinas).toBe(r.golpes.apple);
		expect(lt.fichas[0]).toBe(r.golpes.para);
		// Fichas (stagger 2) → retícula → foco, sin encimarse.
		expect(lt.salidaFichas[1] - lt.salidaFichas[0]).toBe(2);
		expect(lt.salidaFichas[0]).toBeLessThan(lt.salidaReticula);
		expect(lt.salidaFichas[2]).toBeLessThan(lt.salidaReticula);
		expect(lt.salida).toBe(DUR.m2 - FOCO_SALIDA);
		expect(duracionMinimaMotion(M2)).toBeLessThanOrEqual(16.9 - 13.65);
	});

	it('pantalla-a-objeto: tecla en "instalas", cartas después, la caja ya está cuando caen (desde "Claude") y la última aterriza justo antes del relevo', () => {
		const r = resolverMotion(M3, 24.7) as PantallaResuelto;
		const lt = lineaPantalla(r, DUR.m3);
		expect(lt.hunde).toBe(r.golpes.instalas);
		expect(lt.vuelan[0]).toBeGreaterThan(lt.hunde);
		// La caja (con su cursor) crece en 7 cuadros y espera 3 antes de la primera carta: el cursor nunca anda solo.
		expect(lt.cursor).toBe(lt.caja);
		expect(lt.caja).toBeGreaterThanOrEqual(r.golpes.vas);
		expect(lt.convergen[0] - lt.caja).toBe(CUADROS_CAJA + CAJA_ANTES);
		expect(lt.convergen[0]).toBeGreaterThanOrEqual(r.golpes.claude);
		expect(lt.convergen[0] - r.golpes.claude).toBeLessThanOrEqual(6);
		expect(CUADROS_CONVERGEN).toBeLessThanOrEqual(6);
		// La última carta aterriza a lo mucho 2 cuadros antes del relevo con la tarjeta (que escribe enseguida).
		expect(lt.pulso).toBeLessThanOrEqual(DUR.m3);
		expect(DUR.m3 - lt.pulso).toBeLessThanOrEqual(2);
		expect(cajaCrece(r, lt.caja - 1, DUR.m3)).toBeNull();
		expect(cajaCrece(r, lt.caja + CUADROS_CAJA - 1, DUR.m3)!.p).toBeCloseTo(1, 6);
		// En el último cuadro la caja ya mide lo que la tarjeta (relevo sin costura).
		const c = cajaCrece(r, DUR.m3 - 1, DUR.m3)!;
		expect(c.p).toBeCloseTo(1, 2);
		expect(Math.abs(c.x0 - r.tarjeta.x0) + Math.abs(c.y1 - r.tarjeta.y1)).toBeLessThan(2);
		expect([0, 7, 8, 13, 14, 21].map(cursorVisible)).toEqual([true, true, false, false, true, true]);
		expect(duracionMinimaMotion(M3)).toBeLessThanOrEqual(27.819 - 24.7);
	});

	it('stagger decreciente', () => {
		expect(staggerDecreciente(10, 4, [4, 3, 2, 1])).toEqual([10, 14, 17, 19]);
		expect(staggerDecreciente(0, 7, [3, 3, 2, 2, 1, 1])).toEqual([0, 3, 6, 8, 10, 11, 12]);
	});
});

describe('geometría en la zona segura de Reels', () => {
	it('3 skills a ≥ 28 px y un "+N" arriba de tu cabeza, dentro de x 135–945, sin encimarse', () => {
		expect(skillsVisibles(SKILLS_EJEMPLO)).toEqual(['design-eng', 'animate', 'review-animations', '+4']);
		const fichas = lugaresSkills(SKILLS_EJEMPLO);
		for (const f of fichas) {
			expect(f.letra * f.escala).toBeGreaterThanOrEqual(28);
			const c = {x0: f.cx - (f.w * f.escala) / 2, x1: f.cx + (f.w * f.escala) / 2, y0: f.cy - (f.h * f.escala) / 2, y1: f.cy + (f.h * f.escala) / 2};
			expect(c.x0).toBeGreaterThanOrEqual(CAJA_LIBRE.x0);
			expect(c.x1).toBeLessThanOrEqual(CAJA_LIBRE.x1);
			expect(c.y0).toBeGreaterThanOrEqual(CAJA_LIBRE.y0);
			expect(c.y1).toBeLessThan(490);
			expect(fueraDeZona(c, 'capa')).toEqual([]);
		}
		for (let i = 0; i < fichas.length; i++)
			for (let j = i + 1; j < fichas.length; j++) {
				const a = fichas[i];
				const b = fichas[j];
				const sx = Math.abs(a.cx - b.cx) >= (a.w * a.escala + b.w * b.escala) / 2;
				const sy = Math.abs(a.cy - b.cy) >= (a.h * a.escala + b.h * b.escala) / 2;
				expect(sx || sy).toBe(true);
			}
	});

	it('el comando (mono 26 px) y la tecla quedan en tu pecho, entre tu barbilla y los subtítulos, sin salirse', () => {
		const {ficha, tecla} = piezasComando('npx skills@latest add creador-demo/skills');
		expect(ficha.letra).toBeGreaterThanOrEqual(26);
		for (const c of [ficha, tecla]) {
			expect(c.x0).toBeGreaterThanOrEqual(135);
			expect(c.x1).toBeLessThanOrEqual(945);
			expect(c.y0).toBeGreaterThan(1345); // la barbilla más baja del reel de referencia en ese tramo (pista de cara.json)
			expect(c.y1).toBeLessThanOrEqual(CAJA_LIBRE.y1);
			expect(fueraDeZona(c, 'capa')).toEqual([]);
		}
		expect(tecla.x0).toBeGreaterThan(ficha.x1);
		// ~160 px entre el centro de la ficha y el de los subtítulos (y 1545).
		expect(1545 - (ficha.y0 + ficha.y1) / 2).toBeGreaterThanOrEqual(155);
	});

	it('la ventana de M1 vive arriba de tu cabeza, dentro de la zona segura, y su orilla de abajo se mete detrás de tu coronilla', () => {
		const m = conPistaSint(M1, 7.3, 12.1);
		const r = resolverMotion(m, 7.3) as PruebaResuelto;
		for (let f = 12; f < lineaPrueba(r, DUR.m1).salida; f++) {
			const v = poseVentana(r, f, DUR.m1);
			expect(v.cy - VENTANA.h / 2).toBeGreaterThanOrEqual(224);
			const cab = cabezaLibre(r, f, DUR.m1);
			expect(v.cy + VENTANA.h / 2).toBeGreaterThan(cab.coronilla - 40);
		}
	});

	it('fichas y título de la plantilla quedan fuera del óvalo de tu cara y dentro de la zona segura', () => {
		const m = conPistaSint(M2, 13.65, 16.9);
		const r = resolverMotion(m, 13.65) as PlantillaResuelto;
		for (let f = 0; f < DUR.m2; f += 2) {
			const cab = cabezaLibre(r, f, DUR.m2);
			const z = zonaRostro(cab);
			const {titulo, fichas} = lugaresPlantilla(cab);
			for (const c of [titulo, ...fichas.map((x) => ({x0: x.x0, y0: x.y0, x1: x.x0 + x.w, y1: x.y0 + x.h}))]) {
				expect(c.x1 <= z.x0 || c.x0 >= z.x1 || c.y1 <= z.y0 || c.y0 >= z.y1).toBe(true);
				expect(fueraDeZona(c, 'capa')).toEqual([]);
			}
		}
	});

	it('la caja flotante de un motion libre es CAJA_LIBRE (lo que miden layout.ts y validar.ts)', () => {
		expect(cajaFlotante(undefined, 'plantilla-apple')).toEqual({...CAJA_LIBRE, escala: 1});
		expect(fueraDeZona(CAJA_LIBRE, 'capa')).toEqual([]);
		expect(cajaFlotante(undefined, 'reglas-apple')).toEqual({x0: 135, y0: 250, x1: 945, y1: 1230, escala: 1});
	});
});

describe('nada tapa tus ojos, nariz ni boca (regla dura de los motions libres)', () => {
	const casos: Array<[string, Motion, number, number, number]> = [
		['prueba-corregida', M1, 7.3, 12.1, DUR.m1],
		['plantilla-apple', M2, 13.65, 16.9, DUR.m2],
		['pantalla-a-objeto', M3, 24.7, 27.819, DUR.m3],
	];
	for (const [nombre, m, d, h, dur] of casos) {
		it(`${nombre}: con tu cabeza moviéndose, ninguna pieza te tapa más de 0.5 s seguidos`, () => {
			const r = resolverMotion(conPistaSint(m, d, h), d) as PruebaResuelto | PlantillaResuelto | PantallaResuelto;
			const t = tapaRostro(r, dur);
			expect(t.racha).toBeLessThanOrEqual(15);
		});
	}

	it('prueba-corregida: la ventana (con sus ranuras y fichas) no cruza tu cara en NINGÚN cuadro: entra ya arriba de tu cabeza', () => {
		const r = resolverMotion(conPistaSint(M1, 7.3, 12.1), 7.3) as PruebaResuelto;
		expect(tapaRostro(r, DUR.m1).cuadros).toEqual([]);
		// Entrada propia corta: en ENTRADA_VENTANA cuadros ya está completa y nítida.
		const v = poseVentana(r, ENTRADA_VENTANA - 1, DUR.m1);
		expect(v.op).toBeCloseTo(1, 6);
		expect(v.blur).toBeCloseTo(0, 6);
	});

	it('plantilla-apple: fichas y título nunca te tapan; la retícula interna destella ≤ 12 cuadros a ≤ 0.35', () => {
		const r = resolverMotion(conPistaSint(M2, 13.65, 16.9), 13.65) as PlantillaResuelto;
		const t = tapaRostro(r, DUR.m2);
		expect([...t.piezas].filter((p) => p !== 'reticula')).toEqual([]);
		expect(t.racha).toBeLessThanOrEqual(RETICULA_MAX);
		const lt = lineaPlantilla(r, DUR.m2);
		for (let f = 0; f < DUR.m2; f++) expect(opacidadReticula(lt, f)).toBeLessThanOrEqual(RETICULA_OPACIDAD + 1e-9);
		expect(opacidadReticula(lt, r.golpes.diseno + RETICULA_MAX)).toBe(0);
	});

	it('pantalla-a-objeto: solo el cuadro de continuidad y el arranque del comando (≤ 2 cuadros); ni la tecla, ni las cartas, ni la caja te cruzan', () => {
		const r = resolverMotion(conPistaSint(M3, 24.7, 27.819), 24.7) as PantallaResuelto;
		const t = tapaRostro(r, DUR.m3);
		expect(t.racha).toBeLessThanOrEqual(2);
		expect(t.cuadros.every((f) => f <= 2)).toBe(true);
		for (const p of t.piezas) expect(['pantalla', 'comando']).toContain(p);
		// Desde el cuadro 1 la pantalla va detrás de tu cabeza entera; su recorte libera tu cuerpo en ≤ 3 cuadros.
		expect(posePantalla(r, 0, DUR.m3).detras).toBe(false);
		expect(posePantalla(r, 1, DUR.m3).detras).toBe(true);
		expect(posePantalla(r, 3, DUR.m3).recorte.y1).toBeLessThan(1000);
	});

	it('pantalla-a-objeto: las cartas bajan a la caja por tu costado izquierdo, ya encogidas cuando pasan a la altura de tu cara', () => {
		const r = resolverMotion(conPistaSint(M3, 24.7, 27.819), 24.7) as PantallaResuelto;
		const lt = lineaPantalla(r, DUR.m3);
		lugaresSkills(r.skills).forEach((fi, i) => {
			for (let f = lt.convergen[i]; f < lt.convergen[i] + 6; f++) {
				const s = poseSkill(r, fi, i, f, DUR.m3);
				const z = zonaRostro(cabezaLibre(r, f, DUR.m3));
				if (s.y > z.y0 - 40) {
					expect(s.x + (fi.w * s.escala) / 2).toBeLessThan(z.x0);
					expect(s.escala).toBeLessThanOrEqual(0.25);
				}
			}
			expect(CARRIL_CAIDA).toBeLessThan(260);
		});
	});

	// Con la cabeza real del reel de referencia (su cara.json), si está en esta máquina (proyectos/ no va en git). El
	// proyecto lo dice estilo/estilos/<estilo activo>/motion-ejemplo.json → proyecto.
	const rutaCara = ((): string => {
		const activo = leerCreador().estilo_activo;
		const ejemplo = activo ? join(__dirname, '../../estilo/estilos', activo, 'motion-ejemplo.json') : '';
		const proyecto = ejemplo && existsSync(ejemplo) ? (JSON.parse(readFileSync(ejemplo, 'utf8')) as {proyecto?: string}).proyecto : undefined;
		return proyecto ? join(__dirname, '../..', proyecto, 'cara.json') : '';
	})();
	it.skipIf(!rutaCara || !existsSync(rutaCara))('con la cabeza real del reel de referencia (cara.json): ≤ 0.5 s seguidos en los tres', () => {
		const cara = JSON.parse(readFileSync(rutaCara, 'utf8')) as {cuadros: CuadroCaraPista[]};
		for (const [, m, d, h, dur] of casos) {
			const pista = pistaCabeza(cara.cuadros, d, h)!;
			const r = resolverMotion({...m, pista} as Motion, d) as PruebaResuelto | PlantillaResuelto | PantallaResuelto;
			expect(tapaRostro(r, dur).racha).toBeLessThanOrEqual(r.nombre === 'plantilla-apple' ? RETICULA_MAX : 2);
		}
	});
});

describe('pista de tu cabeza y foco de retrato', () => {
	it('una fila por cuadro (con 3 de rampa antes), suavizada y en px base', () => {
		const p = pistaCabeza(cuadrosSinteticos(13.65, 16.9), 13.65, 16.9)!;
		expect(p.inicio).toBe(-3);
		expect(p.c).toHaveLength(Math.round(16.9 * 30) - Math.round(13.65 * 30) + 4);
		expect(PistaEsquema.safeParse(p).success).toBe(true);
		// Suavizada: el salto entre cuadros es menor que en la entrada cruda.
		for (let i = 1; i < p.c.length; i++) expect(Math.abs(p.c[i][0] - p.c[i - 1][0])).toBeLessThan(12);
		const c = cabezaEn(p, 10.5);
		expect(c.cx).toBeGreaterThan(Math.min(p.c[13][0], p.c[14][0]) - 1e-9);
		expect(c.cx).toBeLessThan(Math.max(p.c[13][0], p.c[14][0]) + 1e-9);
	});

	it('sin pista usa una cabeza fija; con pista la plantilla te sigue', () => {
		const fija = resolverMotion(M2, 13.65) as PlantillaResuelto;
		expect(Math.abs(cabezaLibre(fija, 0, DUR.m2).cx - cabezaLibre(fija, 60, DUR.m2).cx)).toBeLessThan(1);
		const viva = resolverMotion(conPistaSint(M2, 13.65, 16.9), 13.65) as PlantillaResuelto;
		const xs = Array.from({length: DUR.m2}, (_, f) => cabezaLibre(viva, f, DUR.m2).cx);
		expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(40);
	});

	it('el push-in mueve tu cabeza en pantalla alrededor de (540, 864)', () => {
		const c = {cx: 540, cy: 864, w: 500, h: 500, coronilla: 600, barbilla: 1200, boca: 1100, cabCx: 500, cabW: 480};
		const s = cabezaEnPantalla(c, 1.1);
		expect(s.cx).toBe(540);
		expect(s.cy).toBe(864);
		expect(s.coronilla).toBeCloseTo(864 - 264 * 1.1, 6);
		expect(s.cabCx).toBeCloseTo(540 - 40 * 1.1, 6);
	});

	it('la elipse de oclusión abraza la parte de arriba de tu cabeza (anchos medidos en el reel de referencia)', () => {
		const c = {cx: 585, cy: 970, w: 593, h: 593, coronilla: 496, barbilla: 1291, boca: 1149, cabCx: 488, cabW: 530};
		const e = elipseOclusion(c);
		const ancho = (d: number) => {
			const y = c.coronilla + d - e.cy;
			return 2 * e.rx * Math.sqrt(Math.max(0, 1 - (y * y) / (e.ry * e.ry)));
		};
		expect(ancho(60)).toBeGreaterThan(270);
		expect(ancho(60)).toBeLessThan(340);
		expect(ancho(140)).toBeGreaterThan(390);
		expect(ancho(260)).toBeGreaterThan(460);
	});

	it('el tramo de un motion libre arranca 3 cuadros antes, lleva su pista y el retrato devuelve tu cabeza', () => {
		const m = conPistaSint(M2, 13.65, 16.9);
		const tramos = tramosFlotante([insertLibre(m, {desde: 13.65, hasta: 16.9})]);
		expect(tramos[0].desde).toBe(Math.round(13.65 * 30) - 3);
		expect(tramos[0].retratos).toHaveLength(1);
		const els = elipsesRetrato(Math.round(13.65 * 30) + 20, tramos, 1.03);
		expect(els).toHaveLength(2);
		expect(elipsesRetrato(10, tramos, 1)).toBeNull();
		// Sin pista no hay retrato (se desenfoca todo, como antes).
		expect(elipsesRetrato(Math.round(13.65 * 30) + 20, tramosFlotante([insertLibre(M2, {desde: 13.65, hasta: 16.9})]), 1)).toBeNull();
	});

	it('el director escribe la pista sola desde cara.json (las notas no la traen)', () => {
		const r = leerNotas({inserts: [{asset: 'motion:plantilla-apple', tipo: 'motion', layout: 'flotante', desde: 13.65, hasta: 16.9, motion: M2}]});
		expect(r.problemas).toEqual([]);
	});
});

describe('fondo por insert y rack focus', () => {
	it('cada motion libre pide su fondo; motion.fondo lo sobrescribe campo por campo', () => {
		const ins = insertLibre(M2);
		expect(fondoDeInsert(ins)).toEqual(FONDO_DISENO['plantilla-apple']);
		const otro = insertLibre({...M2, fondo: {blur_px: 9}} as Motion);
		expect(fondoDeInsert(otro)).toEqual({...FONDO_DISENO['plantilla-apple'], blur_px: 9});
		expect(fondoDeInsert({layout: 'flotante', desde: 0, hasta: 1, motion: {nombre: 'reglas-apple'}})).toBeUndefined();
	});

	it('el tramo lleva su fondo y fondoEnCuadro lo devuelve mientras dura', () => {
		const tramos = tramosFlotante([insertLibre(M2, {desde: 13.65, hasta: 16.5})]);
		expect(tramos[0].fondo?.blur_px).toBe(FONDO_DISENO['plantilla-apple'].blur_px);
		expect(fondoEnCuadro(450, tramos).oscurecer).toBe(0.22);
		expect(fondoEnCuadro(10, tramos)).toEqual({blur_px: FLOTANTE.blur_px, oscurecer: FLOTANTE.oscurecer, escala: FLOTANTE.escala});
	});

	it('entrada: rack focus que arranca 3 cuadros antes y llega a su máximo en ~10 (no de golpe en 1)', () => {
		const k = (f: number) => intensidadLibre(f, 144);
		expect(k(-4)).toBe(0);
		expect(k(-3)).toBeGreaterThan(0);
		expect(k(-3)).toBeLessThan(0.5);
		expect(k(0) - k(-1)).toBeLessThan(0.25);
		expect(k(6)).toBeCloseTo(1, 6);
	});

	it('salida: las piezas ya se fueron cuando tu cuarto empieza a enfocarse, y el foco dura 9 cuadros', () => {
		const dur = 144;
		expect(intensidadLibre(dur - FOCO_SALIDA - 1, dur)).toBe(1);
		const primero = intensidadLibre(dur - FOCO_SALIDA, dur);
		expect(1 - primero).toBeLessThan(0.1);
		expect(intensidadLibre(dur - 1, dur)).toBeLessThan(0.1);
		const r = resolverMotion(M1, 7.3) as PruebaResuelto;
		expect(poseVentana(r, dur - FOCO_SALIDA, dur).op).toBeCloseTo(0, 6);
		expect(cajasLibre(r, dur - FOCO_SALIDA, dur)).toEqual([]);
	});
});

describe('resorte en forma cerrada', () => {
	it('arranca en 0, llega a 1 y rebota poco (bounce sutil)', () => {
		for (const c of Object.values(RESORTES)) {
			expect(resorte(0, c)).toBe(0);
			expect(resorte(-3, c)).toBe(0);
			expect(resorte(90, c)).toBeCloseTo(1, 3);
			expect(sobrepaso(c)).toBeLessThan(0.1);
		}
		expect(sobrepaso(RESORTES.vivo)).toBeGreaterThan(0.03);
	});

	it('acepta cuadros fraccionarios (para el desenfoque de movimiento) y es continuo', () => {
		const a = resorte(5, RESORTES.vivo);
		const b = resorte(5.125, RESORTES.vivo);
		expect(b).toBeGreaterThan(a);
		expect(b - a).toBeLessThan(0.05);
	});

	it('el pesado se asienta más lento que el vivo', () => {
		expect(cuadrosAsentado(RESORTES.pesado)).toBeGreaterThan(cuadrosAsentado(RESORTES.vivo));
		expect(cuadrosAsentado(RESORTES.vivo)).toBeLessThanOrEqual(14);
	});

	it('sobreamortiguado y crítico tampoco se pasan de 1', () => {
		for (const c of [{damping: 40, stiffness: 100, mass: 1}, {damping: 20, stiffness: 100, mass: 1}]) {
			for (let f = 0; f < 60; f += 0.5) expect(resorte(f, c)).toBeLessThanOrEqual(1 + 1e-9);
		}
	});
});

describe('trazos', () => {
	it('largo y punta de la pluma', () => {
		const t = trazoDe([{x: 0, y: 0}, {x: 30, y: 40}, {x: 30, y: 100}]);
		expect(t.largo).toBeCloseTo(110, 6);
		expect(puntoEn(t, 0)).toEqual({x: 0, y: 0});
		expect(puntoEn(t, 50 / 110)).toEqual({x: 30, y: 40});
		expect(puntoEn(t, 1)).toEqual({x: 30, y: 100});
	});

	it('el óvalo a mano se pasa de su inicio y no es un círculo perfecto', () => {
		const o = ovaloAMano(0, 0, 100, 50, {extra_grados: 18});
		const perimetro = Math.PI * (3 * 150 - Math.sqrt((300 + 50) * (100 + 150)));
		expect(o.largo).toBeGreaterThan(perimetro);
		const radios = o.puntos.map((p) => Math.hypot(p.x / 100, p.y / 50));
		expect(Math.max(...radios) - Math.min(...radios)).toBeGreaterThan(0.02);
	});

	it('la superelipse va de casi cuadrado (n alto) a esquina continua (n = 5) con los mismos puntos', () => {
		const cuadrado = superelipse(0, 0, 100, 100, 40);
		const apple = superelipse(0, 0, 100, 100, 5);
		expect(cuadrado.puntos.length).toBe(apple.puntos.length);
		const esquina = (s: typeof cuadrado) => Math.max(...s.puntos.map((p) => Math.min(Math.abs(p.x), Math.abs(p.y))));
		expect(esquina(cuadrado)).toBeGreaterThan(95);
		expect(esquina(apple)).toBeLessThan(90);
		const mitad = interpolarTrazos(cuadrado, apple, 0.5);
		expect(esquina(mitad)).toBeLessThan(esquina(cuadrado));
		expect(esquina(mitad)).toBeGreaterThan(esquina(apple));
	});

	it('la gráfica de ease-out arranca abajo, sube rápido y termina arriba', () => {
		const g = graficaCurva(CURVAS.salida, 0, 0, 100, 100);
		expect(g.puntos[0]).toEqual({x: 0, y: 100});
		expect(g.puntos[g.puntos.length - 1].y).toBeCloseTo(0, 6);
		const mitad = g.puntos[Math.floor(g.puntos.length / 2)];
		expect(100 - mitad.y).toBeGreaterThan(80);
	});

	it('el tachón tiene panza', () => {
		const l = lineaAMano({x: 0, y: 0}, {x: 100, y: 0}, 6);
		expect(Math.max(...l.puntos.map((p) => Math.abs(p.y)))).toBeCloseTo(6, 6);
	});
});

describe('anclaje a tu cabeza', () => {
	it('mediana de la cara en el tramo, con lado × 1.12', () => {
		const cuadros = [
			{t: 0, cara: {x: 100, y: 200, w: 500, h: 500}, coronilla_y: 180, barbilla_y: 720},
			{t: 0.5, cara: {x: 120, y: 210, w: 520, h: 520}, coronilla_y: 170, barbilla_y: 740},
			{t: 1, cara: {x: 140, y: 220, w: 540, h: 540}, coronilla_y: 190, barbilla_y: 760},
			{t: 5, cara: {x: 900, y: 900, w: 100, h: 100}},
		];
		const a = anclaCabeza(cuadros, 0, 2)!;
		expect(a.x).toBe(380);
		expect(a.y).toBe(470);
		expect(a.lado).toBe(Math.round(520 * 1.12));
		expect(a.coronilla_y).toBe(170);
		expect(a.barbilla_y).toBe(760);
		expect(a.n).toBe(3);
		expect(anclaCabeza(cuadros, 10, 12)).toBeNull();
	});
});
