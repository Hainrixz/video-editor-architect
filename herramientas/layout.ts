// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * layout.ts — todo DEBAJO de tu boca (la zona protegida de tu cara), fuera de la franja de subtítulos y dentro de la
 * zona segura de Instagram.
 *
 *   npx tsx herramientas/layout.ts <slug> [--version N] [--cada S] [--json]
 *
 * Por qué la boca y no la barbilla (director v2): en tus tomas DE CERCA (cara grande: 3 de 18 reels, p. ej.
 * reel P8) pones tarjetas y logos en su lugar de siempre (centro ≈ 1284 las tarjetas, ≈ 1256 los stickers), encima
 * de la barba y el cuello: tocan la barbilla pero NUNCA tapan boca, nariz ni ojos. En tus tomas medias quedan debajo de
 * la barbilla solas. Exigir barbilla + 60 dejaba en IMG_4874 una banda de 69–128 px: letreros chiquitos y 13 stickers
 * quitados, que no es tu estilo.
 *
 * Como librería (la usan el director y validar.ts):
 *  - Zonas en la base 1080×1920, por ventana de tiempo (t0−0.2…t1+0.2, con zooms):
 *      · límite DURO: bocaMax + 12 px (margen supuesto, estilo.cabeza.margen_boca). Como la boca va debajo de la nariz
 *        y de los ojos, lo que respeta este límite tampoco los tapa (por construcción).
 *      · PREFERENCIA: debajo de la barbilla (barbillaMax + estilo.cabeza.margen_barbilla: lo que dejas en tus reels, o
 *        60 del plan), solo moviéndola dentro de su rango medido (tarjetas: p10–p90 del centro en un reel). Si en su
 *        lugar de siempre no cabe debajo de la barbilla, se queda ahí, encima de la barba (como tus tomas de cerca).
 *      · la coronilla para el titular, la franja de subtítulos (centro y_p10…y_p90 ± media mayúscula con borde + 20 px)
 *        y la zona UI (estilo.zona_ui o lo medido en tus overlays; si no, la guía de Meta).
 *  - Geometría de lo que SE VE de cada capa, igual que la dibujan los componentes de src/reel/: stickers (la tinta del PNG,
 *    con el pop o el rebote), tarjetas (texto medido con fontkit; listas apiladas o en árbol con `fila`, como
 *    Tarjeta.tsx → capas.disponerGrupo), titular (renglones, auto-achique a ancho_max y contorno como en Titular.tsx) e
 *    inserts (Insert.tsx y Reel.tsx).
 *  - Colocar: colocarSticker (en su y medida y su ancho p50; se achica hasta el p10 solo si choca), colocarTarjeta (en su
 *    y medida), colocarLista (columna; si no cabe, árbol: 1 arriba y las demás lado a lado), colocarTitular y
 *    colocarInsert. Cada una devuelve su caja (en el formato de la EDL) y avisos que explican qué se movió, se achicó o
 *    se quitó y por qué.
 *
 * Como CLI: diagnóstico de un proyecto (franja, zona UI, zona libre debajo de tu boca y debajo de tu barbilla en el
 * tiempo, qué cabe) y, si hay una edición, la caja visible de cada capa contra la cabeza y la franja.
 *
 * Corre dentro del sandbox (lee cara.json, no llama a Vision). Códigos: 0 bien · 1 fallo interno · 2 falta algo.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import type {Edicion} from '../src/esquema/edicion.ts';
import {POP_MEDIDO, escalaPop, escalaRebote} from '../src/estilo/animaciones.ts';
import {cajaMeme} from '../src/estilo/memes.ts';
import {
	agruparTarjetas,
	altoCajaPrompt,
	altoCajaTarjeta,
	anchoMaxDeTarjeta,
	disponerGrupo,
	escalaDeTarjeta,
	geometriaPrompt,
	geometriaTarjeta,
	partirEnDos,
	pesoReal,
	renglones,
	resolverEstiloSticker,
	resolverEstiloTarjeta,
	resolverEstiloTitular,
	tamanoDeLetra,
	type EstiloSticker,
	type EstiloTarjeta,
	type EstiloTitular,
} from '../src/estilo/capas.ts';
import {archivoFuente, candidata, resolverEstilo as resolverEstiloSubtitulo, type IdFuente} from '../src/estilo/fuentes.ts';
import {ZONA_SEGURA} from '../src/estilo/zona-segura.ts';
import {cajaMotion} from '../src/estilo/motion.ts';
import {cajaFlotante} from '../src/estilo/flotante.ts';
import {barbillaMax, bocaDeCuadro, bocaMax, bocaMedida, cajaCara, cobertura, coronillaMin, leerCara, type CaraConsultable, type ZoomCara} from './lib/cara.ts';
import {leerEstiloDirector, textoMedida, type EstiloDirector} from './lib/director/estilo.ts';
import type {Palabra} from './lib/director/texto.ts';
import {borradorTitular} from './lib/director/titular.ts';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {DIR_PROYECTOS, RAIZ} from './lib/manifest.ts';
import {esSlugValido, REGLA_SLUG} from './lib/slug.ts';
import {abrirFuente, medirTexto} from './lib/texto-ancho.ts';

export const BASE_W = 1080;
export const BASE_H = 1920;
export const FPS = 30;
/**
 * Variación horizontal de los stickers alrededor del centro (± px, con semilla). En tus reels van centrados: centro x
 * p50 540 y p90 545 entre reels (estilo.json → stickers.centro_x, overlays.ts, n = 15): ± (p90 − p50) = 5 px.
 */
export const DESVIO_X_STICKER = 5;
/** Escala mínima del titular antes de declarar que no cabe arriba de la cabeza (supuesto: mayúscula de ~28 px). */
export const ESCALA_MIN_TITULAR = 0.6;
/** Sin cara en la ventana: los stickers van a la banda baja de la zona UI (de aquí a la franja). Supuesto: la mitad de abajo. */
export const BANDA_BAJA_SIN_CARA = BASE_H / 2;

const r1 = (x: number): number => Math.round(x * 10) / 10;
const limitar = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

// ───────────────────────── tipos ─────────────────────────

/** Caja de lo que se ve, en px base: [x0, x1) × [y0, y1). */
export type CajaVisible = {x0: number; y0: number; x1: number; y1: number};

export type Franja = {y0: number; y1: number; fuente: string; detalle: string};

export type ZonaUi = {arriba: number; abajo: number; izquierda: number; derecha: number; fuente: string};

/**
 * Zona libre de una ventana de tiempo. Dos bordes de arriba:
 *  - y0_boca: el DURO (boca máx + 12). Nada con tapaCabeza = false sube de ahí (regla R1 de validar.ts).
 *  - y0: el PREFERIDO (barbilla máx + margen): debajo de tu barbilla, como en tus tomas medias.
 * Sin cara (o sin cara.json) los dos son la banda baja de la zona UI.
 */
export type Banda = {
	/** Borde de arriba PREFERIDO: barbilla máx + margen (o el respaldo sin cara). */
	y0: number;
	/** Borde de abajo permitido (tope de la franja de subtítulos). */
	y1: number;
	/** y1 − y0: lo que mide la zona debajo de tu barbilla. */
	alto: number;
	barbilla: number | null;
	/** Cuándo cae la barbilla más baja de la ventana. */
	t_barbilla: number | null;
	origen: string;
	/** Borde de arriba DURO: boca máx + 12 (zona protegida). ≤ y0. */
	y0_boca: number;
	/** y1 − y0_boca: lo que mide la zona libre debajo de tu boca. */
	alto_boca: number;
	boca: number | null;
	t_boca: number | null;
	/** La boca se estimó (cara.json de antes de medirla): barbilla − 0.18 × alto de la cara. */
	boca_estimada: boolean;
	origen_boca: string;
};

export type ContextoLayout = {
	cara: CaraConsultable | null;
	zooms: ZoomCara[];
	franja: Franja;
	zonaUi: ZonaUi;
	estilo: EstiloDirector;
	estiloTarjeta: EstiloTarjeta;
	estiloTitular: EstiloTitular;
	estiloSticker: EstiloSticker;
	semilla: string;
};

/** Lo que importa de un PNG para saber qué se ve: tamaño y caja de la tinta (α ≥ 128). */
export type InfoPng = {ancho: number; alto: number; tinta: {x: number; y: number; w: number; h: number} | null};

