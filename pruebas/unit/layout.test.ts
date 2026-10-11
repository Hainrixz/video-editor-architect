/**
 * Pruebas del layout (herramientas/layout.ts): zonas (franja de subtítulos, zona libre debajo de tu BOCA —el límite— y
 * debajo de tu barbilla —la preferencia—, zona UI), geometría de lo que se ve (stickers con su tinta, tarjetas y listas
 * apiladas o en árbol, titular, inserts) y las funciones de colocar (sticker, tarjeta, lista, titular, insert) con sus
 * avisos. Cara sintética: no llama a Vision; corre en el sandbox.
 */
import {describe, expect, it} from 'vitest';
import {
	ANCHO_MIN_LOGO_SUPUESTO,
	anchoLegibleDebajo,
	anchoMinimoLogo,
	azarDe,
	bandaLibre,
	cajasVisiblesTarjetas,
	cajaVisibleInsert,
	cajaVisibleSticker,
	colocarInsert,
	colocarLista,
	colocarSticker,
	colocarTarjeta,
	colocarTitular,
	crearContexto,
	encimeVertical,
	escalaMaxSticker,
	filasArbol,
	franjaDeEdicion,
	franjaDeEstilo,
	geometriaTitular,
	medirTarjeta,
	partirRenglones,
	peorBarbilla,
	peorBoca,
	type InfoPng,
} from '../../herramientas/layout.ts';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {estiloDesde, type EstiloDirector} from '../../herramientas/lib/director/estilo.ts';
import {resolverEstiloSticker, resolverEstiloTarjeta, resolverEstiloTitular} from '../../src/estilo/capas.ts';
import type {Edicion} from '../../src/esquema/edicion.ts';
import {HAY_FUENTES} from './requisitos.ts';

/**
 * Cara quieta: barbilla, boca y coronilla fijas durante `segundos` (más cambios por tramo). Sin `boca`, el cara.json es
 * "de antes" (no trae boca_y): el layout la estima con barbilla − 0.18 × alto de la caja de la cara.
 */
function caraSintetica(op: {
	barbilla: number;
	coronilla: number;
	boca?: number;
	segundos?: number;
	tramos?: Array<{desde: number; hasta: number; barbilla?: number; boca?: number; coronilla?: number; sinCara?: boolean}>;
}): CaraConsultable {
	const n = Math.round((op.segundos ?? 20) * 30);
	const cuadros = Array.from({length: n}, (_, j) => {
		const t = j / 30;
		const tramo = op.tramos?.find((x) => t >= x.desde && t < x.hasta);
		if (tramo?.sinCara) return {t, cara: null, barbilla_y: null, coronilla_y: null, cabeza: null, ...(op.boca !== undefined ? {boca_y: null} : {})};
		const barbilla = tramo?.barbilla ?? op.barbilla;
		const coronilla = tramo?.coronilla ?? op.coronilla;
		const boca = tramo?.boca ?? op.boca;
		return {t, cara: {x: 400, y: coronilla + 150, w: 300, h: barbilla - coronilla - 150}, barbilla_y: barbilla, coronilla_y: coronilla, cabeza: {x: 380, y: coronilla, w: 340, h: barbilla - coronilla}, ...(boca !== undefined ? {boca_y: boca} : {})};
	});
	return {fps: 30, cuadros};
}

// Lo medido tal cual (sin la decisión del 2026-10-04: esa se prueba en zona-segura.test.ts).
const estilo = estiloDesde({decision: false});
const ctxCon = (cara: CaraConsultable | null) => crearContexto({cara, estilo, semilla: 'prueba'});
/** PNG de 1024 con la tinta de mascota de frente (catálogo voxel: 940×776 en 42,119). */
const MASCOTA: InfoPng = {ancho: 1024, alto: 1024, tinta: {x: 42, y: 119, w: 940, h: 776}};
/** Letrero ancho (catálogo voxel: 940×292 en 42,361). */
const LETRERO: InfoPng = {ancho: 1024, alto: 1024, tinta: {x: 42, y: 361, w: 940, h: 292}};

