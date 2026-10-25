// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import React from 'react';
import {AbsoluteFill, Sequence, staticFile} from 'remotion';
import {Audio, Video} from '@remotion/media';
import {aCuadro, dbAGanancia, volumenSfx, type Edicion} from '../esquema/edicion';
import {resolverEstilo} from '../estilo/fuentes';
import {franjaSubtitulos, llevaFranja} from '../estilo/franja';
import {TERMINAL_POR_DEFECTO} from '../estilo/terminal';
import {DemoPantalla} from './DemoPantalla';
import {ConDesenfoque} from './Desenfoque';
import {ConFondoFlotante} from './Flotante';
import {CapaInserts} from './Insert';
import {MotionInsert} from './motion/MotionInsert';
import {CapaStickers} from './Sticker';
import {CapaSubtitulos} from './Subtitulo';
import {CapaTarjetas} from './Tarjeta';
import {TerminalDesdeArchivo} from './TerminalAnimada';
import {CapaPersona, CapaVivo, CapaVivoDetras, SubtitulosVivos, subtitulosNormales} from './TextoVivo';
import {CapaTitular} from './Titular';
import {ConZoom} from './Zoom';

/**
 * Composición del reel. Capas, de abajo hacia arriba:
 *   1. Toma base (tu video) con zoom, fondo de los motion flotantes (push-in + desenfoque + oscurecer, src/reel/Flotante.tsx)
 *      y desenfoque de énfasis — a tamaño de lienzo, fuera de toda Sequence.
 *   2. Contenedor base 1080×1920 escalado ×4/3, donde viven todos los overlays:
 *      inserts (capturas, B-roll, demos de pantalla y de terminal) → franja de legibilidad (solo demos a pantalla
 *      completa, src/estilo/franja.ts) → stickers → tarjetas → titular → subtítulos (los subtítulos van al final: encima de todo).
 *   Con `texto_vivo` (src/reel/TextoVivo.tsx): entre 1 y 2 van lo que va detrás de ti y tu silueta recortada; arriba de
 *   las tarjetas, sus píldoras, notas y tarjetas de UI; y sus subtítulos vivos reemplazan a los normales.
 *   3. Audio: SFX de stickers, tarjetas e inserts en su primer cuadro visible + su offset, y sfx_extra (si traen
 *      duracion_frames, cortados a esa duración con un fundido corto: el tecleo de los prompts).
 * Convención de cajas: caja.x / caja.y = CENTRO en base 1080×1920 (stickers, tarjetas, inserts en tarjeta).
 */

type InsertEdl = Edicion['inserts'][number];

const esTerminal = (i: InsertEdl) => i.tipo === 'demo' && i.asset.endsWith('.terminal.json');
const esDemoPantalla = (i: InsertEdl) => i.tipo === 'demo' && !esTerminal(i);
/** Motion graphic propio (src/reel/motion/): no es archivo, se dibuja con código. */
const esMotion = (i: InsertEdl) => i.tipo === 'motion';

const duracionDe = (desde: number, hasta: number) => Math.max(1, aCuadro(hasta) - aCuadro(desde));

/**
 * ¿Entra justo cuando acaba otro insert (±1 cuadro)? Entonces va en corte, sin fundido de entrada: con fundido se
 * vería tu cara sola un par de cuadros entre los dos (en tus reels un insert pasa al otro en corte).
 */
const pegadoAOtro = (i: InsertEdl, todos: readonly InsertEdl[]) => todos.some((o) => o.id !== i.id && Math.abs(aCuadro(o.hasta) - aCuadro(i.desde)) <= 1);

