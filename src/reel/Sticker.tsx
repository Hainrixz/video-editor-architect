import React from 'react';
import {AnimatedImage, Img, Sequence, staticFile, useCurrentFrame} from 'remotion';
import type {Edicion} from '../esquema/edicion';
import {cuadrosDe, resolverEstiloSticker, type EntradaSticker, type EstiloSticker, type SalidaSticker} from '../estilo/capas';
import {escalaPop, escalaRebote, escalaRespira, opacidadPop, salidaEncoger} from '../estilo/animaciones';

/**
 * Stickers (mascota voxel, logos en tile, PNG con borde tipo sticker). Coordenadas base 1080×1920 (dentro del ×4/3).
 *
 * - caja.x / caja.y = CENTRO del sticker; caja.w = ancho (si falta, el del estilo: 316 px, mediana de tus tiles; si
 *   solo trae caja.h, manda el alto); caja.escala multiplica. La otra medida sale de la proporción del PNG.
 * - Entrada (sticker.entrada):
 *   · "pop" (la de tus reels, medida en 6 stickers): escala lineal 0.5 → 1.0 en 6 cuadros, sin sobrepaso; el primer
 *     cuadro visible va al 58 % de tamaño y al 83 % de opacidad; desde el segundo, opaco.
 *   · "rebote": resorte con sobrepaso (0.5 → ~1.06 → 1.00, asentado desde el cuadro 8). No apareció en tus reels medidos.
 *   · "corte": aparece entero.
 *   Si la EDL trae otra palabra, se usa la entrada del estilo (por defecto "pop").
 * - Salida (sticker.salida): "corte" (la de tus reels) o "encoger" (los últimos 3 cuadros: 1 → 0.5, el último al 83 %).
 * - Idle: con mascota.anim = "respira", ±1.5 % de escala con periodo de 1.2 s, desde que termina la entrada (sin salto).
 *   Cualquier otra anim ("ninguna", etc.) lo deja quieto, como en tus reels.
 * - Sombra suave con drop-shadow (sigue la silueta del PNG). estilos.stickers.sombra = false la apaga para PNG que
 *   ya traen la suya.
 * - El primer cuadro visible es aCuadro(desde): ahí debe arrancar su SFX (lo pone Reel.tsx con sfx.offset_frames).
 * - Emojis animados (biblioteca/stickers/emojis, Noto Emoji Animation, CC BY 4.0): el asset de la EDL es su póster PNG
 *   (`emoji-<nombre>.png`, lo que revisan validar.ts y el layout) y aquí se dibuja la animación de al lado
 *   (`emoji-<nombre>.webp`, mismo lienzo cuadrado) con <AnimatedImage>, en loop desde su primer cuadro visible y con
 *   la misma entrada pop y salida seca que los demás.
 */

type StickerEdl = Edicion['stickers'][number];

/** Animación de un sticker (relativa a public/) o null si es un PNG fijo. Solo los emojis del catálogo la tienen. */
export function animacionDeSticker(asset: string): string | null {
	return /^biblioteca\/stickers\/emojis\/emoji-[a-z0-9-]+\.png$/.test(asset) ? asset.replace(/\.png$/, '.webp') : null;
}

/** Lado del lienzo del canvas de un emoji: el tamaño real en el lienzo de 1440 (base ×4/3), sin pasarse de 1024. */
export const ladoCanvasEmoji = (ladoBase: number): number => Math.max(16, Math.min(1024, Math.round((ladoBase * 4) / 3)));

const ENTRADAS: readonly EntradaSticker[] = ['pop', 'corte', 'rebote'];
const SALIDAS: readonly SalidaSticker[] = ['corte', 'encoger'];

export const entradaDe = (s: Pick<StickerEdl, 'entrada'>, e: EstiloSticker): EntradaSticker =>
	(ENTRADAS as readonly string[]).includes(s.entrada) ? (s.entrada as EntradaSticker) : e.entrada;
export const salidaDe = (s: Pick<StickerEdl, 'salida'>, e: EstiloSticker): SalidaSticker =>
	(SALIDAS as readonly string[]).includes(s.salida) ? (s.salida as SalidaSticker) : e.salida;

/** Cuadros que tarda la entrada en asentarse (desde ahí corre el idle). */
export function cuadrosDeEntrada(entrada: EntradaSticker, e: EstiloSticker): number {
	if (entrada === 'pop') return Math.max(0, Math.ceil(e.pop.cuadros) - 1);
	if (entrada === 'rebote') return 8;
	return 0;
}

