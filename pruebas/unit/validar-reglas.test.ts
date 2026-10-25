// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de las reglas de validar.ts (Fase 3): cada regla hace FALLAR una EDL que la rompe, con su número y su origen
 * ("[R1] k1: invade la cara 42 px en t=12.3 s (…)"), y deja pasar una que la cumple. Incluye los criterios del plan:
 * sticker arriba de la cabeza, sticker en la franja de subtítulos y PNG sin alfa → FAIL. R1 (director v2): el límite es
 * tu boca + 12 (una tarjeta que toca la barbilla pero no la boca pasa; un cara.json sin boca la estima y avisa). Cara y catálogo de SFX
 * sintéticos; los PNG, la demo y la terminal se escriben en proyectos/_prueba-unit-validar y demos/_prueba-unit-validar*
 * (se borran al final). Nada abre Chrome ni Vision: corre dentro del sandbox.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {estiloDesde, type EstiloDirector} from '../../herramientas/lib/director/estilo.ts';
import {RAIZ} from '../../herramientas/lib/manifest.ts';
import type {Catalogo} from '../../herramientas/lib/sfx.ts';
import {escribirPng, nuevaImagen, ponerBorde} from '../../herramientas/stickers/lib/borde.ts';
import {fraseReglas, textoHallazgo, validarEdicion, type OpcionesValidar} from '../../herramientas/validar.ts';
import type {Edicion} from '../../src/esquema/edicion.ts';
import {ajustesDeDemo, DemoTerminalEsquema, prepararTerminal} from '../../src/estilo/terminal.ts';
import {HAY_FUENTES, hay} from './requisitos.ts';

const SLUG = '_prueba-unit-validar';
const DIR = join(RAIZ, 'proyectos', SLUG);
const DEMO = join(RAIZ, 'demos', SLUG);
const DEMO_SIN = join(RAIZ, 'demos', `${SLUG}-sin`);
const P = (n: string) => `p/${SLUG}/${n}`;

/** Cara quieta de 10 s. Con `boca`, el cara.json la trae medida; sin ella es "de antes" (R1 la estima). */
function cara(op: {barbilla: number; coronilla: number; boca?: number}): CaraConsultable {
	return {
		fps: 30,
		cuadros: Array.from({length: 300}, (_, j) => ({
			t: j / 30,
			cara: {x: 400, y: op.coronilla + 150, w: 300, h: op.barbilla - op.coronilla - 150},
			barbilla_y: op.barbilla,
			coronilla_y: op.coronilla,
			cabeza: {x: 380, y: op.coronilla, w: 340, h: op.barbilla - op.coronilla},
			...(op.boca !== undefined ? {boca_y: op.boca} : {}),
		})),
	};
}
const CARA = cara({barbilla: 1240, coronilla: 450});
const ESTILO = estiloDesde({});
const VOZ = '# Voz\n\n## Prohibido (suena a IA)\n- usted / lenguaje corporativo-neutro.\n- Hype vacío: "revolucionario", "cambiará tu vida".\n- El tic "no es X, es Y".\n\n## Hooks\n- "El 99% usa la IA como buscador."\n';

/** Catálogo de SFX mínimo: 6 fuentes "pop" para stickers. */
const CATALOGO = {
	eventos: {sticker: ['pop'], tarjeta: [], insert: [], zoom: [], titular: []},
	archivos: Array.from({length: 6}, (_, i) => ({id: `pop-${i}`, archivo: `biblioteca/sfx/pop/pop-${i}.wav`, categoria: 'pop', fuente_id: `f${i}`, aprobacion: 'no-requiere', semitonos: 0, variante_de: null, lufs: -10})),
} as unknown as Catalogo;

const OP: OpcionesValidar = {cara: CARA, estilo: ESTILO, voz: VOZ, catalogoSfx: CATALOGO};

