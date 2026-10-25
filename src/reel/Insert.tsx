// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import React from 'react';
import {AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Video} from '@remotion/media';
import {dbAGanancia, type Edicion} from '../esquema/edicion';
import {cuadrosDe, resolverEstiloInsert, resolverEstiloTarjeta, type EstiloInsert, type EstiloTarjeta} from '../estilo/capas';
import {POP_MEDIDO, deslizar, escalaKenBurns, escalaPop, opacidadPop} from '../estilo/animaciones';
import {TarjetaVisual} from './Tarjeta';
import {esMeme, radioMeme} from '../estilo/memes';

/**
 * Inserts de tu material (capturas, B-roll, tomas de tu laptop). Coordenadas base 1080×1920 (dentro del ×4/3).
 *
 * - layout "tarjeta": caja de esquinas redondeadas (24 px) con sombra suave, centrada en caja.x / caja.y; caja.w es el
 *   ancho y caja.h el alto (si no hay alto, sale de la proporción del archivo); caja.escala multiplica. Entra con el
 *   pop de los stickers (como el meme de reel P20); estilo.tarjeta.entrada = "deslizar" (sube 140 px en 6 cuadros)
 *   o "corte" (como la captura de reel P1). Sale con corte seco. Puede tapar la cabeza (tapaCabeza): eso lo
 *   decide el layout, aquí solo se dibuja donde diga la caja.
 * - layout "pantalla-completa": cubre todo el cuadro (object-fit cover), entra y sale con corte y lleva un Ken Burns
 *   lento de 1.00 a 1.06 a lo largo del insert.
 * - tipo "imagen" → Img; "video", "demo" y "brag" → Video de @remotion/media, recortado con trimBefore
 *   (= trim_desde × fps cuadros; en 4.0.532 trimBefore es el vigente y trimAfter está en desuso).
 * - audio: "mute" → sin sonido; "duck" → el sonido del insert a ganancia_db (lo de bajar tu voz va en Reel.tsx).
 * - texto: si viene, va como una tarjeta normal en su lugar de siempre (y ≈ 1274), encima del insert, mientras dure.
 * - Memes (asset en biblioteca/memes/, src/estilo/memes.ts): misma tarjeta, con el radio del meme medido en
 *   reel P20 (≈ 52 px a 770 de ancho, proporcional) y en loop si el clip dura menos que el insert.
 * - El SFX lo pone Reel.tsx.
 */

type InsertEdl = Edicion['inserts'][number];

export type PropsInsert = {
	insert: InsertEdl;
	estilo: EstiloInsert;
	estiloTarjeta: EstiloTarjeta;
};

const Medio: React.FC<{insert: InsertEdl; ajuste: 'cover' | 'auto'}> = ({insert, ajuste}) => {
	const {fps} = useVideoConfig();
	const estilo: React.CSSProperties = ajuste === 'cover' ? {width: '100%', height: '100%', objectFit: 'cover', display: 'block'} : {width: '100%', height: 'auto', display: 'block'};
	if (insert.tipo === 'imagen') {
		return <Img src={staticFile(insert.asset)} style={estilo} />;
	}
	const mudo = insert.audio.modo === 'mute';
	return (
		<Video
			src={staticFile(insert.asset)}
			trimBefore={Math.max(0, Math.round(insert.trim_desde * fps))}
			// Los memes (biblioteca/memes/) son clips de 1–2 s: si el insert dura más, el clip vuelve a empezar.
			loop={esMeme(insert.asset)}
			muted={mudo}
			volume={mudo ? 0 : dbAGanancia(insert.audio.ganancia_db)}
			objectFit={ajuste === 'cover' ? 'cover' : 'contain'}
			style={estilo}
		/>
	);
};

