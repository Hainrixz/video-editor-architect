// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import React from 'react';

/**
 * Materiales de los motion graphics flotantes (src/estilo/motion-libre.ts): papel, cartulina, vidrio claro, tinta,
 * sombras cafés con la luz de tu cuarto (la tira LED de arriba a la izquierda → brillos arriba a la izquierda, sombras
 * abajo a la derecha), grano para que lo dibujado se case con el ruido del iPhone y el desenfoque de movimiento por
 * muestreo. Todo es función del cuadro (sin estado). Valores de diseño [D], no medidos en tus reels.
 */

export const PALETA = {
	tinta: '#1C1814',
	tintaTenue: '#6B6157',
	papel: '#FBF8F2',
	papelHoja: '#F6F1E8',
	cartulina: '#F2EDE4',
	canto: '#D8CDBD',
	vidrio: 'rgba(255, 248, 238, 0.86)',
	vidrioBorde: 'rgba(255, 255, 255, 0.7)',
	pluma: '#E0452F',
	ambar: '#F3C969',
	enfoque: '#FFD60A',
	acento: '#C4623F',
	linea: 'rgba(28, 24, 20, 0.12)',
} as const;

/** Sombra café en capas (cercana + lejana); `elev` 0–1 = qué tan levantado. dx = 0.3·dy (la luz viene de arriba a la izquierda). */
export function sombraObjeto(elev: number, fuerza = 1): string {
	const e = Math.max(0, elev);
	const dy = 6 + 28 * e;
	const blur = 14 + 50 * e;
	return `0 1.5px 3px rgba(38,22,10,${(0.22 * fuerza).toFixed(3)}), ${(0.3 * dy).toFixed(1)}px ${dy.toFixed(1)}px ${blur.toFixed(1)}px rgba(38,22,10,${(0.3 * fuerza).toFixed(3)})`;
}

/** Vidrio claro esmerilado (sin backdrop-filter: dentro de 3D lo aplana): crema translúcida, filo brillante arriba. */
export function estiloVidrio(elev = 0.4, radio = 18): React.CSSProperties {
	return {
		background: PALETA.vidrio,
		borderRadius: radio,
		boxShadow: `inset 0 1.5px 0 rgba(255,255,255,0.9), inset 0 0 0 1px ${PALETA.vidrioBorde}, ${sombraObjeto(elev, 0.8)}`,
	};
}

/**
 * Grano de película encima del motion (feTurbulence, semilla = cuadro: se mueve como el ruido de la cámara), en
 * overlay y muy bajo. `opacidad` ya trae la intensidad del flotante.
 */
export const Grano: React.FC<{id: string; semilla: number; opacidad: number}> = ({id, semilla, opacidad}) => {
	if (opacidad <= 0.002) return null;
	const fid = `grano-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	return (
		<svg width={1080} height={1920} style={{position: 'absolute', left: 0, top: 0, opacity: opacidad, mixBlendMode: 'overlay', pointerEvents: 'none'}}>
			<filter id={fid} x="0" y="0" width="100%" height="100%">
				<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={semilla % 997} stitchTiles="stitch" />
				<feColorMatrix type="saturate" values="0" />
			</filter>
			<rect width="100%" height="100%" filter={`url(#${fid})`} />
		</svg>
	);
};

/**
 * Desenfoque de movimiento por muestreo: dibuja la capa en t, t − ½·obturador/(n−1)… (obturador en cuadros, 0.5 =
 * 180°) y las promedia (la más vieja abajo a opacidad 1, cada nueva encima a 1/(i+1)). Solo en vuelos rápidos.
 */
export const Estela: React.FC<{t: number; activo: boolean; muestras?: number; obturador?: number; children: (t: number) => React.ReactNode}> = ({t, activo, muestras = 4, obturador = 0.5, children}) => {
	if (!activo || muestras < 2) return <>{children(t)}</>;
	const capas: React.ReactNode[] = [];
	for (let i = 0; i < muestras; i++) {
		const k = muestras - 1 - i; // de la más vieja a la actual
		const tk = t - (k * obturador) / (muestras - 1);
		capas.push(
			<div key={i} style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, opacity: 1 / (i + 1)}}>
				{children(tk)}
			</div>,
		);
	}
	return <>{capas}</>;
};

/** Texto que entra palabra por palabra con desenfoque (8 → 0 px), sube `dy` y aparece; `p(i)` = avance 0–1 de la palabra i. */
export const PalabrasConDesenfoque: React.FC<{texto: string; p: (i: number) => number; dy?: number; style?: React.CSSProperties}> = ({texto, p, dy = 12, style}) => (
	<span style={{display: 'inline-flex', flexWrap: 'wrap', columnGap: '0.28em', ...style}}>
		{texto.split(/\s+/).map((w, i) => {
			const v = Math.min(1, Math.max(0, p(i)));
			return (
				<span key={`${w}-${i}`} style={{display: 'inline-block', opacity: v, transform: `translateY(${((1 - v) * dy).toFixed(2)}px)`, filter: v < 0.99 ? `blur(${((1 - v) * 8).toFixed(2)}px)` : undefined}}>
					{w}
				</span>
			);
		})}
	</span>
);

