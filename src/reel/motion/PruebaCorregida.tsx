import React from 'react';
import {useCurrentFrame} from 'remotion';
import {CURVAS, avance} from '../../estilo/motion';
import {lineaPrueba, type PruebaResuelto} from '../../estilo/motion-libre';
import {FICHA_PRUEBA, VENTANA, bolitaCurva, bump, cabezaLibre, elipseOclusion, poseVentana} from '../../estilo/poses-libres';
import {RESORTES, resorte} from '../../estilo/resorte';
import {graficaCurva, lineaAMano, ovaloAMano, puntoEn, type Trazo} from '../../estilo/trazo';
import {FAMILIA_MONO, FAMILIA_TITULO, FAMILIA_UI} from './comun';
import {Movido, PALETA as P, detrasDeCabeza} from './materiales';

/**
 * "Prueba corregida", rediseño 3 (motion libre, layout flotante; src/estilo/motion-libre.ts y poses-libres.ts).
 *
 * Corte seco del meme a la landing de IA (degradado morado, "Bienvenido a tu nueva experiencia", botón con brillo) en
 * una ventana de navegador YA arriba de tu cabeza, con su entrada corta (sube 40 px, aparece y se enfoca en 6 cuadros);
 * su orilla de abajo se mete detrás de tu coronilla (oclusión) y sigue tu movimiento (paralaje). Nada te cruza la cara.
 *  - "normal": la pluma roja encierra el titular; "porque": tacha el botón; "has": una X sobre los brillos;
 *  - "habilidades": de la orilla de abajo cuelgan dos RANURAS con la forma exacta de las fichas y su etiqueta en
 *    fantasma (lo que le falta);
 *  - "diseño": cae la ficha DISEÑO en su ranura y desde ahí se revela la página arreglada (la MISMA ventana, mismo
 *    layout: titular negro sobre blanco y un botón de verdad);
 *  - "animación": cae ANIMACIÓN y la página baja (scroll) a su sección de animación: la curva ease-out a 640 px con su
 *    etiqueta arriba y una bolita que la recorre en loop dejando estela; luego todo sale hacia arriba y tu cuarto se
 *    enfoca.
 *
 * Coordenadas: px base 1080×1920; la ventana en su propio sistema de 720 × 300.
 */

const W = VENTANA.w;
const H = VENTANA.h;
const BARRA = 40;
const CUERPO = H - BARRA;

// Trazos de la pluma (coordenadas de la ventana).
const OVALO = ovaloAMano(W / 2, BARRA + 74, 260, 58, {extra_grados: 18, semilla: 3});
const TACHON = lineaAMano({x: W / 2 - 150, y: BARRA + 186}, {x: W / 2 + 150, y: BARRA + 170}, 7);
const EQUIS = [lineaAMano({x: W - 104, y: BARRA + 132}, {x: W - 40, y: BARRA + 204}, 4), lineaAMano({x: W - 38, y: BARRA + 134}, {x: W - 106, y: BARRA + 202}, -4)];

// Sección de animación (coordenadas del cuerpo, debajo de la primera sección).
const GRAF = {x: 40, y: 70, w: 640, h: 150} as const;
const CURVA = graficaCurva(CURVAS.salida, GRAF.x, GRAF.y, GRAF.w, GRAF.h);
/** Estela de la bolita: muestras hacia atrás en la curva (fracción de u entre cada una). */
const ESTELA = {n: 7, paso: 0.035} as const;

const cl = (v: number) => Math.min(1, Math.max(0, v));

const Destello: React.FC<{x: number; y: number; r: number}> = ({x, y, r}) => (
	<svg width={r * 2} height={r * 2} viewBox="-1 -1 2 2" style={{position: 'absolute', left: x - r, top: y - r}}>
		<path d="M0 -1 C0.12 -0.12 0.12 -0.12 1 0 C0.12 0.12 0.12 0.12 0 1 C-0.12 0.12 -0.12 0.12 -1 0 C-0.12 -0.12 -0.12 -0.12 0 -1Z" fill="rgba(255,255,255,0.9)" />
	</svg>
);