export const altoDe = (c: CajaVisible): number => c.y1 - c.y0;
export const anchoDe = (c: CajaVisible): number => c.x1 - c.x0;
export const union = (a: CajaVisible, b: CajaVisible): CajaVisible => ({x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1)});
export const redondearCaja = (c: CajaVisible): CajaVisible => ({x0: r1(c.x0), y0: r1(c.y0), x1: r1(c.x1), y1: r1(c.y1)});
/** Cuánto se enciman dos cajas en vertical (px) si también se enciman en horizontal; 0 si no. */
export function encimeVertical(a: CajaVisible, b: CajaVisible): number {
	if (a.x1 <= b.x0 || b.x1 <= a.x0) return 0;
	return Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}

/** Número en [0, 1) a partir de un texto (FNV-1a): la misma semilla da lo mismo. */
export function azarDe(texto: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < texto.length; i++) {
		h ^= texto.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

/** Zooms de la EDL en el formato de la cara. */
export const zoomsDeEdicion = (z: Edicion['zooms']): ZoomCara[] => z.map((x) => ({escala: x.escala, origen: x.origen, desde: x.desde, hasta: x.hasta, transicion: x.transicion}));

// ───────────────────────── texto (fontkit, mismo archivo que el render) ─────────────────────────

const rutaFuente = (fuente: IdFuente, peso: number): string => join(RAIZ, archivoFuente(fuente, pesoReal(fuente, peso)).ruta);

/** Avance (ancho de la caja CSS) de un texto. */
export function avanceTexto(fuente: IdFuente, peso: number, texto: string, tamano: number): number {
	if (!texto) return 0;
	return medirTexto(rutaFuente(fuente, peso), texto, tamano).avance;
}

/** Tinta arriba y abajo de la línea base (px, positivos), con las cajas reales de los glifos. */
export function verticalTexto(fuente: IdFuente, peso: number, texto: string, tamano: number): {arriba: number; abajo: number} {
	const f = abrirFuente(rutaFuente(fuente, peso));
	const escala = tamano / f.unitsPerEm;
	let arriba = 0;
	let abajo = 0;
	for (const g of f.layout(texto).glyphs) {
		if (g.bbox.maxY !== null && Number.isFinite(g.bbox.maxY)) arriba = Math.max(arriba, g.bbox.maxY * escala);
		if (g.bbox.minY !== null && Number.isFinite(g.bbox.minY)) abajo = Math.max(abajo, -g.bbox.minY * escala);
	}
	return {arriba, abajo};
}

/** Renglones de un texto que se acomoda en `disponible` px (como el navegador: por palabras; respeta los "\n"). */
export function partirRenglones(texto: string, disponible: number, medir: (t: string) => number): string[] {
	const lineas: string[] = [];
	for (const parrafo of texto.split(/\r?\n/)) {
		const palabras = parrafo.trim().split(/\s+/).filter(Boolean);
		if (palabras.length === 0) continue;
		let actual = palabras[0];
		for (const p of palabras.slice(1)) {
			const prueba = `${actual} ${p}`;
			if (medir(prueba) <= disponible + 0.5) actual = prueba;
			else {
				lineas.push(actual);
				actual = p;
			}
		}
		lineas.push(actual);
	}
	return lineas.length > 0 ? lineas : [''];
}

// ───────────────────────── tarjetas ─────────────────────────

export type MedidaTarjeta = {ancho: number; alto: number; renglones: number; lineas: string[]};

/** Ancho y alto VISIBLES de una tarjeta (caja blanca) con esa escala total y ese ancho máximo. */
export function medirTarjeta(texto: string, estilo: EstiloTarjeta, escala: number, anchoMax?: number): MedidaTarjeta {
	return medirTarjetaBase(texto, estilo, escala, anchoMax);
}

function medirTarjetaBase(texto: string, estilo: EstiloTarjeta, escala: number, anchoMax?: number): MedidaTarjeta {
	const g = geometriaTarjeta(estilo, escala);
	const maxW = anchoMax ?? estilo.ancho_max;
	const medir = (t: string) => avanceTexto(estilo.fuente, estilo.peso, t, g.tamano_px);
	const lineas = partirRenglones(texto, maxW - 2 * g.pad_lados_px, medir);
	const ancho = Math.max(...lineas.map(medir)) + 2 * g.pad_lados_px;
	return {ancho, alto: altoCajaTarjeta(g, lineas.length), renglones: lineas.length, lineas};
}

type TarjetaEdl = Edicion['tarjetas'][number];
export type CajaTemporal = {id: string; desde: number; hasta: number; caja: CajaVisible};

/**
 * Ancho y alto VISIBLES de una tarjeta de la EDL, como Tarjeta.tsx: su escala (variante × caja.escala, o la de lista
 * si va en grupo), su ancho máximo (caja.w o el del estilo) y, si es "prompt", su geometría propia (una sola caja del
 * renglón más largo).
 */
export function medirTarjetaEdl(t: Pick<TarjetaEdl, 'texto' | 'variante' | 'grupo' | 'caja'>, estilo: EstiloTarjeta): {ancho: number; alto: number} {
	const escala = escalaDeTarjeta(t, estilo);
	const maxW = anchoMaxDeTarjeta(t, estilo);
	if (t.variante === 'prompt') {
		const g = geometriaPrompt(estilo, escala);
		const medir = (x: string) => avanceTexto(estilo.fuente, estilo.peso, x, g.tamano_px);
		const lineas = partirRenglones(t.texto, maxW - 2 * g.pad_lados_px, medir);
		return {ancho: Math.min(maxW, Math.max(...lineas.map(medir)) + 2 * g.pad_lados_px), alto: altoCajaPrompt(g, lineas.length)};
	}
	const m = medirTarjeta(t.texto, estilo, escala, maxW);
	return {ancho: m.ancho, alto: m.alto};
}

/**
 * Cajas visibles de todas las tarjetas (como Tarjeta.tsx → capas.disponerGrupo): el renglón de arriba de un grupo va
 * centrado en la caja.y de su primera tarjeta; los demás bajan con separacion_px; las de la misma `fila` van lado a
 * lado (listas en árbol). Cada una se ve desde su `desde` hasta que se va el grupo entero (el `hasta` más tardío).
 * La entrada (corte o pop) nunca pasa de escala 1.
 */
export function cajasVisiblesTarjetas(tarjetas: readonly TarjetaEdl[], estilo: EstiloTarjeta): CajaTemporal[] {
	const salida: CajaTemporal[] = [];
	for (const grupo of agruparTarjetas(tarjetas)) {
		const hasta = grupo.hasta / FPS;
		const porId = new Map(grupo.tarjetas.map((t) => [t.id, t]));
		for (const c of disponerGrupo(grupo.tarjetas, estilo, (t) => medirTarjetaEdl(t, estilo))) {
			const t = porId.get(c.id)!;
			salida.push({id: c.id, desde: t.desde, hasta, caja: {x0: c.x - c.ancho / 2, y0: c.y - c.alto / 2, x1: c.x + c.ancho / 2, y1: c.y + c.alto / 2}});
		}
	}
	return salida;
}

// ───────────────────────── titular ─────────────────────────

export type GeometriaTitular = {lineas: string[]; k: number; tamano: number; x: number; y: number; caja: CajaVisible; cajas: CajaVisible[]};

/**
 * Lo que se ve del titular (como Titular.tsx): renglones del texto; si viene en uno y no cabe en ancho_max, se parte en
 * dos parejos; si aún no cabe, todo se achica (k). El contorno (borde × caja.escala) va por fuera y no se achica con k.
 * caja.y = centro de las mayúsculas del 1.er renglón.
 */
export function geometriaTitular(titular: {texto: string; caja?: {x?: number; y?: number; escala?: number} | null}, estilo: EstiloTitular): GeometriaTitular {
	const e = estilo;
	const escalaCaja = titular.caja?.escala ?? 1;
	const x = titular.caja?.x ?? e.x;
	const y = titular.caja?.y ?? e.y;
	const tamano = tamanoDeLetra(e.fuente, e.alto_mayuscula_px) * escalaCaja;
	const borde = e.borde_px * escalaCaja;
	const medir = (t: string) => avanceTexto(e.fuente, e.peso, t, tamano);
	let lineas = renglones(titular.texto);
	if (lineas.length === 0) lineas = [titular.texto.trim()];
	if (lineas.length === 1 && medir(lineas[0]) + 2 * borde > e.ancho_max) lineas = partirEnDos(lineas[0], medir) ?? lineas;
	const ancho = Math.max(1, ...lineas.map(medir)) + 2 * borde;
	const k = Math.min(1, e.ancho_max / ancho);
	const alto = e.alto_mayuscula_px * escalaCaja * k;
	const paso = e.interlineado_px * escalaCaja * k;
	const base0 = y + alto / 2;
	const cajas = lineas.map((linea, i) => {
		const base = base0 + i * paso;
		const v = verticalTexto(e.fuente, e.peso, linea, tamano * k);
		const w = medir(linea) * k;
		return {x0: x - w / 2 - borde, y0: base - v.arriba - borde, x1: x + w / 2 + borde, y1: base + v.abajo + borde};
	});
	return {lineas, k, tamano: tamano * k, x, y, cajas, caja: cajas.reduce(union)};
}

// ───────────────────────── stickers ─────────────────────────

/** Escala máxima que alcanza un sticker con su entrada y su idle (pop: 1; rebote: el sobrepaso; respira: +amplitud). */
export function escalaMaxSticker(entrada: string, anim: string | null, estilo: EstiloSticker): number {
	const e = ['pop', 'corte', 'rebote'].includes(entrada) ? entrada : estilo.entrada;
	let max = 1;
	if (e === 'pop') for (let f = 0; f < 60; f++) max = Math.max(max, escalaPop(f, estilo.pop ?? POP_MEDIDO));
	if (e === 'rebote') for (let f = 0; f < 90; f++) max = Math.max(max, escalaRebote(f, estilo.rebote));
	if (anim === 'respira') max *= 1 + estilo.respira.amplitud;
	return max;
}

type StickerEdl = Edicion['stickers'][number];

/**
 * Caja visible de un sticker (como Sticker.tsx): con caja.w manda el ancho; si solo trae caja.h, el alto; si no, el ancho
 * del estilo; caja.escala multiplica. Lo que se ve es la tinta del PNG (α ≥ 128), escalada alrededor del centro del PNG
 * con la escala máxima de su animación. Sin PNG legible se supone cuadrado (aproximada = true).
 */
export function cajaVisibleSticker(s: Pick<StickerEdl, 'caja' | 'entrada' | 'mascota'>, png: InfoPng | null, estilo: EstiloSticker): {caja: CajaVisible; aproximada: boolean} {
	const ec = s.caja.escala ?? 1;
	const proporcion = png ? png.alto / png.ancho : 1;
	let W: number;
	if (s.caja.w !== undefined || s.caja.h === undefined) W = (s.caja.w ?? estilo.ancho_px) * ec;
	else W = (s.caja.h * ec) / proporcion;
	const H = W * proporcion;
	const t = png?.tinta ? {x: png.tinta.x / png.ancho, y: png.tinta.y / png.alto, w: png.tinta.w / png.ancho, h: png.tinta.h / png.alto} : {x: 0, y: 0, w: 1, h: 1};
	const izq = s.caja.x - W / 2;
	const arr = s.caja.y - H / 2;
	const m = escalaMaxSticker(s.entrada, s.mascota?.anim ?? null, estilo);
	const esc = (v: number, c: number) => c + (v - c) * m;
	return {
		caja: {
			x0: esc(izq + t.x * W, s.caja.x),
			y0: esc(arr + t.y * H, s.caja.y),
			x1: esc(izq + (t.x + t.w) * W, s.caja.x),
			y1: esc(arr + (t.y + t.h) * H, s.caja.y),
		},
		aproximada: png === null,
	};
}

// ───────────────────────── subtítulos ─────────────────────────

/**
 * Caja visible de un subtítulo (como Subtitulo.tsx): a lo ancho caja.w (ya mide el texto con su borde) × caja.escala
 * centrado en caja.x; a lo alto, la tinta real del texto (ascendentes y descendentes) más el borde, con la línea base
 * en caja.y + media mayúscula. La escala achica desde el centro de las mayúsculas.
 */
export function cajaVisibleSubtitulo(sub: Edicion['subtitulos'][number], estilos: Edicion['estilos'] | undefined): CajaVisible {
	const est = resolverEstiloSubtitulo((estilos?.subtitulos ?? {}) as Parameters<typeof resolverEstiloSubtitulo>[0]);
	const esc = sub.caja?.escala ?? 1;
	const x = sub.caja?.x ?? est.x;
	const y = sub.caja?.y ?? est.y;
	const tamano = est.tamano_px * esc;
	const cap = candidata(est.fuente).altoMayuscula * tamano;
	const crudo = sub.palabras.map((p) => p.t).join(' ');
	const texto = est.mayusculas ? crudo.toUpperCase() : crudo;
	const v = verticalTexto(est.fuente, pesoReal(est.fuente, est.peso), texto, tamano);
	const base = y + cap / 2;
	const borde = est.borde_px * esc;
	const w = sub.caja?.w !== undefined ? sub.caja.w * esc : avanceTexto(est.fuente, est.peso, texto, tamano) + 2 * borde;
	return {x0: x - w / 2, y0: base - v.arriba - borde, x1: x + w / 2, y1: base + v.abajo + borde};
}

// ───────────────────────── inserts ─────────────────────────

type InsertEdl = Edicion['inserts'][number];

export const esTerminal = (i: Pick<InsertEdl, 'tipo' | 'asset'>): boolean => i.tipo === 'demo' && i.asset.endsWith('.terminal.json');

/**
 * Caja visible de un insert (como Insert.tsx y Reel.tsx). Pantalla completa → el cuadro entero.
 * Tarjeta: demo de pantalla 1000×625 (horizontal) o 900×1125 (vertical) centrada en (540, 960); terminal 960×1100 en
 * (540, 960); video, imagen o BRAG de 770 de ancho (× caja.escala) centrado en (540, 995), con el alto de caja.h o de la
 * proporción del archivo (`medio`). Sin la proporción, se supone 16:9 (aproximada = true).
 */
export function cajaVisibleInsert(ins: InsertEdl, medio: {ancho: number; alto: number} | null): {caja: CajaVisible; aproximada: boolean} {
	if (ins.layout === 'pantalla-completa') return {caja: {x0: 0, y0: 0, x1: BASE_W, y1: BASE_H}, aproximada: false};
	// Motion flotante: solo la escena (810 × 980 × caja.escala, por defecto centro (540, 740)); tu toma sigue detrás (src/estilo/flotante.ts).
	if (ins.layout === 'flotante') {
		const c = cajaFlotante(ins.caja, ins.motion?.nombre);
		return {caja: {x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1}, aproximada: false};
	}
	// Motion en tarjeta: panel de 810 px (zona cian) con la proporción de su escena, centro y ≈ 940 (src/estilo/motion.ts).
	if (ins.tipo === 'motion') return {caja: cajaMotion('tarjeta', ins.caja), aproximada: false};
	let w: number;
	let h: number;
	let cx: number;
	let cy: number;
	let aproximada = false;
	if (esTerminal(ins)) {
		w = ins.caja?.w ?? 960;
		h = ins.caja?.h ?? 1100;
		cx = ins.caja?.x ?? 540;
		cy = ins.caja?.y ?? 960;
	} else if (ins.tipo === 'demo') {
		const horizontal = (ins.encuadre ?? 'horizontal') === 'horizontal';
		w = ins.caja?.w ?? (horizontal ? 1000 : 900);
		h = ins.caja?.h ?? (horizontal ? 625 : 1125);
		cx = ins.caja?.x ?? 540;
		cy = ins.caja?.y ?? 960;
	} else {
		const ec = ins.caja?.escala ?? 1;
		w = (ins.caja?.w ?? 770) * ec;
		if (ins.caja?.h !== undefined) h = ins.caja.h * ec;
		else if (medio && medio.ancho > 0) h = (w * medio.alto) / medio.ancho;
		else {
			h = (w * 9) / 16;
			aproximada = true;
		}
		cx = ins.caja?.x ?? 540;
		cy = ins.caja?.y ?? 995;
	}
	return {caja: {x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2}, aproximada};
}

// ───────────────────────── zonas ─────────────────────────

/** Franja de subtítulos con el estilo medido: centro y_p10…y_p90 ± (media mayúscula + borde) + margen. */
export function franjaDeEstilo(estilo: EstiloDirector): Franja {
	const f = estilo.franja;
	const medio = f.alto_mayuscula.valor / 2 + f.borde.valor;
	return {
		y0: r1(f.y_p10.valor - medio - f.margen.valor),
		y1: r1(f.y_p90.valor + medio + f.margen.valor),
		fuente: `estilo: ${f.y_p10.fuente}`,
		detalle: `centro ${f.y_p10.valor}–${f.y_p90.valor} ± (${f.alto_mayuscula.valor}/2 + ${f.borde.valor}) + ${f.margen.valor} px`,
	};
}

/**
 * Franja de subtítulos de una edición concreta: el rango de caja.y de sus subtítulos (o estilos.subtitulos.y si lo
 * trae) ± (media mayúscula + borde) + margen. null si la edición no fija dónde van (entonces manda la del estilo).
 */
export function franjaDeEdicion(subtitulos: Edicion['subtitulos'], estilos: Edicion['estilos'] | undefined, margen: number): Franja | null {
	const parcial = (estilos?.subtitulos ?? {}) as Record<string, unknown>;
	const ys = subtitulos.map((s) => s.caja?.y).filter((y): y is number => typeof y === 'number');
	if (typeof parcial.y === 'number') ys.push(parcial.y);
	if (subtitulos.length === 0 || ys.length === 0) return null;
	const est = resolverEstiloSubtitulo(parcial as Parameters<typeof resolverEstiloSubtitulo>[0]);
	const cap = est.tamano_px * candidata(est.fuente).altoMayuscula;
	const medio = cap / 2 + est.borde_px;
	return {
		y0: r1(Math.min(...ys) - medio - margen),
		y1: r1(Math.max(...ys) + medio + margen),
		fuente: 'subtítulos de la edición (caja.y / estilos.subtitulos)',
		detalle: `centro ${r1(Math.min(...ys))}–${r1(Math.max(...ys))} ± (${r1(cap)}/2 + ${est.borde_px}) + ${margen} px`,
	};
}

export function zonaUiDe(estilo: EstiloDirector): ZonaUi {
	const z = estilo.zona_ui;
	return {arriba: z.arriba.valor, abajo: z.abajo.valor, izquierda: z.izquierda.valor, derecha: z.derecha.valor, fuente: `arriba: ${z.arriba.fuente}; lados: ${z.izquierda.fuente}`};
}

/** Barbilla más baja en [t0−0.2, t1+0.2] (con zooms) y cuándo cae. null si no hay cara en la ventana. */
export function peorBarbilla(cara: CaraConsultable, t0: number, t1: number, zooms: readonly ZoomCara[] = []): {y: number; t: number} | null {
	const total = barbillaMax(cara, t0, t1, zooms);
	if (total === null) return null;
	const a = Math.max(0, Math.ceil((Math.min(t0, t1) - 0.2) * FPS - 1e-6));
	const b = Math.min(cara.cuadros.length - 1, Math.floor((Math.max(t0, t1) + 0.2) * FPS + 1e-6));
	for (let j = a; j <= b; j++) {
		const v = barbillaMax(cara, j / FPS, j / FPS, zooms, {margen_s: 0});
		if (v !== null && Math.abs(v - total) < 0.05) return {y: total, t: Math.round((j / FPS) * 100) / 100};
	}
	return {y: total, t: Math.round(((t0 + t1) / 2) * 100) / 100};
}

/**
 * Boca más baja en [t0−0.2, t1+0.2] (con zooms), cuándo cae y si se estimó (cara.json sin boca: barbilla − 0.18 ×
 * alto de la cara). null si no hay cara en la ventana.
 */
export function peorBoca(cara: CaraConsultable, t0: number, t1: number, zooms: readonly ZoomCara[] = []): {y: number; t: number; estimada: boolean} | null {
	const total = bocaMax(cara, t0, t1, zooms);
	if (total === null) return null;
	const estimada = !bocaMedida(cara);
	const a = Math.max(0, Math.ceil((Math.min(t0, t1) - 0.2) * FPS - 1e-6));
	const b = Math.min(cara.cuadros.length - 1, Math.floor((Math.max(t0, t1) + 0.2) * FPS + 1e-6));
	for (let j = a; j <= b; j++) {
		if (!bocaDeCuadro(cara.cuadros[j])) continue;
		const v = bocaMax(cara, j / FPS, j / FPS, zooms, {margen_s: 0});
		if (v !== null && Math.abs(v - total) < 0.05) return {y: total, t: Math.round((j / FPS) * 100) / 100, estimada};
	}
	return {y: total, t: Math.round(((t0 + t1) / 2) * 100) / 100, estimada};
}

/**
 * Zona libre para una capa en [t0, t1]: del borde de arriba (duro: boca máx + 12; preferido: barbilla máx + margen)
 * al tope de la franja de subtítulos. Sin cara: la banda baja de la zona UI (de la mitad del cuadro a la franja).
 */
export function bandaLibre(ctx: ContextoLayout, t0: number, t1: number): Banda {
	// Abajo: el tope de la franja de subtítulos, y nunca más abajo que la zona segura de Reels (y ≤ 1600).
	const y1 = Math.min(ctx.franja.y0, ZONA_SEGURA.capas.y1);
	const margen = ctx.estilo.cabeza.margen_barbilla.valor;
	const margenBoca = ctx.estilo.cabeza.margen_boca.valor;
	const sinCara = (origen: string): Banda => {
		const y0 = Math.max(ctx.zonaUi.arriba, BANDA_BAJA_SIN_CARA);
		return {y0, y1, alto: r1(y1 - y0), barbilla: null, t_barbilla: null, origen, y0_boca: y0, alto_boca: r1(y1 - y0), boca: null, t_boca: null, boca_estimada: false, origen_boca: origen};
	};
	if (!ctx.cara) return sinCara('sin cara.json (no sé dónde va tu cabeza): banda baja de la zona UI');
	// Un cuadro de más a cada lado: el director redondea desde/hasta al milisegundo y eso puede meter un cuadro más
	// en la ventana que revisa validar.ts (R1). Así el layout nunca queda menos conservador que la validación.
	const peor = peorBarbilla(ctx.cara, t0 - 1 / FPS, t1 + 1 / FPS, ctx.zooms);
	const boca = peorBoca(ctx.cara, t0 - 1 / FPS, t1 + 1 / FPS, ctx.zooms);
	if (!peor || !boca) return sinCara('sin cara en la ventana: banda baja de la zona UI');
	const y0 = r1(Math.max(ctx.zonaUi.arriba, peor.y + margen));
	const y0Boca = r1(Math.min(y0, Math.max(ctx.zonaUi.arriba, boca.y + margenBoca)));
	return {
		y0,
		y1,
		alto: r1(y1 - y0),
		barbilla: peor.y,
		t_barbilla: peor.t,
		origen: `barbilla máx ${peor.y} (t=${peor.t} s) + ${margen}`,
		y0_boca: y0Boca,
		alto_boca: r1(y1 - y0Boca),
		boca: boca.y,
		t_boca: boca.t,
		boca_estimada: boca.estimada,
		origen_boca: `boca máx ${boca.y}${boca.estimada ? ' (estimada: barbilla − 0.18 × alto de la cara)' : ''} (t=${boca.t} s) + ${margenBoca}`,
	};
}

/**
 * Dónde va (en y) un bloque de alto `alto` cuyo primer renglón (de alto `altoPrimero`) tiene su centro medido en
 * `yMed` (stickers ≈ 1256, tarjetas ≈ 1284): su lugar de siempre, acotado a la zona libre DURA (borde de arriba ≥ boca
 * + 12, borde de abajo ≤ tope de la franja). Preferencia: si en su lugar tocaría la barbilla (+ margen) y bajándolo sin
 * pasar de su rango medido (hasta que el centro del primer renglón llegue a `yMax`) ya no, se baja. Si no alcanza, se
 * queda en su lugar, encima de la barba (como en tus tomas de cerca). null si no cabe de alto (quien llama lo achica).
 * Devuelve el borde de arriba del bloque.
 */
export function ubicarBloque(alto: number, altoPrimero: number, yMed: number, yMax: number, banda: Banda): {tope: number; sobreBarba: boolean} | null {
	const lo = banda.y0_boca;
	const hi = banda.y1 - alto;
	if (lo > hi + 1e-6) return null;
	let tope = limitar(yMed - altoPrimero / 2, lo, hi);
	const tPref = banda.y0;
	const tMaxRango = Math.max(yMed, yMax) - altoPrimero / 2;
	if (banda.barbilla !== null && tope < tPref - 1e-6 && tPref <= Math.min(hi, tMaxRango) + 1e-6) tope = tPref;
	return {tope, sobreBarba: banda.barbilla !== null && tope < banda.y0 - 0.5};
}

/** Por qué una capa no quedó en su y medida, y si va encima de tu barba (para direccion.md). */
function avisosUbicacion(que: string, yc: number, yMed: number, u: {tope: number; sobreBarba: boolean}, banda: Banda): string[] {
	const avisos: string[] = [];
	if (Math.abs(yc - yMed) > 0.5) {
		const porque = yc < yMed ? 'más arriba, para no tocar la franja de subtítulos' : u.tope <= banda.y0_boca + 0.5 ? 'más abajo, para no taparte la boca' : 'más abajo, para quedar debajo de tu barbilla';
		avisos.push(`${que} va en y=${r1(yc)} y no en la medida ${r1(yMed)} (${porque})`);
	}
	if (u.sobreBarba && banda.boca !== null) avisos.push(`${que} va encima de tu barba, como en tus tomas de cerca: su borde de arriba queda ${r1(u.tope - banda.boca)} px debajo de tu boca`);
	return avisos;
}

/** Contexto del layout para un proyecto (o para pruebas). */
export function crearContexto(op: {cara: CaraConsultable | null; estilo: EstiloDirector; zooms?: ZoomCara[]; franja?: Franja | null; estilos?: Edicion['estilos']; semilla?: string}): ContextoLayout {
	return {
		cara: op.cara,
		zooms: op.zooms ?? [],
		franja: op.franja ?? franjaDeEstilo(op.estilo),
		zonaUi: zonaUiDe(op.estilo),
		estilo: op.estilo,
		estiloTarjeta: resolverEstiloTarjeta(op.estilos?.tarjetas),
		estiloTitular: resolverEstiloTitular(op.estilos?.titular),
		estiloSticker: resolverEstiloSticker(op.estilos?.stickers),
		semilla: op.semilla ?? 'layout',
	};
}

// ───────────────────────── colocar ─────────────────────────

export type PedidoSticker = {
	id?: string;
	t0: number;
	t1: number;
	/** Ancho VISIBLE deseado (la tinta con su borde blanco). Por defecto, el p50 medido. */
	anchoDeseado?: number;
	/** Alto/ancho de lo visible. Si viene `png`, sale de su tinta. */
	aspecto?: number;
	png?: InfoPng;
	/** Escala máxima de su animación (pop = 1). */
	escalaMax?: number;
	/**
	 * Ancho visible mínimo antes de quitarlo (por defecto el p10 medido). Los logos de marca usan `anchoMinimoLogo`: su
	 * primera mención sale achicada en tus tomas de cerca en vez de quitarse.
	 */
	anchoMinimo?: {valor: number; nota: string};
};

/** Piso del ancho de un logo si tu estilo no trae el p10 entre reels del ancho p10 (supuesto, n = 0). */
export const ANCHO_MIN_LOGO_SUPUESTO = 180;

/**
 * Ancho visible mínimo de un LOGO de marca: el p10 entre reels de tu ancho p10 de stickers (los reels donde los pones más
 * chicos; estilo.json → stickers.ancho_px.p10.p10 = 202 px, n = 19). Así el logo de la primera mención de una marca
 * cabe achicado en la zona libre debajo de tu boca de una toma de cerca (~212 px), sin subir nunca de boca + 12 (R1).
 * Sin esa medida: ANCHO_MIN_LOGO_SUPUESTO (180 px, supuesto). Nunca más que el p10 normal.
 */
export function anchoMinimoLogo(estilo: EstiloDirector): {valor: number; nota: string} {
	const m = estilo.sticker.ancho_p10;
	if (typeof m.p10 === 'number' && m.p10 > 0) return {valor: Math.min(m.p10, m.valor), nota: `piso de logos: p10 entre reels de tu ancho p10, n = ${m.n}`};
	return {valor: Math.min(ANCHO_MIN_LOGO_SUPUESTO, m.valor), nota: 'piso de logos: supuesto, sin p10 entre reels'};
}

export type ResultadoSticker = {
	caja: {x: number; y: number; w: number} | null;
	/** Ancho visible / ancho deseado. */
	escala: number;
	visible: CajaVisible | null;
	banda: Banda;
	avisos: string[];
};

/**
 * Coloca un sticker: x = 540 ± una variación pequeña con semilla (dentro de la zona UI); y = su centro medido (≈ 1256)
 * acotado a la zona libre (borde de arriba ≥ boca + 12, de abajo ≤ franja), con la preferencia de quedar debajo de la
 * barbilla si cabe dentro de su rango medido (ver ubicarBloque). Ancho visible = el deseado (p50 medido); se achica
 * hasta el p10 medido (o `anchoMinimo`: el piso de los logos) SOLO si choca con la boca o con la franja; si aún no
 * cabe, caja null con el aviso "se quita".
 */
export function colocarSticker(p: PedidoSticker, ctx: ContextoLayout): ResultadoSticker {
	const avisos: string[] = [];
	const banda = bandaLibre(ctx, p.t0, p.t1);
	const t = p.png?.tinta ? p.png.tinta : null;
	const aspecto = p.png ? (t ? t.h / t.w : p.png.alto / p.png.ancho) : (p.aspecto ?? 1);
	const deseado = p.anchoDeseado ?? ctx.estilo.sticker.ancho_p50.valor;
	const minimo = Math.min(deseado, p.anchoMinimo?.valor ?? ctx.estilo.sticker.ancho_p10.valor);
	const queMinimo = p.anchoMinimo ? p.anchoMinimo.nota : 'p10';
	const m = p.escalaMax ?? 1;
	const anchoUi = ctx.zonaUi.derecha - ctx.zonaUi.izquierda;
	let w = Math.min(deseado, anchoUi / m);
	if (w * aspecto * m > banda.alto_boca) w = banda.alto_boca / (aspecto * m);
	if (w < minimo - 1e-6) {
		avisos.push(
			`no cabe debajo de tu boca: la zona libre mide ${banda.alto_boca} px (${banda.origen_boca}; tope de la franja ${ctx.franja.y0}) y a su ancho mínimo (${queMinimo} ${r1(minimo)} px) mide ${r1(minimo * aspecto * m)} px de alto → se quita`,
		);
		return {caja: null, escala: 0, visible: null, banda, avisos};
	}
	if (w < deseado - 0.5) avisos.push(`achicado a ${r1(w)} px de ancho visible (deseado ${r1(deseado)}) para caber entre tu boca y la franja (${banda.alto_boca} px)`);
	const h = w * aspecto;
	const yMed = ctx.estilo.sticker.centro_y.valor;
	const u = ubicarBloque(h * m, h * m, yMed, ctx.estilo.sticker.centro_y.p90 ?? yMed, banda)!;
	const yc = u.tope + (h * m) / 2;
	avisos.push(...avisosUbicacion('el sticker', yc, yMed, u, banda));
	let xc = BASE_W / 2 + (azarDe(`${ctx.semilla}:${p.id ?? p.t0}`) * 2 - 1) * DESVIO_X_STICKER;
	xc = limitar(xc, ctx.zonaUi.izquierda + (w * m) / 2, ctx.zonaUi.derecha - (w * m) / 2);
	// De la caja visible a la caja del PNG (centro del PNG y su ancho completo).
	const png = p.png ?? {ancho: 1, alto: aspecto, tinta: null};
	const fx = t ? t.x / png.ancho : 0;
	const fy = t ? t.y / png.alto : 0;
	const fw = t ? t.w / png.ancho : 1;
	const fh = t ? t.h / png.alto : 1;
	const W = w / fw;
	const H = (W * png.alto) / png.ancho;
	const dx = (fx + fw / 2 - 0.5) * W;
	const dy = (fy + fh / 2 - 0.5) * H;
	return {
		caja: {x: r1(xc - dx), y: r1(yc - dy), w: r1(W)},
		escala: Math.round((w / deseado) * 1000) / 1000,
		visible: redondearCaja({x0: xc - w / 2, y0: yc - h / 2, x1: xc + w / 2, y1: yc + h / 2}),
		banda,
		avisos,
	};
}

export type PedidoTarjeta = {id?: string; t0: number; t1: number; texto: string; variante?: 'normal' | 'grande' | 'prompt'; escala?: number};
export type ResultadoTarjeta = {caja: {x: number; y: number; escala?: number; w?: number} | null; ancho: number; alto: number; renglones: number; escala: number; banda: Banda; avisos: string[]};

/**
 * Coloca una tarjeta sola: x = 540, y = su centro medido (≈ 1284) acotado a la zona libre (borde de arriba ≥ boca +
 * 12, de abajo ≤ franja), con la preferencia de quedar debajo de la barbilla dentro de su rango medido (p10–p90 del
 * centro en un reel; ver ubicarBloque). Si no cabe de alto entre tu boca y la franja (o de ancho en la zona UI), se
 * achica hasta la escala mínima medida; si aún no cabe, caja null ("se quita").
 */
export function colocarTarjeta(p: PedidoTarjeta, ctx: ContextoLayout): ResultadoTarjeta {
	const avisos: string[] = [];
	const banda = bandaLibre(ctx, p.t0, p.t1);
	const e = ctx.estiloTarjeta;
	const variante = p.variante === 'grande' ? e.escala_grande : 1;
	const sMin = ctx.estilo.tarjeta.escala_min.valor;
	const anchoUi = ctx.zonaUi.derecha - ctx.zonaUi.izquierda;
	// Los prompts tienen su propia geometría (una sola caja alineada a la izquierda): se miden como en Tarjeta.tsx. Su
	// ancho máximo no se achica con la escala, así que si no cabe en la zona UI (la zona segura de Reels: 810 px) se
	// acota ahí con caja.w y el texto se parte en más renglones.
	const wPrompt = p.variante === 'prompt' && e.prompt.ancho_max > anchoUi + 1e-6 ? Math.floor(anchoUi) : undefined;
	const medirTarjeta = (texto: string, est: EstiloTarjeta, escala: number): MedidaTarjeta => {
		if (p.variante !== 'prompt') return medirTarjetaBase(texto, est, escala);
		const m = medirTarjetaEdl({texto, variante: 'prompt', grupo: null, caja: {x: BASE_W / 2, y: 0, escala, ...(wPrompt ? {w: wPrompt} : {})}}, est);
		const lineas = texto.split('\n');
		return {ancho: m.ancho, alto: m.alto, renglones: lineas.length, lineas};
	};
	let s = p.escala ?? 1;
	let m = medirTarjeta(p.texto, e, s * variante);
	while (m.alto > banda.alto_boca + 1e-6 || m.ancho > anchoUi + 1e-6) {
		s = Math.round((s - 0.02) * 100) / 100;
		if (s < sMin - 1e-9) {
			avisos.push(`"${p.texto}" no cabe debajo de tu boca: la zona libre mide ${banda.alto_boca} px (${banda.origen_boca}) y la tarjeta a escala ${sMin} mide ${r1(medirTarjeta(p.texto, e, sMin * variante).alto)} px → se quita`);
			return {caja: null, ancho: 0, alto: 0, renglones: 0, escala: 0, banda, avisos};
		}
		m = medirTarjeta(p.texto, e, s * variante);
	}
	if (s < (p.escala ?? 1)) {
		const porAncho = medirTarjeta(p.texto, e, (p.escala ?? 1) * variante).ancho > anchoUi + 1e-6;
		avisos.push(`"${p.texto}" achicada a escala ${s} ${porAncho ? `para caber a lo ancho en la zona UI (${r1(anchoUi)} px)` : `para caber entre tu boca y la franja (${banda.alto_boca} px)`}`);
	}
	const yMed = ctx.estilo.tarjeta.y.valor;
	const u = ubicarBloque(m.alto, m.alto, yMed, ctx.estilo.tarjeta.y_rango.p90.valor, banda)!;
	const y = u.tope + m.alto / 2;
	avisos.push(...avisosUbicacion(`"${p.texto}"`, y, yMed, u, banda));
	return {caja: {x: BASE_W / 2, y: r1(y), ...(s !== 1 ? {escala: s} : {}), ...(wPrompt ? {w: wPrompt} : {})}, ancho: r1(m.ancho), alto: r1(m.alto), renglones: m.renglones, escala: s, banda, avisos};
}

/**
 * Cómo va una lista: "columna" (una debajo de otra), "arbol" (1 arriba y las demás lado a lado de 2 en 2: tus listas
 * mixtas [1,2], [1,2,1], [1,2,2]), "fila" (todas lado a lado) o "secuencial" (no cabe junta: cada una sola).
 */
export type ModoLista = 'columna' | 'arbol' | 'fila' | 'secuencial';
export type PedidoLista = {id?: string; t0: number; t1: number; textos: string[]};
/** cajas[k].fila: el renglón de la tarjeta k dentro de su grupo (0 = arriba; Tarjeta.fila de la EDL). */
export type ResultadoLista = {modo: ModoLista | null; cajas: Array<{x: number; y: number; escala: number; fila: number}>; escala: number; banda: Banda; avisos: string[]};

/** Renglones de una lista en árbol: 1 arriba y luego de 2 en 2 (n = 3 → [1, 2]; 4 → [1, 2, 1]; 5 → [1, 2, 2]). */
export function filasArbol(n: number): number[][] {
	const filas: number[][] = n > 0 ? [[0]] : [];
	for (let k = 1; k < n; k += 2) filas.push(k + 1 < n ? [k, k + 1] : [k]);
	return filas;
}

/**
 * Coloca una lista (enumeración) con la escala de lista medida: 1) columna, apilada hacia abajo con la separación
 * medida; 2) si no cabe en columna, ÁRBOL (1 arriba y las demás lado a lado: 7 de tus 9 listas medidas son así);
 * 3) si tampoco, FILA (todas lado a lado). Solo si ninguna forma cabe a esa escala se achica (hasta la escala mínima
 * medida) y se prueban otra vez; si nada cabe, "secuencial": cada una sola, a su tiempo (las coloca quien llama con
 * colocarTarjeta). El renglón de arriba va en la y medida de las tarjetas, acotado como una tarjeta (ver
 * ubicarBloque). Devuelve las cajas en el orden de `textos`, con su `fila`.
 */
export function colocarLista(p: PedidoLista, ctx: ContextoLayout): ResultadoLista {
	const avisos: string[] = [];
	const banda = bandaLibre(ctx, p.t0, p.t1);
	const e = ctx.estiloTarjeta;
	const sep = e.separacion_px;
	const sepH = e.separacion_h_px;
	const sLista = ctx.estilo.tarjeta.escala_lista.valor;
	const sMin = ctx.estilo.tarjeta.escala_min.valor;
	const yMed = ctx.estilo.tarjeta.y.valor;
	const yMax = ctx.estilo.tarjeta.y_rango.p90.valor;
	const anchoUi = ctx.zonaUi.derecha - ctx.zonaUi.izquierda;
	const escalas: number[] = [];
	for (let s = sLista; s >= sMin - 1e-9; s = Math.round((s - 0.02) * 100) / 100) escalas.push(s);
	const n = p.textos.length;
	const disposiciones: Array<{modo: ModoLista; filas: number[][]}> = [
		{modo: 'columna', filas: p.textos.map((_, k) => [k])},
		...(n >= 3 ? [{modo: 'arbol' as const, filas: filasArbol(n)}] : []),
		{modo: 'fila', filas: [p.textos.map((_, k) => k)]},
	];
	// Primero la escala medida en las tres formas (columna → árbol → fila); solo si ninguna cabe, se achica.
	for (const s of escalas) {
		const ms = p.textos.map((t) => medirTarjeta(t, e, s));
		for (const d of disposiciones) {
			const renglones = d.filas.map((f) => ({ancho: f.reduce((a, k) => a + ms[k].ancho, 0) + sepH * (f.length - 1), alto: Math.max(...f.map((k) => ms[k].alto))}));
			if (renglones.some((r) => r.ancho > anchoUi + 1e-6)) continue;
			const total = renglones.reduce((a, r) => a + r.alto, 0) + sep * (renglones.length - 1);
			const u = total <= banda.alto_boca + 1e-6 ? ubicarBloque(total, renglones[0].alto, yMed, yMax, banda) : null;
			if (!u) continue;
			if (d.modo !== 'columna') avisos.push(`la lista no cabe apilada entre tu boca y la franja (${banda.alto_boca} px): va ${d.modo === 'arbol' ? 'en árbol (1 arriba y las demás lado a lado, como tus listas mixtas)' : 'en fila, lado a lado'}, a escala ${s}`);
			else if (s < sLista) avisos.push(`la lista se achica a escala ${s} (la medida es ${sLista}) para caber entre tu boca y la franja (${banda.alto_boca} px)`);
			avisos.push(...avisosUbicacion('la lista', u.tope + renglones[0].alto / 2, yMed, u, banda));
			const cajas: ResultadoLista['cajas'] = new Array(n);
			let tope = u.tope;
			d.filas.forEach((f, i) => {
				const r = renglones[i];
				let x = BASE_W / 2 - r.ancho / 2;
				for (const k of f) {
					cajas[k] = {x: r1(x + ms[k].ancho / 2), y: r1(tope + r.alto / 2), escala: s, fila: i};
					x += ms[k].ancho + sepH;
				}
				tope += r.alto + sep;
			});
			return {modo: d.modo, cajas, escala: s, banda, avisos};
		}
	}
	avisos.push(`la lista no cabe junta entre tu boca y la franja (${banda.alto_boca} px) ni en columna, ni en árbol, ni en fila: cada tarjeta va sola, una tras otra`);
	return {modo: 'secuencial', cajas: [], escala: 1, banda, avisos};
}

export type PedidoTitular = {texto: string; t0: number; t1: number};
export type ResultadoTitular = {caja: {x: number; y: number; escala?: number}; visible: CajaVisible; lineas: string[]; cabe: boolean; tapaCabeza: true; cabeza: CajaVisible | null; avisos: string[]};

/**
 * Coloca el titular en la y medida (≈302). Debe quedar ARRIBA de la cabeza (sin tocar la caja de la cabeza de toda su
 * ventana, con un poco de aire): si la coronilla lo invade, lo sube hasta el límite de la zona UI; si aún no cabe, lo
 * achica (hasta ESCALA_MIN_TITULAR). Si ni así cabe, cabe = false y el aviso pide acortarlo.
 */
export function colocarTitular(p: PedidoTitular, ctx: ContextoLayout): ResultadoTitular {
	const avisos: string[] = [];
	const e = ctx.estiloTitular;
	const yMed = ctx.estilo.titular.y.valor;
	const aire = ctx.estilo.cabeza.margen_titular.valor;
	const tope = ctx.zonaUi.arriba;
	// Protege la CARA (de la frente a la barbilla), no la punta del pelo: en tus reels el titular va a su tamaño y a
	// veces roza el pelo, nunca la cara.
	const r = ctx.cara ? cajaCara(ctx.cara, p.t0, p.t1, ctx.zooms) : null;
	const cabeza: CajaVisible | null = r ? {x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h} : null;
	const con = (y: number, k: number) => geometriaTitular({texto: p.texto, caja: {x: BASE_W / 2, y, escala: k}}, e);
	const choca = (c: CajaVisible): boolean => (cabeza ? encimeVertical(c, {...cabeza, y0: cabeza.y0 - aire}) > 0 : false);
	const salida = (y: number, k: number, cabe: boolean): ResultadoTitular => {
		const g = con(y, k);
		return {caja: {x: BASE_W / 2, y: r1(y), ...(k !== 1 ? {escala: k} : {})}, visible: redondearCaja(g.caja), lineas: g.lineas, cabe, tapaCabeza: true, cabeza, avisos};
	};
	if (!ctx.cara) avisos.push('sin cara.json: el titular va en su lugar medido sin revisar la cabeza');
	let g = con(yMed, 1);
	if (!choca(g.caja)) return salida(yMed, 1, true);
	// Subirlo hasta que su borde de abajo quede arriba de la coronilla (con aire), sin pasar el tope de la zona UI.
	const limite = (cabeza as CajaVisible).y0 - aire;
	const ySubido = yMed - (g.caja.y1 - limite);
	g = con(ySubido, 1);
	if (g.caja.y0 >= tope - 1e-6) {
		avisos.push(`tu frente llega a y=${r1((cabeza as CajaVisible).y0)}: subí el titular ${r1(yMed - ySubido)} px (y=${r1(ySubido)})`);
		return salida(ySubido, 1, true);
	}
	// Achicarlo pegado al tope de la zona UI.
	for (let k = 0.98; k >= ESCALA_MIN_TITULAR - 1e-9; k = Math.round((k - 0.02) * 100) / 100) {
		const prueba = con(yMed, k);
		const y = yMed + (tope - prueba.caja.y0);
		const c = con(y, k);
		if (!choca(c.caja)) {
			avisos.push(`tu frente llega a y=${r1((cabeza as CajaVisible).y0)}: el titular sube al tope de la zona UI (${tope}) y se achica a escala ${k}`);
			return salida(y, k, true);
		}
	}
	const k = ESCALA_MIN_TITULAR;
	const prueba = con(yMed, k);
	const y = yMed + (tope - prueba.caja.y0);
	const c = con(y, k);
	avisos.push(`el titular no cabe arriba de tu cabeza ni a escala ${k} (frente en y=${r1((cabeza as CajaVisible).y0)}, tope de la zona UI ${tope}; se enciman ${r1(encimeVertical(c.caja, cabeza as CajaVisible))} px): acórtalo a un renglón`);
	return salida(y, k, false);
}

export type PedidoInsert = {id?: string; t0: number; t1: number; layout: 'tarjeta' | 'pantalla-completa' | 'flotante'; aspecto: number; anchoDeseado?: number; evitar?: CajaVisible[]; meme?: boolean};
export type ResultadoInsert = {caja: {x: number; y: number; w: number; h: number} | null; tapaCabeza: boolean; anchoLegible: number | null; banda: Banda | null; avisos: string[]};

/** Ancho máximo (px) con que un insert de esa proporción cabe debajo de la barbilla y dentro de la zona UI. */
export function anchoLegibleDebajo(ctx: ContextoLayout, t0: number, t1: number, aspecto: number): {ancho: number; banda: Banda} {
	const banda = bandaLibre(ctx, t0, t1);
	const anchoUi = ctx.zonaUi.derecha - ctx.zonaUi.izquierda;
	return {ancho: r1(Math.max(0, Math.min(anchoUi, banda.alto / aspecto))), banda};
}

/**
 * Coloca un insert. Pantalla completa: sin restricción (caja null). Tarjeta: si cabe debajo de la barbilla con un ancho
 * legible ≥ 70 % (756 px), va ahí (tapaCabeza = false); si no, tapaCabeza = true (excepción 1 del plan) en el lugar
 * medido (540, 995) con su ancho medido, sin cruzar la franja ni las cajas de `evitar` (el titular). Meme
 * (p.meme): siempre tapa la cara, en la caja de src/estilo/memes.ts (centro y 940, ancho 800 ≤ 810).
 */
export function colocarInsert(p: PedidoInsert, ctx: ContextoLayout): ResultadoInsert {
	const avisos: string[] = [];
	if (p.layout === 'pantalla-completa') return {caja: null, tapaCabeza: false, anchoLegible: null, banda: null, avisos};
	// Flotante (solo motion): flota encima de tu toma desenfocada en su lugar por defecto; no cuenta como tapar tu cabeza.
	if (p.layout === 'flotante') return {caja: null, tapaCabeza: false, anchoLegible: null, banda: null, avisos};
	if (p.meme) {
		// Meme de reacción (src/estilo/memes.ts): tapa tu cara a propósito, como en tus reels; ancho ≤ 810 (zona cian).
		const techo = Math.max(ctx.zonaUi.arriba, ...(p.evitar ?? []).map((c) => c.y1 + 20));
		const m = cajaMeme({aspecto: p.aspecto, ancho: p.anchoDeseado, techo, piso: ctx.franja.y0});
		if (m.achicado) avisos.push(`meme: se achica a ${m.w} px de ancho para no cruzar la franja ni el titular`);
		return {caja: {x: m.x, y: m.y, w: m.w, h: m.h}, tapaCabeza: true, anchoLegible: null, banda: null, avisos};
	}
	const minimo = ctx.estilo.cabeza.ancho_legible_min.valor;
	const {ancho, banda} = anchoLegibleDebajo(ctx, p.t0, p.t1, p.aspecto);
	const deseado = p.anchoDeseado ?? ctx.estilo.insert.ancho.valor;
	if (ctx.cara && ancho >= minimo) {
		const w = Math.min(deseado, ancho);
		const h = w * p.aspecto;
		const y = (banda.y0 + banda.y1) / 2;
		return {caja: {x: BASE_W / 2, y: r1(y), w: r1(w), h: r1(h)}, tapaCabeza: false, anchoLegible: r1(ancho / BASE_W), banda, avisos};
	}
	if (ctx.cara) avisos.push(`debajo de tu barbilla solo cabe a ${ancho} px de ancho (${r1((100 * ancho) / BASE_W)} % < 70 %): va arriba y tapa la cabeza (tapaCabeza = true)`);
	else avisos.push('sin cara.json: el insert va en su lugar medido y se marca tapaCabeza = true');
	const techo = Math.max(ctx.zonaUi.arriba, ...(p.evitar ?? []).map((c) => c.y1 + 20));
	const piso = ctx.franja.y0;
	let w = deseado;
	let h = w * p.aspecto;
	if (h > piso - techo) {
		h = piso - techo;
		w = h / p.aspecto;
		avisos.push(`se achica a ${r1(w)} px de ancho para no cruzar la franja ni el titular`);
	}
	const y = limitar(ctx.estilo.insert.y.valor, techo + h / 2, piso - h / 2);
	return {caja: {x: BASE_W / 2, y: r1(y), w: r1(w), h: r1(h)}, tapaCabeza: true, anchoLegible: ctx.cara ? r1(ancho / BASE_W) : null, banda, avisos};
}

// ───────────────────────── CLI de diagnóstico ─────────────────────────

const USO = 'npx tsx herramientas/layout.ts <slug> [--version N] [--cada S] [--json]';

function leerJson(ruta: string, que: string): unknown {
	try {
		return JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(que, `${relative(RAIZ, ruta)} no es JSON válido`, 'vuelve a correr la etapa que lo genera', 2, error);
	}
}

async function main(): Promise<void> {
	let valores: {version?: string; cada?: string; json?: boolean; ayuda?: boolean};
	let posicionales: string[];
	try {
		({values: valores, positionals: posicionales} = parseArgs({allowPositionals: true, options: {version: {type: 'string'}, cada: {type: 'string'}, json: {type: 'boolean', default: false}, ayuda: {type: 'boolean', short: 'h', default: false}}}));
	} catch (error) {
		throw fallo('leer los argumentos', 'no conozco alguna opción', `usa ${USO}`, 2, error);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	const slug = posicionales[0];
	if (!slug) throw fallo('revisar el layout', 'falta el slug', `usa ${USO}`, 2);
	if (!esSlugValido(slug)) throw fallo('revisar el layout', `"${slug}" no es un slug válido`, `usa ${REGLA_SLUG}`, 2);
	const dir = join(DIR_PROYECTOS, slug);
	if (!existsSync(dir)) throw fallo('revisar el layout', `no existe proyectos/${slug}`, 'revisa el slug', 2);
	const cada = valores.cada ? Number(valores.cada) : 1;
	if (!(cada > 0)) throw fallo('revisar el layout', `--cada ${valores.cada} no es un número de segundos`, 'usa p. ej. --cada 1', 2);

	const {estilo, avisos} = leerEstiloDirector();
	const rutaCara = join(dir, 'cara.json');
	const cara = existsSync(rutaCara) ? leerCara(rutaCara) : null;
	const rutaSubs = join(dir, 'subtitulos.json');
	const subs = existsSync(rutaSubs) ? (leerJson(rutaSubs, 'leer los subtítulos') as {subtitulos?: Edicion['subtitulos']; estilo?: Record<string, unknown>}) : null;
	const franjaSubs = subs ? franjaDeEdicion(subs.subtitulos ?? [], {subtitulos: subs.estilo} as Edicion['estilos'], estilo.franja.margen.valor) : null;
	const ctx = crearContexto({cara, estilo, franja: franjaSubs, semilla: slug});
	const duracion = cara?.duracion_s ?? 0;

	const filas: Array<{t: number; barbilla: number | null; boca: number | null; banda: number; banda_boca: number; cabe: string}> = [];
	// Alto/ancho de la tinta de cada tipo (catálogos de stickers): letrero 292/940, mascota con laptop 488/940,
	// mascota de frente 776/940, logo tile 600/600. Tarjeta de 1 renglón: 117.8 px a escala 1. Lo que cabe se mide en la
	// zona libre debajo de tu boca (el límite duro), a su ancho p50 y, si no, al p10.
	const altoTarjeta = medirTarjeta('Opus 5.5', ctx.estiloTarjeta, 1).alto;
	const escalaMin = estilo.tarjeta.escala_min.valor;
	for (let t = 0; t < duracion; t += cada) {
		const b = bandaLibre(ctx, t, Math.min(duracion, t + cada));
		const cabe: string[] = [];
		const p10 = estilo.sticker.ancho_p10.valor;
		const p50 = estilo.sticker.ancho_p50.valor;
		const s = b.alto_boca / altoTarjeta;
		if (s >= 1) cabe.push('tarjeta');
		else if (s >= escalaMin) cabe.push(`tarjeta a escala ${Math.floor(s * 100) / 100}`);
		for (const [nombre, k] of [['letrero', 292 / 940], ['mascota con laptop', 488 / 940], ['mascota de frente', 776 / 940], ['logo tile', 1]] as const) {
			if (b.alto_boca >= p50 * k) cabe.push(nombre);
			else if (b.alto_boca >= p10 * k) cabe.push(`${nombre} achicado`);
			else if (nombre === 'logo tile' && b.alto_boca >= anchoMinimoLogo(estilo).valor * k) cabe.push('logo tile al piso de logos');
		}
		filas.push({t: r1(t), barbilla: b.barbilla, boca: b.boca, banda: b.alto, banda_boca: b.alto_boca, cabe: cabe.join(', ') || 'nada'});
	}
	// Titular: el de direccion.json; si no hay, el borrador del gancho.
	let textoTitular: string | null = null;
	const rutaDireccion = join(dir, 'direccion.json');
	if (existsSync(rutaDireccion)) textoTitular = ((leerJson(rutaDireccion, 'leer la dirección') as {titular?: {texto?: string} | null}).titular?.texto ?? null) as string | null;
	const rutaTb = join(dir, 'transcripcion-base.json');
	if (!textoTitular && existsSync(rutaTb)) textoTitular = borradorTitular(((leerJson(rutaTb, 'leer la transcripción') as {palabras?: Palabra[]}).palabras ?? []))?.texto ?? null;
	const titular = textoTitular ? colocarTitular({texto: textoTitular, t0: 0, t1: duracion || 1}, ctx) : null;
	const informe: Record<string, unknown> = {
		slug,
		franja: ctx.franja,
		franja_estilo: franjaDeEstilo(estilo),
		zona_ui: ctx.zonaUi,
		cara: cara ? {cobertura: r1(cobertura(cara) * 100), coronilla_min: coronillaMin(cara, 0, duracion), barbilla_max: barbillaMax(cara, 0, duracion), boca_max: bocaMax(cara, 0, duracion), boca_medida: bocaMedida(cara)} : null,
		titular: titular ? {texto: textoTitular, caja: titular.caja, visible: titular.visible, cabe: titular.cabe, avisos: titular.avisos} : null,
		banda_por_tiempo: filas,
		avisos,
	};

	const versiones = readdirSync(dir)
		.map((n) => /^edicion-v(\d+)\.json$/.exec(n)?.[1])
		.filter((v): v is string => v !== undefined)
		.map(Number)
		.sort((a, b) => a - b);
	const version = valores.version ? Number(valores.version) : versiones.at(-1);
	if (version !== undefined && existsSync(join(dir, `edicion-v${version}.json`))) {
		const {validarEdicion} = await import('./validar.ts');
		const r = validarEdicion(leerJson(join(dir, `edicion-v${version}.json`), 'leer la edición'));
		informe.edicion = {version, hallazgos: r.hallazgos, reglas: r.reglas, capas: r.capas};
	}

	if (valores.json) {
		console.log(JSON.stringify(informe, null, '\t'));
		return;
	}
	console.log(`Layout de ${slug}`);
	console.log(`  Franja de subtítulos: ${ctx.franja.y0}–${ctx.franja.y1} (${ctx.franja.fuente}: ${ctx.franja.detalle})`);
	console.log(`  Zona UI: arriba ${ctx.zonaUi.arriba} · abajo ${ctx.zonaUi.abajo} · lados ${r1(ctx.zonaUi.izquierda)}–${r1(ctx.zonaUi.derecha)}`);
	console.log(`  Ancho de sticker: p10 ${textoMedida(estilo.sticker.ancho_p10)} · p50 ${textoMedida(estilo.sticker.ancho_p50)}`);
	if (cara) console.log(`  Cara: cobertura ${r1(cobertura(cara) * 100)} % · boca máx ${bocaMax(cara, 0, duracion)}${bocaMedida(cara) ? '' : ' (estimada: cara.json sin boca; corre cara.ts --forzar)'} · barbilla máx ${barbillaMax(cara, 0, duracion)} · coronilla mín ${coronillaMin(cara, 0, duracion)}`);
	else console.log('  Cara: no hay cara.json (corre npx tsx herramientas/cara.ts <slug>)');
	if (titular) console.log(`  Titular «${textoTitular!.replace(/\n/g, ' / ')}»: y=${titular.caja.y}${titular.caja.escala ? ` escala ${titular.caja.escala}` : ''} · caja ${JSON.stringify(titular.visible)}${titular.avisos.length ? ` · ${titular.avisos.join('; ')}` : ''}`);
	console.log(`  Zona libre por tiempo (debajo de tu boca + ${estilo.cabeza.margen_boca.valor}: el límite; debajo de tu barbilla + ${estilo.cabeza.margen_barbilla.valor}: la preferencia):`);
	for (const f of filas) console.log(`    t=${String(f.t).padStart(5)} s  boca ${f.boca ?? '—'}  barbilla ${f.barbilla ?? '—'}  debajo de la boca ${String(f.banda_boca).padStart(6)} px  debajo de la barbilla ${String(f.banda).padStart(6)} px  cabe: ${f.cabe}`);
	if (informe.edicion) {
		const ed = informe.edicion as {version: number; hallazgos: Array<{regla: string; donde: string; detalle: string}>; reglas: Array<{regla: string; estado: string; detalle: string}>};
		console.log(`  Edición v${ed.version}:`);
		for (const r of ed.reglas) console.log(`    ${r.regla} ${r.estado}: ${r.detalle}`);
		for (const h of ed.hallazgos) console.log(`    - [${h.regla}] ${h.donde}: ${h.detalle}`);
	}
	for (const a of avisos) console.log(`  Aviso: ${a}`);
}

if (esPrincipal(import.meta.url)) void correr(main);
