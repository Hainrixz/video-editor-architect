import React, {useMemo} from 'react';
import {Freeze, useCurrentFrame} from 'remotion';
import {CURVAS, avance} from '../../estilo/motion';
import {FICHA_SKILL, cursorVisible, lineaPantalla, lugaresSkills, piezasComando, type PantallaResuelto} from '../../estilo/motion-libre';
import {bump, cabezaLibre, cajaCrece, elipsesDeCabeza, poseComando, posePantalla, poseSkill} from '../../estilo/poses-libres';
import {RESORTES, resorte} from '../../estilo/resorte';
import {DemoPantalla} from '../DemoPantalla';
import {FAMILIA_MONO} from './comun';
import {Movido, PALETA as P, detrasDeCabezaEntera, sombraObjeto} from './materiales';

/**
 * "La pantalla se vuelve objeto", rediseño 3 (motion libre, layout flotante; src/estilo/motion-libre.ts y
 * poses-libres.ts). Viene justo después de la demo de GitHub a pantalla completa:
 *  - cuadro 0: la demo tal cual (continuidad); desde el cuadro 1 la pantalla queda DETRÁS de tu cabeza entera y se
 *    recorta hacia arriba a la derecha mientras se aleja: nunca pasa a media opacidad ni desenfocada sobre tu cara;
 *  - el comando baja de su lugar en la demo a tu pecho (6 cuadros), en una ficha de terminal oscura; en "instalas" la
 *    tecla return se hunde y la ficha se va;
 *  - de la pantalla salen las skills como cartas que se reparten (oscuras, mono claro): la estrella al frente y
 *    nítida, las otras detrás, más chicas, giradas y con desenfoque de profundidad; en "literalmente" laten;
 *  - poco antes de "Claude" la caja blanca de la tarjeta crece desde su cursor; las cartas caen en ella por tu
 *    costado izquierdo (nunca por tu cara) y el cursor late con cada una; la tarjeta real sigue en el siguiente cuadro.
 *
 * Tu cabeza queda nítida (foco de retrato en Flotante.tsx). Coordenadas: px base 1080×1920.
 */

const cl = (v: number) => Math.min(1, Math.max(0, v));

