// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Contrato de la edición (EDL): lo escribe el director (Claude) y lo renderiza Remotion.
 * Coordenadas en base 1080×1920; el lienzo real es 1440×2560 (×4/3).
 * Tiempos en segundos sobre la línea de tiempo de la base ya cortada.
 *
 * `EdicionBase` es el objeto plano que usa el Studio de Remotion.
 * `Edicion` le suma las reglas de coherencia (orden de tiempos, ids únicos, límites) y es la que usa validar.ts.
 */
import {z} from 'zod';
import {MotionEsquema, assetMotion, esMotionLibre} from '../estilo/motion';
import {TextoVivoEsquema} from '../estilo/texto-vivo';

const segundos = z.number().nonnegative();

export const Caja = z.object({
	x: z.number(),
	y: z.number(),
	w: z.number().positive().optional(),
	h: z.number().positive().optional(),
	escala: z.number().positive().optional(),
});

export const Sfx = z.object({
	asset: z.string().min(1),
	ganancia_db: z.number().min(-40).max(0),
	offset_frames: z.number().int().min(-6).max(6),
	variante: z.number().int().nonnegative(),
	/**
	 * Cuadros que suena (desde su arranque); sin valor, el archivo completo. Lo usa el tecleo de las tarjetas "prompt":
	 * dura lo que tarda en escribirse el texto y se apaga con un fundido corto (Reel.tsx → FUNDIDO_SFX_CUADROS).
	 */
	duracion_frames: z.number().int().positive().optional(),
});

export const Palabra = z.object({
	i: z.number().int().nonnegative(),
	t: z.string().min(1),
	d: segundos,
	h: segundos,
});

export const Subtitulo = z.object({
	id: z.string().min(1),
	desde: segundos,
	hasta: segundos,
	palabras: z.array(Palabra).min(1).max(3),
	caja: Caja.optional(),
});

/**
 * Titular: en tus reels va fijo arriba de la cabeza todo el video, en 1–2 líneas (texto con "\n").
 * Es una excepción a "todo debajo de la cabeza" (tapaCabeza = true), medida en tus reels.
 */
export const Titular = z.object({
	texto: z.string().min(1),
	desde: segundos,
	hasta: segundos,
	caja: Caja.optional(),
	tapaCabeza: z.boolean(),
});

/**
 * Tarjeta de palabra clave: caja blanca con texto negro en negritas, a la altura del pecho
 * (tu "resaltado como con bold"). Las de un mismo `grupo` se apilan como lista.
 */
export const Tarjeta = z.object({
	id: z.string().min(1),
	desde: segundos,
	hasta: segundos,
	/** Hasta 48 caracteres; solo las de variante "prompt" pasan de ahí (sus prompts: 78–124). */
	texto: z.string().min(1).max(160),
	/** caja.x, caja.y = centro de la tarjeta en base 1080×1920. */
	caja: Caja,
	grupo: z.string().min(1).nullable().default(null),
	/**
	 * Fila dentro de su grupo (0 = la de arriba). Tarjetas del mismo grupo con la misma fila van lado a lado,
	 * como sus listas "en árbol" (1 arriba y 2 abajo: 7 de 9 listas medidas). Sin fila, cada una va en su propio renglón.
	 */
	fila: z.number().int().min(0).optional(),
	/** "prompt": tarjeta de texto largo alineada a la izquierda (en sus reels: 3–4 renglones, radio 36–51, mayúscula 31–35). */
	variante: z.enum(['normal', 'grande', 'prompt']).default('normal'),
	/** "corte" (lo medido en 211/213), "pop" o "escritura" (letra por letra, como sus tarjetas tipo prompt: 16/213). */
	entrada: z.enum(['corte', 'pop', 'escritura']).default('corte'),
	/**
	 * Horario de escritura (solo con entrada "escritura"; lo escribe el director en los prompts): en el segundo `t` del
	 * video ya se ven `car` grafemas. Entre dos puntos las letras salen parejas; antes del primero no se ve ninguna y
	 * después del último se quedan las suyas. El director pone dos puntos por palabra dicha (su inicio y su final), así
	 * cada palabra aparece cuando la dices. Sin horario: la velocidad medida (Tarjeta.tsx → escrituraDeTarjeta).
	 */
	escritura: z
		.array(z.object({car: z.number().int().nonnegative(), t: segundos}))
		.min(2)
		.refine((h) => h.every((p, i) => i === 0 || (p.car >= h[i - 1].car && p.t >= h[i - 1].t - 1e-9)), {message: 'el horario de escritura va en orden: car y t nunca bajan'})
		.optional(),
	tapaCabeza: z.boolean().default(false),
	sfx: Sfx.nullable().default(null),
});