function edl(cambios: Partial<Edicion> = {}): Edicion {
	return {
		version: 1,
		estilo_version: 'prueba',
		estilo_hash: 'prueba',
		lienzo: {w: 1440, h: 2560, fps: 30, base: [1080, 1920]},
		base: 'fx/clip-6s.mp4',
		duracion_s: 10,
		titular: null,
		subtitulos: [{id: 's1', desde: 0, hasta: 1, palabras: [{i: 0, t: 'hola', d: 0, h: 1}], caja: {x: 540, y: 1498.5}}],
		resaltar_palabras: [],
		tarjetas: [],
		stickers: [],
		inserts: [],
		zooms: [],
		efectos: [],
		sfx_extra: [],
		estilos: {subtitulos: {tamano_px: 61.1, borde_px: 3.94, y: 1498.5}},
		audio: {lufs: -14, pico_dbtp: -1.5},
		...cambios,
	};
}

type StickerEdl = Edicion['stickers'][number];
const sticker = (id: string, desde: number, hasta: number, y: number, extra: Partial<StickerEdl> = {}): StickerEdl => ({
	id,
	desde,
	hasta,
	asset: P('sticker.png'),
	mascota: null,
	caja: {x: 540, y, w: 140},
	entrada: 'pop',
	salida: 'corte',
	tapaCabeza: false,
	sfx: null,
	...extra,
});
type TarjetaEdl = Edicion['tarjetas'][number];
const tarjeta = (id: string, desde: number, hasta: number, texto: string, extra: Partial<TarjetaEdl> = {}): TarjetaEdl => ({id, desde, hasta, texto, caja: {x: 540, y: 1370, escala: 0.8}, grupo: null, variante: 'normal', entrada: 'corte', tapaCabeza: false, sfx: null, ...extra});
type InsertEdl = Edicion['inserts'][number];
const insert = (extra: Partial<InsertEdl>): InsertEdl => ({id: 'b1', tipo: 'imagen', desde: 2, hasta: 4, asset: P('captura.png'), trim_desde: 0, layout: 'tarjeta', tapaCabeza: false, texto: null, eventos: null, audio: {modo: 'mute', ganancia_db: 0}, sfx: null, ...extra});

const de = (r: ReturnType<typeof validarEdicion>, regla: string) => r.hallazgos.filter((h) => h.regla === regla);
const estado = (r: ReturnType<typeof validarEdicion>, regla: string) => r.reglas.find((x) => x.regla === regla)?.estado;

// Sin las fuentes (validar.ts mide textos) ni los fixtures de demos, estas pruebas se saltan.
const HAY_REGLAS = HAY_FUENTES && hay('pruebas/fixtures/f7-claude-code.json') && hay('pruebas/fixtures/f7-demo-mala.json');

