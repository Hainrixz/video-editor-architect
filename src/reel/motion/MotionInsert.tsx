import React from 'react';
import {AbsoluteFill, Sequence, staticFile, useCurrentFrame} from 'remotion';
import {Audio} from '@remotion/media';
import {dbAGanancia} from '../../esquema/edicion';
import {intensidadLibre} from '../../estilo/poses-libres';
import type {LibreResuelto} from '../../estilo/motion-libre';
import type {Edicion} from '../../esquema/edicion';
import {CENTRO_PANTALLA, COLORES_MOTION as C, ESCENA, TARJETA_MOTION, cajaMotion, resolverMotion, type MotionResuelto} from '../../estilo/motion';
import {BasuraADiseno} from './BasuraADiseno';
import {FondoMotion, cargarFuentesMotion} from './comun';
import {ReglasApple} from './ReglasApple';
import {SkillsInstaladas} from './SkillsInstaladas';
import {EscenaFlotante} from '../Flotante';
import {Grano} from './materiales';
import {PantallaAObjeto} from './PantallaAObjeto';
import {PlantillaApple} from './PlantillaApple';
import {PruebaCorregida} from './PruebaCorregida';

/**
 * Insert de tipo "motion" (dentro de su Sequence; coordenadas base 1080×1920 del contenedor ×4/3 de Reel.tsx).
 *
 * - pantalla-completa: fondo oscuro desde el cuadro 0 (entra y sale en corte, como tus inserts) y la escena de
 *   810 × 980 centrada en (540, 740): todo lo legible queda en x 135–945, y 250–1230, dentro de la zona segura y
 *   arriba de tus tarjetas, stickers y subtítulos.
 * - flotante (src/estilo/flotante.ts): sin fondo; tu toma sigue detrás, desenfocada (Flotante.tsx → ConFondoFlotante)
 *   y la escena flota encima con un velo radial y sombra; por defecto en (540, 740), caja.x / caja.y / caja.escala la mueven.
 * - tarjeta: panel oscuro redondeado (por defecto 810 px de ancho, centro y ≈ 940 como tus memes en tarjeta; tapa la
 *   cara a propósito) con la escena escalada a su ancho.
 */

type InsertEdl = Edicion['inserts'][number];

const Escena: React.FC<{m: MotionResuelto}> = ({m}) => {
	if (m.nombre === 'skills-instaladas') return <SkillsInstaladas m={m} />;
	if (m.nombre === 'basura-a-diseno') return <BasuraADiseno m={m} />;
	if (m.nombre === 'reglas-apple') return <ReglasApple m={m} />;
	return null;
};

/**
 * Motion LIBRE (src/estilo/motion-libre.ts): sin escena ni velo; cada pieza vive en px base 1080×1920 anclada a tu
 * cabeza, con su propia entrada y salida. Encima, el grano (sigue a la rampa del fondo flotante) y sus SFX por golpe.
 */
const EscenaLibre: React.FC<{m: LibreResuelto; dur: number; id: string}> = ({m, dur, id}) => {
	const f = useCurrentFrame();
	const k = intensidadLibre(f, dur);
	return (
		<AbsoluteFill style={{width: 1080, height: 1920, pointerEvents: 'none'}}>
			{m.nombre === 'prueba-corregida' ? <PruebaCorregida m={m} dur={dur} /> : m.nombre === 'plantilla-apple' ? <PlantillaApple m={m} dur={dur} /> : <PantallaAObjeto m={m} dur={dur} />}
			<Grano id={id} semilla={f + 1} opacidad={0.06 * k} />
			{m.sfx.map((s, i) => (
				<Sequence key={`sfx-${i}`} from={s.cuadro} layout="none">
					<Audio src={staticFile(s.asset)} volume={dbAGanancia(s.ganancia_db)} />
				</Sequence>
			))}
		</AbsoluteFill>
	);
};

export const MotionInsert: React.FC<{insert: InsertEdl; duracion?: number}> = ({insert, duracion}) => {
	cargarFuentesMotion();
	if (!insert.motion) return null;
	const m = resolverMotion(insert.motion, insert.desde);
	const dur = duracion ?? Math.max(1, Math.round((insert.hasta - insert.desde) * 30));

	if (m.nombre === 'prueba-corregida' || m.nombre === 'plantilla-apple' || m.nombre === 'pantalla-a-objeto') {
		return (
			<div data-insert={insert.id} data-motion={m.nombre} data-layout="flotante">
				<EscenaLibre m={m} dur={dur} id={insert.id} />
			</div>
		);
	}

	if (insert.layout === 'flotante') {
		return (
			<div data-insert={insert.id} data-motion={m.nombre} data-layout="flotante">
				<EscenaFlotante caja={insert.caja} dur={duracion ?? Math.max(1, Math.round((insert.hasta - insert.desde) * 30))}>
					<Escena m={m} />
				</EscenaFlotante>
			</div>
		);
	}

	if (insert.layout === 'pantalla-completa') {
		return (
			<AbsoluteFill data-insert={insert.id} data-motion={m.nombre} style={{overflow: 'hidden'}}>
				<FondoMotion />
				<div style={{position: 'absolute', left: CENTRO_PANTALLA.x - ESCENA.ancho / 2, top: CENTRO_PANTALLA.y - ESCENA.alto / 2, width: ESCENA.ancho, height: ESCENA.alto}}>
					<Escena m={m} />
				</div>
			</AbsoluteFill>
		);
	}

	const caja = cajaMotion('tarjeta', insert.caja);
	const w = caja.x1 - caja.x0;
	const h = caja.y1 - caja.y0;
	// Margen interior proporcional; la escena se escala para caber (sin deformarse) y se centra.
	const pad = 36 * (w / TARJETA_MOTION.ancho);
	const escala = Math.min((w - 2 * pad) / ESCENA.ancho, (h - 2 * pad) / ESCENA.alto);
	return (
		<div
			data-insert={insert.id}
			data-motion={m.nombre}
			style={{
				position: 'absolute',
				left: caja.x0,
				top: caja.y0,
				width: w,
				height: h,
				borderRadius: TARJETA_MOTION.radio,
				overflow: 'hidden',
				background: C.fondo,
				boxShadow: `0 0 0 1px ${C.lineaFuerte}, 0 30px 80px rgba(0,0,0,0.55)`,
			}}
		>
			<FondoMotion />
			<div style={{position: 'absolute', left: (w - ESCENA.ancho * escala) / 2, top: (h - ESCENA.alto * escala) / 2, width: ESCENA.ancho, height: ESCENA.alto, transform: `scale(${escala})`, transformOrigin: '0 0'}}>
				<Escena m={m} />
			</div>
		</div>
	);
};