describe('zonas', () => {
	it('franja del estilo: centro ± (media mayúscula + borde) + 20 px ≈ 1453–1544 con la y medida (1498.5)', () => {
		const f = franjaDeEstilo(estilo);
		expect(f.y0).toBeCloseTo(1498.5 - 43 / 2 - 3.94 - 20, 0);
		expect(f.y1).toBeCloseTo(1498.5 + 43 / 2 + 3.94 + 20, 0);
		expect(f.y0).toBeGreaterThan(1450);
		expect(f.y1).toBeLessThan(1548);
	});

	it('franja de una edición: el rango de caja.y de sus subtítulos con su tamaño; null si no fija dónde van', () => {
		const subs = [
			{id: 's1', desde: 0, hasta: 1, palabras: [{i: 0, t: 'hola', d: 0, h: 1}], caja: {x: 540, y: 1498.5}},
			{id: 's2', desde: 1, hasta: 2, palabras: [{i: 1, t: 'otra', d: 1, h: 2}], caja: {x: 540, y: 1510}},
		];
		const f = franjaDeEdicion(subs, {subtitulos: {tamano_px: 61.1, borde_px: 3.94}}, 20)!;
		const cap = 61.1 * 0.705;
		expect(f.y0).toBeCloseTo(1498.5 - cap / 2 - 3.94 - 20, 0);
		expect(f.y1).toBeCloseTo(1510 + cap / 2 + 3.94 + 20, 0);
		expect(franjaDeEdicion([{id: 's1', desde: 0, hasta: 1, palabras: [{i: 0, t: 'x', d: 0, h: 1}]}], {}, 20)).toBeNull();
		expect(franjaDeEdicion([], {subtitulos: {y: 1500}}, 20)).toBeNull();
	});

	it('zona libre: límite DURO = boca máx de la ventana (±0.2 s) + 12; PREFERENCIA = barbilla máx + 60; dice cuándo caen', () => {
		const cara = caraSintetica({barbilla: 1240, boca: 1100, coronilla: 450, tramos: [{desde: 5, hasta: 6, barbilla: 1300, boca: 1160}]});
		const ctx = ctxCon(cara);
		const b = bandaLibre(ctx, 2, 3);
		expect(b.y0).toBe(1300);
		expect(b.y0_boca).toBe(1112);
		expect(b.y1).toBe(ctx.franja.y0);
		expect(b.alto).toBeCloseTo(ctx.franja.y0 - 1300, 1);
		expect(b.alto_boca).toBeCloseTo(ctx.franja.y0 - 1112, 1);
		expect(b.boca_estimada).toBe(false);
		// La ventana 6.1–7 s toca la cabeza baja (barbilla 1300, boca 1160) por el margen de 0.2 s.
		const b2 = bandaLibre(ctx, 6.1, 7);
		expect(b2.barbilla).toBe(1300);
		expect(b2.boca).toBe(1160);
		expect(b2.y0_boca).toBe(1172);
		expect(peorBarbilla(cara, 6.1, 7)).toEqual({y: 1300, t: 5.9});
		expect(peorBoca(cara, 6.1, 7)).toEqual({y: 1160, t: 5.9, estimada: false});
	});

	it('cara.json sin boca (de antes): la estima como barbilla − 0.18 × alto de la cara y lo dice', () => {
		// Alto de la caja: 1240 − 450 − 150 = 640 → boca ≈ 1240 − 115.2 = 1124.8.
		const b = bandaLibre(ctxCon(caraSintetica({barbilla: 1240, coronilla: 450})), 2, 3);
		expect(b.boca).toBeCloseTo(1124.8, 1);
		expect(b.y0_boca).toBeCloseTo(1136.8, 1);
		expect(b.boca_estimada).toBe(true);
		expect(b.origen_boca).toMatch(/estimada/);
	});

	it('sin cara.json o sin cara en la ventana: banda baja de la zona UI (de la mitad del cuadro a la franja) y lo dice', () => {
		const sin = bandaLibre(ctxCon(null), 0, 1);
		expect(sin.origen).toMatch(/sin cara\.json/);
		expect(sin.y0).toBe(960);
		expect(sin.y0_boca).toBe(960);
		const cara = caraSintetica({barbilla: 1240, coronilla: 450, tramos: [{desde: 0, hasta: 4, sinCara: true}]});
		const b = bandaLibre(ctxCon(cara), 1, 2);
		expect(b.barbilla).toBeNull();
		expect(b.y0).toBe(960);
		expect(b.origen).toMatch(/banda baja/);
	});
});

