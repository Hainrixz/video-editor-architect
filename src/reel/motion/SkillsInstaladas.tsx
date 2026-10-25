// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import React from 'react';
import {Img, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {VENTANA} from '../../estilo/terminal';
import {COLORES_MOTION as C, ESCENA, LOGO_CLAUDE, avance, caracteresTecleados, entrada, lineaSkills, type SkillsResuelto} from '../../estilo/motion';
import {FAMILIA_MONO, FAMILIA_UI, LogoMono, Palomita} from './comun';

/**
 * "Skills instaladas": una terminal oscura teclea el comando del README de Emil y, al dar Enter, las skills reales del
 * repo caen en cascada con su palomita (stagger de 2 cuadros). Cierra con una píldora naranja "Listas en Claude Code".
 * Escena de 810 × 980 (MotionInsert la coloca). Todo es función del cuadro: sin estado ni efectos.
 */

const LETRA = 29;
const COL = LETRA * 0.6;
/** Letra de las skills (más grande que el comando: es lo que se lee). */
const LETRA_SKILL = 34;
const FILA = 64;
const BARRA = 62;
const PAD = {arriba: 30, abajo: 34, lados: 24};

export const SkillsInstaladas: React.FC<{m: SkillsResuelto}> = ({m}) => {
	const f = useCurrentFrame();
	const {fps} = useVideoConfig();
	const lt = lineaSkills(m);

	const cab = entrada(f, 0, 9, 14);
	const ven = entrada(f, lt.ventana.inicio, lt.ventana.cuadros, 26, 0.965);
	const n = caracteresTecleados(lt, m.comando.length, f);
	const tecleando = f < lt.enter;
	// Cursor: fijo mientras teclea (como una terminal real) y parpadea (16 cuadros) cuando espera.
	const cursorVisible = tecleando ? true : f < lt.encabezado ? Math.floor((f - lt.enter) / 8) % 2 === 0 : false;
	const pEncabezado = avance(f, lt.encabezado, 8);

	const pie = lt.pie !== null ? spring({frame: f - lt.pie, fps, config: {damping: 16, stiffness: 190, mass: 0.9}}) : 0;

	return (
		<div style={{position: 'absolute', left: 0, top: 0, width: ESCENA.ancho, height: ESCENA.alto}}>
			{/* Encabezado: autor y repo */}
			<div style={{position: 'absolute', left: 0, right: 0, top: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, opacity: cab.opacidad, transform: `translateY(${cab.y}px)`}}>
				{m.avatar ? (
					m.avatar.endsWith('.svg') ? (
						<LogoMono src={m.avatar} tam={46} color={C.texto} />
					) : (
						<Img src={staticFile(m.avatar)} style={{width: 58, height: 58, borderRadius: 29, objectFit: 'cover', boxShadow: `0 0 0 2px ${C.fondo}, 0 0 0 3.5px ${C.lineaFuerte}`}} />
					)
				) : null}
				<div style={{fontFamily: FAMILIA_MONO, fontWeight: 700, fontSize: 34, color: C.texto, letterSpacing: -0.3}}>
					<span style={{color: C.tenue, fontWeight: 500}}>github.com/</span>
					{m.repo}
				</div>
			</div>

			{/* Ventana de terminal */}
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: 100,
					width: ESCENA.ancho,
					borderRadius: 22,
					overflow: 'hidden',
					background: `linear-gradient(180deg, ${VENTANA.fondo}, ${VENTANA.fondoAbajo})`,
					boxShadow: `0 0 0 1px ${C.lineaFuerte}, 0 30px 80px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 ${VENTANA.brillo}`,
					opacity: ven.opacidad,
					transform: `translateY(${ven.y}px) scale(${ven.escala})`,
					transformOrigin: '50% 30%',
				}}
			>
				<div style={{height: BARRA, display: 'flex', alignItems: 'center', padding: '0 24px', gap: 12, background: `linear-gradient(180deg, ${VENTANA.barra}, ${VENTANA.barraAbajo})`, borderBottom: `1px solid ${VENTANA.lineaBarra}`}}>
					{VENTANA.semaforo.map((s, i) => (
						<div key={i} style={{width: 18, height: 18, borderRadius: 9, background: s.relleno, boxShadow: `inset 0 0 0 1px ${s.borde}`}} />
					))}
					<div style={{flex: 1, textAlign: 'center', marginRight: 78, fontFamily: FAMILIA_UI, fontWeight: 600, fontSize: 23, color: VENTANA.titulo}}>Terminal — zsh</div>
				</div>
				<div style={{padding: `${PAD.arriba}px ${PAD.lados}px ${PAD.abajo}px`, fontFamily: FAMILIA_MONO, fontSize: LETRA, lineHeight: `${FILA}px`, color: C.texto, whiteSpace: 'pre'}}>
					{/* Comando */}
					<div style={{display: 'flex', alignItems: 'center', height: FILA}}>
						<span style={{color: C.acento, fontWeight: 700}}>$ </span>
						<span style={{fontWeight: 500}}>{m.comando.slice(0, n)}</span>
						<span style={{display: 'inline-block', width: COL, height: LETRA * 1.15, marginLeft: 1, background: VENTANA.cursor, opacity: cursorVisible ? 0.9 : 0}} />
					</div>
					{/* Encabezado de la salida */}
					<div style={{height: FILA, display: 'flex', alignItems: 'center', gap: 12, color: C.tenue, opacity: pEncabezado, transform: `translateY(${(1 - pEncabezado) * 8}px)`}}>
						<span>
							{m.skills.length} skills instaladas
						</span>
					</div>
					{/* Skills en cascada */}
					{m.skills.map((s, i) => {
						const inicio = lt.filas[i];
						const e = entrada(f, inicio, 9, 12, 1);
						const pCheck = avance(f, inicio + 1, 10);
						return (
							<div key={s} style={{height: FILA, display: 'flex', alignItems: 'center', gap: 20, paddingLeft: 4, fontSize: LETRA_SKILL, opacity: e.opacidad, transform: `translateY(${e.y}px)`}}>
								<Palomita tam={38} p={pCheck} />
								<span style={{fontWeight: 700, color: C.texto}}>{s}</span>
							</div>
						);
					})}
				</div>
			</div>

			{/* Píldora final */}
			{lt.pie !== null && m.pie ? (
				<div style={{position: 'absolute', left: 0, right: 0, top: 100 + BARRA + PAD.arriba + PAD.abajo + FILA * (2 + m.skills.length) + 36, display: 'flex', justifyContent: 'center'}}>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 16,
							padding: '18px 34px 18px 26px',
							borderRadius: 999,
							background: 'linear-gradient(180deg, rgba(217,119,87,0.22), rgba(217,119,87,0.12))',
							boxShadow: `inset 0 0 0 1.5px rgba(217,119,87,0.55), 0 12px 40px rgba(217,119,87,0.18)`,
							opacity: f < lt.pie ? 0 : Math.min(1, pie * 1.5),
							transform: `translateY(${(1 - pie) * 16}px) scale(${0.94 + 0.06 * pie})`,
						}}
					>
						<LogoMono src={LOGO_CLAUDE} tam={38} color={C.acento} />
						<span style={{fontFamily: FAMILIA_UI, fontWeight: 700, fontSize: 36, color: C.texto, letterSpacing: -0.4}}>{m.pie}</span>
					</div>
				</div>
			) : null}
		</div>
	);
};
