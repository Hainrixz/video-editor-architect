// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Franja de legibilidad de los subtítulos sobre demos de pantalla a pantalla completa.
 *
 * Por qué existe: en un reel de prueba (v7) los subtítulos (blancos con borde negro, y ≈ 1498 de 1920) caían encima del texto
 * de las páginas web (GitHub, Apple) y se perdían. Debajo de los subtítulos, y solo mientras dura una demo a pantalla
 * completa, va un degradado vertical negro: transparente → OPACIDAD_PICO → transparente, centrado en la franja de
 * subtítulos. Encima de la demo y debajo de stickers, tarjetas, titular y subtítulos.
 *
 * Decisión de legibilidad del 2026-10-04, NO medida en tus reels: los valores (pico 0.6, meseta y alto total) son un
 * punto de partida razonable. No aplica a tu cámara normal ni a los inserts en tarjeta ni a la terminal animada.
 */
import type {Edicion} from '../esquema/edicion';

type InsertEdl = Edicion['inserts'][number];

/** Opacidad del negro en el centro de la franja (pedido: ~55–65 %). */
export const OPACIDAD_PICO = 0.6;
/** Meseta: medio alto (px base) alrededor del centro donde el negro ya está al pico. */
export const MEDIA_MESETA_PX = 60;
/** Medio alto total (px base) de la franja, del centro a donde vuelve a ser transparente. */
export const MEDIO_ALTO_PX = 190;

/** ¿Este insert lleva franja? Solo demos de pantalla (no la terminal animada) a pantalla completa. */
export function llevaFranja(i: Pick<InsertEdl, 'tipo' | 'layout' | 'asset'>): boolean {
	return i.tipo === 'demo' && i.layout === 'pantalla-completa' && !i.asset.endsWith('.terminal.json');
}

export type Franja = {top: number; alto: number; fondo: string};

/**
 * Geometría de la franja en base 1080×1920 para un centro de subtítulo y (el centro de las mayúsculas, como en
 * Subtitulo.tsx). Se recorta al lienzo.
 */
export function franjaSubtitulos(yCentro: number, opts: {pico?: number; mediaMeseta?: number; medioAlto?: number} = {}): Franja {
	const pico = opts.pico ?? OPACIDAD_PICO;
	const meseta = opts.mediaMeseta ?? MEDIA_MESETA_PX;
	const medio = Math.max(opts.medioAlto ?? MEDIO_ALTO_PX, meseta + 1);
	const top = yCentro - medio;
	const alto = 2 * medio;
	const a = ((medio - meseta) / alto) * 100;
	const b = ((medio + meseta) / alto) * 100;
	const negro = `rgba(0, 0, 0, ${pico})`;
	const fondo = `linear-gradient(to bottom, rgba(0, 0, 0, 0) 0%, ${negro} ${a.toFixed(2)}%, ${negro} ${b.toFixed(2)}%, rgba(0, 0, 0, 0) 100%)`;
	return {top, alto, fondo};
}
