// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Modo flotante de los motion graphics (src/estilo/flotante.ts): contrato, rampas del fondo (tu toma desenfocada),
 * entrada de la escena, cajas, y que validar.ts / layout.ts no lo traten como algo que tapa tu cabeza.
 */
import {describe, expect, it} from 'vitest';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {estiloDesde} from '../../herramientas/lib/director/estilo.ts';
import {leerNotas} from '../../herramientas/lib/director/plan.ts';
import {cajaVisibleInsert, colocarInsert} from '../../herramientas/layout.ts';
import {validarEdicion, type OpcionesValidar} from '../../herramientas/validar.ts';
import {EdicionValidada, edicionVacia, type Edicion} from '../../src/esquema/edicion.ts';
import {CENTRO_FLOTANTE, FLOTANTE, cajaFlotante, escenaFlotante, fondoFlotante, intensidadFlotante, tramosFlotante} from '../../src/estilo/flotante.ts';
import {assetMotion, ESCENA} from '../../src/estilo/motion.ts';
import {fueraDeZona} from '../../src/estilo/zona-segura.ts';
import {HAY_FUENTES} from './requisitos.ts';

type InsertEdl = Edicion['inserts'][number];

const flotante = (extra: Partial<InsertEdl> = {}): InsertEdl => ({
	id: 'm1',
	tipo: 'motion',
	desde: 2,
	hasta: 5,
	asset: assetMotion('reglas-apple'),
	trim_desde: 0,
	layout: 'flotante',
	tapaCabeza: false,
	texto: null,
	eventos: null,
	audio: {modo: 'mute', ganancia_db: 0},
	sfx: null,
	motion: {nombre: 'reglas-apple'},
	...extra,
});

describe('contrato del layout "flotante"', () => {
	it('lo acepta en un motion, con o sin caja', () => {
		const r = EdicionValidada.safeParse({...edicionVacia, duracion_s: 10, inserts: [flotante(), flotante({id: 'm2', desde: 6, hasta: 9, caja: {x: 540, y: 700, escala: 0.9}})]});
		expect(r.success).toBe(true);
	});

	it('no lo deja en otros tipos de insert', () => {
		const r = EdicionValidada.safeParse({...edicionVacia, duracion_s: 10, inserts: [flotante({tipo: 'imagen', asset: 'p/x/a.png', motion: undefined})]});
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.issues.map((i) => i.message).join(' ')).toMatch(/solo para motion graphics/);
	});

	it('notas-director.json acepta "flotante" en inserts', () => {
		const r = leerNotas({inserts: [{asset: 'motion:reglas-apple', layout: 'flotante', desde: 13.65, hasta: 16.5, motion: {nombre: 'reglas-apple'}}]});
		expect(r.problemas).toEqual([]);
		expect(r.notas?.inserts[0].layout).toBe('flotante');
	});
});

describe('fondo: tu toma desenfocada', () => {
	it('tramos en cuadros; los que se tocan se unen', () => {
		expect(tramosFlotante([flotante(), {layout: 'pantalla-completa', desde: 6, hasta: 7}])).toEqual([{desde: 60, hasta: 150}]);
		expect(tramosFlotante([flotante({desde: 2, hasta: 3}), flotante({desde: 3.02, hasta: 4})])).toEqual([{desde: 60, hasta: 120}]);
		expect(tramosFlotante([flotante({desde: 2, hasta: 3}), flotante({desde: 3.5, hasta: 4})])).toHaveLength(2);
	});

	it('sube en las rampas sin corte, se queda en 1 y en `hasta` ya no hay efecto', () => {
		const t = [{desde: 60, hasta: 150}];
		expect(intensidadFlotante(59, t)).toBe(0);
		const primero = intensidadFlotante(60, t);
		expect(primero).toBeGreaterThan(0);
		expect(primero).toBeLessThan(1);
		// ease-out fuerte: a mitad de la rampa ya va más de la mitad
		expect(intensidadFlotante(60 + FLOTANTE.entrada / 2, t)).toBeGreaterThan(0.6);
		expect(intensidadFlotante(60 + FLOTANTE.entrada - 1, t)).toBeCloseTo(1, 6);
		expect(intensidadFlotante(100, t)).toBe(1);
		let previo = 1;
		for (let f = 150 - FLOTANTE.salida; f < 150; f++) {
			const k = intensidadFlotante(f, t);
			expect(k).toBeLessThanOrEqual(previo + 1e-9);
			previo = k;
		}
		expect(intensidadFlotante(149, t)).toBe(0);
		expect(intensidadFlotante(150, t)).toBe(0);
	});

	it('un tramo corto recorta sus rampas a un tercio', () => {
		const t = [{desde: 0, hasta: 9}];
		expect(intensidadFlotante(3, t)).toBeCloseTo(1, 6);
	});

	it('valores en los rangos pedidos: blur 10–18 px, oscurecer 8–20 %, push-in 1.03–1.06, rampas 6–9 cuadros', () => {
		expect(FLOTANTE.blur_px).toBeGreaterThanOrEqual(10);
		expect(FLOTANTE.blur_px).toBeLessThanOrEqual(18);
		expect(FLOTANTE.oscurecer).toBeGreaterThanOrEqual(0.08);
		expect(FLOTANTE.oscurecer).toBeLessThanOrEqual(0.2);
		expect(FLOTANTE.escala).toBeGreaterThanOrEqual(1.03);
		expect(FLOTANTE.escala).toBeLessThanOrEqual(1.06);
		for (const c of [FLOTANTE.entrada, FLOTANTE.salida]) {
			expect(c).toBeGreaterThanOrEqual(6);
			expect(c).toBeLessThanOrEqual(9);
		}
		expect(fondoFlotante(0)).toEqual({blur: 0, brillo: 1, escala: 1});
		expect(fondoFlotante(1)).toEqual({blur: FLOTANTE.blur_px, brillo: 1 - FLOTANTE.oscurecer, escala: FLOTANTE.escala});
	});
});