describe('geometría de lo que se ve', () => {
	const e = resolverEstiloSticker({});
	it('sticker: la tinta del PNG escalada a caja.w, centrada en caja.x/caja.y', () => {
		const {caja} = cajaVisibleSticker({caja: {x: 540, y: 1000, w: 1024}, entrada: 'corte', mascota: null}, MASCOTA, e);
		expect(caja).toEqual({x0: 540 - 512 + 42, y0: 1000 - 512 + 119, x1: 540 - 512 + 42 + 940, y1: 1000 - 512 + 119 + 776});
	});

	it('el pop no pasa de escala 1; el rebote sí (sobrepaso) y respira suma su amplitud', () => {
		expect(escalaMaxSticker('pop', null, e)).toBe(1);
		expect(escalaMaxSticker('rebote', null, e)).toBeGreaterThan(1.03);
		expect(escalaMaxSticker('corte', 'respira', e)).toBeCloseTo(1.015, 5);
	});

	it.runIf(HAY_FUENTES)('tarjeta: 1 renglón mide mayúscula + rellenos (117 px); un texto largo se parte en 2 renglones', () => {
		const et = resolverEstiloTarjeta({});
		const corta = medirTarjeta('Opus 5.5', et, 1);
		expect(corta.renglones).toBe(1);
		expect(corta.alto).toBeCloseTo(51 + 30 + 36, 5);
		const larga = medirTarjeta('Instala todas las dependencias del agente', et, 1);
		expect(larga.renglones).toBe(2);
		expect(larga.alto).toBeCloseTo(51 + 76 + 30 + 36, 5);
		expect(larga.ancho).toBeLessThanOrEqual(et.ancho_max + 1);
	});

	it('partirRenglones respeta los saltos y corta por palabras', () => {
		const medir = (t: string) => t.length * 10;
		expect(partirRenglones('uno dos tres\ncuatro', 70, medir)).toEqual(['uno dos', 'tres', 'cuatro']);
	});

	it.runIf(HAY_FUENTES)('lista apilada (grupo): la 2.ª y la 3.ª van debajo de la primera con la separación del estilo y se van juntas', () => {
		const et = resolverEstiloTarjeta({});
		const t = (id: string, desde: number, hasta: number): Edicion['tarjetas'][number] => ({id, desde, hasta, texto: id, caja: {x: 540, y: 1200}, grupo: 'g1', variante: 'normal', entrada: 'corte', tapaCabeza: false, sfx: null});
		const cajas = cajasVisiblesTarjetas([t('Uno', 1, 2), t('Dos', 1.5, 2), t('Tres', 1.8, 3)], et);
		expect(cajas[1].caja.y0 - cajas[0].caja.y1).toBeCloseTo(et.separacion_px, 5);
		expect(cajas[2].caja.y0 - cajas[1].caja.y1).toBeCloseTo(et.separacion_px, 5);
		expect(cajas.map((c) => c.hasta)).toEqual([3, 3, 3]);
		expect((cajas[0].caja.y0 + cajas[0].caja.y1) / 2).toBeCloseTo(1200, 5);
	});

	it.runIf(HAY_FUENTES)('titular: 2 renglones, la y es el centro de las mayúsculas del primero, y se achica si no cabe en ancho_max', () => {
		const et = resolverEstiloTitular({});
		const g = geometriaTitular({texto: 'Cómo hacer páginas web\nprofesionales con Claude', caja: {x: 540, y: 302}}, et);
		expect(g.lineas).toHaveLength(2);
		expect(g.caja.y0).toBeLessThan(302 - 47 / 2);
		expect(g.caja.y1).toBeGreaterThan(302 + 47 / 2 + 85 * g.k - 1);
		const largo = geometriaTitular({texto: 'Una frase larguísima que no cabe en un renglón del titular jamás', caja: {x: 540, y: 302}}, et);
		expect(largo.lineas.length).toBe(2);
		expect(largo.k).toBeLessThan(1);
	});

	it('insert: video en tarjeta de 770 de ancho con la proporción del archivo; pantalla completa = el cuadro', () => {
		const base: Edicion['inserts'][number] = {id: 'b1', tipo: 'video', desde: 0, hasta: 1, asset: 'x.mp4', trim_desde: 0, layout: 'tarjeta', tapaCabeza: false, texto: null, eventos: null, audio: {modo: 'mute', ganancia_db: 0}, sfx: null};
		expect(cajaVisibleInsert(base, {ancho: 1920, alto: 1080}).caja).toEqual({x0: 540 - 385, y0: 995 - 216.5625, x1: 540 + 385, y1: 995 + 216.5625});
		expect(cajaVisibleInsert({...base, layout: 'pantalla-completa'}, null).caja).toEqual({x0: 0, y0: 0, x1: 1080, y1: 1920});
		expect(cajaVisibleInsert(base, null).aproximada).toBe(true);
	});

	it('encimeVertical solo cuenta si también se enciman en horizontal', () => {
		expect(encimeVertical({x0: 0, y0: 0, x1: 10, y1: 10}, {x0: 5, y0: 8, x1: 20, y1: 20})).toBe(2);
		expect(encimeVertical({x0: 0, y0: 0, x1: 10, y1: 10}, {x0: 11, y0: 0, x1: 20, y1: 20})).toBe(0);
	});
});

