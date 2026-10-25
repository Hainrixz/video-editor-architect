// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Estilo "texto vivo" (estilo/estilos/estilo-texto-vivo/, en prueba desde el 2026-10-04): se ve al creador, el texto
 * lo sigue y a la vez hay titulares, texto alrededor, muchas animaciones de texto y otros elementos que aparecen. Las
 * referencias (perfiles de otros creadores) están en el perfil de ese estilo.
 *
 * Aquí viven el contrato de la capa `texto_vivo` de la EDL y su geometría (la misma para el render, src/reel/TextoVivo.tsx,
 * y para validar.ts). Las posiciones son absolutas en px base 1080×1920: quien dirige (Claude, con cara.json) las
 * calcula para que el texto vaya pegado a ti en cada toma. Puro: sin React, sin Remotion y sin Node.
 */
import {z} from 'zod';

const segundos = z.number().nonnegative();

/**
 * Voces de texto (todas OFL-1.1, de google/fonts en el commit de src/estilo/fuentes.ts; biblioteca/fuentes/bajar-vivo.sh):
 *  - sans: Inter Bold, blanca (los titulares y subtítulos de Meg).
 *  - serif: Instrument Serif Italic, amarilla (su palabra clave: "get claude / to edit").
 *  - mano: Caveat Bold, blanca (su nota "i'm literally just a mom" con flecha).
 *  - impacto: Anton, con degradado y relieve (los "CLAUDE CODE" / "DAY 5" de Forseth).
 * `ancho_em`: ancho medio de un carácter en em, medido con fonttools (hmtx) sobre "mejora el diseño de tu página"
 * (en mayúsculas para Anton) el 2026-10-04: Inter 0.492, Instrument Serif 0.366, Caveat 0.339, Anton 0.416; aquí
 * con +5 % de margen (Inter +6 %: va sin espaciado negativo). Sirve para las cajas de validar.ts y para achicar un
 * titular que no cabe; el render usa la fuente real. alto_mayuscula: OS/2 sCapHeight / unitsPerEm.
 */
export const VOCES = {
	sans: {familia: 'Vivo Inter', ruta: 'biblioteca/fuentes/inter/Inter-Bold.ttf', peso: 700, estilo: 'normal', ancho_em: 0.52, alto_mayuscula: 0.728},
	serif: {familia: 'Vivo Instrument Serif', ruta: 'biblioteca/fuentes/instrument-serif/InstrumentSerif-Italic.ttf', peso: 400, estilo: 'italic', ancho_em: 0.385, alto_mayuscula: 0.72},
	mano: {familia: 'Vivo Caveat', ruta: 'biblioteca/fuentes/caveat/Caveat-Bold.ttf', peso: 700, estilo: 'normal', ancho_em: 0.356, alto_mayuscula: 0.61},
	impacto: {familia: 'Vivo Anton', ruta: 'biblioteca/fuentes/anton/Anton-Regular.ttf', peso: 400, estilo: 'normal', ancho_em: 0.437, alto_mayuscula: 0.859},
} as const;
export type Voz = keyof typeof VOCES;
export const VozEsquema = z.enum(['sans', 'serif', 'mano', 'impacto']);

/** Colores medidos a ojo en las hojas de las referencias (N/A medido fino: no corrimos medir.ts sobre ellas). */
export const COLORES_VIVO = {texto: '#FFFFFF', clave: '#F6E27F', pildora: '#0B0B0C', borde_pildora: 'rgba(255,255,255,0.14)', impacto: ['#FFE45C', '#F29A0E'] as const, relieve: '#7A2C05'};

export const LineaViva = z.object({
	texto: z.string().min(1),
	voz: VozEsquema.default('sans'),
	color: z.string().optional(),
	/** Segundo (absoluto) en que entra esta línea; sin valor, con el bloque (escalonada 4 cuadros). */
	en: segundos.optional(),
});

const comun = {id: z.string().min(1), desde: segundos, hasta: segundos};