/** La landing de IA: degradado morado-azul, titular centrado, botón rosa con brillo y destellos. */
const PaginaFea: React.FC = () => (
	<div style={{position: 'absolute', inset: 0, background: 'linear-gradient(135deg, #6D28D9 0%, #4F46E5 48%, #2563EB 100%)', overflow: 'hidden'}}>
		<div style={{position: 'absolute', left: -60, top: -80, width: 300, height: 300, borderRadius: 150, background: 'radial-gradient(circle, rgba(236,72,153,0.55), rgba(236,72,153,0) 70%)'}} />
		<div style={{position: 'absolute', left: 0, right: 0, top: 28, textAlign: 'center', fontFamily: FAMILIA_TITULO, fontWeight: 800, fontSize: 42, lineHeight: 1.08, color: 'white', letterSpacing: -0.6, textShadow: '0 4px 18px rgba(0,0,0,0.25)'}}>
			Bienvenido a tu
			<br />
			nueva experiencia
		</div>
		<div style={{position: 'absolute', left: 0, right: 0, top: 150, display: 'flex', justifyContent: 'center'}}>
			<div style={{padding: '12px 30px', borderRadius: 999, background: 'linear-gradient(90deg, #EC4899, #A855F7)', color: 'white', fontFamily: FAMILIA_UI, fontWeight: 800, fontSize: 26, boxShadow: '0 0 30px rgba(236,72,153,0.7)'}}>Comenzar ahora →</div>
		</div>
		<Destello x={W - 72} y={150} r={16} />
		<Destello x={W - 48} y={110} r={9} />
		<Destello x={70} y={160} r={12} />
	</div>
);

/**
 * La página arreglada: el MISMO layout que la landing (titular centrado, botón al centro) pero en papel, tinta y un
 * botón real; debajo, su sección de animación (la cámara baja con `scroll`). `q(i)` = resorte de cada pieza.
 */