describe('colocar stickers', () => {
	// Sin estilo.json: ancho p50 316 y p10 272 (MEDICIONES_CAPAS), centro y 1258 (supuesto), franja 1453.1, margen de la
	// boca 12 y de la barbilla 60. mascota de frente: 940×776 de tinta → a 316 de ancho mide 260.9 de alto.
	const cerca = ctxCon(caraSintetica({barbilla: 1240, boca: 1100, coronilla: 450}));

	it('toma de cerca: un mascota de frente va a su ancho p50 en su y medida, encima de la barba y nunca arriba de boca + 12', () => {
		const r = colocarSticker({id: 'k1', t0: 2, t1: 3, png: MASCOTA}, cerca);
		expect(r.caja).not.toBeNull();
		expect(r.escala).toBe(1);
		expect(r.visible!.x1 - r.visible!.x0).toBeCloseTo(316, 0);
		expect((r.visible!.y0 + r.visible!.y1) / 2).toBeCloseTo(1258, 0);
		expect(r.visible!.y0).toBeGreaterThanOrEqual(1112 - 0.1);
		expect(r.visible!.y0).toBeLessThan(1300); // toca la barba: como tus tomas de cerca
		expect(r.visible!.y1).toBeLessThanOrEqual(cerca.franja.y0 + 0.1);
		expect(r.avisos.join(' ')).toMatch(/encima de tu barba/);
		expect(Math.abs((r.visible!.x0 + r.visible!.x1) / 2 - 540)).toBeLessThanOrEqual(5);
		// Ida y vuelta: la caja de la EDL da la misma caja visible (geometría de Sticker.tsx).
		const {caja} = cajaVisibleSticker({caja: r.caja!, entrada: 'pop', mascota: null}, MASCOTA, cerca.estiloSticker);
		expect(caja.y0).toBeCloseTo(r.visible!.y0, 0);
		expect(caja.x1).toBeCloseTo(r.visible!.x1, 0);
	});

	it('toma media: queda debajo de la barbilla en su y medida, sin avisos', () => {
		const r = colocarSticker({id: 'k1', t0: 2, t1: 3, png: MASCOTA}, ctxCon(caraSintetica({barbilla: 1000, boca: 880, coronilla: 300})));
		expect((r.visible!.y0 + r.visible!.y1) / 2).toBeCloseTo(1258, 0);
		expect(r.visible!.y0).toBeGreaterThanOrEqual(1060);
		expect(r.avisos).toEqual([]);
	});

	it('si choca con la boca baja, primero baja; si no cabe a su p50, se achica hasta el p10 y solo entonces', () => {
		// Boca 1190 → límite 1202: zona de 251.1 px < 260.9 → se achica a 304 px (≥ p10 272) y baja hasta el límite.
		const r = colocarSticker({id: 'k1', t0: 2, t1: 3, png: MASCOTA}, ctxCon(caraSintetica({barbilla: 1300, boca: 1190, coronilla: 450})));
		expect(r.caja).not.toBeNull();
		expect(r.escala).toBeLessThan(1);
		expect(r.visible!.x1 - r.visible!.x0).toBeGreaterThanOrEqual(estilo.sticker.ancho_p10.valor - 0.2);
		expect(r.visible!.y0).toBeGreaterThanOrEqual(1202 - 0.1);
		expect(r.avisos.join(' ')).toMatch(/achicado/);
		expect(r.avisos.join(' ')).toMatch(/para no taparte la boca/);
		// Un letrero (bajito) en la misma ventana no se achica: solo baja.
		const l = colocarSticker({id: 'k2', t0: 2, t1: 3, png: LETRERO}, ctxCon(caraSintetica({barbilla: 1300, boca: 1190, coronilla: 450})));
		expect(l.escala).toBe(1);
		expect(l.visible!.y0).toBeGreaterThanOrEqual(1202 - 0.1);
	});

	it('logo de marca: con anchoMinimo (piso de logos) cabe achicado donde el p10 no cabe; el piso sale del p10 entre reels', () => {
		const TILE: InfoPng = {ancho: 650, alto: 650, tinta: {x: 25, y: 25, w: 600, h: 600}};
		// Boca 1229 → límite 1241; franja ≈ 1453 → ~212 px libres.
		const ctx = ctxCon(caraSintetica({barbilla: 1330, boca: 1229, coronilla: 450}));
		expect(colocarSticker({id: 'k1', t0: 2, t1: 3, png: TILE}, ctx).caja).toBeNull();
		const piso = anchoMinimoLogo(estilo);
		expect(piso.valor).toBe(ANCHO_MIN_LOGO_SUPUESTO); // sin estilo.json: supuesto
		const r = colocarSticker({id: 'k1', t0: 2, t1: 3, png: TILE, anchoMinimo: piso}, ctx);
		expect(r.caja).not.toBeNull();
		expect(r.visible!.y0).toBeGreaterThanOrEqual(1241 - 0.1);
		expect(r.visible!.y1).toBeLessThanOrEqual(ctx.franja.y0 + 0.1);
		expect(r.visible!.x1 - r.visible!.x0).toBeGreaterThanOrEqual(piso.valor);
		expect(r.avisos.join(' ')).toMatch(/achicado/);
		// Con la boca más baja (~100 px libres) ni al piso cabe: se quita y dice cuál piso usó.
		const no = colocarSticker({id: 'k1', t0: 2, t1: 3, png: TILE, anchoMinimo: piso}, ctxCon(caraSintetica({barbilla: 1420, boca: 1340, coronilla: 450})));
		expect(no.caja).toBeNull();
		expect(no.avisos.join(' ')).toMatch(/piso de logos/);
		// Con el p10 entre reels medido (estilo.json: 202), ese es el piso; nunca más que el p10 normal.
		const medido = {...estilo, sticker: {...estilo.sticker, ancho_p10: {...estilo.sticker.ancho_p10, valor: 277, p10: 202}}};
		expect(anchoMinimoLogo(medido).valor).toBe(202);
		const raro = {...estilo, sticker: {...estilo.sticker, ancho_p10: {...estilo.sticker.ancho_p10, valor: 150, p10: 202}}};
		expect(anchoMinimoLogo(raro).valor).toBe(150);
	});

	it('si ni a su p10 cabe entre tu boca y la franja, se quita y lo explica', () => {
		const r = colocarSticker({id: 'k2', t0: 2, t1: 3, png: MASCOTA}, ctxCon(caraSintetica({barbilla: 1330, boca: 1240, coronilla: 450})));
		expect(r.caja).toBeNull();
		expect(r.avisos.join(' ')).toMatch(/no cabe debajo de tu boca/);
		expect(r.avisos.join(' ')).toMatch(/se quita/);
	});

	it('la variación horizontal es determinista con la semilla', () => {
		const a = colocarSticker({id: 'k1', t0: 2, t1: 3, png: LETRERO}, cerca);
		const b = colocarSticker({id: 'k1', t0: 2, t1: 3, png: LETRERO}, cerca);
		expect(a.caja).toEqual(b.caja);
		expect(azarDe('x')).toBe(azarDe('x'));
	});
});

