import React from 'react';
import {spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {COLORES_MOTION as C, ESCENA, entrada, lineaApple, type AppleResuelto} from '../../estilo/motion';
import {FAMILIA_MONO, FAMILIA_TITULO, FAMILIA_UI, LogoMono} from './comun';

/**
 * "Reglas de diseño de Apple": logo y título arriba; debajo, 3–4 principios como tarjetas de vidrio oscuro que llegan
 * desde atrás (perspectiva: inclinadas en X, más chicas y más abajo) y se asientan con un resorte de rebote sutil,
 * escalonadas 4 cuadros. Profundidad real: la sombra crece mientras la tarjeta "se acerca". Escena 810 × 980.
 */

const ICONOS: Array<React.FC<{c: string}>> = [
	// Claridad: un ojo / apertura
	({c}) => (
		<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
			<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
			<circle cx="12" cy="12" r="3.2" />
		</svg>
	),
	// Deferencia: el contenido al frente (marco con bloque)
	({c}) => (
		<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="3" width="18" height="18" rx="4" />
			<rect x="7" y="7" width="10" height="7" rx="1.5" fill={c} fillOpacity="0.9" stroke="none" />
			<path d="M7 17.5h6" />
		</svg>
	),
	// Profundidad: capas
	({c}) => (
		<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 3 2.5 8 12 13l9.5-5L12 3Z" />
			<path d="m2.5 12.5 9.5 5 9.5-5" />
			<path d="m2.5 17 9.5 5 9.5-5" />
		</svg>
	),
	// Cuarto principio (genérico): rejilla / consistencia
	({c}) => (
		<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="3" width="7.5" height="7.5" rx="2" />
			<rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
			<rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
			<rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
		</svg>
	),
];

export const ReglasApple: React.FC<{m: AppleResuelto}> = ({m}) => {
	const f = useCurrentFrame();
	const {fps} = useVideoConfig();
	const lt = lineaApple(m);
	const n = m.principios.length;
	const cab = entrada(f, lt.encabezado, 10, 20, 0.96);
	const logo = spring({frame: f, fps, config: {damping: 14, stiffness: 170, mass: 0.8}});

	const altoTarjeta = n === 4 ? 158 : 192;
	const hueco = n === 4 ? 20 : 26;
	const top0 = 262;

	return (
		<div style={{position: 'absolute', left: 0, top: 0, width: ESCENA.ancho, height: ESCENA.alto, perspective: 1400, perspectiveOrigin: '50% 20%'}}>
			{/* Encabezado */}
			<div style={{position: 'absolute', left: 0, right: 0, top: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22}}>
				<div style={{opacity: Math.min(1, logo * 1.4), transform: `scale(${0.9 + 0.1 * logo})`}}>
					{m.logo ? <LogoMono src={m.logo} tam={88} color={C.texto} style={{filter: 'drop-shadow(0 6px 24px rgba(255,255,255,0.18))'}} /> : null}
				</div>
				<div style={{fontFamily: FAMILIA_TITULO, fontWeight: 700, fontSize: 60, letterSpacing: -1.6, lineHeight: 1.05, color: C.texto, textAlign: 'center', opacity: cab.opacidad, transform: `translateY(${cab.y}px)`}}>{m.titulo}</div>
			</div>

			{/* Principios */}
			{m.principios.map((p, i) => {
				const s = spring({frame: f - lt.tarjetas[i], fps, config: {damping: 17, stiffness: 160, mass: 1}});
				const visible = f >= lt.tarjetas[i];
				const Icono = ICONOS[Math.min(i, ICONOS.length - 1)];
				const top = top0 + i * (altoTarjeta + hueco);
				return (
					<div
						key={`${p.titulo}-${i}`}
						style={{
							position: 'absolute',
							left: 0,
							top,
							width: ESCENA.ancho,
							height: altoTarjeta,
							opacity: visible ? Math.min(1, s * 1.6) : 0,
							transform: `translateY(${(1 - s) * 70}px) translateZ(${(1 - s) * -160}px) rotateX(${(1 - s) * 24}deg)`,
							transformOrigin: '50% 100%',
						}}
					>
						<div
							style={{
								position: 'absolute',
								inset: 0,
								borderRadius: 30,
								background: 'linear-gradient(180deg, rgba(38,38,44,0.92), rgba(20,20,24,0.92))',
								boxShadow: `inset 0 1px 0 rgba(255,255,255,0.10), inset 0 0 0 1px ${C.linea}, 0 ${10 + 22 * s}px ${30 + 40 * s}px rgba(0,0,0,${0.3 + 0.25 * s})`,
								display: 'flex',
								alignItems: 'center',
								gap: 30,
								padding: '0 40px 0 30px',
							}}
						>
							<div style={{width: altoTarjeta - 64, height: altoTarjeta - 64, borderRadius: 24, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(160deg, rgba(217,119,87,0.30), rgba(217,119,87,0.10))', boxShadow: 'inset 0 0 0 1px rgba(217,119,87,0.45), inset 0 1px 0 rgba(255,255,255,0.18)'}}>
								<Icono c="#FBD5C6" />
							</div>
							<div style={{flex: 1, minWidth: 0}}>
								<div style={{fontFamily: FAMILIA_UI, fontWeight: 800, fontSize: n === 4 ? 46 : 52, letterSpacing: -1, color: C.texto, lineHeight: 1.05}}>{p.titulo}</div>
								<div style={{fontFamily: FAMILIA_UI, fontWeight: 600, fontSize: n === 4 ? 24 : 27, color: C.tenue, marginTop: 8}}>{p.nota}</div>
							</div>
							<div style={{fontFamily: FAMILIA_MONO, fontWeight: 500, fontSize: 24, color: 'rgba(255,255,255,0.28)', alignSelf: 'flex-start', marginTop: 30}}>{String(i + 1).padStart(2, '0')}</div>
						</div>
					</div>
				);
			})}
		</div>
	);
};