/** Efectos sobre la toma base (no sobre los overlays). Hoy: desenfoque de énfasis. */
export const Efecto = z.object({
	id: z.string().min(1),
	tipo: z.enum(['desenfoque']),
	desde: segundos,
	hasta: segundos,
	/** Radio del desenfoque en px base. */
	intensidad: z.number().min(0).max(60),
});

const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** Estilo de subtítulo que se usó al agrupar (el ancho medido solo vale con este mismo estilo). */
export const EstiloSubtitulosEdl = z
	.object({
		fuente: z.enum(['tiktok-sans', 'instrument-sans', 'inter']),
		peso: z.number().int().min(100).max(900),
		tamano_px: z.number().positive(),
		color: Color,
		borde_px: z.number().min(0),
		color_borde: Color,
		x: z.number(),
		y: z.number(),
		ancho_max: z.number().positive(),
		espaciado_px: z.number(),
		mayusculas: z.boolean(),
		quitar_puntuacion: z.boolean(),
		resaltado: z
			.object({activo: z.boolean(), peso: z.number().int().min(100).max(900), color: Color.nullable(), escala: z.number().positive()})
			.partial(),
	})
	.partial();

/** Estilos de cada capa. Lo que falte sale de los valores por defecto de cada componente. */
export const Estilos = z.object({
	subtitulos: EstiloSubtitulosEdl.optional(),
	tarjetas: z.record(z.string(), z.unknown()).optional(),
	titular: z.record(z.string(), z.unknown()).optional(),
	stickers: z.record(z.string(), z.unknown()).optional(),
});

/** Pose, ojos y animación de un sticker de mascota (personaje del catálogo); null en logos y PNG sueltos. */
export const Mascota = z.object({
	pose: z.string().min(1),
	ojos: z.string().min(1),
	anim: z.string().min(1),
});