describe('colocar tarjetas y listas', () => {
	// Tarjeta de 1 renglón a escala 1: 51 + 30 + 36 = 117 px; y medida 1274 (sin estilo.json, sin rango medido).
	it.runIf(HAY_FUENTES)('toma de cerca: la tarjeta va en su y medida (1274), encima de tu barba, nunca arriba de boca + 12', () => {
		const ctx = ctxCon(caraSintetica({barbilla: 1240, boca: 1100, coronilla: 450}));
		const r = colocarTarjeta({t0: 2, t1: 3, texto: 'Opus 5.5'}, ctx);
		expect(r.caja).toEqual({x: 540, y: 1274});
		expect(r.avisos.join(' ')).toMatch(/encima de tu barba/);
		const [visible] = cajasVisiblesTarjetas([{id: 't1', desde: 2, hasta: 3, texto: 'Opus 5.5', caja: r.caja!, grupo: null, variante: 'normal', entrada: 'corte', tapaCabeza: false, sfx: null}], ctx.estiloTarjeta);
		expect(visible.caja.y0).toBeGreaterThanOrEqual(1112 - 0.1);
		expect(visible.caja.y1).toBeLessThanOrEqual(ctx.franja.y0 + 0.1);
	});

	it.runIf(HAY_FUENTES)('toma media: en su y medida, debajo de la barbilla, sin avisos', () => {
		const r = colocarTarjeta({t0: 2, t1: 3, texto: 'Opus 5.5'}, ctxCon(caraSintetica({barbilla: 1000, boca: 880, coronilla: 300})));
		expect(r.caja!.y).toBe(1274);
		expect(r.caja!.escala).toBeUndefined();
		expect(r.avisos).toEqual([]);
	});

	it.runIf(HAY_FUENTES)('preferencia: si bajarla dentro de su rango medido la deja debajo de la barbilla, se baja; si no alcanza, se queda', () => {
		const cara = caraSintetica({barbilla: 1180, boca: 1060, coronilla: 450});
		const conRango: EstiloDirector = {...estilo, tarjeta: {...estilo.tarjeta, y_rango: {p10: {valor: 1250, n: 9, fuente: 'prueba'}, p90: {valor: 1300, n: 9, fuente: 'prueba'}}}};
		const r = colocarTarjeta({t0: 2, t1: 3, texto: 'Opus 5.5'}, crearContexto({cara, estilo: conRango, semilla: 'prueba'}));
		expect(r.caja!.y).toBeCloseTo(1240 + 117 / 2, 0);
		expect(r.avisos.join(' ')).toMatch(/para quedar debajo de tu barbilla/);
		// Sin rango (la y sola), no se mueve: va encima de la barba.
		const q = colocarTarjeta({t0: 2, t1: 3, texto: 'Opus 5.5'}, ctxCon(cara));
		expect(q.caja!.y).toBe(1274);
	});

	it.runIf(HAY_FUENTES)('si la boca la empuja, baja; si no cabe entre tu boca y la franja, se achica hasta la escala mínima; si no, se quita', () => {
		const baja = colocarTarjeta({t0: 2, t1: 3, texto: 'Folders'}, ctxCon(caraSintetica({barbilla: 1350, boca: 1250, coronilla: 450})));
		expect(baja.caja!.y).toBeCloseTo(1262 + 117 / 2, 0);
		expect(baja.avisos.join(' ')).toMatch(/para no taparte la boca/);
		const apretada = colocarTarjeta({t0: 2, t1: 3, texto: 'Folders'}, ctxCon(caraSintetica({barbilla: 1420, boca: 1350, coronilla: 450})));
		expect(apretada.caja!.escala).toBeLessThan(1);
		expect(apretada.caja!.escala).toBeGreaterThanOrEqual(0.58);
		expect(apretada.alto).toBeLessThanOrEqual(apretada.banda.alto_boca + 0.01);
		const imposible = colocarTarjeta({t0: 2, t1: 3, texto: 'Folders'}, ctxCon(caraSintetica({barbilla: 1470, boca: 1400, coronilla: 450})));
		expect(imposible.caja).toBeNull();
		expect(imposible.avisos.join(' ')).toMatch(/se quita/);
	});

	it('filasArbol: 1 arriba y luego de 2 en 2 (tus listas mixtas [1,2], [1,2,1], [1,2,2])', () => {
		expect(filasArbol(3)).toEqual([[0], [1, 2]]);
		expect(filasArbol(4)).toEqual([[0], [1, 2], [3]]);
		expect(filasArbol(5)).toEqual([[0], [1, 2], [3, 4]]);
	});

	const textos = ['Precios', 'Nombre', 'Dónde es'];
	it.runIf(HAY_FUENTES)('lista: con espacio va en COLUMNA; si choca con la franja sube y lo dice', () => {
		const ctx = ctxCon(caraSintetica({barbilla: 900, boca: 780, coronilla: 300}));
		const r = colocarLista({t0: 2, t1: 4, textos}, ctx);
		expect(r.modo).toBe('columna');
		expect(r.escala).toBe(0.75);
		expect(r.avisos.join(' ')).toMatch(/más arriba, para no tocar la franja/);
		const visibles = cajasVisiblesTarjetas(
			r.cajas.map((c, k) => ({id: `t${k}`, desde: 2, hasta: 4, texto: textos[k], caja: {x: c.x, y: c.y, escala: c.escala}, grupo: 'g1', variante: 'normal' as const, entrada: 'corte' as const, tapaCabeza: false, sfx: null})),
			ctx.estiloTarjeta,
		);
		expect(Math.max(...visibles.map((v) => v.caja.y1))).toBeLessThanOrEqual(ctx.franja.y0 + 0.1);
		expect(Math.min(...visibles.map((v) => v.caja.y0))).toBeGreaterThanOrEqual(792 - 0.1);
	});

	it.runIf(HAY_FUENTES)('lista: si no cabe en columna entre tu boca y la franja, va en ÁRBOL (1 arriba, 2 lado a lado) y así la dibuja Tarjeta.tsx', () => {
		const ctx = ctxCon(caraSintetica({barbilla: 1240, boca: 1140, coronilla: 450}));
		const r = colocarLista({t0: 2, t1: 4, textos}, ctx);
		expect(r.modo).toBe('arbol');
		expect(r.escala).toBe(0.75);
		expect(r.cajas.map((c) => c.fila)).toEqual([0, 1, 1]);
		expect(r.cajas[0].y).toBeCloseTo(1274, 0);
		expect(r.cajas[1].y).toBe(r.cajas[2].y);
		expect(r.cajas[1].x).toBeLessThan(r.cajas[2].x);
		expect(r.avisos.join(' ')).toMatch(/en árbol/);
		// Como en la EDL (grupo, fila y caja.x = 540): la geometría de validar (capas.disponerGrupo) cae donde dijo el layout.
		const tarjetas = r.cajas.map((c, k) => ({id: `t${k}`, desde: 2 + 0.3 * k, hasta: 4, texto: textos[k], caja: {x: 540, y: c.y, escala: c.escala}, grupo: 'g1', fila: c.fila, variante: 'normal' as const, entrada: 'corte' as const, tapaCabeza: false, sfx: null}));
		const v = cajasVisiblesTarjetas(tarjetas, ctx.estiloTarjeta);
		const [a, b, c] = ['t0', 't1', 't2'].map((id) => v.find((x) => x.id === id)!.caja);
		expect((a.y0 + a.y1) / 2).toBeCloseTo(r.cajas[0].y, 0);
		expect((b.y0 + b.y1) / 2).toBeCloseTo(r.cajas[1].y, 0);
		expect((b.x0 + c.x1) / 2).toBeCloseTo(540, 0);
		expect(c.x0 - b.x1).toBeCloseTo(ctx.estiloTarjeta.separacion_h_px, 1);
		expect(encimeVertical(a, b) + encimeVertical(a, c) + encimeVertical(b, c)).toBe(0);
		expect(Math.min(a.y0, b.y0, c.y0)).toBeGreaterThanOrEqual(1152 - 0.1);
		expect(Math.max(a.y1, b.y1, c.y1)).toBeLessThanOrEqual(ctx.franja.y0 + 0.1);
	});

	it.runIf(HAY_FUENTES)('lista: si tampoco cabe en árbol, va en FILA; sin espacio ni para la fila, "secuencial" (cada una sola) y lo dice', () => {
		const fila = colocarLista({t0: 2, t1: 4, textos}, ctxCon(caraSintetica({barbilla: 1330, boca: 1260, coronilla: 450})));
		expect(fila.modo).toBe('fila');
		expect(new Set(fila.cajas.map((c) => c.y)).size).toBe(1);
		expect(fila.cajas.map((c) => c.fila)).toEqual([0, 0, 0]);
		expect(fila.cajas[0].x).toBeLessThan(fila.cajas[1].x);
		const nada = colocarLista({t0: 2, t1: 4, textos}, ctxCon(caraSintetica({barbilla: 1450, boca: 1380, coronilla: 450})));
		expect(nada.modo).toBe('secuencial');
		expect(nada.avisos.join(' ')).toMatch(/sola/);
	});
});

