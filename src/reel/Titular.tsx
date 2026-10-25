// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import React, {useEffect, useRef, useState} from 'react';
import {Sequence, useDelayRender} from 'remotion';
import type {Edicion} from '../esquema/edicion';
import {BASE_ALTO, BASE_ANCHO, candidata} from '../estilo/fuentes';
import {cuadrosDe, partirEnDos, pesoReal, renglones, resolverEstiloTitular, tamanoDeLetra} from '../estilo/capas';
import {cargarFuenteCapa} from './Tarjeta';

/**
 * Titular fijo arriba de la cabeza, todo el video. Coordenadas base 1080×1920 (va dentro del contenedor ×4/3).
 *
 * Cómo se ve (medido en 11 de tus reels; ver MEDICIONES_CAPAS en src/estilo/capas.ts): 2 renglones centrados,
 * texto blanco TikTok Sans 800 con CONTORNO negro de ~3 px por fuera y uniones redondas, sin caja y sin sombra medible;
 * mayúsculas de ~47 px, 85 px de línea base a línea base y el centro de las mayúsculas del 1.er renglón en y ≈ 302.
 * Aparece en su primer cuadro sin animación.
 *
 * - Renglones: los del texto ("\n"). Si viene en uno solo y no cabe en ancho_max, se parte en dos lo más parejos posible.
 *   Si un renglón aún no cabe, el titular entero se achica (el centro del 1.er renglón se queda en su lugar).
 * - Se dibuja en SVG (como los subtítulos): el contorno con uniones redondas solo sale bien en SVG; en HTML,
 *   -webkit-text-stroke deja picos en la "A", la "V" y la "W" (probado en el Chrome de Remotion, out/f3-componentes/_sonda).
 * - Para medir los renglones con la fuente real, espera a que cargue (loadFont) y mide con getComputedTextLength;
 *   mientras tanto frena el render con delayRender, así ningún cuadro sale con la medida de otra fuente.
 * - caja.x / caja.y = centro del 1.er renglón; caja.escala = tamaño.
 */

type TitularEdl = NonNullable<Edicion['titular']>;

type Ajuste = {clave: string; lineas: string[]; escala: number};

export type PropsTitular = {
	titular: TitularEdl;
	/** edicion.estilos.titular (objeto libre): lo que traiga pisa los valores por defecto campo por campo. */
	estilo?: unknown;
};

export const Titular: React.FC<PropsTitular> = ({titular, estilo}) => {
	const e = resolverEstiloTitular(estilo);
	const peso = pesoReal(e.fuente, e.peso);
	const familia = `"${candidata(e.fuente).familiaCss}"`;
	const escalaCaja = titular.caja?.escala ?? 1;
	const x = titular.caja?.x ?? e.x;
	const y = titular.caja?.y ?? e.y;
	const tamano = tamanoDeLetra(e.fuente, e.alto_mayuscula_px) * escalaCaja;
	const borde = e.borde_px * escalaCaja;
	const lineasTexto = renglones(titular.texto);
	const clave = JSON.stringify([titular.texto, e.fuente, peso, tamano, borde, e.ancho_max]);

	const {delayRender, continueRender, cancelRender} = useDelayRender();
	const [espera] = useState(() => delayRender('Titular: cargar la fuente y medir los renglones'));
	const [ajuste, setAjuste] = useState<Ajuste | null>(null);
	const medidor = useRef<SVGTextElement>(null);

	useEffect(() => {
		let vivo = true;
		cargarFuenteCapa(e.fuente, peso)
			.then(() => {
				const el = medidor.current;
				if (!vivo || !el) return;
				const medir = (texto: string): number => {
					el.textContent = texto;
					return el.getComputedTextLength();
				};
				let lineas = lineasTexto;
				if (lineas.length === 1 && medir(lineas[0]) + 2 * borde > e.ancho_max) {
					lineas = partirEnDos(lineas[0], medir) ?? lineas;
				}
				const ancho = Math.max(1, ...lineas.map(medir)) + 2 * borde;
				el.textContent = '';
				setAjuste({clave, lineas, escala: Math.min(1, e.ancho_max / ancho)});
			})
			.catch((err) => cancelRender(err));
		return () => {
			vivo = false;
		};
		// La clave junta todo lo que cambia la medida (texto, fuente, peso, tamaño, contorno y ancho máximo).
	}, [clave]);

	useEffect(() => {
		if (ajuste?.clave === clave) continueRender(espera);
	}, [ajuste, clave, espera, continueRender]);
	// Si el titular se desmonta antes de medir (por ejemplo al moverse en el Studio), suelta la espera.
	useEffect(() => () => continueRender(espera), [espera, continueRender]);

	const listo = ajuste?.clave === clave;
	const lineas = listo ? ajuste.lineas : lineasTexto;
	const k = listo ? ajuste.escala : 1;
	const alto = e.alto_mayuscula_px * escalaCaja * k;
	const paso = e.interlineado_px * escalaCaja * k;
	const base0 = y + alto / 2;
	const comunes = {
		fontFamily: familia,
		fontWeight: peso,
		fontStyle: 'normal',
		fontSize: tamano * k,
		style: {fontKerning: 'normal', fontSynthesis: 'none', whiteSpace: 'pre'} as React.CSSProperties,
	};
	const sombra = e.sombra.activa
		? `drop-shadow(0px ${e.sombra.dy_px}px ${e.sombra.desenfoque_px}px ${conOpacidad(e.sombra.color, e.sombra.opacidad)})`
		: undefined;

	return (
		<svg
			data-titular
			width={BASE_ANCHO}
			height={BASE_ALTO}
			viewBox={`0 0 ${BASE_ANCHO} ${BASE_ALTO}`}
			style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', opacity: listo ? 1 : 0, filter: sombra}}
		>
			<text ref={medidor} x={0} y={-1000} visibility="hidden" {...comunes} fontSize={tamano} />
			{lineas.map((linea, i) => (
				<text
					key={i}
					x={x}
					y={base0 + i * paso}
					textAnchor="middle"
					fill={e.color}
					stroke={e.color_borde}
					strokeWidth={2 * borde}
					strokeLinejoin="round"
					strokeLinecap="round"
					paintOrder="stroke fill"
					{...comunes}
				>
					{linea}
				</text>
			))}
		</svg>
	);
};

/** #RRGGBB + opacidad → rgba(). */
function conOpacidad(hex: string, opacidad: number): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacidad})`;
}

export type PropsCapaTitular = {
	titular: Edicion['titular'];
	estilo?: unknown;
};

/** El titular con su tiempo (mismo redondeo a cuadro que Reel.tsx). Sin titular no dibuja nada. */
export const CapaTitular: React.FC<PropsCapaTitular> = ({titular, estilo}) => {
	if (!titular) return null;
	const c = cuadrosDe(titular);
	return (
		<Sequence from={c.desde} durationInFrames={c.duracion} layout="none" name="titular">
			<Titular titular={titular} estilo={estilo} />
		</Sequence>
	);
};
