import React from 'react';
import {staticFile} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {archivoFuente} from '../../estilo/fuentes';
import {FUENTE_TERMINAL} from '../../estilo/terminal';
import {COLORES_MOTION} from '../../estilo/motion';
import {cargarFuentesTerminal} from '../TerminalAnimada';

/**
 * Piezas compartidas de los motion graphics: fuentes, fondo oscuro, logos monocromos y la palomita que se dibuja.
 * Fuentes del proyecto (OFL, biblioteca/fuentes/): Inter para texto de UI, Instrument Sans para titulares (la de tu
 * titular) y JetBrains Mono para la terminal. Se registran con métricas normales (no las de los subtítulos).
 */

export const FAMILIA_UI = 'Editor Motion Inter';
export const FAMILIA_TITULO = 'Editor Motion Display';
export const FAMILIA_MONO = FUENTE_TERMINAL.familiaCss;

const cargadas = new Set<string>();

/** Registra una vez por pestaña las fuentes de los motion (loadFont frena el render hasta que cargan). */
export function cargarFuentesMotion(): void {
	cargarFuentesTerminal();
	const pedidos: Array<{familia: string; id: 'inter' | 'instrument-sans'; peso: number}> = [
		{familia: FAMILIA_UI, id: 'inter', peso: 600},
		{familia: FAMILIA_UI, id: 'inter', peso: 700},
		{familia: FAMILIA_UI, id: 'inter', peso: 800},
		{familia: FAMILIA_TITULO, id: 'instrument-sans', peso: 600},
		{familia: FAMILIA_TITULO, id: 'instrument-sans', peso: 700},
	];
	for (const p of pedidos) {
		const llave = `${p.familia}:${p.peso}`;
		if (cargadas.has(llave)) continue;
		cargadas.add(llave);
		loadFont({family: p.familia, url: staticFile(archivoFuente(p.id, p.peso).ruta), weight: String(p.peso), style: 'normal', display: 'block'});
	}
}

/** Fondo de pantalla completa: casi negro, un brillo cálido arriba y una rejilla de puntos que se desvanece. Estático. */
export const FondoMotion: React.FC = () => (
	<>
		<div style={{position: 'absolute', inset: 0, background: COLORES_MOTION.fondo}} />
		<div style={{position: 'absolute', inset: 0, background: `radial-gradient(ellipse 80% 45% at 50% 18%, ${COLORES_MOTION.fondoBrillo}, rgba(0,0,0,0) 70%)`}} />
		<div
			style={{
				position: 'absolute',
				inset: 0,
				backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1.4px, rgba(0,0,0,0) 1.6px)',
				backgroundSize: '36px 36px',
				WebkitMaskImage: 'radial-gradient(ellipse 75% 55% at 50% 38%, black 20%, transparent 80%)',
				maskImage: 'radial-gradient(ellipse 75% 55% at 50% 38%, black 20%, transparent 80%)',
			}}
		/>
	</>
);

/** Logo monocromo pintado con máscara (sirve con SVG de simple-icons o PNG con alfa): toma el color que le pidas. */
export const LogoMono: React.FC<{src: string; tam: number; color: string; style?: React.CSSProperties}> = ({src, tam, color, style}) => {
	const url = `url("${staticFile(src)}")`;
	return (
		<div
			style={{
				width: tam,
				height: tam,
				backgroundColor: color,
				WebkitMaskImage: url,
				maskImage: url,
				WebkitMaskSize: 'contain',
				maskSize: 'contain',
				WebkitMaskRepeat: 'no-repeat',
				maskRepeat: 'no-repeat',
				WebkitMaskPosition: 'center',
				maskPosition: 'center',
				flexShrink: 0,
				...style,
			}}
		/>
	);
};

/**
 * Palomita en círculo que se dibuja: el círculo entra (0.9 → 1 + opacidad) y el trazo avanza con `p` de 0 a 1.
 * El trazo va con strokeDashoffset (sin animar tamaño ni layout).
 */
export const Palomita: React.FC<{tam: number; p: number; color?: string}> = ({tam, p, color = COLORES_MOTION.verde}) => {
	const largo = 20;
	const circulo = Math.min(1, p * 2.2);
	const trazo = Math.max(0, Math.min(1, (p - 0.25) / 0.75));
	return (
		<svg width={tam} height={tam} viewBox="0 0 32 32" style={{flexShrink: 0, opacity: circulo, transform: `scale(${0.9 + 0.1 * circulo})`}}>
			<circle cx="16" cy="16" r="15" fill={`${color}24`} stroke={`${color}66`} strokeWidth="1.5" />
			<path d="M9.5 16.5 L14 21 L22.5 11.5" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={largo} strokeDashoffset={largo * (1 - trazo)} />
		</svg>
	);
};