const PaginaBuena: React.FC<{q: (i: number) => number; scroll: number; curva: number; u: number | null}> = ({q, scroll, curva, u}) => {
	const pieza = (i: number, dy: number): React.CSSProperties => {
		const v = q(i);
		return {opacity: cl(v * 2.5), transform: `translateY(${((1 - v) * dy).toFixed(2)}px)`, filter: v < 0.5 ? `blur(${((0.5 - v) * 8).toFixed(2)}px)` : undefined};
	};
	const pt = (v: number) => ({x: GRAF.x + GRAF.w * v, y: GRAF.y + GRAF.h - GRAF.h * CURVAS.salida(v)});
	const bol = u === null ? null : pt(u);
	return (
		<div style={{position: 'absolute', inset: 0, background: P.papelHoja, overflow: 'hidden'}}>
			<div style={{position: 'absolute', left: 0, top: 0, width: W, height: CUERPO * 2, transform: `translateY(${(-CUERPO * scroll).toFixed(2)}px)`}}>
				{/* Sección 1: mismo lugar que la landing fea */}
				<div style={{position: 'absolute', left: 0, right: 0, top: 28, textAlign: 'center', fontFamily: FAMILIA_TITULO, fontWeight: 800, fontSize: 50, lineHeight: 1.02, letterSpacing: -1.6, color: P.tinta, ...pieza(0, 16)}}>
					Diseño que
					<br />
					se siente bien.
				</div>
				<div style={{position: 'absolute', left: 0, right: 0, top: 150, display: 'flex', justifyContent: 'center', gap: 14, ...pieza(1, 14)}}>
					<div style={{padding: '12px 28px', borderRadius: 12, background: P.tinta, color: P.papel, fontFamily: FAMILIA_UI, fontWeight: 700, fontSize: 26, boxShadow: '0 1px 0 rgba(255,255,255,0.15) inset, 0 4px 10px rgba(38,22,10,0.25)'}}>Empezar →</div>
					<div style={{padding: '12px 22px', borderRadius: 12, boxShadow: 'inset 0 0 0 2px rgba(28,24,20,0.28)', color: P.tinta, fontFamily: FAMILIA_UI, fontWeight: 700, fontSize: 26}}>Ver demo</div>
				</div>
				{/* Sección 2: la curva de la animación */}
				<div style={{position: 'absolute', left: 0, top: CUERPO, width: W, height: CUERPO, borderTop: `1.5px solid ${P.linea}`}}>
					<div style={{position: 'absolute', left: GRAF.x, top: 16, right: GRAF.x, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', opacity: cl(curva * 2)}}>
						<span style={{fontFamily: FAMILIA_MONO, fontWeight: 700, fontSize: 30, color: P.tinta, whiteSpace: 'nowrap'}}>ease-out · 200 ms</span>
						<span style={{fontFamily: FAMILIA_MONO, fontWeight: 600, fontSize: 22, color: P.tintaTenue, whiteSpace: 'nowrap'}}>(.23, 1, .32, 1)</span>
					</div>
					<svg width={W} height={CUERPO} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
						<line x1={GRAF.x} y1={GRAF.y + GRAF.h} x2={GRAF.x + GRAF.w} y2={GRAF.y + GRAF.h} stroke="rgba(28,24,20,0.25)" strokeWidth={2} />
						<line x1={GRAF.x} y1={GRAF.y} x2={GRAF.x} y2={GRAF.y + GRAF.h} stroke="rgba(28,24,20,0.25)" strokeWidth={2} />
						<line x1={GRAF.x} y1={GRAF.y + GRAF.h} x2={GRAF.x + GRAF.w} y2={GRAF.y} stroke="rgba(28,24,20,0.18)" strokeWidth={2} strokeDasharray="6 8" />
						{curva > 0 ? <path d={CURVA.d} fill="none" stroke={P.acento} strokeWidth={6} strokeLinecap="round" strokeDasharray={CURVA.largo} strokeDashoffset={CURVA.largo * (1 - curva)} /> : null}
						{bol && u !== null ? (
							<>
								<line x1={bol.x} y1={GRAF.y + GRAF.h} x2={bol.x} y2={bol.y} stroke={P.acento} strokeWidth={2} opacity={0.35} />
								{Array.from({length: ESTELA.n}, (_, k) => {
									const uk = u - (k + 1) * ESTELA.paso;
									if (uk < 0) return null;
									const e = pt(uk);
									return <circle key={k} cx={e.x} cy={e.y} r={9 - k} fill={P.acento} opacity={0.45 * (1 - (k + 1) / (ESTELA.n + 1))} />;
								})}
								<circle cx={bol.x} cy={bol.y} r={11} fill={P.acento} stroke={P.papel} strokeWidth={3} />
							</>
						) : null}
					</svg>
				</div>
			</div>
		</div>
	);
};

/** Un trazo de pluma que se dibuja con avance p; mientras dibuja, la punta de la pluma (plumón rojo) va en la cabeza. */
const TrazoPluma: React.FC<{tr: Trazo; p: number; ancho?: number}> = ({tr, p, ancho = 10}) => {
	if (p <= 0.001) return null;
	const punta = puntoEn(tr, p);
	const dibujando = p < 0.999;
	return (
		<g>
			<path d={tr.d} fill="none" stroke={P.pluma} strokeWidth={ancho} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={tr.largo} strokeDashoffset={tr.largo * (1 - p)} style={{mixBlendMode: 'multiply'}} />
			{dibujando ? (
				<g transform={`translate(${punta.x.toFixed(2)} ${punta.y.toFixed(2)}) rotate(-38)`}>
					<rect x={-7} y={-74} width={14} height={66} rx={5} fill="#2A2420" />
					<rect x={-7} y={-22} width={14} height={14} fill="#B8322A" />
					<path d="M-6 -8 L6 -8 L2 2 L-2 2 Z" fill={P.pluma} />
				</g>
			) : null}
		</g>
	);
};

/**
 * Ranura y ficha: la ranura tiene el tamaño y la forma exactos de la ficha, cuelga de la orilla de abajo de la ventana
 * y muestra su etiqueta en fantasma; la ficha cae desde arriba y la llena (cierra la idea).
 */
const RanuraFicha: React.FC<{x: number; texto: string; hueco: number; cae: number}> = ({x, texto, hueco, cae}) => {
	const caida = resorte(cae, RESORTES.vivo);
	const visible = cae > 0;
	const dy = (1 - Math.min(1, caida)) * -70;
	const golpe = bump(cae - 4, 5);
	const letra: React.CSSProperties = {fontFamily: FAMILIA_UI, fontWeight: 800, fontSize: 28, letterSpacing: '0.05em'};
	if (hueco <= 0.001 && !visible) return null;
	return (
		<div style={{position: 'absolute', left: x, top: H - FICHA_PRUEBA.h / 2, width: FICHA_PRUEBA.w, height: FICHA_PRUEBA.h}}>
			<div style={{position: 'absolute', inset: 0, borderRadius: 14, border: '2.5px dashed rgba(255,255,255,0.8)', background: 'rgba(14,12,20,0.5)', boxSizing: 'border-box', opacity: hueco * (1 - cl(caida * 1.5)), transform: `scale(${(0.94 + 0.06 * hueco).toFixed(4)})`, display: 'flex', alignItems: 'center', justifyContent: 'center', ...letra, color: 'rgba(255,255,255,0.5)'}}>
				{texto}
			</div>
			{visible ? (
				<div
					style={{
						position: 'absolute',
						inset: 0,
						borderRadius: 14,
						background: `linear-gradient(180deg, #FBF7EF, ${P.cartulina})`,
						boxShadow: `inset 0 1.5px 0 rgba(255,255,255,0.9), inset 0 -2px 0 ${P.canto}, 0 ${(4 + 14 * (1 - cl(caida))).toFixed(1)}px ${(10 + 24 * (1 - cl(caida))).toFixed(1)}px rgba(38,22,10,0.35)`,
						opacity: cl(caida * 3),
						transform: `translateY(${dy.toFixed(2)}px) scale(${(1 + 0.04 * golpe).toFixed(4)})`,
						filter: caida < 0.5 ? `blur(${((0.5 - caida) * 10).toFixed(2)}px)` : undefined,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						...letra,
						color: P.tinta,
					}}
				>
					{texto}
				</div>
			) : null}
		</div>
	);
};

/** La ventana del navegador: barra, landing fea, página buena revelada en círculo, pluma y brillo de vidrio. */
const VentanaNavegador: React.FC<{f: number; lt: ReturnType<typeof lineaPrueba>; v: ReturnType<typeof poseVentana>; revela: number; q: (i: number) => number; scroll: number; curva: number; u: number | null; levanta: number}> = ({f, lt, v, revela, q, scroll, curva, u, levanta}) => {
	const origenRevela = {x: -FICHA_PRUEBA.sobresale + FICHA_PRUEBA.w / 2, y: CUERPO};
	// La ventana y su sombra corta sobre la pared (luz de la tira LED arriba a la izquierda).
	return (
			<div style={{position: 'absolute', inset: 0, borderRadius: 16, overflow: 'hidden', background: '#1C1C21', boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 10px 16px 30px rgba(38,22,10,0.38), 3px 5px 10px rgba(38,22,10,0.3)'}}>
				<div style={{position: 'absolute', left: 0, right: 0, top: 0, height: BARRA, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16}}>
					{['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
						<div key={c} style={{width: 12, height: 12, borderRadius: 6, background: c}} />
					))}
					<div style={{position: 'absolute', left: '50%', transform: 'translateX(-50%)', padding: '4px 16px', borderRadius: 8, background: 'rgba(255,255,255,0.08)', fontFamily: FAMILIA_MONO, fontSize: 18, color: 'rgba(255,255,255,0.65)'}}>{revela > 0.4 ? 'estudio.dev' : 'mi-landing-ia.html'}</div>
				</div>
				<div style={{position: 'absolute', left: 0, right: 0, top: BARRA, height: CUERPO, overflow: 'hidden'}}>
					<PaginaFea />
					{revela > 0 ? (
						<div style={{position: 'absolute', inset: 0, clipPath: revela < 1 ? `circle(${(820 * revela).toFixed(1)}px at ${origenRevela.x}px ${origenRevela.y}px)` : undefined}}>
							<PaginaBuena q={q} scroll={scroll} curva={curva} u={u} />
						</div>
					) : null}
				</div>
				{/* Pluma: se levanta (desenfoque) cuando la página se arregla */}
				{levanta < 1 ? (
					<svg width={W} height={H} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: 1 - levanta, filter: levanta > 0 ? `blur(${(6 * levanta).toFixed(2)}px)` : undefined}}>
						<TrazoPluma tr={OVALO} p={avance(f, lt.ovalo, 10, CURVAS.trazo)} />
						<TrazoPluma tr={TACHON} p={avance(f, lt.tachon, 5, CURVAS.trazo)} ancho={11} />
						<TrazoPluma tr={EQUIS[0]} p={avance(f, lt.equis, 4, CURVAS.trazo)} />
						<TrazoPluma tr={EQUIS[1]} p={avance(f, lt.equis + 4, 4, CURVAS.trazo)} />
					</svg>
				) : null}
				{/* Brillo de vidrio que se corre con el giro */}
				<div style={{position: 'absolute', inset: 0, background: `linear-gradient(115deg, rgba(255,255,255,0) ${30 + v.ry * 6}%, rgba(255,255,255,0.10) ${42 + v.ry * 6}%, rgba(255,255,255,0) ${56 + v.ry * 6}%)`, pointerEvents: 'none'}} />
			</div>
	);
};

export const PruebaCorregida: React.FC<{m: PruebaResuelto; dur: number}> = ({m, dur}) => {
	const f = useCurrentFrame();
	const lt = lineaPrueba(m, dur);
	const v = poseVentana(m, f, dur);
	if (v.op <= 0.001) return null;
	// Elipse de oclusión 6 px más abajo y orilla corta: si no, la ventana mostraba una "mordida" borrosa arriba de tu pelo.
	const e0 = elipseOclusion(cabezaLibre(m, f, dur));
	const el = {...e0, cy: e0.cy + 6};

	// La página buena se revela en círculo desde la ranura de DISEÑO (abajo a la izquierda) cuando la ficha aterriza.
	const revela = avance(f, lt.diseno + 3, 9, CURVAS.salida);
	const q = (i: number) => cl(resorte(f - lt.piezas[i], RESORTES.vivo));
	const scroll = avance(f, lt.zoom, 10, CURVAS.mover);
	const curva = avance(f, lt.curva, 12, CURVAS.trazo);
	const u = bolitaCurva(f, lt.bolita);
	const levanta = avance(f, lt.diseno, 6);
	const huecos = avance(f, lt.huecos, 6, CURVAS.salida);
	// La ventana y lo que va encima de ella se dibujan con la misma cámara (posición, giro, perspectiva y desenfoque de
	// movimiento): `capa` envuelve cada parte.
	const capa = (id: string, extra: React.CSSProperties, hijos: React.ReactNode) => (
		<div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, opacity: v.op, filter: v.blur > 0.05 ? `blur(${v.blur.toFixed(2)}px)` : undefined, ...extra}}>
			<Movido id={id} vx={v.vx} vy={v.vy} max={8} caja={{x0: Math.max(0, v.cx - W / 2 - 60), y0: v.cy - H / 2 - 30, x1: Math.min(1080, v.cx + W / 2 + 60), y1: v.cy + H / 2 + 60}}>
				<div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, perspective: 1400, perspectiveOrigin: `${v.cx}px ${v.cy}px`}}>
					<div style={{position: 'absolute', left: v.cx - W / 2, top: v.cy - H / 2, width: W, height: H, transform: `rotateY(${v.ry.toFixed(3)}deg) rotateZ(${v.rz.toFixed(3)}deg)`}}>{hijos}</div>
				</div>
			</Movido>
		</div>
	);

	return (
		<>
			{/* La ventana: DETRÁS de tu cabeza (su orilla de abajo se mete tras tu coronilla) */}
			{capa(
				'm1-ventana',
				detrasDeCabeza(el, 1),
				<VentanaNavegador f={f} lt={lt} v={v} revela={revela} q={q} scroll={scroll} curva={curva} u={u} levanta={levanta} />,
			)}
			{/* Ranuras y fichas: al frente (cuelgan sobre tu pelo, nunca sobre tu cara) */}
			{capa(
				'm1-fichas',
				{},
				<>
					<RanuraFicha x={-FICHA_PRUEBA.sobresale} texto={m.etiquetas.diseno} hueco={huecos} cae={f - lt.diseno} />
					<RanuraFicha x={W - FICHA_PRUEBA.w + FICHA_PRUEBA.sobresale} texto={m.etiquetas.animacion} hueco={huecos} cae={f - lt.animacion} />
				</>,
			)}
		</>
	);
};