const Pantalla: React.FC<{m: PantallaResuelto; t: number; dur: number}> = ({m, t, dur}) => {
	const pa = posePantalla(m, t, dur);
	if (pa.op <= 0.001) return null;
	const els = elipsesDeCabeza(cabezaLibre(m, t, dur));
	const c = m.comando_en_demo;
	const hueco = avance(t, 1, 3);
	const atras = posePantalla(m, t - 0.5, dur);
	const R = pa.recorte;
	const recortado = R.x0 > 0.5 || R.y1 < 1919.5;
	return (
		<div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, opacity: pa.op, filter: pa.blur > 0.05 ? `blur(${pa.blur.toFixed(2)}px)` : undefined, ...(pa.detras ? detrasDeCabezaEntera(els, 1) : {})}}>
			<div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, clipPath: recortado ? `inset(${R.y0.toFixed(1)}px ${(1080 - R.x1).toFixed(1)}px ${(1920 - R.y1).toFixed(1)}px ${R.x0.toFixed(1)}px round ${(34 * pa.p).toFixed(1)}px)` : undefined}}>
				<Movido id="m3-pantalla" vx={(pa.cx - atras.cx) * 2} vy={(pa.cy - atras.cy) * 2} max={6} caja={{x0: Math.max(0, pa.cx - 560 * pa.s - 30), y0: Math.max(0, pa.cy - 980 * pa.s - 30), x1: Math.min(1080, pa.cx + 560 * pa.s + 30), y1: Math.min(1920, pa.cy + 980 * pa.s + 30)}}>
					<div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, perspective: 1500, perspectiveOrigin: `${pa.cx}px ${pa.cy}px`}}>
						<div
							style={{
								position: 'absolute',
								left: 0,
								top: 0,
								width: 1080,
								height: 1920,
								overflow: 'hidden',
								borderRadius: (34 * pa.p) / pa.s,
								transformOrigin: '50% 50%',
								transform: `translate3d(${(pa.cx - 540).toFixed(2)}px, ${(pa.cy - 960).toFixed(2)}px, ${pa.z.toFixed(1)}px) rotateX(${(5 * pa.p).toFixed(3)}deg) rotateY(${(-12 * pa.p).toFixed(3)}deg) scale(${pa.s.toFixed(4)})`,
								boxShadow: pa.p > 0.02 ? `0 0 0 ${(2.5 / pa.s).toFixed(2)}px rgba(255,255,255,${(0.35 * pa.p).toFixed(3)}), ${(18 / pa.s).toFixed(1)}px ${(26 / pa.s).toFixed(1)}px ${(60 / pa.s).toFixed(1)}px rgba(38,22,10,${(0.45 * pa.p).toFixed(3)})` : undefined,
								background: '#0d1117',
							}}
						>
							{m.demo ? (
								<Freeze frame={m.demo.cuadro}>
									<DemoPantalla asset={m.demo.asset} eventos={m.demo.eventos} layout="pantalla-completa" encuadre={m.demo.encuadre ?? 'vertical'} trim_desde={m.demo.trim_desde} ancho={1080} alto={1920} />
								</Freeze>
							) : (
								<div style={{position: 'absolute', left: c.x0, top: c.y0, fontFamily: FAMILIA_MONO, fontSize: (c.y1 - c.y0) * 0.62, color: '#e6edf3', whiteSpace: 'pre'}}>{m.comando}</div>
							)}
							{/* El hueco que deja el comando: vacío oscuro con contorno punteado ("de aquí salió") */}
							<div style={{position: 'absolute', left: c.x0 - 14, top: c.y0 - 10, width: c.x1 - c.x0 + 28, height: c.y1 - c.y0 + 20, borderRadius: 10, background: '#0d1117', opacity: hueco, outline: `${(2 / Math.max(0.3, pa.s)).toFixed(1)}px dashed rgba(230,237,243,0.75)`, outlineOffset: -2}} />
							<div style={{position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(255,255,255,0.12), rgba(255,255,255,0) 40%)', opacity: pa.p}} />
						</div>
					</div>
				</Movido>
			</div>
		</div>
	);
};

const FichaComando: React.FC<{m: PantallaResuelto; t: number; dur: number}> = ({m, t, dur}) => {
	const {ficha} = piezasComando(m.comando);
	const co = poseComando(m, t, dur);
	if (co.op <= 0.001) return null;
	const anchoTexto = m.comando.length * ficha.letra * 0.6;
	// Mientras baja pasa DETRÁS de tu cabeza (sale de la pantalla, que ya está detrás de ti) y aparece en tu pecho.
	const els = elipsesDeCabeza(cabezaLibre(m, t, dur));
	return (
		<div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, ...detrasDeCabezaEntera(els, 1)}}>
			<Movido id="m3-comando" vx={co.vx} vy={co.vy} max={6} caja={{x0: Math.max(0, ficha.x0 + co.dx - 120), y0: ficha.y0 + co.dy - 60, x1: Math.min(1080, ficha.x1 + co.dx + 120), y1: ficha.y1 + co.dy + 60}}>
				<div
					style={{
						position: 'absolute',
						left: ficha.x0,
						top: ficha.y0,
						width: ficha.x1 - ficha.x0,
						height: ficha.y1 - ficha.y0,
						transformOrigin: `${22 + anchoTexto / 2}px 50%`,
						transform: `translate(${co.dx.toFixed(2)}px, ${co.dy.toFixed(2)}px) scale(${co.k.toFixed(4)}, ${(co.k * (1 - 0.3 * co.rompe)).toFixed(4)})`,
						opacity: co.op,
						filter: co.blur > 0.05 ? `blur(${co.blur.toFixed(2)}px)` : undefined,
						borderRadius: 14,
						background: '#0D1117',
						boxShadow: `inset 0 1px 0 rgba(255,255,255,0.10), 0 0 0 1px rgba(255,255,255,0.16), ${sombraObjeto(0.5, 1.1)}`,
					}}
				>
					<div style={{position: 'absolute', left: 22, top: 0, bottom: 0, display: 'flex', alignItems: 'center', fontFamily: FAMILIA_MONO, fontWeight: 600, fontSize: ficha.letra, whiteSpace: 'pre', color: '#E6EDF3'}}>{m.comando}</div>
				</div>
			</Movido>
		</div>
	);
};