/** Titular por frase (no fijo todo el video). Con `detras`, tu silueta (persona.webm) se dibuja encima: queda detrás de ti. */
export const TitularVivo = z.object({
	...comun,
	tipo: z.literal('titular'),
	lineas: z.array(LineaViva).min(1).max(4),
	/** Centro del bloque. */
	x: z.number().default(540),
	y: z.number(),
	tamano_px: z.number().positive().default(122),
	ancho_max: z.number().positive().default(800),
	detras: z.boolean().default(true),
	entrada: z.enum(['subir', 'palabra', 'pop']).default('subir'),
});

/** Titular de impacto (Forseth): línea chica arriba y palabra gruesa con degradado, relieve y rebote. */
export const Impacto = z.object({
	...comun,
	tipo: z.literal('impacto'),
	arriba: z.string().min(1).nullable().default(null),
	texto: z.string().min(1),
	x: z.number(),
	y: z.number(),
	tamano_px: z.number().positive().default(140),
	rot: z.number().default(-3),
	detras: z.boolean().default(false),
});

const ContenidoPildora = z.discriminatedUnion('clase', [
	z.object({clase: z.literal('texto'), texto: z.string().min(1)}),
	/** Interruptor tipo "SIMPLE ↔ INSANE": la bolita pasa de `a` a `b` en el segundo `en`. */
	z.object({clase: z.literal('interruptor'), a: z.string().min(1), b: z.string().min(1), en: segundos}),
	/** Contador que sube de `de` a `a` mientras dura la píldora. */
	z.object({clase: z.literal('contador'), de: z.number(), a: z.number(), formato: z.enum(['numero', 'porcentaje', 'mm:ss']).default('numero'), texto: z.string().optional()}),
	/** Íconos (PNG de biblioteca/stickers) y un texto. */
	z.object({clase: z.literal('iconos'), iconos: z.array(z.string().min(1)).min(1).max(4), texto: z.string().min(1)}),
]);

/** Píldora negra tipo isla dinámica (Forseth): nace chica y se abre con resorte. */
export const Pildora = z.object({...comun, tipo: z.literal('pildora'), x: z.number().default(540), y: z.number(), contenido: ContenidoPildora});

/** Nota escrita a mano (Meg) que se escribe letra por letra y luego dibuja su flecha hacia `flecha`. */
export const Nota = z.object({
	...comun,
	tipo: z.literal('nota'),
	texto: z.string().min(1),
	x: z.number(),
	y: z.number(),
	tamano_px: z.number().positive().default(64),
	rot: z.number().default(-6),
	flecha: z.object({x: z.number(), y: z.number()}).nullable().default(null),
});

/** Captura o tarjeta de UI que flota a tu lado (Meg: carpeta, selector de estilo, timeline). */
export const TarjetaUi = z.object({...comun, tipo: z.literal('tarjeta-ui'), asset: z.string().min(1), x: z.number(), y: z.number(), w: z.number().positive(), proporcion: z.number().positive().default(0.75), rot: z.number().default(0)});

/** Collage que se esparce desde un punto (Meg: "week", "b-roll"). Cada pieza entra escalonada `cada_s`. */
export const Collage = z.object({
	...comun,
	tipo: z.literal('collage'),
	desde_punto: z.object({x: z.number(), y: z.number()}),
	/** proporcion = alto / ancho de la imagen (para su caja). */
	piezas: z.array(z.object({asset: z.string().min(1), x: z.number(), y: z.number(), w: z.number().positive(), proporcion: z.number().positive().default(1.33), rot: z.number().default(0)})).min(2).max(12),
	cada_s: z.number().positive().default(0.07),
});

export const ElementoVivo = z.discriminatedUnion('tipo', [TitularVivo, Impacto, Pildora, Nota, TarjetaUi, Collage]);
export type ElementoVivo = z.infer<typeof ElementoVivo>;

/** Subtítulos "vivos": 1–2 palabras pegadas a tu pecho (su caja.x / caja.y la pone quien dirige), pop por palabra y palabra clave en serif amarilla. */
export const SubtitulosVivos = z.object({
	activo: z.boolean().default(true),
	tamano_px: z.number().positive().default(64),
	escala_clave: z.number().positive().default(1.32),
	voz_clave: VozEsquema.default('serif'),
	color_clave: z.string().default(COLORES_VIVO.clave),
	/** Ids de subtítulo que se quedan con la apariencia normal del estilo (p. ej. sobre una demo a pantalla completa). */
	normales: z.array(z.string()).default([]),
});

