/**
 * Memes de reacción en tarjeta (GIFs convertidos a MP4 en biblioteca/memes/, ver su README.md y catalogo.json).
 *
 * En los reels recientes del estilo de referencia van 1–2 (hasta 4) memes por reel: una tarjeta de esquinas redondeadas a la altura
 * de la cara, que la TAPA A PROPÓSITO (es el chiste), 0.8–1.4 s, con el pop de los stickers (≤ 6 cuadros), salida seca
 * y un SFX corto. Referencia medida: el meme de reel A (770×820 base, centro y ≈ 960, radio ≈ 52 px;
 * src/estilo/capas.ts → MEDICIONES_CAPAS.insert_tarjeta). Ancho 800 y centro y 940 son lo que pidió el director
 * (2026-10-04) dentro de la zona segura de Reels (x 135–945: el ancho máximo centrado es 810).
 *
 * Un insert es "meme" cuando su asset vive en biblioteca/memes/. Eso basta para que:
 *  - el layout lo ponga en la caja de meme (tapaCabeza = true aunque quepa debajo de la barbilla; R4 no aplica),
 *  - Insert.tsx lo dibuje con el radio del meme y en loop si el clip dura menos que el insert,
 *  - el selector de SFX lo trate como un sticker (pop corto) y no como un insert (whoosh).
 * Puro: sin React, sin Remotion y sin Node.
 */

export const MEME = {
	/** Centro y ancho por defecto (px base 1080×1920). */
	x: 540,
	y: 940,
	ancho: 800,
	/** Ancho máximo centrado en x = 540 sin salir de la zona cian (x 135–945). */
	ancho_max: 810,
	/** Radio de esquinas: el del meme medido en reel A (≈ 52 px con 770 de ancho), proporcional al ancho. */
	radio_por_ancho: 52 / 770,
	/** Duración que se le da cuando las notas no dicen (s): dentro de 0.8–1.4 s. */
	duracion: 1.2,
} as const;

/** ¿El asset es un meme de biblioteca/memes/? (acepta "biblioteca/memes/x.mp4" con o sin "/" al principio). */
export function esMeme(asset: string): boolean {
	return /(^|\/)biblioteca\/memes\/[^/]+\.(mp4|webm|gif|png|jpe?g|webp)$/i.test(asset);
}

/** Radio de esquinas (px base) de un meme de ese ancho. */
export function radioMeme(ancho: number): number {
	return Math.round(ancho * MEME.radio_por_ancho * 10) / 10;
}

/**
 * Caja de un meme (pura): centrada en x = 540, ancho ≤ 810 y su alto por la proporción (alto/ancho); el centro va en
 * y = 940 salvo que se salga de [techo, piso] (por arriba el límite de la zona segura y por abajo la franja de
 * subtítulos); si no cabe a lo alto, se achica.
 */
export function cajaMeme(p: {aspecto: number; ancho?: number; techo: number; piso: number}): {x: number; y: number; w: number; h: number; achicado: boolean} {
	let w = Math.min(p.ancho ?? MEME.ancho, MEME.ancho_max);
	let h = w * p.aspecto;
	let achicado = false;
	const disponible = p.piso - p.techo;
	if (h > disponible) {
		h = disponible;
		w = h / p.aspecto;
		achicado = true;
	}
	const y = Math.min(Math.max(MEME.y, p.techo + h / 2), p.piso - h / 2);
	const r1 = (x: number) => Math.round(x * 10) / 10;
	return {x: MEME.x, y: r1(y), w: r1(w), h: r1(h), achicado};
}