/** Un insert dentro de su Sequence: useCurrentFrame() = cuadros desde que entra. */
export const Insert: React.FC<PropsInsert> = ({insert, estilo, estiloTarjeta}) => {
	const f = useCurrentFrame();
	const {duracion} = cuadrosDe(insert);
	const texto = insert.texto ? (
		<div style={{position: 'absolute', left: estiloTarjeta.x, top: estiloTarjeta.y, transform: 'translate(-50%, -50%)', width: 'max-content', maxWidth: estiloTarjeta.ancho_max}}>
			<TarjetaVisual data-tarjeta={`${insert.id}-texto`} texto={insert.texto} estilo={estiloTarjeta} />
		</div>
	) : null;

	if (insert.layout === 'pantalla-completa') {
		const pc = estilo.pantalla_completa;
		const s = escalaKenBurns(f, duracion, pc.ken_burns_desde, pc.ken_burns_hasta);
		return (
			<AbsoluteFill data-insert={insert.id} style={{overflow: 'hidden', backgroundColor: 'black'}}>
				<AbsoluteFill style={{transform: `scale(${s})`, transformOrigin: '50% 50%'}}>
					<Medio insert={insert} ajuste="cover" />
				</AbsoluteFill>
				{texto}
			</AbsoluteFill>
		);
	}

	const t = estilo.tarjeta;
	const escalaCaja = insert.caja?.escala ?? 1;
	const ancho = (insert.caja?.w ?? t.ancho_px) * escalaCaja;
	const alto = insert.caja?.h !== undefined ? insert.caja.h * escalaCaja : undefined;
	const meme = esMeme(insert.asset);
	let escala = 1;
	let opacidad = 1;
	let dy = 0;
	if (t.entrada === 'pop') {
		escala = escalaPop(f, POP_MEDIDO);
		opacidad = opacidadPop(f, POP_MEDIDO);
	} else if (t.entrada === 'deslizar') {
		const d = deslizar(f, t.deslizar_cuadros, t.deslizar_px);
		dy = d.dy;
		opacidad = d.opacidad;
	}
	const sombra = t.sombra.activa ? `0px ${t.sombra.dy_px}px ${t.sombra.desenfoque_px}px rgba(0, 0, 0, ${t.sombra.opacidad})` : undefined;
	return (
		<>
			<div
				data-insert={insert.id}
				style={{
					position: 'absolute',
					left: insert.caja?.x ?? t.x,
					top: insert.caja?.y ?? t.y,
					width: ancho,
					height: alto,
					transform: `translate(-50%, -50%) translateY(${dy}px) scale(${escala})`,
					transformOrigin: '50% 50%',
					opacity: opacidad,
					borderRadius: meme ? radioMeme(ancho) : t.radio_px,
					overflow: 'hidden',
					boxShadow: sombra,
					backgroundColor: 'black',
				}}
			>
				<Medio insert={insert} ajuste={alto === undefined ? 'auto' : 'cover'} />
			</div>
			{texto}
		</>
	);
};

export type PropsCapaInserts = {
	inserts: Edicion['inserts'];
	/** Estilo de los inserts (no está en edicion.estilos; Reel.tsx puede pasarlo). */
	estilo?: unknown;
	/** edicion.estilos.tarjetas, para el texto de los inserts. */
	estiloTarjetas?: unknown;
};

/** Todos los inserts con su tiempo (mismo redondeo a cuadro que Reel.tsx). */
export const CapaInserts: React.FC<PropsCapaInserts> = ({inserts, estilo, estiloTarjetas}) => {
	const e = resolverEstiloInsert(estilo);
	const et = resolverEstiloTarjeta(estiloTarjetas);
	return (
		<>
			{inserts.map((ins) => {
				const c = cuadrosDe(ins);
				return (
					<Sequence key={ins.id} from={c.desde} durationInFrames={c.duracion} layout="none" name={`insert ${ins.id}`}>
						<Insert insert={ins} estilo={e} estiloTarjeta={et} />
					</Sequence>
				);
			})}
		</>
	);
};