/** Tecla return física: tapa crema sobre su base, recorrido de 10 px; se hunde en "instalas" y se va con la ficha. */
const Tecla: React.FC<{m: PantallaResuelto; t: number; dur: number}> = ({m, t, dur}) => {
	const lt = lineaPantalla(m, dur);
	const {tecla} = piezasComando(m.comando);
	if (t < lt.tecla) return null;
	const e = resorte(t - lt.tecla, RESORTES.vivo);
	const baja = t < lt.hunde ? 0 : t < lt.hunde + 3 ? avance(t, lt.hunde, 3) : Math.max(-0.08, 1 - resorte(t - (lt.hunde + 3), RESORTES.vivo));
	const sale = avance(t, lt.rompe + 2, 6, CURVAS.mover);
	if (sale >= 1) return null;
	const w = tecla.x1 - tecla.x0;
	const h = tecla.y1 - tecla.y0;
	const recorrido = 10;
	return (
		<div style={{position: 'absolute', left: tecla.x0, top: tecla.y0, width: w, height: h, opacity: cl(e * 2) * (1 - sale), transform: `translateY(${((1 - Math.min(1, e)) * 16 + 24 * sale).toFixed(2)}px) scale(${(0.94 + 0.06 * Math.min(1, e)).toFixed(4)})`, filter: sale > 0 ? `blur(${(6 * sale).toFixed(2)}px)` : undefined}}>
			<div style={{position: 'absolute', left: 0, right: 0, top: recorrido, bottom: 0, borderRadius: 18, background: 'linear-gradient(180deg, #D8CFC1, #C2B8A8)', boxShadow: sombraObjeto(0.35 - 0.25 * baja, 0.9)}} />
			<div
				style={{
					position: 'absolute',
					left: 3,
					right: 3,
					top: recorrido * baja,
					height: h - recorrido - 4,
					borderRadius: 15,
					background: 'linear-gradient(180deg, #F4EFE6, #E2DACD)',
					boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,0.95), inset 0 -2px 0 rgba(38,22,10,0.10)',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
				}}
			>
				<svg width={40} height={30} viewBox="0 0 26 20" fill="none" stroke={P.tinta} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
					<path d="M22 2 V10 H5" />
					<path d="M10 5 L5 10 L10 15" />
				</svg>
			</div>
		</div>
	);
};