const esMascota = (v: unknown): boolean =>
	typeof v === 'object' && v !== null && ['pose', 'ojos', 'anim'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string');

/** Campos conocidos de un sticker: lo demás es extra (y Zod lo descarta). */
const CAMPOS_STICKER = new Set(['id', 'desde', 'hasta', 'asset', 'mascota', 'caja', 'entrada', 'salida', 'tapaCabeza', 'sfx']);

/**
 * EDL de antes del renombre: la mascota venía en otro campo. Si el sticker no trae `mascota`, se toma del campo
 * extra con forma de mascota ({pose, ojos, anim}); si no hay ninguno (el campo viejo era null), queda null.
 * Así las EDL viejas validan y se renderizan igual que antes.
 */
export function moverAliasMascota(s: unknown): unknown {
	if (typeof s !== 'object' || s === null || Array.isArray(s) || 'mascota' in s) return s;
	const extra = Object.entries(s as Record<string, unknown>).find(([k, v]) => !CAMPOS_STICKER.has(k) && esMascota(v));
	return {...s, mascota: extra ? extra[1] : null};
}

export const Sticker = z.preprocess(
	moverAliasMascota,
	z.object({
		id: z.string().min(1),
		desde: segundos,
		hasta: segundos,
		asset: z.string().min(1),
		mascota: Mascota.nullable(),
		caja: Caja,
		entrada: z.string().min(1),
		salida: z.string().min(1),
		tapaCabeza: z.boolean(),
		sfx: Sfx.nullable(),
	}),
);

export const Insert = z.object({
	id: z.string().min(1),
	/** "motion": motion graphic propio (src/reel/motion/); su asset es "motion:<nombre>" y sus props van en `motion`. */
	tipo: z.enum(['video', 'imagen', 'demo', 'brag', 'motion']),
	desde: segundos,
	hasta: segundos,
	asset: z.string().min(1),
	trim_desde: segundos,
	/**
	 * "flotante" (solo tipo "motion", src/estilo/flotante.ts): tú sigues en pantalla con tu toma desenfocada y la
	 * animación flota encima; caja.x / caja.y / caja.escala mueven la escena (por defecto centro (540, 740)).
	 */
	layout: z.enum(['tarjeta', 'pantalla-completa', 'flotante']),
	/** Solo demos: encuadre de la toma (por defecto: pantalla-completa → vertical, tarjeta → horizontal). */
	encuadre: z.enum(['horizontal', 'vertical']).optional(),
	caja: Caja.optional(),
	tapaCabeza: z.boolean(),
	texto: z.string().min(1).nullable(),
	eventos: z.string().min(1).nullable(),
	audio: z.object({modo: z.enum(['mute', 'duck']), ganancia_db: z.number().max(0)}),
	sfx: Sfx.nullable(),
	/** Solo tipo "motion": cuál y con qué textos (src/estilo/motion.ts). */
	motion: MotionEsquema.optional(),
});

export const Zoom = z.object({
	id: z.string().min(1),
	desde: segundos,
	hasta: segundos,
	escala: z.number().min(1).max(2.5),
	origen: z.object({x: z.number(), y: z.number()}),
	/** "corte": entra de golpe (punch-in); "suave": entra y sale con resorte. */
	transicion: z.enum(['corte', 'suave']).default('suave'),
});

export const SfxExtra = z.object({en: segundos, sfx: Sfx});

export const EdicionBase = z.object({
	version: z.literal(1),
	estilo_version: z.string(),
	estilo_hash: z.string(),
	lienzo: z.object({
		w: z.literal(1440),
		h: z.literal(2560),
		fps: z.literal(30),
		base: z.tuple([z.literal(1080), z.literal(1920)]),
	}),
	base: z.string().min(1),
	duracion_s: z.number().positive().max(600),
	titular: Titular.nullable(),
	subtitulos: z.array(Subtitulo),
	resaltar_palabras: z.array(z.number().int().nonnegative()),
	tarjetas: z.array(Tarjeta).default([]),
	stickers: z.array(Sticker),
	inserts: z.array(Insert),
	zooms: z.array(Zoom),
	efectos: z.array(Efecto).default([]),
	sfx_extra: z.array(SfxExtra),
	estilos: Estilos.default({}),
	/** Estilo "texto vivo" (src/estilo/texto-vivo.ts): titulares detrás de ti, píldoras, notas, tarjetas y subtítulos pegados a ti. */
	texto_vivo: TextoVivoEsquema.optional(),
	audio: z.object({lufs: z.number().min(-30).max(-6), pico_dbtp: z.number().min(-9).max(0)}),
});

export type Edicion = z.infer<typeof EdicionBase>;

type ConTiempo = {id?: string; desde: number; hasta: number};

/** Reglas de coherencia que no caben en un objeto plano. */
export const EdicionValidada = EdicionBase.superRefine((e, ctx) => {
	const revisarTramo = (el: ConTiempo, ruta: (string | number)[]) => {
		if (!(el.desde < el.hasta)) {
			ctx.addIssue({code: 'custom', path: ruta, message: `desde (${el.desde}) debe ser menor que hasta (${el.hasta})`});
		}
		if (el.hasta > e.duracion_s + 1e-6) {
			ctx.addIssue({code: 'custom', path: ruta, message: `termina en ${el.hasta} s, después de la duración (${e.duracion_s} s)`});
		}
	};
	e.subtitulos.forEach((s, i) => revisarTramo(s, ['subtitulos', i]));
	e.tarjetas.forEach((s, i) => revisarTramo(s, ['tarjetas', i]));
	e.tarjetas.forEach((t, i) => {
		if (t.variante !== 'prompt' && t.texto.length > 48) {
			ctx.addIssue({code: 'custom', path: ['tarjetas', i, 'texto'], message: `mide ${t.texto.length} caracteres; solo las tarjetas "prompt" pasan de 48 (tus prompts: 78–124)`});
		}
		if (t.escritura) {
			if (t.entrada !== 'escritura') ctx.addIssue({code: 'custom', path: ['tarjetas', i, 'escritura'], message: `trae horario de escritura y entra con "${t.entrada}"; solo las de entrada "escritura" lo usan`});
			const fuera = t.escritura.find((p) => p.t < t.desde - 1e-6 || p.t > t.hasta + 1e-6);
			if (fuera) ctx.addIssue({code: 'custom', path: ['tarjetas', i, 'escritura'], message: `el horario de escritura tiene un punto en ${fuera.t} s, fuera de la tarjeta (${t.desde}–${t.hasta} s)`});
		}
	});
	e.stickers.forEach((s, i) => revisarTramo(s, ['stickers', i]));
	e.inserts.forEach((s, i) => revisarTramo(s, ['inserts', i]));
	e.inserts.forEach((s, i) => {
		if (s.tipo === 'motion') {
			if (!s.motion) ctx.addIssue({code: 'custom', path: ['inserts', i, 'motion'], message: 'un insert "motion" necesita `motion` (cuál y con qué textos: src/estilo/motion.ts)'});
			else if (s.asset !== assetMotion(s.motion.nombre)) ctx.addIssue({code: 'custom', path: ['inserts', i, 'asset'], message: `el asset de un motion es "${assetMotion(s.motion.nombre)}" (trae "${s.asset}")`});
			if (s.motion && esMotionLibre(s.motion.nombre) && s.layout !== 'flotante') ctx.addIssue({code: 'custom', path: ['inserts', i, 'layout'], message: `"${s.motion.nombre}" flota encima de ti anclado a tu cabeza: va con layout "flotante" (trae "${s.layout}")`});
		} else if (s.motion) ctx.addIssue({code: 'custom', path: ['inserts', i, 'motion'], message: `trae \`motion\` y es de tipo "${s.tipo}"; solo los inserts "motion" lo usan`});
		if (s.layout === 'flotante' && s.tipo !== 'motion') ctx.addIssue({code: 'custom', path: ['inserts', i, 'layout'], message: `el layout "flotante" es solo para motion graphics (tipo "motion"); este es "${s.tipo}"`});
	});
	e.zooms.forEach((s, i) => revisarTramo(s, ['zooms', i]));
	e.efectos.forEach((s, i) => revisarTramo(s, ['efectos', i]));
	if (e.titular) revisarTramo(e.titular, ['titular']);
	e.texto_vivo?.elementos.forEach((s, i) => revisarTramo(s, ['texto_vivo', 'elementos', i]));
	e.sfx_extra.forEach((s, i) => {
		if (s.en > e.duracion_s) ctx.addIssue({code: 'custom', path: ['sfx_extra', i], message: `suena en ${s.en} s, después del final`});
	});

	const ids = [...e.subtitulos, ...e.tarjetas, ...e.stickers, ...e.inserts, ...e.zooms, ...e.efectos, ...(e.texto_vivo?.elementos ?? [])].map((x) => x.id);
	const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
	if (repetidos.length > 0) {
		ctx.addIssue({code: 'custom', path: [], message: `ids repetidos: ${[...new Set(repetidos)].join(', ')}`});
	}

	// Subtítulos: en orden y sin encimarse.
	for (let i = 1; i < e.subtitulos.length; i++) {
		if (e.subtitulos[i].desde < e.subtitulos[i - 1].hasta - 1e-6) {
			ctx.addIssue({code: 'custom', path: ['subtitulos', i], message: 'se encima con el subtítulo anterior'});
		}
	}
});

/** EDL mínima válida (sirve de defaultProps en el Studio). */
export const edicionVacia: Edicion = {
	version: 1,
	estilo_version: '0.0.0',
	estilo_hash: 'sin-estilo',
	lienzo: {w: 1440, h: 2560, fps: 30, base: [1080, 1920]},
	base: 'fx/clip-6s.mp4',
	duracion_s: 3,
	titular: null,
	subtitulos: [],
	resaltar_palabras: [],
	tarjetas: [],
	stickers: [],
	inserts: [],
	zooms: [],
	efectos: [],
	sfx_extra: [],
	estilos: {},
	audio: {lufs: -14, pico_dbtp: -1.5},
};

/** Cuadro (frame) a 30 fps para un tiempo en segundos. */
export const aCuadro = (segundos: number): number => Math.round(segundos * 30);

/** Ganancia lineal a partir de decibeles. */
export const dbAGanancia = (db: number): number => Math.pow(10, db / 20);

/** Cuadros del fundido con que se apaga un SFX recortado (sfx.duracion_frames): corto, para que el corte no truene. */
export const FUNDIDO_SFX_CUADROS = 3;

/**
 * Volumen lineal de un SFX en su cuadro local `f` (0 = su arranque). Sin duracion_frames: la ganancia fija. Con ella:
 * la ganancia hasta los últimos FUNDIDO_SFX_CUADROS cuadros, que bajan en línea recta hasta 0 en el cuadro
 * duracion_frames (de ahí en adelante, silencio; Reel.tsx además corta el Audio con su Sequence).
 */
export function volumenSfx(f: number, sfx: {ganancia_db: number; duracion_frames?: number}): number {
	const g = dbAGanancia(sfx.ganancia_db);
	const d = sfx.duracion_frames;
	if (d === undefined) return g;
	if (f >= d) return 0;
	const fundido = Math.min(FUNDIDO_SFX_CUADROS, d);
	const inicio = d - fundido;
	if (f < inicio) return g;
	return g * Math.max(0, (d - f) / (fundido + 1));
}
