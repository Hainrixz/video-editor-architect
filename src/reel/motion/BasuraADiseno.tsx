import React from 'react';
import {spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {COLORES_MOTION as C, ESCENA, avance, entrada, lineaBasura, CURVAS, type BasuraResuelto} from '../../estilo/motion';
import {FAMILIA_MONO, FAMILIA_TITULO, FAMILIA_UI} from './comun';

/**
 * "Basura de IA → diseño bueno": una landing genérica de IA (degradado morado, sombras pesadas, botones chuecos) y,
 * en `cambio_s`, un barrido naranja de izquierda a derecha (ease-in-out fuerte, 15 cuadros) la reemplaza por una UI
 * oscura y sobria. Cada pieza de la UI buena nace desde el lugar "chueco" de la fea y se acomoda con un resorte de
 * rebote sutil, escalonadas 2 cuadros. La etiqueta de arriba cambia con fundido + desenfoque (el truco de Emil para
 * que el cambio de estado se lea como uno solo). Escena 810 × 980.
 */

const CARD = {top: 112, alto: 820, radio: 38} as const;

const Destello: React.FC<{x: number; y: number; tam: number; color: string; rot?: number}> = ({x, y, tam, color, rot = 0}) => (
	<svg width={tam} height={tam} viewBox="0 0 24 24" style={{position: 'absolute', left: x, top: y, transform: `rotate(${rot}deg)`}}>
		<path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0Z" fill={color} />
	</svg>
);

/** La landing fea (genérica de IA). */
export const Fea: React.FC = () => {
	const sombra = '0 18px 30px rgba(0,0,0,0.45)';
	const boton = (texto: string, fondo: string, color: string, rot: number, dy: number, radio: number): React.ReactNode => (
		<div style={{padding: '20px 30px', background: fondo, color, borderRadius: radio, fontFamily: FAMILIA_UI, fontWeight: 800, fontSize: 26, boxShadow: `${sombra}, 0 0 28px ${fondo}`, transform: `translateY(${dy}px) rotate(${rot}deg)`, textShadow: '0 2px 0 rgba(0,0,0,0.25)'}}>{texto}</div>
	);
	return (
		<div style={{position: 'absolute', inset: 0, background: 'linear-gradient(135deg, #7C3AED 0%, #DB2777 52%, #F97316 100%)', boxShadow: 'inset 0 0 0 6px rgba(255,255,255,0.35)'}}>
			<Destello x={640} y={150} tam={54} color="#FDE047" rot={12} />
			<Destello x={70} y={320} tam={36} color="#FFFFFF" />
			<Destello x={690} y={470} tam={30} color="#A7F3D0" rot={-20} />
			<Destello x={110} y={610} tam={44} color="#FDE047" rot={30} />
			{/* nav apretada */}
			<div style={{position: 'absolute', left: 36, right: 30, top: 36, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: FAMILIA_UI, fontWeight: 800, color: 'white', textShadow: '0 3px 0 rgba(0,0,0,0.3)'}}>
				<div style={{fontSize: 32}}>AI·Genius Pro</div>
				<div style={{display: 'flex', gap: 10, fontSize: 19}}>
					<span>Inicio</span>
					<span style={{transform: 'translateY(7px)'}}>Funciones</span>
					<span>Precios</span>
					<span style={{transform: 'translateY(-5px)'}}>¡Contacto!</span>
				</div>
			</div>
			{/* titular centrado y gritón */}
			<div style={{position: 'absolute', left: 40, right: 40, top: 170, textAlign: 'center', fontFamily: FAMILIA_UI, fontWeight: 800, fontSize: 60, lineHeight: 1.08, color: 'white', textShadow: '0 6px 18px rgba(0,0,0,0.45), 0 0 30px rgba(255,255,255,0.35)'}}>
				¡Revoluciona tu flujo de trabajo con <span style={{color: '#FDE047'}}>IA!</span>
			</div>
			<div style={{position: 'absolute', left: 70, right: 70, top: 396, textAlign: 'center', fontFamily: FAMILIA_UI, fontWeight: 600, fontSize: 24, lineHeight: 1.3, color: 'rgba(255,255,255,0.72)'}}>
				La plataforma todo-en-uno impulsada por inteligencia artificial de última generación para potenciar tu productividad
			</div>
			{/* botones chuecos */}
			<div style={{position: 'absolute', left: 0, right: 0, top: 540, display: 'flex', justifyContent: 'center', gap: 18}}>
				{boton('Empezar ahora', '#22C55E', '#052e16', -3, 0, 10)}
				{boton('Ver más', '#FACC15', '#3f2d00', 2.5, 16, 999)}
				{boton('Saber más', '#22D3EE', '#083344', -1.5, -6, 0)}
			</div>
			{/* tarjetitas desalineadas */}
			<div style={{position: 'absolute', left: 40, right: 40, top: 680, display: 'flex', justifyContent: 'space-between'}}>
				{[
					{t: 'Rápido', c: '#F472B6', dy: 0, rot: -2},
					{t: 'Seguro', c: '#60A5FA', dy: 18, rot: 1.5},
					{t: 'Inteligente', c: '#34D399', dy: 6, rot: -1},
				].map((x) => (
					<div key={x.t} style={{width: 222, padding: '18px 16px', background: 'white', borderRadius: 18, display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 16px 30px rgba(0,0,0,0.4)', transform: `translateY(${x.dy}px) rotate(${x.rot}deg)`}}>
						<div style={{width: 34, height: 34, borderRadius: 17, background: x.c}} />
						<span style={{fontFamily: FAMILIA_UI, fontWeight: 800, fontSize: 24, color: '#1f2937'}}>{x.t}</span>
					</div>
				))}
			</div>
		</div>
	);
};

/** La UI buena. `q(i)` = avance del resorte (0 → 1) de la pieza i; nace desde su desacomodo y se acomoda. */
const Buena: React.FC<{q: (i: number) => number}> = ({q}) => {
	const pieza = (i: number, dx: number, dy: number, rot: number): React.CSSProperties => {
		const v = q(i);
		return {transform: `translate(${(1 - v) * dx}px, ${(1 - v) * dy}px) rotate(${(1 - v) * rot}deg)`};
	};
	return (
		<div style={{position: 'absolute', inset: 0, background: '#0D0D10', boxShadow: `inset 0 0 0 1px ${C.lineaFuerte}`}}>
			<div style={{position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 60% 45% at 88% 0%, rgba(217,119,87,0.20), rgba(0,0,0,0) 70%)'}} />
			{/* nav */}
			<div style={{position: 'absolute', left: 56, right: 56, top: 46, display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...pieza(0, 0, -14, -1.5)}}>
				<div style={{display: 'flex', alignItems: 'center', gap: 14}}>
					<div style={{width: 34, height: 34, borderRadius: 10, background: `linear-gradient(140deg, #F0A487, ${C.acento})`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35)'}} />
					<span style={{fontFamily: FAMILIA_UI, fontWeight: 700, fontSize: 27, color: C.texto, letterSpacing: -0.4}}>Estudio</span>
				</div>
				<div style={{display: 'flex', gap: 30, fontFamily: FAMILIA_UI, fontWeight: 600, fontSize: 22, color: C.tenue}}>
					<span>Trabajo</span>
					<span>Notas</span>
					<span>Contacto</span>
				</div>
			</div>
			<div style={{position: 'absolute', left: 56, right: 56, top: 118, height: 1, background: C.linea}} />
			{/* kicker */}
			<div style={{position: 'absolute', left: 56, top: 170, ...pieza(1, -16, 12, -3)}}>
				<div style={{display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderRadius: 999, boxShadow: `inset 0 0 0 1px ${C.lineaFuerte}`, background: 'rgba(255,255,255,0.03)', fontFamily: FAMILIA_UI, fontWeight: 600, fontSize: 20, color: C.tenue}}>
					<div style={{width: 8, height: 8, borderRadius: 4, background: C.acento}} />
					Nuevo · Animaciones
				</div>
			</div>
			{/* titular */}
			<div style={{position: 'absolute', left: 56, right: 56, top: 236, fontFamily: FAMILIA_TITULO, fontWeight: 700, fontSize: 82, lineHeight: 1.0, letterSpacing: -2.6, color: C.texto, ...pieza(2, 0, 26, -2)}}>
				Diseño que se
				<br />
				<span style={{color: '#CFCFD6'}}>siente bien.</span>
			</div>
			<div style={{position: 'absolute', left: 56, width: 600, top: 432, fontFamily: FAMILIA_UI, fontWeight: 600, fontSize: 27, lineHeight: 1.45, color: C.tenue, ...pieza(3, 12, 20, 1.5)}}>
				Movimiento con intención, espacios claros y detalles que se notan.
			</div>
			{/* botones alineados */}
			<div style={{position: 'absolute', left: 56, top: 568, display: 'flex', gap: 16, ...pieza(4, -10, 26, 3)}}>
				<div style={{padding: '19px 32px', borderRadius: 14, background: '#F5F5F7', color: '#0B0B0D', fontFamily: FAMILIA_UI, fontWeight: 700, fontSize: 25, boxShadow: '0 1px 0 rgba(255,255,255,0.4) inset, 0 8px 24px rgba(0,0,0,0.35)'}}>Empezar</div>
				<div style={{padding: '19px 30px', borderRadius: 14, boxShadow: `inset 0 0 0 1px ${C.lineaFuerte}`, color: C.texto, fontFamily: FAMILIA_UI, fontWeight: 600, fontSize: 25}}>Ver demo</div>
			</div>
			{/* tokens de diseño */}
			<div style={{position: 'absolute', left: 56, right: 56, top: 690, display: 'flex', gap: 14, ...pieza(5, 0, 30, -2)}}>
				{[
					{k: 'Curva', v: 'ease-out'},
					{k: 'Duración', v: '200 ms'},
					{k: 'Ritmo', v: '60 fps'},
				].map((x) => (
					<div key={x.k} style={{flex: 1, padding: '16px 18px', borderRadius: 16, background: 'rgba(255,255,255,0.035)', boxShadow: `inset 0 0 0 1px ${C.linea}`}}>
						<div style={{fontFamily: FAMILIA_UI, fontWeight: 600, fontSize: 17, color: C.tenue, marginBottom: 6}}>{x.k}</div>
						<div style={{fontFamily: FAMILIA_MONO, fontWeight: 700, fontSize: 25, color: C.texto}}>{x.v}</div>
					</div>
				))}
			</div>
		</div>
	);
};

const Etiqueta: React.FC<{texto: string; color: string; opacidad: number; y: number; blur: number}> = ({texto, color, opacidad, y, blur}) => (
	<div style={{position: 'absolute', left: 0, right: 0, top: 18, display: 'flex', justifyContent: 'center', opacity: opacidad, transform: `translateY(${y}px)`, filter: blur > 0.05 ? `blur(${blur}px)` : undefined}}>
		<div style={{display: 'flex', alignItems: 'center', gap: 14, padding: '14px 28px 14px 22px', borderRadius: 999, background: `${color}1F`, boxShadow: `inset 0 0 0 1.5px ${color}73`}}>
			<div style={{width: 14, height: 14, borderRadius: 7, background: color, boxShadow: `0 0 14px ${color}`}} />
			<span style={{fontFamily: FAMILIA_UI, fontWeight: 700, fontSize: 34, color: C.texto, letterSpacing: -0.3}}>{texto}</span>
		</div>
	</div>
);

export const BasuraADiseno: React.FC<{m: BasuraResuelto}> = ({m}) => {
	const f = useCurrentFrame();
	const {fps} = useVideoConfig();
	const lt = lineaBasura(m);

	const tarjeta = entrada(f, 0, 10, 30, 0.96);
	// Barrido: ease-in-out (se mueve en pantalla), 15 cuadros.
	const pb = avance(f, lt.cambio, lt.barrido, CURVAS.mover);
	const corte = 100 * (1 - pb);
	// Un "respiro" mínimo de la tarjeta durante el barrido (se siente como que la arreglan).
	const respiro = 1 - 0.014 * Math.sin(Math.PI * pb);
	// Piezas de la UI buena: resorte con rebote sutil, escalonadas 2 cuadros desde que el barrido va a la mitad.
	const q = (i: number) => spring({frame: f - (lt.cambio + 4 + i * 2), fps, config: {damping: 15, stiffness: 150, mass: 0.9}});

	// Etiquetas: la vieja sale (6 cuadros) y la nueva entra después (no se enciman: sin doble exposición).
	const sale = avance(f, lt.cambio, 6);
	const entra = avance(f, lt.cambio + 6, 9);
	const x = (1 - corte / 100) * ESCENA.ancho;

	return (
		<div style={{position: 'absolute', left: 0, top: 0, width: ESCENA.ancho, height: ESCENA.alto}}>
			<Etiqueta texto={m.antes} color={C.rojo} opacidad={(1 - sale) * tarjeta.opacidad} y={-10 * sale + tarjeta.y * 0.5} blur={4 * sale} />
			{f >= lt.cambio + 6 ? <Etiqueta texto={m.despues} color={C.verde} opacidad={entra} y={10 * (1 - entra)} blur={4 * (1 - entra)} /> : null}
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: CARD.top,
					width: ESCENA.ancho,
					height: CARD.alto,
					borderRadius: CARD.radio,
					overflow: 'hidden',
					opacity: tarjeta.opacidad,
					transform: `translateY(${tarjeta.y}px) scale(${tarjeta.escala * respiro})`,
					boxShadow: '0 40px 100px rgba(0,0,0,0.6), 0 10px 30px rgba(0,0,0,0.35)',
				}}
			>
				<Fea />
				{f >= lt.cambio ? (
					<div style={{position: 'absolute', inset: 0, clipPath: `inset(0 ${corte}% 0 0)`}}>
						<Buena q={q} />
					</div>
				) : null}
				{/* Filo del barrido: una línea naranja con brillo, solo mientras barre */}
				{pb > 0 && pb < 1 ? (
					<div style={{position: 'absolute', top: 0, bottom: 0, left: x - 2, width: 4, background: '#FFD2BF', boxShadow: `0 0 18px 4px ${C.acento}, 0 0 60px 10px rgba(217,119,87,0.45)`}} />
				) : null}
			</div>
		</div>
	);
};
