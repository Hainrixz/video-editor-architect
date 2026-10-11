import React, {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {aCuadro, type Edicion} from '../esquema/edicion';
import {BASE_ANCHO} from '../estilo/fuentes';
import {ZOOM_POR_DEFECTO} from '../estilo/capas';
import {estadoZoomEn, planZoom, type ZoomCuadros} from '../estilo/animaciones';

/**
 * Envoltura de la toma base: le aplica el zoom activo (edicion.zooms) alrededor de su origen (base 1080×1920).
 *
 * - transicion "corte": punch-in de golpe en `desde` y de vuelta a 1 de golpe en `hasta`.
 * - transicion "suave": entra con un resorte críticamente amortiguado (sin sobrepaso) en 8 cuadros desde `desde` y
 *   sale con el mismo resorte de modo que en `hasta` ya está en 1. Si el zoom dura poco, cada rampa se recorta.
 * - Zooms seguidos o encimados: el siguiente parte del estado en que iba el anterior (sin saltos ni vuelta a 1).
 * - El origen se limita al cuadro y la escala nunca baja de 1: nunca se ven las orillas de la toma.
 *
 * Va a nivel del lienzo (1440×2560), NO dentro del contenedor ×4/3 de los overlays, y fuera de cualquier Sequence:
 * usa el cuadro absoluto de la composición. Los overlays (titular, tarjetas, stickers, subtítulos) no se mueven.
 */

export type PropsConZoom = {
	zooms: Edicion['zooms'];
	children: React.ReactNode;
	/** Cuadros de las rampas "suave" (por defecto 8, supuesto). */
	cuadrosSuave?: number;
};

/** Pasa los zooms de la EDL (segundos) a cuadros, con el mismo redondeo que el resto de Reel.tsx. */
export function zoomsEnCuadros(zooms: Edicion['zooms']): ZoomCuadros[] {
	return zooms.map((z) => ({
		desde: aCuadro(z.desde),
		hasta: aCuadro(z.hasta),
		escala: z.escala,
		origen: z.origen,
		// Remotion no valida las props al renderizar: si la EDL no trae transición, vale la de por defecto del contrato.
		transicion: z.transicion === 'corte' ? 'corte' : 'suave',
	}));
}

export const ConZoom: React.FC<PropsConZoom> = ({zooms, children, cuadrosSuave = ZOOM_POR_DEFECTO.cuadros_suave}) => {
	const frame = useCurrentFrame();
	const {width} = useVideoConfig();
	const plan = useMemo(() => planZoom(zoomsEnCuadros(zooms), cuadrosSuave), [zooms, cuadrosSuave]);
	const e = estadoZoomEn(frame, plan);
	// Del espacio base (1080 de ancho) al del lienzo real.
	const k = width / BASE_ANCHO;
	const identidad = e.escala === 1 && e.tx === 0 && e.ty === 0;
	return (
		<AbsoluteFill
			data-zoom={identidad ? '1' : e.escala.toFixed(4)}
			style={identidad ? undefined : {transform: `translate(${e.tx * k}px, ${e.ty * k}px) scale(${e.escala})`, transformOrigin: '0 0'}}
		>
			{children}
		</AbsoluteFill>
	);
};