/**
 * Desenfoque de movimiento DIRECCIONAL (una sola copia, sin franjas): un feGaussianBlur solo a lo largo de la
 * velocidad (vx, vy en px base por cuadro). Obturador de 180°: la estela mide media velocidad; la desviación es ~1/2.4
 * de eso. Gira el contenedor a la dirección del movimiento, desenfoca en x y lo regresa. Sin velocidad, no hace nada.
 */
export const Movido: React.FC<{id: string; vx: number; vy: number; max?: number; caja?: {x0: number; y0: number; x1: number; y1: number}; children: React.ReactNode}> = ({id, vx, vy, max = 18, caja, children}) => {
	const v = Math.hypot(vx, vy);
	const std = Math.min(max, (0.5 * v) / 2.4);
	const lleno: React.CSSProperties = {position: 'absolute', left: 0, top: 0, width: 1080, height: 1920};
	if (std < 0.35) return <div style={lleno}>{children}</div>;
	const ang = (Math.atan2(vy, vx) * 180) / Math.PI;
	const fid = `movido-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	// El filtro va en una caja del tamaño de la pieza (no del lienzo): en cajas enormes Chrome baja la resolución del
	// filtro y salen franjas. Sin `caja`, el lienzo entero.
	const b = caja ?? {x0: 0, y0: 0, x1: 1080, y1: 1920};
	const w = b.x1 - b.x0;
	const h = b.y1 - b.y0;
	const origen = `${(w / 2).toFixed(1)}px ${(h / 2).toFixed(1)}px`;
	return (
		<div style={lleno}>
			<svg width={0} height={0} style={{position: 'absolute'}}>
				<filter id={fid} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
					<feGaussianBlur stdDeviation={`${std.toFixed(2)} 0`} />
				</filter>
			</svg>
			<div style={{position: 'absolute', left: b.x0, top: b.y0, width: w, height: h, transformOrigin: origen, transform: `rotate(${ang.toFixed(2)}deg)`, filter: `url(#${fid})`}}>
				<div style={{position: 'absolute', left: 0, top: 0, width: w, height: h, transformOrigin: origen, transform: `rotate(${(-ang).toFixed(2)}deg)`}}>
					<div style={{position: 'absolute', left: -b.x0, top: -b.y0, width: 1080, height: 1920}}>{children}</div>
				</div>
			</div>
		</div>
	);
};

/**
 * Máscara de oclusión: lo que lleva este estilo queda DETRÁS de tu cabeza (la elipse de cara.json, px base). `fuerza`
 * 0–1 (0 = encima de todo, 1 = detrás). Orilla corta (4 %) porque tu cabeza está nítida.
 */
export function detrasDeCabeza(el: {cx: number; cy: number; rx: number; ry: number}, fuerza: number): React.CSSProperties {
	if (fuerza <= 0.001) return {};
	const a = (1 - Math.min(1, fuerza)).toFixed(3);
	const m = `radial-gradient(ellipse ${el.rx.toFixed(1)}px ${el.ry.toFixed(1)}px at ${el.cx.toFixed(1)}px ${el.cy.toFixed(1)}px, rgba(0,0,0,${a}) 0%, rgba(0,0,0,${a}) 96%, black 100%)`;
	return {maskImage: m, WebkitMaskImage: m};
}

/**
 * Oclusión con tu cabeza ENTERA (cráneo + cara y barba, `elipsesDeCabeza`): lo que lleva este estilo queda detrás de
 * ti de la coronilla a la barba. Las dos capas se intersectan (lo visible es lo que queda fuera de las dos).
 */
export function detrasDeCabezaEntera(els: ReadonlyArray<{cx: number; cy: number; rx: number; ry: number}>, fuerza: number): React.CSSProperties {
	if (fuerza <= 0.001) return {};
	const a = (1 - Math.min(1, fuerza)).toFixed(3);
	const m = els.map((el) => `radial-gradient(ellipse ${el.rx.toFixed(1)}px ${el.ry.toFixed(1)}px at ${el.cx.toFixed(1)}px ${el.cy.toFixed(1)}px, rgba(0,0,0,${a}) 0%, rgba(0,0,0,${a}) 92%, black 100%)`).join(', ');
	return {maskImage: m, WebkitMaskImage: m, maskComposite: 'intersect', WebkitMaskComposite: 'source-in'} as React.CSSProperties;
}
