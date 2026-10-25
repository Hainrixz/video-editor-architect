// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * vivo.ts: arma una versión NUEVA de un reel con el estilo "texto vivo" (estilo/estilos/estilo-texto-vivo/) a partir de
 * una versión ya hecha y de las notas de ese estilo. Nunca sobrescribe: escribe la siguiente edicion-vN.json libre.
 *
 *   npx tsx herramientas/vivo.ts <slug> --desde N [--notas proyectos/<slug>/notas-director.estilo-texto-vivo.json]
 *
 * Qué hace (todo determinista; lo creativo, qué texto va y cuándo, lo decide Claude en las notas):
 *   1. Subtítulos de 1–2 palabras (parte los de 3 por la pausa más larga) pegados a tu pecho: x = centro de tu cabeza,
 *      y = barbilla + dy_barbilla (mediana del tramo, cara.json). Si ese tramo comparte pantalla con un sticker, un prompt
 *      o un meme, bajan a la y del estilo (como en el oficial); sobre una demo a pantalla completa quedan "normales".
 *   2. Palabras clave (notas.clave) → resaltar_palabras: van en serif itálica amarilla.
 *   3. Elementos (notas.elementos): tiempos por palabra ("Emil#1": la 1.ª vez que lo dices; desde_palabra usa su
 *      inicio y hasta_palabra su final), posición fija o `ancla` a tu cabeza (coronilla, barbilla o cara, + dx/dy; con
 *      ancla.x la x queda fija y solo la y te sigue),
 *      metidos en la zona segura, y su SFX (solo tus Foleys) en sfx_extra.
 *   4. Quita las tarjetas normales (el resaltado ahora va en el subtítulo; los prompts se quedan) y los stickers que
 *      digan las notas (por texto de su asset).
 *
 * Códigos: 0 bien · 1 fallo interno · 2 falta algo (versión, notas, cara.json).
 */
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {EdicionValidada, type Edicion} from '../src/esquema/edicion';
import {cajaElemento, ElementoVivo, SubtitulosVivos, type CajaVivo} from '../src/estilo/texto-vivo';
import {esMeme} from '../src/estilo/memes';
import {ZONA_SEGURA} from '../src/estilo/zona-segura';
import {correr, esPrincipal, fallo} from './lib/fallo';
import {dirProyecto, RAIZ} from './lib/manifest';

type Sub = Edicion['subtitulos'][number];
type Palabra = Sub['palabras'][number];
export type CuadroCara = {t: number; cara?: {x: number; y: number; w: number; h: number} | null; barbilla_y?: number; coronilla_y?: number; boca_y?: number; cabeza?: {x: number; w: number} | null};

const r1 = (x: number) => Math.round(x * 10) / 10;
const mediana = (xs: number[]): number => {
	const a = [...xs].sort((p, q) => p - q);
	const m = Math.floor(a.length / 2);
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const normal = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}%]/gu, '');

/** Parte cada subtítulo en trozos de ≤ max palabras por su pausa más larga. Ids: s7 → s7a, s7b. Puro. */
export function reagrupar(subs: readonly Sub[], max = 2): Sub[] {
	const out: Sub[] = [];
	for (const s of subs) {
		if (s.palabras.length <= max) {
			out.push(s);
			continue;
		}
		const ps = s.palabras;
		// Corte en la pausa más larga entre palabras (a igualdad, deja la palabra corta pegada a la siguiente).
		let mejor = 1;
		let pausa = -Infinity;
		for (let k = 1; k < ps.length; k++) {
			if (k > max || ps.length - k > max) continue;
			const p = ps[k].d - ps[k - 1].h + (ps[k - 1].t.length <= 3 ? -0.05 : 0);
			if (p > pausa) {
				pausa = p;
				mejor = k;
			}
		}
		const a = ps.slice(0, mejor);
		const b = ps.slice(mejor);
		const corte = Math.max(s.desde + 4 / 30, Math.min(s.hasta - 4 / 30, b[0].d));
		out.push({...s, id: `${s.id}a`, hasta: corte, palabras: a});
		out.push({...s, id: `${s.id}b`, desde: corte, palabras: b});
	}
	return out;
}

/** Todas las palabras del reel en orden. */
export const palabrasDe = (subs: readonly Sub[]): Palabra[] => subs.flatMap((s) => s.palabras);