/** Demo grabada con el estudio (toma.mp4 + eventos.json): zoom al clic, cursor y onda. */
const InsertDemo: React.FC<{insert: InsertEdl}> = ({insert}) => {
	const encuadre = insert.encuadre ?? (insert.layout === 'pantalla-completa' ? 'vertical' : 'horizontal');
	if (insert.layout === 'pantalla-completa') {
		return (
			<div style={{position: 'absolute', left: 0, top: 0}}>
				<DemoPantalla asset={insert.asset} eventos={insert.eventos} layout="pantalla-completa" encuadre={encuadre} trim_desde={insert.trim_desde} ancho={1080} alto={1920} />
			</div>
		);
	}
	const ancho = insert.caja?.w ?? (encuadre === 'horizontal' ? 1000 : 900);
	const alto = insert.caja?.h ?? (encuadre === 'horizontal' ? 625 : 1125);
	const x = insert.caja?.x ?? 540;
	const y = insert.caja?.y ?? 960;
	return (
		<div style={{position: 'absolute', left: x - ancho / 2, top: y - alto / 2}}>
			<DemoPantalla asset={insert.asset} eventos={insert.eventos} layout="tarjeta" encuadre={encuadre} trim_desde={insert.trim_desde} ancho={ancho} alto={alto} />
		</div>
	);
};

/**
 * Demo de terminal animada (guion en demos/<slug>/<x>.terminal.json). La ventana se dibuja a su ancho natural (960) y
 * se escala completa a la caja: la letra crece o se achica con ella y el texto envuelve igual que lo midió el director
 * (medioDe → altoNecesarioTerminal), así no se recorre ni sobra ventana vacía.
 */
const InsertTerminal: React.FC<{insert: InsertEdl; enCorte?: boolean}> = ({insert, enCorte = false}) => {
	const ancho = insert.caja?.w ?? TERMINAL_POR_DEFECTO.ancho;
	const alto = insert.caja?.h ?? TERMINAL_POR_DEFECTO.alto;
	const x = insert.caja?.x ?? 540;
	const y = insert.caja?.y ?? 960;
	const escala = ancho / TERMINAL_POR_DEFECTO.ancho;
	return (
		<div style={{position: 'absolute', left: x - ancho / 2, top: y - alto / 2, width: ancho, height: alto}}>
			<div style={{position: 'absolute', left: 0, top: 0, transform: `scale(${escala})`, transformOrigin: '0 0'}}>
				{/* Redondeado: la caja trae décimas y un alto de 621.9 en vez de 622 le quitaría una fila. */}
				<TerminalDesdeArchivo src={staticFile(insert.asset)} x={0} y={0} ancho={TERMINAL_POR_DEFECTO.ancho} alto={Math.round(alto / escala)} entrada={!enCorte} />
			</div>
		</div>
	);
};

/**
 * Degradado negro detrás de la franja de subtítulos mientras dura una demo a pantalla completa (decisión de
 * legibilidad 2026-10-04, no medida en tus reels: ver src/estilo/franja.ts).
 */
const FranjaLegibilidad: React.FC<{y: number}> = ({y}) => {
	const f = franjaSubtitulos(y);
	return <div data-franja-subtitulos style={{position: 'absolute', left: 0, width: 1080, top: f.top, height: f.alto, background: f.fondo, pointerEvents: 'none'}} />;
};

/**
 * Un SFX que suena en el primer cuadro visible de su elemento, más su offset. Con sfx.duracion_frames (el tecleo de
 * un prompt) su Sequence lo corta a esos cuadros y se apaga con un fundido de FUNDIDO_SFX_CUADROS (volumenSfx).
 */
const Sfx: React.FC<{desde: number; sfx: NonNullable<Edicion['stickers'][number]['sfx']>}> = ({desde, sfx}) => (
	<Sequence from={Math.max(0, aCuadro(desde) + sfx.offset_frames)} durationInFrames={sfx.duracion_frames} layout="none">
		<Audio src={staticFile(sfx.asset)} volume={sfx.duracion_frames === undefined ? dbAGanancia(sfx.ganancia_db) : (f) => volumenSfx(f, sfx)} />
	</Sequence>
);