describe('escena flotante', () => {
	it('entra sin nacer de escala 0, se asienta y sale antes de que acabe el insert', () => {
		const a = escenaFlotante(0, 90);
		expect(a.opacidad).toBeGreaterThan(0);
		expect(a.escala).toBeGreaterThanOrEqual(FLOTANTE.escena_desde);
		expect(a.dy).toBeGreaterThan(0);
		const medio = escenaFlotante(45, 90);
		expect(medio).toEqual({opacidad: 1, escala: 1, dy: 0});
		expect(escenaFlotante(89, 90).opacidad).toBe(0);
	});

	it('caja por defecto: 810 × 980 centrada en (540, 740), dentro de la zona segura y arriba de los subtítulos', () => {
		const c = cajaFlotante();
		expect(c).toEqual({x0: 135, y0: 250, x1: 945, y1: 1230, escala: 1});
		expect(c.x1 - c.x0).toBe(ESCENA.ancho);
		expect(fueraDeZona(c, 'capa')).toEqual([]);
		expect(c.y1).toBeLessThan(1545 - 60);
		expect(CENTRO_FLOTANTE).toEqual({x: 540, y: 740});
		expect(cajaFlotante({escala: 0.8, y: 800})).toMatchObject({x0: 216, x1: 864, y0: 408, y1: 1192, escala: 0.8});
	});
});

describe('layout.ts y validar.ts', () => {
	it('la caja visible es la escena, no el cuadro entero', () => {
		expect(cajaVisibleInsert(flotante(), null)).toEqual({caja: {x0: 135, y0: 250, x1: 945, y1: 1230}, aproximada: false});
	});

	it('colocarInsert no lo marca como tapa-cabeza', () => {
		const r = colocarInsert({t0: 2, t1: 5, layout: 'flotante', aspecto: ESCENA.alto / ESCENA.ancho}, {} as Parameters<typeof colocarInsert>[1]);
		expect(r).toMatchObject({caja: null, tapaCabeza: false});
	});

	const cara: CaraConsultable = {
		fps: 30,
		cuadros: Array.from({length: 300}, (_, j) => ({
			t: j / 30,
			cara: {x: 400, y: 600, w: 300, h: 490},
			barbilla_y: 1240,
			coronilla_y: 450,
			cabeza: {x: 380, y: 450, w: 340, h: 790},
			boca_y: 1100,
		})),
	};
	const OP: OpcionesValidar = {cara, estilo: estiloDesde({}), voz: null, catalogoSfx: null, revisarArchivos: false};
	const edl = (inserts: InsertEdl[]): Edicion => ({
		...edicionVacia,
		duracion_s: 10,
		subtitulos: [{id: 's1', desde: 2, hasta: 3, palabras: [{i: 0, t: 'hola', d: 2, h: 3}], caja: {x: 540, y: 1545}}],
		estilos: {subtitulos: {tamano_px: 58.7, borde_px: 4.13, y: 1545}},
		inserts,
	});
	const de = (r: ReturnType<typeof validarEdicion>, regla: string) => r.hallazgos.filter((h) => h.regla === regla);

	it.runIf(HAY_FUENTES)('encima de tu cara no rompe R1 ni R3, y en su lugar cumple R2 y R12', () => {
		const r = validarEdicion(edl([flotante()]), OP);
		for (const regla of ['R1', 'R2', 'R3', 'R12']) expect(de(r, regla)).toEqual([]);
		expect(r.capas.find((c) => c.id === 'm1')?.caja).toEqual({x0: 135, y0: 250, x1: 945, y1: 1230});
	});

	it.runIf(HAY_FUENTES)('si se sale de la zona segura o baja a los subtítulos, R12 y R2 lo dicen', () => {
		const r = validarEdicion(edl([flotante({caja: {x: 540, y: 1200}})]), OP);
		expect(de(r, 'R2').map((h) => h.donde)).toEqual(['m1']);
		expect(de(r, 'R12').map((h) => h.donde)).toEqual(['m1']);
		const ancha = validarEdicion(edl([flotante({caja: {x: 540, y: 740, escala: 1.15}})]), OP);
		expect(de(ancha, 'R12').map((h) => h.donde)).toEqual(['m1']);
	});
});