describe.runIf(HAY_REGLAS)('validar.ts: reglas', () => {
	beforeAll(() => {
		for (const d of [DIR, DEMO, DEMO_SIN]) {
			rmSync(d, {recursive: true, force: true});
			mkdirSync(d, {recursive: true});
		}
		// Sticker bueno: cuadro naranja con borde blanco y esquinas transparentes.
		const sujeto = nuevaImagen(160, 160);
		for (let y = 20; y < 140; y++) for (let x = 20; x < 140; x++) sujeto.datos.set([217, 119, 87, 255], (y * 160 + x) * 4);
		writeFileSync(join(DIR, 'sticker.png'), escribirPng(ponerBorde(sujeto, {sombra: null}).imagen));
		writeFileSync(join(DIR, 'sin-borde.png'), escribirPng(sujeto));
		writeFileSync(join(DIR, 'sin-alfa.png'), escribirPng(nuevaImagen(160, 160, [217, 119, 87, 255])));
		writeFileSync(join(DIR, 'captura.png'), escribirPng(nuevaImagen(1600, 900, [250, 250, 250, 255])));
		copyFileSync(join(RAIZ, 'pruebas', 'fixtures', 'f7-claude-code.json'), join(DIR, 'demo.terminal.json'));
		copyFileSync(join(RAIZ, 'pruebas', 'fixtures', 'f7-demo-mala.json'), join(DIR, 'mala.terminal.json'));
		// Demo de pantalla "grabada": toma de 5 s escaneada (LIMPIA) y otra sin revisión.
		for (const d of [DEMO, DEMO_SIN]) {
			writeFileSync(join(d, 'toma.mp4'), 'toma de prueba');
			writeFileSync(join(d, 'eventos.json'), '[]');
			writeFileSync(join(d, 'toma.json'), JSON.stringify({version: 1, cuadro: {ancho: 2560, alto: 1600, fps: 30, dpr: 2}, duracion_s: 5}));
		}
		const sha = createHash('sha256').update('toma de prueba').digest('hex');
		writeFileSync(
			join(DEMO, 'revision.json'),
			JSON.stringify({version: 1, estado: 'LIMPIA', motivo: 'OCR sin hallazgos', revisado_por: null, revisado_en: null, aprobado_sha256: {}, fuentes: [{archivo: 'toma.mp4', sha256: sha, leidos: 1, paso: 5, escaneado_en: '2026-10-03T00:00:00Z', avisos: [], hallazgos: []}], como_aprobar: 'x'}),
		);
	});
	afterAll(() => {
		for (const d of [DIR, DEMO, DEMO_SIN]) rmSync(d, {recursive: true, force: true});
	});

	describe('una edición bien puesta pasa', () => {
		it('sticker debajo de la barbilla y arriba de la franja: 0 FAIL, R1, R2 y R5 PASA', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376)]}), OP);
			expect(r.hallazgos).toEqual([]);
			expect(estado(r, 'R1')).toBe('PASA');
			expect(estado(r, 'R2')).toBe('PASA');
			expect(estado(r, 'R5')).toBe('PASA');
			expect(fraseReglas(r.reglas)).toMatch(/^cumple \d+ de \d+ reglas \(\d+ N\/A\)$/);
		});
	});

	describe('R1 · nada sobre tu boca, nariz ni ojos', () => {
		const CERCA = cara({barbilla: 1240, coronilla: 450, boca: 1100});
		// El mecanismo con la boca protegida (+ 12 px): con la decisión del 2026-10-09 (las capas pueden tapar la cara) el
		// margen por defecto ya no limita, así que estas pruebas lo fijan a mano.
		const PROTEGIDA: EstiloDirector = {...ESTILO, cabeza: {...ESTILO.cabeza, margen_boca: {valor: 12, n: 0, fuente: 'prueba'}}};
		const OPB: OpcionesValidar = {...OP, estilo: PROTEGIDA};

		it('con la decisión del 2026-10-09 (puede tapar la cara), un sticker sobre la boca PASA', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1112 + 70 - 5)]}), {...OP, cara: CERCA});
			expect(de(r, 'R1')).toHaveLength(0);
		});
		it('un sticker arriba de la cabeza (sobre ojos y boca) HACE FALLAR validar, con cuánto invade, cuándo y de dónde sale', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 900)]}), {...OPB, cara: CERCA});
			const h = de(r, 'R1');
			expect(h).toHaveLength(1);
			expect(h[0].donde).toBe('k1');
			expect(h[0].detalle).toMatch(/^invade la cara [\d.]+ px en t=[\d.]+ s \(borde de arriba en y=[\d.]+; boca máx 1100 \+ 12 = 1112: nada tapa tu boca, nariz ni ojos; cara dada\)$/);
			expect(textoHallazgo(h[0])).toMatch(/^\[R1\] k1: invade la cara/);
		});

		it('un sticker que tapa la boca (su borde de arriba 5 px arriba de boca + 12) también falla', () => {
			// Sticker de 140 px (tinta 120 + borde): su borde de arriba en y ≈ caja.y − 70.
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1112 + 70 - 5)]}), {...OPB, cara: CERCA});
			expect(de(r, 'R1').map((h) => h.donde)).toEqual(['k1']);
		});

		it('toma de cerca: una tarjeta que toca tu barbilla pero queda debajo de tu boca PASA (como Dktnz6TIKor)', () => {
			// Tarjeta de 1 renglón a escala 0.8 centrada en 1274: su borde de arriba en ≈ 1227, arriba de la barbilla (1240).
			const r = validarEdicion(edl({tarjetas: [tarjeta('t1', 1, 2, 'Opus 5.5', {caja: {x: 540, y: 1274, escala: 0.8}})]}), {...OP, cara: CERCA});
			expect(de(r, 'R1')).toHaveLength(0);
			expect(estado(r, 'R1')).toBe('PASA');
			expect(r.capas.find((c) => c.id === 't1')!.caja.y0).toBeLessThan(1240);
		});

		it('una tarjeta encima de la cara también falla; con tapaCabeza = true no (eso lo cuenta R3)', () => {
			const sobre = tarjeta('t1', 1, 2, 'Opus 5.5', {caja: {x: 540, y: 1000}});
			expect(de(validarEdicion(edl({tarjetas: [sobre]}), {...OPB, cara: CERCA}), 'R1')).toHaveLength(1);
			expect(de(validarEdicion(edl({tarjetas: [{...sobre, tapaCabeza: true}]}), {...OPB, cara: CERCA}), 'R1')).toHaveLength(0);
		});

		it('cara.json sin boca (de antes): la estima con barbilla − 0.18 × alto de la cara, lo dice en el FAIL y avisa', () => {
			// Alto de la caja 640 → boca ≈ 1124.8; límite 1136.8.
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 900)]}), OPB);
			const h = de(r, 'R1');
			expect(h[0].detalle).toMatch(/boca máx 1124\.8 estimada \(barbilla − 0\.18 × alto de la cara\) \+ 12 = 1136\.8/);
			expect(r.avisos.join(' ')).toMatch(/no trae tu boca/);
			const ok = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376)]}), OPB);
			expect(estado(ok, 'R1')).toBe('PASA');
			expect(ok.reglas.find((x) => x.regla === 'R1')!.detalle).toMatch(/boca estimada/);
		});

		it('el titular no debe tocar la CARA (puede rozar el pelo, como en tus reels)', () => {
			const titular = {texto: 'Cómo hacer páginas web\nprofesionales con Claude', desde: 0, hasta: 10, tapaCabeza: true};
			// cara(): la caja de la cara empieza 150 px debajo de la coronilla (pelo).
			const toca = validarEdicion(edl({titular}), {...OP, cara: cara({barbilla: 1240, coronilla: 230})});
			expect(de(toca, 'R1').map((h) => h.donde)).toEqual(['titular']);
			expect(de(toca, 'R1')[0].detalle).toMatch(/^toca la cara [\d.]+ px en t=/);
			// Solo el pelo lo toca (coronilla 380, cara desde 530): pasa.
			expect(de(validarEdicion(edl({titular}), {...OP, cara: cara({barbilla: 1240, coronilla: 380})}), 'R1')).toHaveLength(0);
			expect(de(validarEdicion(edl({titular}), {...OP, cara: cara({barbilla: 1240, coronilla: 700})}), 'R1')).toHaveLength(0);
		});

		it('sin cara.json R1 y R4 quedan N/A con aviso (no fallan)', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 900)]}), {...OP, cara: null});
			expect(de(r, 'R1')).toHaveLength(0);
			expect(estado(r, 'R1')).toBe('N/A');
			expect(estado(r, 'R4')).toBe('N/A');
		});
	});

	describe('R2 · franja de subtítulos', () => {
		it('un sticker que cruza la franja de subtítulos HACE FALLAR validar', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1500)]}), OP);
			expect(de(r, 'R2')).toHaveLength(1);
			expect(de(r, 'R2')[0].detalle).toMatch(/^cruza la franja de subtítulos [\d.]+ px \(ocupa y=.*franja 1453–1544/);
		});

		it('una tarjeta en la franja también falla', () => {
			expect(de(validarEdicion(edl({tarjetas: [tarjeta('t1', 1, 2, 'Opus 5.5', {caja: {x: 540, y: 1490}})]}), OP), 'R2')).toHaveLength(1);
		});
	});

	describe('R3 · tapaCabeza por reel', () => {
		const dos = [tarjeta('t1', 1, 2, 'Uno', {caja: {x: 540, y: 1000}, tapaCabeza: true}), tarjeta('t2', 3, 4, 'Dos', {caja: {x: 540, y: 1000}, tapaCabeza: true})];
		it('sin medida (N/A) el máximo es 1: dos capas que tapan la cabeza fallan', () => {
			const h = de(validarEdicion(edl({tarjetas: dos}), OP), 'R3');
			expect(h).toHaveLength(1);
			expect(h[0].detalle).toMatch(/2 capas con tapaCabeza = true y el máximo es 1/);
		});
		it('con un p90 medido de 2, pasan', () => {
			const estilo: EstiloDirector = {...ESTILO, tapa_cabeza_p90: {valor: 2, n: 8, fuente: 'prueba'}};
			expect(de(validarEdicion(edl({tarjetas: dos}), {...OP, estilo}), 'R3')).toHaveLength(0);
		});
	});

	describe('R4 · inserts que no caben debajo de la barbilla', () => {
		it('un insert 16:9 con < 70 % de ancho legible debajo de la barbilla y sin tapaCabeza falla', () => {
			const h = de(validarEdicion(edl({inserts: [insert({caja: {x: 540, y: 1380, w: 770}})]}), OP), 'R4');
			expect(h).toHaveLength(1);
			expect(h[0].detalle).toMatch(/debe ir con tapaCabeza = true/);
		});
		it('con tapaCabeza = true pasa (y no cruza la franja)', () => {
			const r = validarEdicion(edl({inserts: [insert({tapaCabeza: true, caja: {x: 540, y: 995, w: 770}})]}), OP);
			expect([...de(r, 'R4'), ...de(r, 'R2'), ...de(r, 'R1')]).toEqual([]);
		});
		it('uno que SÍ cabe debajo debe ir debajo: con tapaCabeza = true falla', () => {
			const h = de(validarEdicion(edl({inserts: [insert({tapaCabeza: true, caja: {x: 540, y: 995, w: 770}})]}), {...OP, cara: cara({barbilla: 500, coronilla: 150})}), 'R4');
			expect(h).toHaveLength(1);
			expect(h[0].detalle).toMatch(/cabe debajo de la barbilla/);
		});
	});

	describe('R5 · alfa y borde tipo sticker', () => {
		it('un PNG sin alfa HACE FALLAR validar (regla "alfa", número R5)', () => {
			const h = de(validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376, {asset: P('sin-alfa.png')})]}), OP), 'alfa');
			expect(h).toHaveLength(1);
			expect(h[0].numero).toBe('R5');
			expect(h[0].detalle).toMatch(/esquinas con alfa 255\/255\/255\/255/);
		});
		it('con alfa pero sin borde blanco tampoco pasa', () => {
			const h = de(validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376, {asset: P('sin-borde.png')})]}), OP), 'R5');
			expect(h).toHaveLength(1);
			expect(h[0].detalle).toMatch(/no tiene borde tipo sticker/);
		});
	});

	describe('R6 · SFX', () => {
		const sfx = (i: number, offset = 0) => ({asset: `biblioteca/sfx/pop/pop-${i}.wav`, ganancia_db: -10, offset_frames: offset, variante: 0});
		const sinArchivos: OpcionesValidar = {...OP, revisarArchivos: false};
		it('el mismo archivo dos veces en 5 eventos con sonido falla', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376, {sfx: sfx(0)}), sticker('k2', 3, 4, 1376, {sfx: sfx(0)}), sticker('k3', 5, 6, 1376), sticker('k4', 7, 8, 1376, {sfx: sfx(1)})]}), sinArchivos);
			// Además van 3 "pop" seguidos con sonido: también rompe la racha de categorías.
			expect(de(r, 'R6').map((h) => h.detalle.split(':')[0]).sort()).toEqual(['racha-categoria', 'ventana-5']);
			expect(de(r, 'R6').find((h) => h.detalle.startsWith('ventana-5'))!.donde).toBe('k2');
		});
		it('un SFX de sticker fuera de −2…0 cuadros falla', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376, {sfx: sfx(0, 2)}), sticker('k2', 3, 4, 1376, {sfx: sfx(1)}), sticker('k3', 5, 6, 1376)]}), sinArchivos);
			expect(de(r, 'R6')).toHaveLength(1);
			expect(de(r, 'R6')[0].detalle).toMatch(/arranca a 2 cuadros/);
		});
		it('sin ningún SFX elegido no se revisa el silencio (N/A con aviso)', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376), sticker('k2', 3, 4, 1376)]}), sinArchivos);
			expect(de(r, 'R6')).toHaveLength(0);
			expect(estado(r, 'R6')).toBe('N/A');
		});
	});

	describe('R7 · duración mínima por palabra', () => {
		it('un titular de 5 palabras que dura 1 s y una tarjeta de 3 palabras de 0.5 s fallan (0.3 s por palabra, supuesto BRAG)', () => {
			const r = validarEdicion(
				edl({
					titular: {texto: 'Cómo hacer páginas web profesionales', desde: 0, hasta: 1, tapaCabeza: true},
					tarjetas: [tarjeta('t1', 2, 2.5, 'Aplicación de Claude')],
				}),
				{...OP, cara: cara({barbilla: 1240, coronilla: 700})},
			);
			const h = de(r, 'R7');
			expect(h.map((x) => x.donde).sort()).toEqual(['t1', 'titular']);
			expect(h.find((x) => x.donde === 'titular')!.detalle).toMatch(/dura 1 s y necesita 1.5 s \(5 palabras × 0.3 s/);
		});
	});

	describe('R8 · voice.md', () => {
		it('un titular con una palabra de la lista "Prohibido" falla; sin voice.md queda N/A', () => {
			const e = edl({titular: {texto: 'Esto es revolucionario', desde: 0, hasta: 10, tapaCabeza: true}});
			const h = de(validarEdicion(e, {...OP, cara: cara({barbilla: 1240, coronilla: 700})}), 'R8');
			expect(h).toHaveLength(1);
			expect(h[0].detalle).toMatch(/revolucionario/);
			expect(estado(validarEdicion(e, {...OP, voz: null, cara: cara({barbilla: 1240, coronilla: 700})}), 'R8')).toBe('N/A');
		});
	});

	describe('R9 · pose repetida', () => {
		const frente = {pose: 'frente', ojos: 'felices', anim: 'ninguna'};
		it('dos stickers seguidos con la misma pose fallan; con otro sticker en medio, no', () => {
			const h = de(validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376, {mascota: frente}), sticker('k2', 3, 4, 1376, {mascota: frente})]}), OP), 'R9');
			expect(h.map((x) => x.donde)).toEqual(['k2']);
			const ok = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376, {mascota: frente}), sticker('k2', 3, 4, 1376), sticker('k3', 5, 6, 1376, {mascota: frente})]}), OP);
			expect(de(ok, 'R9')).toHaveLength(0);
		});
	});

	describe('R10 · demos', () => {
		const pc = {layout: 'pantalla-completa' as const};
		it('terminal: el insert debe durar lo que pide su guion; un guion que no cumple el contrato falla', async () => {
			const {readFileSync} = await import('node:fs');
			const demo = DemoTerminalEsquema.parse(JSON.parse(readFileSync(join(DIR, 'demo.terminal.json'), 'utf8')));
			const necesita = prepararTerminal(ajustesDeDemo(demo)).duracion;
			const corta = de(validarEdicion(edl({inserts: [insert({...pc, tipo: 'demo', asset: P('demo.terminal.json'), desde: 1, hasta: 1.5})]}), OP), 'R10');
			expect(corta).toHaveLength(1);
			expect(corta[0].detalle).toMatch(/la terminal necesita/);
			expect(de(validarEdicion(edl({inserts: [insert({...pc, tipo: 'demo', asset: P('demo.terminal.json'), desde: 0.5, hasta: Math.min(10, 0.5 + necesita + 0.1)})]}), OP), 'R10')).toHaveLength(0);
			const mala = de(validarEdicion(edl({inserts: [insert({...pc, tipo: 'demo', asset: P('mala.terminal.json'), desde: 1, hasta: 3})]}), OP), 'R10');
			expect(mala.length).toBeGreaterThan(0);
			expect(mala[0].detalle).toMatch(/no cumple su contrato/);
		});

		it('pantalla: usable y con el trim dentro de la toma pasa; pasarse de la toma o sin revisión falla', () => {
			const base = {...pc, tipo: 'demo' as const, asset: `demos/${SLUG}/toma.mp4`, eventos: `demos/${SLUG}/eventos.json`, desde: 1, hasta: 4};
			expect(de(validarEdicion(edl({inserts: [insert(base)]}), OP), 'R10')).toHaveLength(0);
			const larga = de(validarEdicion(edl({inserts: [insert({...base, trim_desde: 3})]}), OP), 'R10');
			expect(larga.map((h) => h.detalle)).toEqual([expect.stringMatching(/la toma dura 5 s/)]);
			const sin = de(validarEdicion(edl({inserts: [insert({...base, asset: `demos/${SLUG}-sin/toma.mp4`, eventos: `demos/${SLUG}-sin/eventos.json`})]}), OP), 'R10');
			expect(sin.map((h) => h.detalle)).toEqual([expect.stringMatching(/no se puede usar/)]);
		});
	});

	describe('R11 · archivos y rutas (lo de la Fase 0, con su número)', () => {
		it('un archivo que no existe es "archivo" (R11) y una ruta con ".." es "ruta" (R11)', () => {
			const r = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376, {asset: P('no-existe.png')})], base: '../entrada/x.mov'}), OP);
			expect(r.hallazgos.filter((h) => h.numero === 'R11').map((h) => h.regla).sort()).toEqual(['archivo', 'ruta']);
		});
	});

	describe('CLI', () => {
		it('sale con 2 y escribe cada FAIL con su número y su origen', () => {
			const ruta = join(DIR, 'edicion-v1.json');
			writeFileSync(ruta, JSON.stringify(edl({stickers: [sticker('k1', 1, 2, 1500)]})));
			const r = spawnSync('npx', ['tsx', 'herramientas/validar.ts', ruta], {cwd: RAIZ, encoding: 'utf8'});
			expect(r.status).toBe(2);
			expect(r.stdout).toMatch(/\[R2\] k1: cruza la franja de subtítulos/);
			expect(r.stdout).toMatch(/cumple \d+ de \d+ reglas \(\d+ N\/A\)/);
			expect(r.stderr.trim().split('\n').at(-1)).toMatch(/^No pude validar la edición: 1 regla\(s\) no se cumplen\. Siguiente paso: .+\.$/);
		}, 60_000);
	});

	describe('R12 · zona segura de Reels (src/estilo/zona-segura.ts)', () => {
		it('dentro de la zona pasa; un sticker en la orilla derecha, un subtítulo pegado al usuario o una tarjeta muy ancha FALLAN', () => {
			const bien = validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376)]}), OP);
			expect(de(bien, 'R12')).toEqual([]);
			expect(estado(bien, 'R12')).toBe('PASA');
			const derecha = de(validarEdicion(edl({stickers: [sticker('k1', 1, 2, 1376, {caja: {x: 900, y: 1376, w: 140}})]}), OP), 'R12');
			expect(derecha).toHaveLength(1);
			expect(derecha[0].detalle).toMatch(/derecha hasta x=.*límite 945/);
			const abajo = de(validarEdicion(edl({subtitulos: [{id: 's1', desde: 0, hasta: 1, palabras: [{i: 0, t: 'hola', d: 0, h: 1}], caja: {x: 540, y: 1580}}]}), OP), 'R12');
			expect(abajo.map((h) => h.donde)).toEqual(['s1']);
			expect(abajo[0].detalle).toMatch(/subtítulo: baja a y=.*1590/);
			const ancha = de(validarEdicion(edl({tarjetas: [tarjeta('t1', 1, 2, 'Una frase larguísima que no cabe', {caja: {x: 540, y: 1370, w: 1000}})]}), {...OP, revisarArchivos: false}), 'R12');
			expect(ancha.map((h) => h.donde)).toEqual(['t1']);
		});

		it('el subtítulo en la y nueva (1545) cabe; los inserts a pantalla completa no cuentan; un insert en tarjeta en la columna de íconos falla', () => {
			const nueva = validarEdicion(edl({subtitulos: [{id: 's1', desde: 0, hasta: 1, palabras: [{i: 0, t: 'yoga', d: 0, h: 1}], caja: {x: 540, y: 1545}}], estilos: {subtitulos: {tamano_px: 58.7, borde_px: 4.13, y: 1545}}}), OP);
			expect(de(nueva, 'R12')).toEqual([]);
			const pc = validarEdicion(edl({inserts: [insert({layout: 'pantalla-completa', tapaCabeza: false})]}), OP);
			expect(de(pc, 'R12')).toEqual([]);
			const iconos = de(validarEdicion(edl({inserts: [insert({tapaCabeza: true, caja: {x: 800, y: 1300, w: 400, h: 300}})]}), OP), 'R12');
			expect(iconos).toHaveLength(1);
			expect(iconos[0].detalle).toMatch(/columna de íconos/);
		});
	});
});
