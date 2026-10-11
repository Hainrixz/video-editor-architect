import React, {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {aCuadro, type Edicion} from '../esquema/edicion';
import {BASE_ANCHO} from '../estilo/fuentes';
import {DESENFOQUE_POR_DEFECTO, type ParametrosDesenfoque} from '../estilo/capas';
import {intensidadDesenfoque, type TramoDesenfoque} from '../estilo/animaciones';

/**
 * Envoltura de la toma base: desenfoque de énfasis (edicion.efectos de tipo "desenfoque").
 *
 * - intensidad = desviación del desenfoque en px BASE (se pasa al lienzo real ×4/3).
 * - Rampa: sube con suavizado seno en 18 cuadros y baja en 18 de modo que en `hasta` ya no hay desenfoque (medido
 *   en reel P10: la nitidez baja en ~20 cuadros). Si el tramo dura poco, cada rampa se recorta a un tercio.
 *   `rampa` la cambia (por ejemplo { entrada: 0 } para que entre de golpe, como el fondo de una captura en reel P1).
 * - Se dibuja con backdrop-filter sobre la toma: en el Chrome de Remotion, filter: blur() oscurece las orillas
 *   (el borde se mezcla con transparente) y el filtro SVG con edgeMode="duplicate" también; backdrop-filter no
 *   (probado en out/f3-componentes/_sonda/blur-3.png).
 * - Solo desenfoca lo que envuelve (la toma base, con su zoom); los overlays van encima y quedan nítidos.
 *
 * Va a nivel del lienzo y fuera de cualquier Sequence (usa el cuadro absoluto), como ConZoom.
 */

export type PropsConDesenfoque = {
	efectos: Edicion['efectos'];
	children: React.ReactNode;
	rampa?: Partial<ParametrosDesenfoque>;
};

/** Los tramos de desenfoque de la EDL en cuadros, con el mismo redondeo que el resto de Reel.tsx. */
export function tramosDesenfoque(efectos: Edicion['efectos']): TramoDesenfoque[] {
	return efectos
		.filter((e) => e.tipo === 'desenfoque')
		.map((e) => ({desde: aCuadro(e.desde), hasta: aCuadro(e.hasta), intensidad: e.intensidad}));
}

export const ConDesenfoque: React.FC<PropsConDesenfoque> = ({efectos, children, rampa}) => {
	const frame = useCurrentFrame();
	const {width} = useVideoConfig();
	const tramos = useMemo(() => tramosDesenfoque(efectos), [efectos]);
	const entrada = rampa?.rampa_entrada ?? DESENFOQUE_POR_DEFECTO.rampa_entrada;
	const salida = rampa?.rampa_salida ?? DESENFOQUE_POR_DEFECTO.rampa_salida;
	const r = intensidadDesenfoque(frame, tramos, entrada, salida) * (width / BASE_ANCHO);
	return (
		<AbsoluteFill>
			{children}
			{r >= 0.05 ? (
				<AbsoluteFill data-desenfoque={r.toFixed(2)} style={{backdropFilter: `blur(${r}px)`, WebkitBackdropFilter: `blur(${r}px)`}} />
			) : null}
		</AbsoluteFill>
	);
};
