// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import React from 'react';
import {Sequence, staticFile} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {aCuadro, type Edicion} from '../esquema/edicion';
import {
	BASE_ANCHO,
	ESTILO_SUBTITULO_POR_DEFECTO,
	archivoFuente,
	candidata,
	metricasCss,
	pesoDisponible,
	resolverEstilo,
	textoVisible,
	type EstiloSubtitulo,
	type EstiloSubtituloParcial,
} from '../estilo/fuentes';

/**
 * Un subtítulo en coordenadas base 1080×1920 (va dentro del contenedor escalado ×4/3 de Reel.tsx).
 *
 * - Fuente: el archivo de biblioteca/fuentes/ que dice el estilo, cargado con loadFont de @remotion/fonts
 *   (frena el render hasta que carga; si falla, el render falla). Es el MISMO archivo con el que
 *   herramientas/subtitulos.ts midió el ancho.
 * - Una sola línea (white-space: nowrap), centrada en caja.x (o estilo.x).
 * - Y: caja.y (o estilo.y) es el CENTRO DE LAS MAYÚSCULAS: la línea base queda en y + alto de mayúscula / 2.
 *   Para que eso no dependa de las métricas de la plataforma, la fuente se registra con ascent = alto de
 *   mayúscula y descent = 0, y el texto se ancla por abajo (el pie de la caja es la línea base).
 * - Borde: se dibuja en SVG con stroke de 2 × borde_px, paint-order stroke y uniones REDONDAS (la mitad
 *   interior queda bajo el relleno, así que por fuera se ve borde_px). Con -webkit-text-stroke de HTML,
 *   Chrome une las esquinas en inglete y salen picos en la "t", la "W" y la "y"; tus subtítulos no los tienen.
 * - Resaltado (apagado por defecto): si estilo.resaltado.activo y la palabra está en `resaltar`
 *   (edicion.resaltar_palabras), va con el peso, color y escala del resaltado.
 * - caja.escala < 1 (la pone el agrupador cuando una palabra sola no cabe) achica todo desde el centro.
 */

export type {EstiloSubtitulo, EstiloSubtituloParcial};

/** Blanco con borde negro, TikTok Sans 600 (supuestos hasta medir tus reels). */
export const estiloSubtituloPorDefecto: EstiloSubtitulo = ESTILO_SUBTITULO_POR_DEFECTO;

type SubtituloEdl = Edicion['subtitulos'][number];

const cargadas = new Map<string, Promise<void>>();

/** Registra (una sola vez por pestaña) los pesos que usa el estilo. Llamarla de más no hace nada. */
export function cargarFuentesSubtitulo(estilo: EstiloSubtitulo): void {
	const c = candidata(estilo.fuente);
	const pesos = new Set([pesoDisponible(c.id, estilo.peso)]);
	if (estilo.resaltado.activo) pesos.add(pesoDisponible(c.id, estilo.resaltado.peso));
	for (const peso of pesos) {
		const llave = `${c.id}:${peso}`;
		if (cargadas.has(llave)) continue;
		cargadas.set(
			llave,
			loadFont({
				family: c.familiaCss,
				url: staticFile(archivoFuente(c.id, peso).ruta),
				weight: String(peso),
				style: 'normal',
				display: 'block',
				...metricasCss(c.id),
			}),
		);
	}
}

export type PropsSubtitulo = {
	subtitulo: SubtituloEdl;
	/** Índices de palabra a resaltar (edicion.resaltar_palabras). Solo cuentan si estilo.resaltado.activo. */
	resaltar?: readonly number[];
	estilo?: EstiloSubtituloParcial;
};

export const Subtitulo: React.FC<PropsSubtitulo> = ({subtitulo, resaltar = [], estilo: parcial}) => {
	const estilo = resolverEstilo(parcial);
	cargarFuentesSubtitulo(estilo);
	const c = candidata(estilo.fuente);
	const peso = pesoDisponible(c.id, estilo.peso);
	const pesoResaltado = pesoDisponible(c.id, estilo.resaltado.peso);
	const marcadas = new Set(estilo.resaltado.activo ? resaltar : []);
	const altoMayuscula = c.altoMayuscula * estilo.tamano_px;
	const x = subtitulo.caja?.x ?? estilo.x;
	const y = subtitulo.caja?.y ?? estilo.y;
	const escala = subtitulo.caja?.escala ?? 1;
	const lineaBase = y + altoMayuscula / 2;
	// Lienzo SVG del ancho de la base y alto de sobra para ascendentes, descendentes y borde.
	const alto = estilo.tamano_px * 2.4 + 4 * estilo.borde_px;
	const baseEnSvg = estilo.tamano_px * 1.4 + 2 * estilo.borde_px;

	return (
		<svg
			data-subtitulo={subtitulo.id}
			width={BASE_ANCHO}
			height={alto}
			viewBox={`0 0 ${BASE_ANCHO} ${alto}`}
			style={{
				position: 'absolute',
				left: x - BASE_ANCHO / 2,
				top: lineaBase - baseEnSvg,
				overflow: 'visible',
				transform: `scale(${escala})`,
				transformOrigin: `50% ${baseEnSvg - altoMayuscula / 2}px`,
			}}
		>
			<text
				x={BASE_ANCHO / 2}
				y={baseEnSvg}
				textAnchor="middle"
				fontFamily={`"${c.familiaCss}"`}
				fontWeight={peso}
				fontStyle="normal"
				fontSize={estilo.tamano_px}
				letterSpacing={estilo.espaciado_px}
				fill={estilo.color}
				stroke={estilo.color_borde}
				strokeWidth={2 * estilo.borde_px}
				strokeLinejoin="round"
				strokeLinecap="round"
				paintOrder="stroke fill"
				style={{fontKerning: 'normal', fontVariantLigatures: 'normal', fontSynthesis: 'none', whiteSpace: 'pre'}}
			>
				{subtitulo.palabras.map((p, k) => {
					const resaltada = marcadas.has(p.i);
					// El espacio va aparte y sin resaltar (así lo mide el agrupador).
					return (
						<React.Fragment key={p.i}>
							{k > 0 ? <tspan> </tspan> : null}
							<tspan
								fontWeight={resaltada ? pesoResaltado : undefined}
								fill={resaltada && estilo.resaltado.color ? estilo.resaltado.color : undefined}
								fontSize={resaltada ? estilo.tamano_px * estilo.resaltado.escala : undefined}
							>
								{textoVisible(p.t, estilo)}
							</tspan>
						</React.Fragment>
					);
				})}
			</text>
		</svg>
	);
};

export type PropsCapaSubtitulos = {
	subtitulos: Edicion['subtitulos'];
	resaltar?: readonly number[];
	estilo?: EstiloSubtituloParcial;
};

/** Todos los subtítulos con su tiempo (mismo redondeo a cuadro que el resto de Reel.tsx). Van encima de todo. */
export const CapaSubtitulos: React.FC<PropsCapaSubtitulos> = ({subtitulos, resaltar = [], estilo}) => (
	<>
		{subtitulos.map((sub) => (
			<Sequence key={sub.id} from={aCuadro(sub.desde)} durationInFrames={Math.max(1, aCuadro(sub.hasta) - aCuadro(sub.desde))} layout="none">
				<Subtitulo subtitulo={sub} resaltar={resaltar} estilo={estilo} />
			</Sequence>
		))}
	</>
);
