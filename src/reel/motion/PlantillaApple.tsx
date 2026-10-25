// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import React from 'react';
import {useCurrentFrame} from 'remotion';
import {CURVAS, avance} from '../../estilo/motion';
import {SALIDA_FICHA, lineaPlantilla, type PlantillaResuelto} from '../../estilo/motion-libre';
import {cabezaLibre, lugaresPlantilla, opacidadReticula} from '../../estilo/poses-libres';
import {RESORTES, resorte} from '../../estilo/resorte';
import {interpolarTrazos, superelipse, trazoDe, type Punto} from '../../estilo/trazo';
import {FAMILIA_MONO, FAMILIA_UI, LogoMono} from './comun';
import {PALETA as P, PalabrasConDesenfoque, estiloVidrio} from './materiales';

/**
 * "Te enfoca Apple", rediseño 3 (motion libre, layout flotante; src/estilo/motion-libre.ts). En "reglas" cuatro
 * esquinas blancas de enfoque se cierran sobre tu cara (de 1.3 a 1, pulsan dos veces, como el enfoque del iPhone); en
 * "diseño" se unen en el contorno del ícono y la retícula interna de Apple (diagonales, ejes, círculos) destella
 * encima de ti a lo mucho a 0.35 de opacidad y se va en ≤ 12 cuadros: lo que se queda es la superelipse de afuera,
 * que no te cruza la cara. En "Apple" las esquinas pasan a curvatura continua y arriba se escribe "Human Interface
 * Guidelines"; en "para que te ayude" salen tres reglas concretas (44 pt, 1024 px, 22.37 %) en fichas de vidrio con
 * líneas guía desde el contorno. La cota "1024" va arriba de tu pelo. Sale escalonado: fichas (4 cuadros cada una),
 * contorno y foco.
 *
 * Coordenadas: px base 1080×1920, centradas en tu cara cuadro por cuadro (pista de cara.json).
 */

const BLANCO = 'rgba(255,255,255,0.92)';
/** Grosor de las guías y de la superelipse final [D]: la plantilla se lee en el teléfono (antes 1.6 px era ruido). */
const GUIA = 2.4;
const CONTORNO = 5;
const cl = (v: number) => Math.min(1, Math.max(0, v));
const bump = (x: number, largo: number) => (x <= 0 || x >= largo ? 0 : Math.sin((Math.PI * x) / largo));

/** Un trazo que se dibuja: avance p (0–1) con strokeDashoffset. */
const Dibujo: React.FC<{d: string; largo: number; p: number; ancho?: number; color?: string}> = ({d, largo, p, ancho = GUIA, color = BLANCO}) =>
	p > 0.001 ? <path d={d} fill="none" stroke={color} strokeWidth={ancho} strokeLinecap="round" strokeDasharray={largo} strokeDashoffset={largo * (1 - cl(p))} /> : null;

const circulo = (c: Punto, r: number) => {
	const pts: Punto[] = [];
	for (let i = 0; i <= 96; i++) {
		const a = -Math.PI / 2 + (2 * Math.PI * i) / 96;
		pts.push({x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a)});
	}
	return trazoDe(pts);
};

