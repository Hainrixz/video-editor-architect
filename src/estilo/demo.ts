// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Estilo y formato del inserto de demo de pantalla (Fase 5). Lo comparten el estudio
 * (herramientas/grabador/*, en Node) y el componente (src/reel/DemoPantalla.tsx, en el navegador).
 *
 * Este archivo es puro: sin React, sin Remotion y sin Node (solo zod), para que lo puedan importar los dos lados.
 *
 * Formato de los archivos de una demo (demos/<slug>/):
 *   - toma.mp4      la grabación ya comprimida (sin tiempos muertos), CFR 30, H.264.
 *   - eventos.json  [{t, tipo, caja, dur?}]: t en segundos sobre toma.mp4; caja en px del cuadro grabado
 *                   (2560×1600 con viewport 1280×800 y DPR 2). Las teclas nunca guardan texto.
 *   - toma.json     metadatos de la toma: tamaño del cuadro, DPR, fps, duración y el mapa de compresión.
 *                   DemoPantalla lo lee de la misma carpeta que eventos.json (de ahí saca el tamaño del cuadro).
 *
 * Los valores visuales son SUPUESTOS hasta medirlos en tus reels (regla 4: lo no medido no es dato).
 * El radio del marco sale del brand kit (r_photo = 28 px) mientras tus reels no den una medida.
 */
import {z} from 'zod';

/** Caja en px del cuadro grabado, origen arriba-izquierda. */
export const CajaPx = z.object({
	x: z.number(),
	y: z.number(),
	w: z.number().nonnegative(),
	h: z.number().nonnegative(),
});
export type CajaPx = z.infer<typeof CajaPx>;

export const TIPOS_EVENTO = ['clic', 'tecla', 'scroll', 'navegacion'] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

/**
 * Un evento de la demo. `dur` (opcional) es lo que duró la acción en la toma (escribir, desplazar).
 * Nunca lleva el texto tecleado: una tecla es solo {tipo: "tecla"} con la caja del campo.
 */
export const EventoDemo = z.strictObject({
	t: z.number().nonnegative(),
	tipo: z.enum(TIPOS_EVENTO),
	caja: CajaPx,
	dur: z.number().nonnegative().optional(),
});
export type EventoDemo = z.infer<typeof EventoDemo>;

export const EventosDemo = z.array(EventoDemo);

/** Lo que DemoPantalla necesita de toma.json (el archivo trae más campos; se toleran). */
export const TomaDemo = z.looseObject({
	version: z.literal(1),
	cuadro: z.looseObject({
		ancho: z.number().int().positive(),
		alto: z.number().int().positive(),
		fps: z.number().positive(),
		dpr: z.number().positive().nullable(),
	}),
	duracion_s: z.number().nonnegative(),
});
export type TomaDemo = z.infer<typeof TomaDemo>;

/** Ruta de toma.json a partir de la de eventos.json (misma carpeta). */
export function rutaTomaDeEventos(rutaEventos: string): string {
	const i = rutaEventos.lastIndexOf('/');
	return `${i >= 0 ? rutaEventos.slice(0, i + 1) : ''}toma.json`;
}

export type Medida<T> = {valor: T; fuente: string; n: number; falta: string | null};

/**
 * Apariencia del inserto. Todo es `supuesto` (n = 0) salvo el radio, que viene del brand kit.
 * Medidas en px de la base 1080×1920 salvo las que dicen "_rel" (fracción del alto del cuadro grabado).
 */
export const ESTILO_DEMO = {
	radio_px: {valor: 28, fuente: 'brand-kit (r_photo)', n: 0, falta: 'medir el radio de las tarjetas de pantalla en tus reels (Fase 2)'},
	/** Sombra de la tarjeta (supuesto). */
	sombra: '0 18px 48px rgba(0, 0, 0, 0.42)',
	/** Borde fino que separa la tarjeta del fondo cuando la página es blanca (supuesto). */
	borde: '1px solid rgba(255, 255, 255, 0.10)',
	/** Fondo detrás de una toma horizontal a pantalla completa (ink del brand kit, supuesto). */
	fondo_pantalla_completa: '#0B0B0D',
	/** Tamaño por defecto de la tarjeta (px base) si quien la usa no da ancho y alto. */
	tarjeta_horizontal: {ancho: 1000, alto: 625},
	tarjeta_vertical: {ancho: 900, alto: 1125},
	cursor: {
		/** Alto de la flecha como fracción del alto del cuadro (≈ 54 px en un cuadro de 1600). */
		alto_rel: 0.034,
		relleno: '#111111',
		contorno: '#FFFFFF',
		/** Sombra suave bajo la flecha. */
		sombra: 'drop-shadow(0px 3px 4px rgba(0, 0, 0, 0.35))',
		/** Al hacer clic la flecha se encoge un poco (escala mínima) y regresa. */
		escala_clic: 0.84,
		/** Viaje entre clics: dura como mucho esto (s) y como mucho esta fracción del tiempo entre clics. */
		viaje_max_s: 0.65,
		viaje_frac: 0.7,
		/** Dónde descansa antes del primer clic (fracción del cuadro). */
		reposo: {x: 0.62, y: 0.7},
	},
	/**
	 * Onda del clic. Coral del brand kit (#E1693F) porque se ve sobre páginas blancas, oscuras y botones de color;
	 * una onda blanca desaparece en una página blanca. Supuesto hasta medir tus reels.
	 */
	onda: {
		duracion_s: 0.55,
		radio_ini_rel: 0.008,
		radio_fin_rel: 0.046,
		grosor_rel: 0.0055,
		color: 'rgba(225, 105, 63, 0.95)',
		relleno: 'rgba(225, 105, 63, 0.20)',
		opacidad_max: 0.9,
		fuente: 'brand-kit (coral) · supuesto',
	},
} as const;