/** "Emil#2" → la 2.ª palabra que es "Emil" (sin acentos ni signos). Puro. */
export function buscarPalabra(palabras: readonly Palabra[], ref: string): Palabra {
	const [texto, n] = ref.split('#');
	const objetivo = normal(texto);
	const hits = palabras.filter((p) => normal(p.t) === objetivo);
	const p = hits[(Number(n) || 1) - 1];
	if (!p) throw fallo('ubicar una palabra', `no encontré "${ref}" (la dices ${hits.length} veces)`, 'revisa el texto en los subtítulos de la versión de origen', 2);
	return p;
}

/** Mediana de tu cabeza en [desde, hasta): centro x, coronilla, barbilla, centro y de la cara y boca. null sin cara. */
export function cabezaEnTramo(cuadros: readonly CuadroCara[], desde: number, hasta: number): {cx: number; coronilla: number; barbilla: number; cy: number; boca: number} | null {
	const q = cuadros.filter((c) => c.t >= desde - 1e-6 && c.t < hasta && c.cara && c.cara.w > 0);
	if (!q.length) return null;
	return {
		cx: mediana(q.map((c) => c.cara!.x + c.cara!.w / 2)),
		coronilla: mediana(q.map((c) => c.coronilla_y ?? c.cara!.y - 0.3 * c.cara!.h)),
		barbilla: Math.max(...q.map((c) => c.barbilla_y ?? c.cara!.y + c.cara!.h)),
		cy: mediana(q.map((c) => c.cara!.y + c.cara!.h / 2)),
		boca: Math.max(...q.map((c) => c.boca_y ?? c.cara!.y + 0.8 * c.cara!.h)),
	};
}

/** Corrimiento para meter una caja en la zona [x0,x1]×[y0,y1] (si no cabe, la centra). Puro. */
export function meterEnZona(caja: CajaVivo, zona: CajaVivo): {dx: number; dy: number} {
	const ajuste = (a0: number, a1: number, z0: number, z1: number) => (a1 - a0 > z1 - z0 ? (z0 + z1) / 2 - (a0 + a1) / 2 : a0 < z0 ? z0 - a0 : a1 > z1 ? z1 - a1 : 0);
	return {dx: ajuste(caja.x0, caja.x1, zona.x0, zona.x1), dy: ajuste(caja.y0, caja.y1, zona.y0, zona.y1)};
}

export const NotasVivo = {
	parse(datos: unknown) {
		const d = datos as Record<string, unknown>;
		if (!d || typeof d !== 'object' || !Array.isArray(d.elementos)) throw fallo('leer las notas del estilo', 'falta la lista "elementos"', 'revisa notas-director.estilo-texto-vivo.json', 2);
		return d as {
			estilo?: string;
			persona?: string | null;
			subtitulos?: Record<string, unknown> & {max_palabras?: number; dy_barbilla?: number; y_min?: number};
			clave?: string[];
			quitar_stickers?: string[];
			quitar_tarjetas?: 'normales' | 'ninguna';
			/**
			 * "ninguna" (decisión del estilo: un estilo independiente, sin mezclar con el oficial):
			 * de la versión de origen solo quedan la toma, la demo y los prompts (restilizados con `estilo_tarjetas`); fuera
			 * stickers, memes, tarjetas normales, perfil de X y sus SFX. "oficial" (por defecto): parte del oficial.
			 */
			base?: 'oficial' | 'ninguna';
			/** Cambios al estilo de las tarjetas (los prompts), p. ej. la tarjeta oscura de Meg. */
			estilo_tarjetas?: Record<string, unknown>;
			/** Ids de stickers, tarjetas o inserts que se quedan sin SFX (para la variedad y el silencio de R6). */
			sin_sfx?: string[];
			elementos: Array<Record<string, unknown>>;
		};
	},
};

const TIEMPO_SFX = {ganancia_db: -14, offset_frames: 0, variante: 0};