export const Reel: React.FC<Edicion> = (edicion) => {
	const estilos = edicion.estilos ?? {};
	const inserts = edicion.inserts ?? [];
	const conSonido = [...edicion.stickers, ...(edicion.tarjetas ?? []), ...inserts].filter((x) => x.sfx);

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			<ConDesenfoque efectos={edicion.efectos ?? []}>
				<ConFondoFlotante inserts={inserts}>
					<ConZoom zooms={edicion.zooms}>
						<Video src={staticFile(edicion.base)} objectFit="cover" style={{width: '100%', height: '100%'}} />
					</ConZoom>
				</ConFondoFlotante>
			</ConDesenfoque>

			{/* Texto vivo: lo que va detrás de ti, y tu silueta encima (src/reel/TextoVivo.tsx). */}
			<AbsoluteFill style={{width: 1080, height: 1920, transform: 'scale(1.3333333)', transformOrigin: '0 0'}}>
				<CapaVivoDetras vivo={edicion.texto_vivo} />
			</AbsoluteFill>
			<CapaPersona vivo={edicion.texto_vivo} />

			<AbsoluteFill style={{width: 1080, height: 1920, transform: 'scale(1.3333333)', transformOrigin: '0 0'}}>
				<CapaInserts inserts={inserts.filter((i) => !esTerminal(i) && !esDemoPantalla(i) && !esMotion(i))} estiloTarjetas={estilos.tarjetas} />
				{inserts.filter(esMotion).map((i) => (
					<Sequence key={i.id} from={aCuadro(i.desde)} durationInFrames={duracionDe(i.desde, i.hasta)} layout="none" name={`motion ${i.id}`}>
						<MotionInsert insert={i} duracion={duracionDe(i.desde, i.hasta)} />
					</Sequence>
				))}
				{inserts.filter(esDemoPantalla).map((i) => (
					<Sequence key={i.id} from={aCuadro(i.desde)} durationInFrames={duracionDe(i.desde, i.hasta)} layout="none" name={`demo ${i.id}`}>
						<InsertDemo insert={i} />
					</Sequence>
				))}
				{inserts.filter(esTerminal).map((i) => (
					<Sequence key={i.id} from={aCuadro(i.desde)} durationInFrames={duracionDe(i.desde, i.hasta)} layout="none" name={`terminal ${i.id}`}>
						<InsertTerminal insert={i} enCorte={pegadoAOtro(i, inserts)} />
					</Sequence>
				))}
				{inserts.filter(llevaFranja).map((i) => (
					<Sequence key={`franja-${i.id}`} from={aCuadro(i.desde)} durationInFrames={duracionDe(i.desde, i.hasta)} layout="none" name={`franja ${i.id}`}>
						<FranjaLegibilidad y={resolverEstilo(estilos.subtitulos).y} />
					</Sequence>
				))}
				<CapaStickers stickers={edicion.stickers} estilo={estilos.stickers} />
				<CapaTarjetas tarjetas={edicion.tarjetas ?? []} estilo={estilos.tarjetas} />
				<CapaVivo vivo={edicion.texto_vivo} />
				<CapaTitular titular={edicion.titular} estilo={estilos.titular} />
				<CapaSubtitulos subtitulos={subtitulosNormales(edicion.subtitulos, edicion.texto_vivo)} resaltar={edicion.resaltar_palabras} estilo={estilos.subtitulos} />
				<SubtitulosVivos subtitulos={edicion.subtitulos} resaltar={edicion.resaltar_palabras} vivo={edicion.texto_vivo} />
			</AbsoluteFill>

			{conSonido.map((x) => (
				<Sfx key={`sfx-${x.id}`} desde={x.desde} sfx={x.sfx!} />
			))}
			{edicion.sfx_extra.map((x, i) => (
				<Sfx key={`sfxx-${i}`} desde={x.en} sfx={x.sfx} />
			))}
		</AbsoluteFill>
	);
};