/** Escala y opacidad del sticker en el cuadro local `f` (0 = primer cuadro visible) de un sticker de `duracion` cuadros. */
export function animacionSticker(
	f: number,
	duracion: number,
	entrada: EntradaSticker,
	salida: SalidaSticker,
	anim: string | null,
	e: EstiloSticker,
): {escala: number; opacidad: number} {
	let escala = 1;
	let opacidad = 1;
	if (entrada === 'pop') {
		escala = escalaPop(f, e.pop);
		opacidad = opacidadPop(f, e.pop);
	} else if (entrada === 'rebote') {
		escala = escalaRebote(f, e.rebote);
		opacidad = opacidadPop(f, e.pop);
	}
	if (anim === 'respira') {
		escala *= escalaRespira(f - cuadrosDeEntrada(entrada, e), e.respira.amplitud, e.respira.periodo_s);
	}
	if (salida === 'encoger') {
		const s = salidaEncoger(duracion - f, e.cuadros_encoger, e.pop.opacidadInicial);
		escala *= s.escala;
		opacidad *= s.opacidad;
	}
	return {escala, opacidad};
}

export type PropsSticker = {
	sticker: StickerEdl;
	/** Duración del sticker en cuadros (la salida "encoger" la necesita). */
	duracion: number;
	estilo: EstiloSticker;
};

/** Un sticker dentro de su Sequence: useCurrentFrame() = cuadros desde su primer cuadro visible. */
export const Sticker: React.FC<PropsSticker> = ({sticker, duracion, estilo}) => {
	const f = useCurrentFrame();
	const entrada = entradaDe(sticker, estilo);
	const salida = salidaDe(sticker, estilo);
	const {escala, opacidad} = animacionSticker(f, duracion, entrada, salida, sticker.mascota?.anim ?? null, estilo);
	// Con caja.w manda el ancho; si solo trae caja.h, manda el alto; si no trae ninguno, el ancho del estilo.
	const escalaCaja = sticker.caja.escala ?? 1;
	const ancho = sticker.caja.w !== undefined || sticker.caja.h === undefined ? (sticker.caja.w ?? estilo.ancho_px) * escalaCaja : undefined;
	const alto = ancho === undefined && sticker.caja.h !== undefined ? sticker.caja.h * escalaCaja : undefined;
	const sombra = estilo.sombra.activa
		? `drop-shadow(0px ${estilo.sombra.dy_px}px ${estilo.sombra.desenfoque_px}px rgba(${rgb(estilo.sombra.color)}, ${estilo.sombra.opacidad}))`
		: undefined;
	const estiloCaja: React.CSSProperties = {
		position: 'absolute',
		left: sticker.caja.x,
		top: sticker.caja.y,
		width: ancho ?? 'auto',
		height: alto ?? 'auto',
		transform: `translate(-50%, -50%) scale(${escala})`,
		transformOrigin: '50% 50%',
		opacity: opacidad,
		filter: sombra,
	};
	const animacion = animacionDeSticker(sticker.asset);
	if (animacion) {
		// El lienzo del emoji es cuadrado: el lado que falte es igual al otro.
		const lado = ancho ?? alto ?? estilo.ancho_px;
		const n = ladoCanvasEmoji(lado);
		return (
			<AnimatedImage
				data-sticker={sticker.id}
				src={staticFile(animacion)}
				width={n}
				height={n}
				fit="contain"
				loopBehavior="loop"
				style={{...estiloCaja, width: lado, height: lado}}
			/>
		);
	}
	return <Img data-sticker={sticker.id} src={staticFile(sticker.asset)} style={estiloCaja} />;
};

function rgb(hex: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export type PropsCapaStickers = {
	stickers: Edicion['stickers'];
	/** edicion.estilos.stickers (objeto libre): lo que traiga pisa los valores por defecto campo por campo. */
	estilo?: unknown;
};

/** Todos los stickers con su tiempo (mismo redondeo a cuadro que Reel.tsx). Los SFX los pone Reel.tsx. */
export const CapaStickers: React.FC<PropsCapaStickers> = ({stickers, estilo}) => {
	const e = resolverEstiloSticker(estilo);
	return (
		<>
			{stickers.map((s) => {
				const c = cuadrosDe(s);
				return (
					<Sequence key={s.id} from={c.desde} durationInFrames={c.duracion} layout="none" name={`sticker ${s.id}`}>
						<Sticker sticker={s} duracion={c.duracion} estilo={e} />
					</Sequence>
				);
			})}
		</>
	);
};