describe('colocar el titular', () => {
	const texto = 'Cómo hacer páginas web\nprofesionales con Claude';
	it.runIf(HAY_FUENTES)('con la cabeza abajo se queda en su y medida (302)', () => {
		const r = colocarTitular({texto, t0: 0, t1: 10}, ctxCon(caraSintetica({barbilla: 1240, coronilla: 700})));
		expect(r.caja).toEqual({x: 540, y: 302});
		expect(r.cabe).toBe(true);
		expect(r.tapaCabeza).toBe(true);
	});

	// caraSintetica(): la caja de la CARA empieza 150 px debajo de la coronilla (pelo). El titular protege la cara.
	it.runIf(HAY_FUENTES)('si solo el pelo lo toca (la cara no), se queda en su lugar a su tamaño', () => {
		const r = colocarTitular({texto, t0: 0, t1: 10}, ctxCon(caraSintetica({barbilla: 1240, coronilla: 400})));
		expect(r.cabe).toBe(true);
		expect(r.caja.y).toBe(302);
		expect(r.caja.escala).toBeUndefined();
	});

	it.runIf(HAY_FUENTES)('si la cara (frente) lo invade, lo sube (hasta la zona UI) y lo dice', () => {
		const r = colocarTitular({texto, t0: 0, t1: 10}, ctxCon(caraSintetica({barbilla: 1240, coronilla: 280})));
		expect(r.cabe).toBe(true);
		expect(r.caja.y).toBeLessThan(302);
		expect(r.caja.escala).toBeUndefined();
		expect(r.visible.y1).toBeLessThanOrEqual(430 - 12 + 0.1);
		expect(r.visible.y0).toBeGreaterThanOrEqual(estilo.zona_ui.arriba.valor - 0.1);
		expect(r.avisos.join(' ')).toMatch(/subí el titular/);
	});

	it.runIf(HAY_FUENTES)('si subirlo no alcanza, se achica pegado al tope de la zona UI; si ni así, cabe = false', () => {
		const r = colocarTitular({texto, t0: 0, t1: 10}, ctxCon(caraSintetica({barbilla: 1240, coronilla: 200})));
		expect(r.cabe).toBe(true);
		expect(r.caja.escala).toBeLessThan(1);
		expect(r.visible.y1).toBeLessThanOrEqual(350 - 12 + 0.1);
		const no = colocarTitular({texto, t0: 0, t1: 10}, ctxCon(caraSintetica({barbilla: 1240, coronilla: 110})));
		expect(no.cabe).toBe(false);
		expect(no.avisos.join(' ')).toMatch(/no cabe/);
	});
});