/** Arma la EDL nueva. Puro (recibe la edición de origen, las notas y los cuadros de cara.json). */
export function armarVivo(origen: Edicion, notasCrudas: unknown, cuadros: readonly CuadroCara[]): Edicion {
	const notas = NotasVivo.parse(notasCrudas);
	const e: Edicion = structuredClone(origen);
	const estiloSub = (e.estilos?.subtitulos ?? {}) as {y?: number};
	const yFija = estiloSub.y ?? 1545;
	const palabras = palabrasDe(origen.subtitulos);

	const independiente = notas.base === 'ninguna';
	if (independiente) {
		e.stickers = [];
		e.inserts = e.inserts.filter((i) => !esMeme(i.asset));
		e.sfx_extra = [];
	}
	if (notas.estilo_tarjetas) e.estilos = {...e.estilos, tarjetas: {...(e.estilos?.tarjetas ?? {}), ...notas.estilo_tarjetas} as NonNullable<Edicion['estilos']>['tarjetas']};

	// 4. Quitar tarjetas normales y stickers.
	if ((notas.quitar_tarjetas ?? 'normales') === 'normales') e.tarjetas = e.tarjetas.filter((t) => t.variante === 'prompt');
	const quitar = notas.quitar_stickers ?? [];
	e.stickers = e.stickers.filter((s) => !quitar.some((q) => s.asset.includes(q) || s.id === q));

	const sinSfx = new Set(notas.sin_sfx ?? []);
	for (const x of [...e.stickers, ...e.tarjetas, ...e.inserts]) if (sinSfx.has(x.id)) x.sfx = null;

	// 3. Elementos.
	const tiempo = (v: unknown, palabra: unknown, lado: 'd' | 'h'): number => {
		if (typeof v === 'number') return v;
		if (typeof palabra === 'string') return buscarPalabra(palabras, palabra)[lado];
		throw fallo('ubicar un elemento', 'le falta desde/hasta (segundos) o desde_palabra/hasta_palabra', 'revisa las notas', 2);
	};
	const elementos = [];
	for (const crudo of notas.elementos) {
		const {desde_palabra, hasta_palabra, ancla, sfx, ...resto} = crudo as Record<string, unknown> & {ancla?: {a: 'coronilla' | 'barbilla' | 'cara'; dx?: number; dy?: number; x?: number}; sfx?: string};
		const desde = tiempo(resto.desde, desde_palabra, 'd');
		const hasta = tiempo(resto.hasta, hasta_palabra, 'h');
		const el: Record<string, unknown> = {...resto, desde: r1(desde * 1000) / 1000, hasta: r1(hasta * 1000) / 1000};
		if (Array.isArray(resto.lineas)) el.lineas = (resto.lineas as Array<Record<string, unknown>>).map(({en_palabra, ...l}) => (typeof en_palabra === 'string' ? {...l, en: buscarPalabra(palabras, en_palabra).d} : l));
		if (resto.contenido && typeof (resto.contenido as {en_palabra?: string}).en_palabra === 'string') {
			const {en_palabra, ...c} = resto.contenido as {en_palabra: string};
			el.contenido = {...c, en: buscarPalabra(palabras, en_palabra).d};
		}
		if (ancla) {
			const k = cabezaEnTramo(cuadros, desde, hasta);
			if (!k) throw fallo('anclar un elemento a tu cabeza', `no hay cara en ${desde.toFixed(2)}–${hasta.toFixed(2)} s (${String(resto.id)})`, 'dale x/y fijos en las notas', 2);
			const ref = ancla.a === 'coronilla' ? k.coronilla : ancla.a === 'barbilla' ? k.barbilla : k.cy;
			el.x = r1(ancla.x ?? k.cx + (ancla.dx ?? 0));
			el.y = r1(ref + (ancla.dy ?? 0));
		}
		const parsed = ElementoVivo.parse(el);
		const {dx, dy} = meterEnZona(cajaElemento(parsed), ZONA_SEGURA.capas);
		if ('x' in parsed && (dx || dy)) {
			(parsed as {x: number}).x = r1(parsed.x + dx);
			(parsed as {y: number}).y = r1(parsed.y + dy);
		}
		elementos.push(parsed);
		if (sfx) e.sfx_extra.push({en: parsed.desde, sfx: {asset: `biblioteca/sfx/${sfx}`, ...TIEMPO_SFX}});
	}
	e.sfx_extra.sort((a, b) => a.en - b.en);

	// 1. Subtítulos vivos.
	const op = notas.subtitulos ?? {};
	const max = op.max_palabras ?? 2;
	const dy = op.dy_barbilla ?? 115;
	const subs = reagrupar(origen.subtitulos, max);
	const normales: string[] = [];
	const ocupan = [
		...e.stickers.map((s) => ({desde: s.desde, hasta: s.hasta})),
		...e.tarjetas.map((t) => ({desde: t.desde, hasta: t.hasta})),
		...e.inserts.filter((i) => i.layout === 'tarjeta').map((i) => ({desde: i.desde, hasta: i.hasta})),
	];
	const completa = e.inserts.filter((i) => i.layout === 'pantalla-completa');
	e.subtitulos = subs.map((s) => {
		const cruza = (x: {desde: number; hasta: number}) => x.desde < s.hasta - 1e-6 && s.desde < x.hasta - 1e-6;
		if (completa.some(cruza)) {
			if (!independiente) normales.push(s.id);
			return {...s, caja: {...(s.caja ?? {x: 540}), x: 540, y: yFija}};
		}
		const k = cabezaEnTramo(cuadros, s.desde, s.hasta);
		if (!k || ocupan.some(cruza)) return {...s, caja: {...(s.caja ?? {x: 540}), x: 540, y: yFija}};
		const y = Math.min(yFija, Math.max(op.y_min ?? 1150, k.barbilla + dy));
		// x: el centro de tu cabeza, a medio camino del centro de la pantalla (que no se pegue a la orilla).
		const x = Math.min(800, Math.max(280, (k.cx + 540) / 2));
		return {...s, caja: {...(s.caja ?? {x: 540}), x: r1(x), y: r1(y)}};
	});

	// 2. Palabras clave.
	const clave = new Set((notas.clave ?? []).map(normal));
	e.resaltar_palabras = palabrasDe(e.subtitulos)
		.filter((p) => clave.has(normal(p.t)))
		.map((p) => p.i);

	const {max_palabras: _m, dy_barbilla: _d, y_min: _y, ...opSub} = op;
	e.texto_vivo = {
		persona: notas.persona ?? null,
		subtitulos: SubtitulosVivos.parse({...opSub, normales}),
		elementos,
	};
	return EdicionValidada.parse(e);
}