/** Cartas de skill: terminal oscura, mono claro; la estrella con su rótulo "skill" y un filo de acento arriba. */
const Skills: React.FC<{m: PantallaResuelto; t: number; dur: number}> = ({m, t, dur}) => {
	const fichas = useMemo(() => lugaresSkills(m.skills), [m.skills]);
	// Las de atrás primero (z): la estrella al final para que quede encima.
	const orden = fichas.map((fi, i) => ({fi, i})).sort((a, b) => Number(a.fi.estrella) - Number(b.fi.estrella));
	return (
		<>
			{orden.map(({fi, i}) => {
				const s = poseSkill(m, fi, i, t, dur);
				if (s.op <= 0.001) return null;
				const elev = fi.estrella ? 0.9 : 0.45;
				return (
					<Movido key={fi.texto} id={`m3-skill-${i}`} vx={s.vx} vy={s.vy} max={6} caja={{x0: Math.max(0, s.x - fi.w / 2 - 60), y0: s.y - fi.h / 2 - 60, x1: Math.min(1080, s.x + fi.w / 2 + 60), y1: s.y + fi.h / 2 + 60}}>
						<div
							style={{
								position: 'absolute',
								left: 0,
								top: 0,
								width: fi.w,
								height: fi.h,
								transform: `translate(${(s.x - fi.w / 2).toFixed(2)}px, ${(s.y - fi.h / 2).toFixed(2)}px) rotate(${s.rot.toFixed(2)}deg) scale(${s.escala.toFixed(4)})`,
								opacity: s.op,
								filter: s.blur > 0.1 ? `blur(${s.blur.toFixed(2)}px)` : undefined,
								borderRadius: fi.estrella ? 18 : 14,
								background: fi.estrella ? 'linear-gradient(180deg, #1A1F27, #0D1117)' : '#11151B',
								boxShadow: `inset 0 1px 0 rgba(255,255,255,${fi.estrella ? 0.16 : 0.08}), 0 0 0 1px rgba(255,255,255,${fi.estrella ? 0.22 : 0.12}), ${sombraObjeto(elev, 1.2)}`,
								display: 'flex',
								flexDirection: 'column',
								justifyContent: 'center',
								alignItems: fi.mas ? 'center' : 'flex-start',
								padding: `0 ${FICHA_SKILL.pad}px`,
								boxSizing: 'border-box',
								overflow: 'hidden',
							}}
						>
							{fi.estrella ? <div style={{position: 'absolute', left: 0, right: 0, top: 0, height: 3, background: P.acento}} /> : null}
							{fi.rotulo ? <div style={{fontFamily: FAMILIA_MONO, fontWeight: 600, fontSize: FICHA_SKILL.rotulo, color: '#8B949E', lineHeight: 1.2, marginBottom: 4}}>{fi.rotulo}</div> : null}
							<span style={{fontFamily: FAMILIA_MONO, fontWeight: fi.estrella ? 700 : 600, fontSize: fi.letra, lineHeight: 1.25, color: fi.mas ? '#8B949E' : '#F0F3F6', whiteSpace: 'nowrap'}}>{fi.texto}</span>
						</div>
					</Movido>
				);
			})}
		</>
	);
};

/**
 * La caja blanca de la tarjeta: crece desde su cursor hacia la derecha poco antes de "Claude" (ease-out, 7 cuadros),
 * espera con el cursor parpadeando y recibe las cartas; el cursor late con cada una. En el último cuadro mide lo que la
 * tarjeta real, que sigue escribiendo en el cuadro siguiente.
 */
const CajaYCursor: React.FC<{m: PantallaResuelto; t: number; dur: number}> = ({m, t, dur}) => {
	const lt = lineaPantalla(m, dur);
	const caja = cajaCrece(m, t, dur);
	if (!caja) return null;
	const k = t - lt.cursor;
	const fijo = t >= lt.convergen[0];
	const visible = fijo || cursorVisible(k);
	const late = Math.max(0, ...lt.convergen.map((c) => bump(t - (c + 5), 5)));
	const entra = avance(t, lt.caja, 3);
	return (
		<>
			<div style={{position: 'absolute', left: caja.x0, top: caja.y0, width: caja.x1 - caja.x0, height: caja.y1 - caja.y0, borderRadius: 14, background: 'white', opacity: entra, boxShadow: `0 ${(2 + 8 * late).toFixed(1)}px ${(10 + 16 * late).toFixed(1)}px rgba(38,22,10,${(0.22 + 0.15 * late).toFixed(3)})`}} />
			<div
				style={{
					position: 'absolute',
					left: m.cursor.x,
					top: m.cursor.y - (m.cursor.alto * 0.8) / 2,
					width: 4,
					height: m.cursor.alto * 0.8,
					borderRadius: 2,
					background: P.tinta,
					opacity: visible ? entra : 0,
					transform: `scaleY(${(1 + 0.3 * late).toFixed(3)})`,
				}}
			/>
		</>
	);
};

export const PantallaAObjeto: React.FC<{m: PantallaResuelto; dur: number}> = ({m, dur}) => {
	const t = useCurrentFrame();
	return (
		<div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920}}>
			<Pantalla m={m} t={t} dur={dur} />
			<FichaComando m={m} t={t} dur={dur} />
			<Tecla m={m} t={t} dur={dur} />
			<CajaYCursor m={m} t={t} dur={dur} />
			<Skills m={m} t={t} dur={dur} />
		</div>
	);
};