describe('colocar inserts', () => {
	it('16:9 en la banda chica: menos de 70 % de ancho legible → tapaCabeza = true, sin cruzar la franja ni el titular', () => {
		const ctx = ctxCon(caraSintetica({barbilla: 1240, coronilla: 450}));
		const titular = {x0: 100, y0: 230, x1: 980, y1: 340};
		const r = colocarInsert({t0: 2, t1: 4, layout: 'tarjeta', aspecto: 9 / 16, evitar: [titular]}, ctx);
		expect(r.tapaCabeza).toBe(true);
		expect(r.anchoLegible).toBeLessThan(0.7);
		expect(r.caja!.y - r.caja!.h / 2).toBeGreaterThanOrEqual(titular.y1 + 20 - 0.1);
		expect(r.caja!.y + r.caja!.h / 2).toBeLessThanOrEqual(ctx.franja.y0 + 0.1);
		expect(r.avisos.join(' ')).toMatch(/tapa la cabeza/);
		expect(anchoLegibleDebajo(ctx, 2, 4, 9 / 16).ancho).toBeLessThan(756);
	});

	it('16:9 con la barbilla arriba: cabe con ≥ 756 px debajo de la barbilla → va debajo (tapaCabeza = false)', () => {
		const ctx = ctxCon(caraSintetica({barbilla: 500, coronilla: 150}));
		const r = colocarInsert({t0: 2, t1: 4, layout: 'tarjeta', aspecto: 9 / 16}, ctx);
		expect(r.tapaCabeza).toBe(false);
		expect(r.caja!.w).toBe(770);
		expect(r.caja!.y - r.caja!.h / 2).toBeGreaterThanOrEqual(560 - 0.1);
	});

	it('pantalla completa: sin restricción', () => {
		const r = colocarInsert({t0: 2, t1: 4, layout: 'pantalla-completa', aspecto: 16 / 9}, ctxCon(caraSintetica({barbilla: 1240, coronilla: 450})));
		expect(r).toMatchObject({caja: null, tapaCabeza: false});
	});

	it('meme: tapa la cara aunque quepa debajo de la barbilla, centro y 940, 800 px y dentro de x 135–945', () => {
		const ctx = ctxCon(caraSintetica({barbilla: 500, coronilla: 150}));
		const r = colocarInsert({t0: 2, t1: 3, layout: 'tarjeta', aspecto: 1, meme: true}, ctx);
		expect(r.tapaCabeza).toBe(true);
		expect(r.caja).toMatchObject({x: 540, y: 940, w: 800, h: 800});
		expect(r.caja!.x - r.caja!.w / 2).toBeGreaterThanOrEqual(135);
		expect(r.caja!.x + r.caja!.w / 2).toBeLessThanOrEqual(945);
		expect(r.caja!.y + r.caja!.h / 2).toBeLessThanOrEqual(ctx.franja.y0);
		// Pedir 1000 de ancho no lo saca de la zona cian.
		expect(colocarInsert({t0: 2, t1: 3, layout: 'tarjeta', aspecto: 0.5, meme: true, anchoDeseado: 1000}, ctx).caja!.w).toBe(810);
	});
});