/** Siguiente edicion-vN.json libre. */
export function siguienteVersion(dir: string): number {
	const vs = readdirSync(dir)
		.map((f) => /^edicion-v(\d+)\.json$/.exec(f)?.[1])
		.filter((v): v is string => !!v)
		.map(Number);
	return (vs.length ? Math.max(...vs) : 0) + 1;
}

async function main(): Promise<void> {
	const {values: v, positionals: pos} = parseArgs({allowPositionals: true, options: {desde: {type: 'string'}, notas: {type: 'string'}}});
	const uso = 'npx tsx herramientas/vivo.ts <slug> --desde N [--notas <json>]';
	if (pos.length !== 1 || !v.desde) throw fallo('leer los argumentos', 'faltan el slug o --desde', `usa ${uso}`, 2);
	const slug = pos[0];
	const dir = dirProyecto(slug);
	const origen = join(dir, `edicion-v${v.desde}.json`);
	const notas = v.notas ?? join(dir, 'notas-director.estilo-texto-vivo.json');
	const caraRuta = join(dir, 'cara.json');
	for (const r of [origen, notas, caraRuta]) if (!existsSync(r)) throw fallo('armar el texto vivo', `no existe ${relative(RAIZ, r)}`, 'revisa la versión, las notas o corre herramientas/cara.ts', 2);
	const e = EdicionValidada.parse(JSON.parse(readFileSync(origen, 'utf8')));
	const cara = JSON.parse(readFileSync(caraRuta, 'utf8')) as {cuadros: CuadroCara[]};
	const nueva = armarVivo(e, JSON.parse(readFileSync(notas, 'utf8')), cara.cuadros);
	const n = siguienteVersion(dir);
	const destino = join(dir, `edicion-v${n}.json`);
	writeFileSync(destino, `${JSON.stringify(nueva, null, '\t')}\n`, {flag: 'wx'});
	const tv = nueva.texto_vivo!;
	console.log(
		`Listo: ${relative(RAIZ, destino)} (desde v${v.desde}) · ${tv.elementos.length} elementos vivos · ${nueva.subtitulos.length} subtítulos (${tv.subtitulos?.normales.length ?? 0} normales) · ${nueva.resaltar_palabras.length} palabras clave · ${nueva.tarjetas.length} tarjetas · ${nueva.stickers.length} stickers`,
	);
}

if (esPrincipal(import.meta.url)) await correr(main);