export const PlantillaApple: React.FC<{m: PlantillaResuelto; dur: number}> = ({m, dur}) => {
	const t = useCurrentFrame();
	const lt = lineaPlantilla(m, dur);
	// La plantilla te SIGUE cuadro por cuadro (pista de cara.json suavizada); sin pista, el ancla fija.
	const cab = cabezaLibre(m, t, dur);
	const c = {x: cab.cx, y: cab.cy};
	const L = cab.w * 1.12;
	const h = L / 2;
	const x0 = c.x - h;
	const y0 = c.y - h;
	const x1 = c.x + h;
	const y1 = c.y + h;

	// Salida escalonada: fichas (stagger 2) → retícula (se des-dibuja) → tu cuarto se enfoca (Flotante.tsx).
	const retrae = 1 - avance(t, lt.salidaReticula, 6, CURVAS.mover);
	const saleFicha = (i: number) => avance(t, lt.salidaFichas[i], SALIDA_FICHA, CURVAS.mover);
	if (t >= lt.salida) return null;

	// 1) Cuadro de enfoque: baja de 1.3 a 1 (ease-out, 7 cuadros) y pulsa dos veces; luego pasa de amarillo a blanco.
	const fijar = avance(t, lt.foco, 7);
	const escFoco = 1.3 - 0.3 * fijar;
	const pulso = 1 - 0.55 * bump(t - lt.pulsos, 4) - 0.55 * bump(t - lt.pulsos - 4, 4);
	const blanco = avance(t, lt.blanco, 6);
	const opFoco = cl(avance(t, lt.foco, 2, (x) => x)) * pulso;
	// Las esquinas se dibujan desde el vértice hacia afuera (4 cuadros).
	const brazo = 0.16 * L * avance(t, lt.foco, 4, CURVAS.trazo);

	// 2) Esquinas continuas: la superelipse pasa de n = 40 (casi cuadrado) a n = 5 con ease-in-out (se mueve en pantalla).
	const pEsq = avance(t, lt.esquinas, 12, CURVAS.mover);
	const contorno = interpolarTrazos(superelipse(c.x, c.y, h, h, 40), superelipse(c.x, c.y, h, h, 5), pEsq);
	const dibujaContorno = avance(t, lt.blanco, 8, CURVAS.trazo);
	const opRet = opacidadReticula(lt, t) / 0.92;
	const brilloP = cl((t - (lt.esquinas + 4)) / 16);

	// 3) Plantilla: diagonales, ejes, tres círculos y dos rectángulos guía, escalonados 3, 2, 2, 1, 1.
	const d = lt.lineas;
	const lineas = [
		{tr: trazoDe([{x: x0, y: y0}, {x: x1, y: y1}]), p: avance(t, d[0], 6, CURVAS.trazo)},
		{tr: trazoDe([{x: x1, y: y0}, {x: x0, y: y1}]), p: avance(t, d[0], 6, CURVAS.trazo)},
		{tr: trazoDe([{x: c.x, y: y0}, {x: c.x, y: y1}]), p: avance(t, d[1], 6, CURVAS.trazo)},
		{tr: trazoDe([{x: x0, y: c.y}, {x: x1, y: c.y}]), p: avance(t, d[1], 6, CURVAS.trazo)},
		{tr: circulo(c, 0.46 * L), p: avance(t, d[2], 6, CURVAS.trazo)},
		{tr: circulo(c, 0.3 * L), p: avance(t, d[3], 6, CURVAS.trazo)},
		{tr: circulo(c, 0.135 * L), p: avance(t, d[4], 6, CURVAS.trazo)},
		{tr: trazoDe([{x: c.x - 0.4 * L, y: c.y - 0.31 * L}, {x: c.x + 0.4 * L, y: c.y - 0.31 * L}, {x: c.x + 0.4 * L, y: c.y + 0.31 * L}, {x: c.x - 0.4 * L, y: c.y + 0.31 * L}], true), p: avance(t, d[5], 6, CURVAS.trazo)},
		{tr: trazoDe([{x: c.x - 0.31 * L, y: c.y - 0.4 * L}, {x: c.x + 0.31 * L, y: c.y - 0.4 * L}, {x: c.x + 0.31 * L, y: c.y + 0.4 * L}, {x: c.x - 0.31 * L, y: c.y + 0.4 * L}], true), p: avance(t, d[5], 6, CURVAS.trazo)},
	];

	// 4) Cotas "1024" (ámbar, mono): arriba y a la derecha; se van cuando llegan las fichas.
	const cotaSale = 1 - avance(t, lt.fichas[0] - 2, 6);
	const cotaArr = avance(t, lt.cotas[0], 6, CURVAS.trazo);
	const cotaDer = avance(t, lt.cotas[1], 6, CURVAS.trazo);
	const numArr = avance(t, lt.cotas[0] + 2, 6);
	const numDer = avance(t, lt.cotas[1] + 2, 6);
	// La cota de arriba va arriba de tu pelo (no sobre tu frente).
	const yCota = Math.min(y0 - 34, cab.coronilla - 34);

	// 5) Etiqueta de la esquina continua: línea guía desde la esquina de arriba a la derecha de la superelipse.
	const esq = {x: c.x + h * 0.8706, y: c.y - h * 0.8706};
	const chipX0 = Math.min(945 - 270, Math.max(620, esq.x - 30));
	const chipEsq = {x0: chipX0, y0: esq.y - 124, x1: chipX0 + 270, y1: esq.y - 68};
	const guiaEsq = avance(t, lt.esquinas + 6, 5, CURVAS.trazo);
	const chipEsqP = avance(t, lt.esquinas + 9, 7);

	// 6) Título arriba (pastilla de vidrio claro) palabra por palabra con desenfoque.
	const pastilla = avance(t, lt.titulo - 1, 8);

	// Deriva de cámara: las fichas cercanas se mueven más que las líneas (paralaje real con perspectiva).
	const a = t / 30;
	const ry = 1.0 * Math.sin(2 * Math.PI * 0.21 * a + 0.3);
	const rx = 0.6 * Math.sin(2 * Math.PI * 0.17 * a + 1.2);
	const tx = 5 * Math.sin(2 * Math.PI * 0.13 * a);

	const lug = lugaresPlantilla(cab);
	const fs = lug.fichas.map((fi, i) => {
		// Las guías salen del CONTORNO (no de adentro de tu cara): esquina de arriba a la izquierda, arriba y abajo al centro.
		const ancla = [{x: c.x - h * 0.8706, y: c.y - h * 0.8706}, {x: c.x + 0.2 * h, y: c.y - h}, {x: c.x, y: c.y + h}][i];
		const llega = i < 2 ? {x: fi.x0 + fi.w / 2, y: fi.y0 + fi.h} : {x: fi.x0 + fi.w / 2, y: fi.y0};
		return {...fi, ancla, llega};
	});
	const saleTitulo = saleFicha(0);

	return (
		<div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, perspective: 1600, perspectiveOrigin: `${c.x}px ${c.y}px`}}>
			<div style={{position: 'absolute', inset: 0, transformStyle: 'preserve-3d', transform: `translateX(${tx.toFixed(2)}px) rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg)`, transformOrigin: `${c.x}px ${c.y}px`}}>
				<svg width={1080} height={1920} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', filter: 'drop-shadow(0 0 1px rgba(20,12,6,0.85)) drop-shadow(0 1px 3px rgba(20,12,6,0.45))'}}>
					{/* Esquinas de enfoque (blancas, se dibujan desde cada vértice y se cierran sobre tu cara) */}
					{blanco < 1 && brazo > 0.5 ? (
						<g opacity={opFoco * (1 - blanco)} transform={`translate(${c.x} ${c.y}) scale(${escFoco}) translate(${-c.x} ${-c.y})`} fill="none" stroke="white" strokeWidth={3.5} strokeLinecap="round">
							{[
								[x0, y0, 1, 1],
								[x1, y0, -1, 1],
								[x0, y1, 1, -1],
								[x1, y1, -1, -1],
							].map(([vx, vy, sx, sy], i) => (
								<path key={i} d={`M${vx + sx * brazo} ${vy} L${vx} ${vy} L${vx} ${vy + sy * brazo}`} />
							))}
						</g>
					) : null}
					{/* Contorno: superelipse que pasa a curvatura continua en "Apple" */}
					{blanco > 0 ? <Dibujo d={contorno.d} largo={contorno.largo} p={dibujaContorno * retrae} ancho={3 + (CONTORNO - 3) * pEsq} color="white" /> : null}
					{brilloP > 0 && brilloP < 1 ? (
						<path d={contorno.d} fill="none" stroke="white" strokeWidth={3.5} strokeLinecap="round" strokeDasharray={`${0.08 * contorno.largo} ${contorno.largo}`} strokeDashoffset={-brilloP * contorno.largo} opacity={bump(brilloP, 1)} style={{filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.9))'}} />
					) : null}
					{/* Retícula interna: destella ≤ 12 cuadros a ≤ 0.35 (cruza tu cara) */}
					{opRet > 0.001 ? (
						<g opacity={opRet}>
							{lineas.map((l, i) => (
								<Dibujo key={i} d={l.tr.d} largo={l.tr.largo} p={l.p} />
							))}
						</g>
					) : null}
					{/* Cotas */}
					<g opacity={cotaSale * retrae} stroke={P.ambar} strokeWidth={2.4} fill="none">
						<Dibujo d={trazoDe([{x: x0, y: yCota}, {x: x1, y: yCota}]).d} largo={L} p={cotaArr} color={P.ambar} />
						{cotaArr > 0 ? (
							<>
								<line x1={x0} y1={yCota - 8} x2={x0} y2={yCota + 8} />
								<line x1={x1} y1={yCota - 8} x2={x1} y2={yCota + 8} opacity={cotaArr > 0.95 ? 1 : 0} />
							</>
						) : null}
						<Dibujo d={trazoDe([{x: x1 + 34, y: y0}, {x: x1 + 34, y: y1}]).d} largo={L} p={cotaDer} color={P.ambar} />
						{cotaDer > 0 ? (
							<>
								<line x1={x1 + 26} y1={y0} x2={x1 + 42} y2={y0} />
								<line x1={x1 + 26} y1={y1} x2={x1 + 42} y2={y1} opacity={cotaDer > 0.95 ? 1 : 0} />
							</>
						) : null}
					</g>
					{/* Guía de la esquina */}
					<Dibujo d={trazoDe([esq, {x: (chipEsq.x0 + chipEsq.x1) / 2 + 30, y: chipEsq.y1}]).d} largo={Math.hypot(esq.x - (chipEsq.x0 + chipEsq.x1) / 2 - 30, esq.y - chipEsq.y1)} p={guiaEsq * retrae} ancho={2} />
					{guiaEsq > 0 ? <circle cx={esq.x} cy={esq.y} r={4.5} fill="white" opacity={retrae} /> : null}
					{/* Líneas guía de las fichas */}
					{fs.map((fi, i) => {
						const p = avance(t, lt.fichas[i], 5, CURVAS.trazo) * (1 - saleFicha(i));
						const tr = trazoDe([fi.ancla, fi.llega]);
						return (
							<g key={i}>
								{p > 0 ? <circle cx={fi.ancla.x} cy={fi.ancla.y} r={5} fill="white" opacity={1 - saleFicha(i)} /> : null}
								<Dibujo d={tr.d} largo={tr.largo} p={p} ancho={2.6} />
							</g>
						);
					})}
				</svg>

				{/* Números de las cotas (entran con desenfoque) */}
				<div style={{position: 'absolute', left: c.x - 60, top: yCota - 19, width: 120, textAlign: 'center', opacity: numArr * cotaSale, filter: numArr < 1 ? `blur(${((1 - numArr) * 6).toFixed(2)}px)` : undefined}}>
					<span style={{fontFamily: FAMILIA_MONO, fontWeight: 700, fontSize: 28, color: P.ambar, padding: '0 10px', textShadow: '0 1px 3px rgba(20,12,6,0.85)'}}>{m.medida}</span>
				</div>
				<div style={{position: 'absolute', left: x1 + 34 - 60, top: c.y - 15, width: 120, textAlign: 'center', transform: 'rotate(-90deg)', opacity: numDer * cotaSale, filter: numDer < 1 ? `blur(${((1 - numDer) * 6).toFixed(2)}px)` : undefined}}>
					<span style={{fontFamily: FAMILIA_MONO, fontWeight: 700, fontSize: 28, color: P.ambar, textShadow: '0 1px 3px rgba(20,12,6,0.85)'}}>{m.medida}</span>
				</div>

				{/* Chip de la esquina continua */}
				<div style={{position: 'absolute', left: chipEsq.x0, top: chipEsq.y0, width: chipEsq.x1 - chipEsq.x0, height: chipEsq.y1 - chipEsq.y0, display: 'flex', alignItems: 'center', justifyContent: 'center', ...estiloVidrio(0.25, 12), opacity: chipEsqP * (1 - saleTitulo), transform: `translateY(${((1 - chipEsqP) * 8).toFixed(2)}px) scale(${(0.96 + 0.04 * chipEsqP).toFixed(4)})`}}>
					<span style={{fontFamily: FAMILIA_MONO, fontWeight: 700, fontSize: 26, color: P.tinta}}>{m.esquina}</span>
				</div>

				{/* Título arriba, en la pared */}
				<div style={{position: 'absolute', left: 0, right: 0, top: lug.titulo.y0, display: 'flex', justifyContent: 'center', opacity: pastilla * (1 - saleTitulo), transform: `translateY(${((1 - pastilla) * 10 - 12 * saleTitulo).toFixed(2)}px) scale(${(0.96 + 0.04 * pastilla).toFixed(4)})`, filter: saleTitulo > 0 ? `blur(${(6 * saleTitulo).toFixed(2)}px)` : undefined}}>
					<div style={{display: 'flex', alignItems: 'center', gap: 16, padding: '16px 30px 16px 24px', ...estiloVidrio(0.45, 999)}}>
						{m.logo ? <LogoMono src={m.logo} tam={38} color={P.tinta} style={{marginTop: -4}} /> : null}
						<PalabrasConDesenfoque texto={m.titulo} p={(i) => avance(t, lt.titulo + 2 * i, 6)} style={{fontFamily: FAMILIA_UI, fontWeight: 700, fontSize: 34, color: P.tinta, letterSpacing: -0.4}} />
					</div>
				</div>

				{/* Fichas a distintas profundidades: un valor concreto grande y qué es */}
				{m.principios.map((pr, i) => {
					const fi = fs[i];
					const inicio = lt.fichas[i] + 3;
					const sr = resorte(t - inicio, RESORTES.vivo);
					const sale = saleFicha(i);
					// Sale en SALIDA_FICHA cuadros: sube, se desenfoca y se apaga rápido (sin quedarse gris a media opacidad).
				const vis = cl(sr * 2) * (1 - cl(sale * 1.4));
					if (vis <= 0.001) return null;
					const dirX = fi.llega.x - fi.ancla.x;
					const dirY = fi.llega.y - fi.ancla.y;
					const dl = Math.hypot(dirX, dirY) || 1;
					const off = (1 - sr) * 34;
					const lejos = fi.z < 0;
					return (
						<div
							key={`${pr.titulo}-${i}`}
							style={{
								position: 'absolute',
								left: fi.x0,
								top: fi.y0,
								width: fi.w,
								height: fi.h,
								padding: '12px 22px',
								boxSizing: 'border-box',
								display: 'flex',
								flexDirection: 'column',
								justifyContent: 'center',
								...estiloVidrio(fi.z > 0 ? 0.9 : lejos ? 0.2 : 0.45, 20),
								opacity: vis,
								transform: `translate3d(${((-dirX / dl) * off).toFixed(2)}px, ${((-dirY / dl) * off - 24 * sale).toFixed(2)}px, ${fi.z}px) scale(${(0.94 + 0.06 * Math.min(1, sr)).toFixed(4)})`,
								filter: sale > 0 || lejos ? `blur(${(8 * sale + (lejos ? 0.6 : 0)).toFixed(2)}px)` : undefined,
							}}
						>
							<div style={{fontFamily: FAMILIA_MONO, fontWeight: 700, fontSize: 40, letterSpacing: -0.5, color: P.tinta, lineHeight: 1}}>{pr.titulo}</div>
							<div style={{fontFamily: FAMILIA_UI, fontWeight: 700, fontSize: 26, color: '#4A423A', marginTop: 6, whiteSpace: 'nowrap'}}>{pr.nota}</div>
						</div>
					);
				})}
			</div>
		</div>
	);
};