export const TextoVivoEsquema = z.object({
	/** Tu silueta con alfa (`npx tsx herramientas/cara.ts <slug> --mascara`), relativa a public/. null = sin "detrás de ti". */
	persona: z.string().min(1).nullable().default(null),
	subtitulos: SubtitulosVivos.nullable().default(null),
	elementos: z.array(ElementoVivo).default([]),
});
export type TextoVivo = z.infer<typeof TextoVivoEsquema>;

// ───────────────────────── geometría (render y validar.ts) ─────────────────────────

export type CajaVivo = {x0: number; y0: number; x1: number; y1: number};

/** Ancho aproximado de un texto en px. */
export const anchoTexto = (texto: string, voz: Voz, tamano: number): number => texto.length * VOCES[voz].ancho_em * tamano;

/** Alto de línea de cada voz (× tamaño): las serif y manuscritas van más apretadas, como en las referencias. */
export const INTERLINEA: Record<Voz, number> = {sans: 0.98, serif: 0.9, mano: 1.0, impacto: 1.0};

/** Escala del titular para que su línea más ancha quepa en ancho_max (nunca agranda). */
export function escalaTitular(t: Pick<z.infer<typeof TitularVivo>, 'lineas' | 'tamano_px' | 'ancho_max'>): number {
	const ancho = Math.max(...t.lineas.map((l) => anchoTexto(l.texto, l.voz ?? 'sans', tamanoLinea(l.voz ?? 'sans', t.tamano_px))));
	return Math.min(1, t.ancho_max / ancho);
}

/** Tamaño de cada línea (las serif van ×1.08 para igualar el peso visual de la sans, como en las referencias). */
export const tamanoLinea = (voz: Voz, base: number): number => base * (voz === 'serif' ? 1.08 : 1);

/** Caja de un elemento (px base). Las tarjetas y piezas rotadas usan su caja sin rotar (rotaciones de ±8° o menos). */
export function cajaElemento(el: ElementoVivo): CajaVivo {
	switch (el.tipo) {
		case 'titular': {
			const k = escalaTitular(el);
			const lineas = el.lineas.map((l) => ({w: anchoTexto(l.texto, l.voz, tamanoLinea(l.voz, el.tamano_px * k)), h: tamanoLinea(l.voz, el.tamano_px * k) * INTERLINEA[l.voz]}));
			const w = Math.max(...lineas.map((l) => l.w));
			const h = lineas.reduce((s, l) => s + l.h, 0);
			return {x0: el.x - w / 2, x1: el.x + w / 2, y0: el.y - h / 2, y1: el.y + h / 2};
		}
		case 'impacto': {
			const w = anchoTexto(el.texto, 'impacto', el.tamano_px);
			const arriba = el.arriba ? el.tamano_px * 0.32 : 0;
			const h = el.tamano_px * 0.95;
			return {x0: el.x - w / 2, x1: el.x + w / 2, y0: el.y - h / 2 - arriba, y1: el.y + h / 2};
		}
		case 'pildora': {
			const {w, h} = tamanoPildora(el.contenido);
			return {x0: el.x - w / 2, x1: el.x + w / 2, y0: el.y - h / 2, y1: el.y + h / 2};
		}
		case 'nota': {
			const lineas = el.texto.split('\n');
			const w = Math.max(...lineas.map((l) => anchoTexto(l, 'mano', el.tamano_px)));
			const h = lineas.length * el.tamano_px * INTERLINEA.mano;
			const c = {x0: el.x - w / 2, x1: el.x + w / 2, y0: el.y - h / 2, y1: el.y + h / 2};
			if (el.flecha) return {x0: Math.min(c.x0, el.flecha.x - 20), x1: Math.max(c.x1, el.flecha.x + 20), y0: Math.min(c.y0, el.flecha.y - 20), y1: Math.max(c.y1, el.flecha.y + 20)};
			return c;
		}
		case 'tarjeta-ui':
			return {x0: el.x - el.w / 2, x1: el.x + el.w / 2, y0: el.y - (el.w * el.proporcion) / 2, y1: el.y + (el.w * el.proporcion) / 2};
		case 'collage': {
			const cs = el.piezas.map((p) => ({x0: p.x - p.w / 2, x1: p.x + p.w / 2, y0: p.y - (p.w * p.proporcion) / 2, y1: p.y + (p.w * p.proporcion) / 2}));
			return {x0: Math.min(...cs.map((c) => c.x0)), x1: Math.max(...cs.map((c) => c.x1)), y0: Math.min(...cs.map((c) => c.y0)), y1: Math.max(...cs.map((c) => c.y1))};
		}
	}
}

