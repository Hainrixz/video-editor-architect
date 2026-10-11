import React, {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import type {Edicion} from '../esquema/edicion';
import {BASE_ANCHO} from '../estilo/fuentes';
import {FLOTANTE, cajaFlotante, elipsesRetrato, escenaFlotante, fondoEnCuadro, fondoFlotante, intensidadFlotante, tramosFlotante} from '../estilo/flotante';
import {ESCENA} from '../estilo/motion';

/**
 * Envoltura de la toma base para los motion graphics flotantes (layout "flotante", src/estilo/flotante.ts): mientras
 * dura uno, tu toma se acerca apenas (push-in), se desenfoca y se oscurece un poco, con rampas cortas. Tú sigues ahí,
 * detrás de la animación.
 *
 * - El push-in es un transform sobre lo que envuelve (la toma con su zoom); el desenfoque y el brillo van en una capa
 *   con backdrop-filter encima (como ConDesenfoque: filter: blur() oscurece las orillas en el Chrome de Remotion).
 * - Va a nivel del lienzo y fuera de cualquier Sequence (cuadro absoluto), dentro de ConDesenfoque.
 */
export const ConFondoFlotante: React.FC<{inserts: Edicion['inserts']; children: React.ReactNode}> = ({inserts, children}) => {
	const frame = useCurrentFrame();
	const {width, fps} = useVideoConfig();
	const tramos = useMemo(() => tramosFlotante(inserts, fps), [inserts, fps]);
	const k = intensidadFlotante(frame, tramos);
	if (k <= 0.001) return <AbsoluteFill>{children}</AbsoluteFill>;
	const {blur, brillo, escala} = fondoFlotante(k, fondoEnCuadro(frame, tramos));
	const r = blur * (width / BASE_ANCHO);
	// Foco de retrato (motions libres con pista): tu cabeza queda nítida; el desenfoque solo cae en tu cuarto, con una
	// orilla suave para que se lea como profundidad de campo y no como recorte. Lo oscuro va aparte, como una viñeta
	// amplia centrada en ti (si fuera con la misma máscara se vería un halo claro alrededor de tu cabeza).
	const els = elipsesRetrato(frame, tramos, escala);
	const u = width / BASE_ANCHO;
	const filtro = els ? `blur(${r.toFixed(2)}px)` : `blur(${r.toFixed(2)}px) brightness(${brillo.toFixed(3)})`;
	// Cada elipse: transparente adentro (nítido) y negra afuera (desenfocado); se intersectan (lo nítido es la unión
	// de las dos: cráneo + cara y barba).
	// Orilla ancha (~28 % del radio ×1.18 ≈ 70–90 px base): lo que pasa a la altura de tu cara (tus manos) también
	// queda casi nítido; con una orilla corta se veía la mano borrosa encima de la cara nítida (se delataba la máscara).
	const capa = (e: {cx: number; cy: number; rx: number; ry: number}) =>
		`radial-gradient(ellipse ${(e.rx * 1.18 * u).toFixed(1)}px ${(e.ry * 1.18 * u).toFixed(1)}px at ${(e.cx * u).toFixed(1)}px ${(e.cy * u).toFixed(1)}px, transparent 0%, transparent 72%, black 100%)`;
	const mascara = els ? els.map(capa).join(', ') : undefined;
	const vineta = els
		? (() => {
				const e = els[1];
				return `radial-gradient(ellipse ${(e.rx * 2.2 * u).toFixed(1)}px ${(e.ry * 2.0 * u).toFixed(1)}px at ${(e.cx * u).toFixed(1)}px ${(e.cy * u).toFixed(1)}px, rgba(0,0,0,0) 30%, rgba(0,0,0,${(1 - brillo).toFixed(3)}) 100%)`;
			})()
		: undefined;
	return (
		<AbsoluteFill>
			<AbsoluteFill style={{transform: `scale(${escala})`, transformOrigin: '50% 45%'}}>{children}</AbsoluteFill>
			<AbsoluteFill data-fondo-flotante={k.toFixed(2)} data-retrato={els ? '1' : undefined} style={{backdropFilter: filtro, WebkitBackdropFilter: filtro, ...(mascara ? {maskImage: mascara, WebkitMaskImage: mascara, maskComposite: 'intersect', WebkitMaskComposite: 'source-in'} : {})}} />
			{vineta ? <AbsoluteFill style={{background: vineta}} /> : null}
		</AbsoluteFill>
	);
};

/**
 * La escena de un motion flotante (dentro de su Sequence, coordenadas base del contenedor ×4/3): sin fondo de pantalla
 * completa. Detrás, un velo radial oscuro que sigue a la escena (contraste para el texto blanco, sin tapar tu toma);
 * la escena lleva sombra de contacto y entra flotando (escenaFlotante). `dur` = cuadros del insert.
 */
export const EscenaFlotante: React.FC<{caja?: {x?: number; y?: number; escala?: number}; dur: number; children: React.ReactNode}> = ({caja, dur, children}) => {
	const f = useCurrentFrame();
	const c = cajaFlotante(caja);
	const w = c.x1 - c.x0;
	const h = c.y1 - c.y0;
	const e = escenaFlotante(f, dur);
	const cx = (c.x0 + c.x1) / 2;
	const cy = (c.y0 + c.y1) / 2;
	return (
		<AbsoluteFill style={{pointerEvents: 'none'}}>
			<div
				data-velo-flotante
				style={{
					position: 'absolute',
					left: cx - w * 0.85,
					top: cy - h * 0.72,
					width: w * 1.7,
					height: h * 1.44,
					opacity: e.opacidad,
					background: `radial-gradient(ellipse 50% 50% at 50% 50%, rgba(0,0,0,${FLOTANTE.velo}) 0%, rgba(0,0,0,${FLOTANTE.velo * 0.55}) 55%, rgba(0,0,0,0) 100%)`,
				}}
			/>
			<div
				style={{
					position: 'absolute',
					left: c.x0,
					top: c.y0,
					width: w,
					height: h,
					opacity: e.opacidad,
					transform: `translateY(${e.dy}px) scale(${e.escala})`,
					transformOrigin: '50% 60%',
					filter: 'drop-shadow(0 18px 36px rgba(0,0,0,0.45)) drop-shadow(0 2px 6px rgba(0,0,0,0.35))',
				}}
			>
				<div style={{position: 'absolute', left: 0, top: 0, width: ESCENA.ancho, height: ESCENA.alto, transform: `scale(${c.escala})`, transformOrigin: '0 0'}}>{children}</div>
			</div>
		</AbsoluteFill>
	);
};