/** Medidas de la píldora (alto 112 base: ~10 % del ancho de la pantalla, como "Team" de Forseth; los íconos miden 72). */
export const PILDORA = {alto: 112, pad: 48, texto_px: 48, icono: 72, hueco: 18, bolita: 76, nace_w: 170, nace_h: 54} as const;
export function tamanoPildora(c: z.infer<typeof ContenidoPildora>): {w: number; h: number} {
	const t = (s: string) => anchoTexto(s, 'sans', PILDORA.texto_px);
	switch (c.clase) {
		case 'texto':
			return {w: t(c.texto) + 2 * PILDORA.pad, h: PILDORA.alto};
		case 'interruptor':
			return {w: t(c.a) + t(c.b) + PILDORA.bolita * 2 + 3 * PILDORA.hueco + 2 * PILDORA.pad, h: PILDORA.alto};
		case 'contador': {
			const muestra = textoContador(c.a, c.formato) + (c.texto ? ` ${c.texto}` : '');
			return {w: t(muestra) * 1.05 + 2 * PILDORA.pad, h: PILDORA.alto};
		}
		case 'iconos':
			return {w: c.iconos.length * (PILDORA.icono + PILDORA.hueco) + t(c.texto) + 2 * PILDORA.pad, h: PILDORA.alto};
	}
}

/** "100%", "04:24" o "1,250". */
export function textoContador(v: number, formato: 'numero' | 'porcentaje' | 'mm:ss'): string {
	const n = Math.round(v);
	if (formato === 'porcentaje') return `${n}%`;
	if (formato === 'mm:ss') return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
	return n.toLocaleString('en-US');
}

/** ¿Va detrás de ti? (titulares e impactos con detras = true). */
export const vaDetras = (el: ElementoVivo): boolean => (el.tipo === 'titular' || el.tipo === 'impacto') && el.detras;

/** Tramos (s) en que tu silueta se dibuja encima: los de los elementos que van detrás, unidos si se tocan. */
export function tramosPersona(elementos: readonly ElementoVivo[]): Array<{desde: number; hasta: number}> {
	const t = elementos.filter(vaDetras).map((e) => ({desde: e.desde, hasta: e.hasta})).sort((a, b) => a.desde - b.desde);
	const out: Array<{desde: number; hasta: number}> = [];
	for (const x of t) {
		const u = out[out.length - 1];
		if (u && x.desde <= u.hasta + 1 / 30) u.hasta = Math.max(u.hasta, x.hasta);
		else out.push({...x});
	}
	return out;
}

// ───────────────────────── curvas de animación ─────────────────────────

const lim = (x: number) => Math.min(1, Math.max(0, x));
/** Salida cúbica 0→1 en `n` cuadros. */
export const entra = (f: number, n: number): number => 1 - Math.pow(1 - lim(f / n), 3);
/** Resorte amortiguado 0→1 en ~`n` cuadros con un rebote corto (pasa ~8 % de 1 y vuelve), para pops y píldoras. */
export function resorte(f: number, n = 9): number {
	if (f <= 0) return 0;
	const t = f / n;
	if (t >= 2.5) return 1;
	return 1 - Math.exp(-4 * t) * Math.cos(2 * Math.PI * 0.55 * t);
}
/** Opacidad de salida: 1 hasta los últimos `n` cuadros. */
export const sale = (restantes: number, n = 5): number => lim(restantes / n);
