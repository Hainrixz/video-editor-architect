import React, {useEffect, useMemo, useState} from 'react';
import {cancelRender, continueRender, delayRender, Easing, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {candidata} from '../estilo/fuentes';
import {
	DemoTerminalEsquema,
	FUENTE_TERMINAL,
	GLIFOS_DIBUJADOS,
	VENTANA,
	ajustesDeDemo,
	erroresDemo,
	estadoEn,
	prepararTerminal,
	tieneGlifo,
	type AjustesTerminal,
	type CajaEstado,
	type CeldaEstado,
	type CursorEstado,
	type DemoTerminal,
	type FilaEstado,
	type GeometriaTerminal,
} from '../estilo/terminal';

/**
 * Terminal animada (Fase 7): una ventana de terminal con look macOS oscuro que "teclea" un guion.
 *
 * - Coordenadas en base 1080×1920: va dentro del contenedor escalado ×4/3 de Reel.tsx (igual que los subtítulos).
 * - Todo lo que cambia con el tiempo sale de src/estilo/terminal.ts (funciones puras con pruebas): este componente
 *   solo dibuja `estadoEn(lineaDeTiempo, t)` con t = (cuadro / fps) − retraso.
 * - Ventana: barra con los 3 puntos, esquinas de 14 px, sombra y un borde de 1 px que la despega del fondo.
 * - Texto: JetBrains Mono (OFL) en una rejilla exacta: cada celda mide 0.6 em. Las corridas de caracteres que la
 *   fuente trae van en un solo <span> (avance exacto de la fuente); lo demás va celda por celda, así un glifo de
 *   otra fuente nunca corre la rejilla. ⎿ ✓ ✗ y los asteriscos de "Pensando…" se dibujan en SVG propio.
 * - Animaciones: entrada con resorte (escala y opacidad), tecleo carácter por carácter con cursor que parpadea,
 *   líneas que aparecen con un fundido corto, desplazamiento suave cuando se llena, y salida al final de su Sequence.
 * - Modo "claude-code": encabezado naranja (#D97757), recuadro de entrada y "● " en las respuestas; sin logos.
 */

const FAMILIA_TITULO = 'Editor Terminal Titulo';
const cargadas = new Map<string, Promise<void>>();

/** Registra (una vez por pestaña) JetBrains Mono normal y negrita, e Inter 600 para el título de la barra. */
export function cargarFuentesTerminal(): void {
	const pedidos = [
		{familia: FUENTE_TERMINAL.familiaCss, ruta: FUENTE_TERMINAL.archivos[FUENTE_TERMINAL.pesoNormal].ruta, peso: FUENTE_TERMINAL.pesoNormal},
		{familia: FUENTE_TERMINAL.familiaCss, ruta: FUENTE_TERMINAL.archivos[FUENTE_TERMINAL.pesoNegrita].ruta, peso: FUENTE_TERMINAL.pesoNegrita},
		{familia: FAMILIA_TITULO, ruta: candidata('inter').archivos[600].ruta, peso: 600},
	];
	for (const p of pedidos) {
		const llave = `${p.familia}:${p.peso}`;
		if (cargadas.has(llave)) continue;
		cargadas.set(llave, loadFont({family: p.familia, url: staticFile(p.ruta), weight: String(p.peso), style: 'normal', display: 'block'}));
	}
}

export type PropsTerminalAnimada = AjustesTerminal & {
	/** Entrada con resorte al principio (por defecto sí). */
	entrada?: boolean;
	/** Salida en los últimos 0.3 s de la Sequence que la contiene (por defecto sí). */
	salida?: boolean;
};

export const TerminalAnimada: React.FC<PropsTerminalAnimada> = ({entrada = true, salida = true, ...ajustes}) => {
	cargarFuentesTerminal();
	const frame = useCurrentFrame();
	const {fps, durationInFrames} = useVideoConfig();
	// El guion y las opciones llegan como objetos nuevos en cada cuadro: la llave del memo es su JSON.
	const llave = JSON.stringify(ajustes);
	const {geo, lt, x: izquierda, y: arriba, retraso, titulo: tituloBarra} = useMemo(() => prepararTerminal(ajustes), [llave]);
	const t = frame / fps - retraso;
	const estado = estadoEn(lt, t);

	// Entrada (resorte con un poco de rebote) y salida (al final de la Sequence que la contiene).
	const resorte = entrada ? spring({frame, fps, config: {damping: 15, stiffness: 150, mass: 0.85}}) : 1;
	const aparicion = entrada ? interpolate(frame, [0, 0.2 * fps], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;
	const despedida = salida
		? interpolate(frame, [durationInFrames - 0.3 * fps, durationInFrames - 1], [0, 1], {
				extrapolateLeft: 'clamp',
				extrapolateRight: 'clamp',
				easing: Easing.in(Easing.cubic),
			})
		: 0;
	const escala = (0.88 + 0.12 * resorte) * (1 - 0.04 * despedida);
	const dy = (1 - resorte) * 56 + despedida * 24;
	const quieta = Math.abs(escala - 1) < 5e-4 && Math.abs(dy) < 0.05;

	// Zonas de fundido en los márgenes de arriba y de abajo del área de texto (≈ media fila, lo que quepa).
	const fundidoArriba = Math.max(0, Math.min(geo.area.y - geo.barra, Math.round(geo.altoFila * 0.45)));
	const fundidoAbajo = Math.max(0, Math.min(geo.alto - geo.area.y - geo.area.h, Math.round(geo.altoFila * 0.45)));
	const mascara = `linear-gradient(180deg, transparent 0px, black ${fundidoArriba}px, black ${fundidoArriba + geo.area.h}px, transparent ${fundidoArriba + geo.area.h + fundidoAbajo}px)`;

	// Solo se dibujan las filas que caen (aunque sea en parte) dentro del área de texto.
	const desde = estado.desplazamiento - 1;
	const hasta = estado.desplazamiento + geo.filasVisibles + 1;
	const filas = estado.filas.filter((f) => f.fila >= desde && f.fila <= hasta && f.opacidad > 0.001);

	return (
		<div
			data-terminal={lt.modo}
			style={{
				position: 'absolute',
				left: izquierda,
				top: arriba,
				width: geo.ancho,
				height: geo.alto,
				opacity: aparicion * (1 - despedida),
				transform: quieta ? undefined : `translateY(${dy}px) scale(${escala})`,
				transformOrigin: '50% 50%',
			}}
		>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					borderRadius: geo.radio,
					overflow: 'hidden',
					background: `linear-gradient(180deg, ${VENTANA.fondo} 0%, ${VENTANA.fondoAbajo} 100%)`,
					boxShadow: '0 34px 90px rgba(0,0,0,0.55), 0 12px 30px rgba(0,0,0,0.35)',
				}}
			>
				<BarraTitulo geo={geo} titulo={tituloBarra} />
				<div
					style={{
						position: 'absolute',
						left: geo.area.x,
						top: geo.area.y - fundidoArriba,
						width: geo.area.w,
						height: geo.area.h + fundidoArriba + fundidoAbajo,
						overflow: 'hidden',
						// Las orillas se desvanecen en los márgenes (no dentro del área): una fila que sale por arriba o que
						// entra por abajo mientras el contenido se desliza no se corta en seco, y las filas quietas se ven completas.
						maskImage: mascara,
						WebkitMaskImage: mascara,
						fontFamily: `"${FUENTE_TERMINAL.familiaCss}", monospace`,
						fontSize: geo.tamanoLetra,
						fontWeight: FUENTE_TERMINAL.pesoNormal,
						lineHeight: `${geo.altoFila}px`,
						letterSpacing: 0,
						fontKerning: 'none',
						fontVariantLigatures: 'none',
						fontFeatureSettings: '"liga" 0, "calt" 0',
						fontSynthesis: 'none',
						whiteSpace: 'pre',
					}}
				>
					<div
						style={{
							position: 'absolute',
							left: 0,
							top: fundidoArriba,
							width: '100%',
							height: geo.area.h,
							transform: `translateY(${-estado.desplazamiento * geo.altoFila}px)`,
						}}
					>
						{estado.cajas.map((c) => (
							<Recuadro key={c.clave} caja={c} geo={geo} />
						))}
						{filas.map((f) => (
							<Fila key={f.clave} fila={f} geo={geo} />
						))}
						{estado.cursor ? <Cursor cursor={estado.cursor} geo={geo} /> : null}
					</div>
				</div>
			</div>
			{/* Borde fino por dentro: separa la ventana de cualquier fondo. */}
			<div style={{position: 'absolute', inset: 0, borderRadius: geo.radio, boxShadow: `inset 0 0 0 1px ${VENTANA.brillo}`, pointerEvents: 'none'}} />
		</div>
	);
};

const BarraTitulo: React.FC<{geo: GeometriaTerminal; titulo: string}> = ({geo, titulo}) => {
	const diametro = Math.round(geo.barra * 0.4);
	const paso = Math.round(geo.barra * 0.66);
	const primero = Math.round(geo.barra * 0.66);
	return (
		<div
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				width: '100%',
				height: geo.barra,
				background: `linear-gradient(180deg, ${VENTANA.barra} 0%, ${VENTANA.barraAbajo} 100%)`,
				boxShadow: `inset 0 -1px 0 ${VENTANA.lineaBarra}, inset 0 1px 0 rgba(255,255,255,0.06)`,
			}}
		>
			{VENTANA.semaforo.map((s, k) => (
				<div
					key={k}
					style={{
						position: 'absolute',
						left: primero + k * paso - diametro / 2,
						top: (geo.barra - diametro) / 2,
						width: diametro,
						height: diametro,
						borderRadius: '50%',
						background: s.relleno,
						boxShadow: `inset 0 0 0 1px ${s.borde}`,
					}}
				/>
			))}
			<div
				style={{
					position: 'absolute',
					left: primero + 3 * paso,
					right: primero + 3 * paso,
					top: 0,
					height: geo.barra,
					lineHeight: `${geo.barra}px`,
					textAlign: 'center',
					fontFamily: `"${FAMILIA_TITULO}", sans-serif`,
					fontWeight: 600,
					fontSize: Math.round(geo.barra * 0.4),
					color: VENTANA.titulo,
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis',
				}}
			>
				{titulo}
			</div>
		</div>
	);
};

type Pieza = {col: number; texto: string; ancho: number; color: string; negrita: boolean; tipo: 'corrida' | 'suelta' | 'dibujada'};

/** ¿La fuente dibuja este carácter con su avance exacto de 1 celda? */
function vaEnCorrida(c: CeldaEstado): boolean {
	if (c.ancho !== 1 || GLIFOS_DIBUJADOS.has(c.ch)) return false;
	const cps = Array.from(c.ch);
	return cps.length === 1 && tieneGlifo(cps[0].codePointAt(0) ?? 0);
}

/** Junta celdas seguidas del mismo estilo que la fuente trae; lo demás va suelto o dibujado. */
function piezas(celdas: readonly CeldaEstado[]): Pieza[] {
	const salida: Pieza[] = [];
	for (const c of celdas) {
		if (c.ch === ' ' && salida.length > 0) {
			const ultima = salida[salida.length - 1];
			if (ultima.tipo === 'corrida' && ultima.col + ultima.ancho === c.col) {
				ultima.texto += ' ';
				ultima.ancho += 1;
			}
			continue;
		}
		if (c.ch === ' ') continue;
		if (GLIFOS_DIBUJADOS.has(c.ch)) {
			salida.push({col: c.col, texto: c.ch, ancho: c.ancho, color: c.color, negrita: c.negrita, tipo: 'dibujada'});
			continue;
		}
		if (!vaEnCorrida(c)) {
			salida.push({col: c.col, texto: c.ch, ancho: c.ancho, color: c.color, negrita: c.negrita, tipo: 'suelta'});
			continue;
		}
		const ultima = salida[salida.length - 1];
		if (ultima && ultima.tipo === 'corrida' && ultima.col + ultima.ancho === c.col && ultima.color === c.color && ultima.negrita === c.negrita) {
			ultima.texto += c.ch;
			ultima.ancho += 1;
		} else {
			salida.push({col: c.col, texto: c.ch, ancho: 1, color: c.color, negrita: c.negrita, tipo: 'corrida'});
		}
	}
	// Los espacios al final de una corrida no se ven: se quitan.
	for (const p of salida) {
		if (p.tipo !== 'corrida') continue;
		const limpio = p.texto.replace(/ +$/u, '');
		p.ancho -= p.texto.length - limpio.length;
		p.texto = limpio;
	}
	return salida.filter((p) => p.texto.length > 0);
}

const Fila: React.FC<{fila: FilaEstado; geo: GeometriaTerminal}> = ({fila, geo}) => (
	<div style={{position: 'absolute', left: 0, top: fila.fila * geo.altoFila, width: '100%', height: geo.altoFila, opacity: fila.opacidad}}>
		{piezas(fila.celdas).map((p) =>
			p.tipo === 'dibujada' ? (
				<GlifoDibujado key={p.col} ch={p.texto} color={p.color} negrita={p.negrita} col={p.col} ancho={p.ancho} geo={geo} />
			) : (
				<span
					key={p.col}
					style={{
						position: 'absolute',
						left: p.col * geo.celda,
						top: 0,
						width: p.tipo === 'suelta' ? p.ancho * geo.celda : undefined,
						textAlign: p.tipo === 'suelta' ? 'center' : undefined,
						color: p.color,
						fontWeight: p.negrita ? FUENTE_TERMINAL.pesoNegrita : FUENTE_TERMINAL.pesoNormal,
					}}
				>
					{p.texto}
				</span>
			),
		)}
	</div>
);

const Cursor: React.FC<{cursor: CursorEstado; geo: GeometriaTerminal}> = ({cursor, geo}) => {
	const alto = Math.round(geo.tamanoLetra * 1.22);
	return (
		<div
			data-cursor
			style={{
				position: 'absolute',
				left: cursor.col * geo.celda,
				top: cursor.fila * geo.altoFila + (geo.altoFila - alto) / 2,
				width: geo.celda,
				height: alto,
				borderRadius: Math.max(1, geo.tamanoLetra * 0.06),
				background: VENTANA.cursor,
				opacity: cursor.opacidad * 0.92,
			}}
		/>
	);
};

const Recuadro: React.FC<{caja: CajaEstado; geo: GeometriaTerminal}> = ({caja, geo}) => (
	<div
		style={{
			position: 'absolute',
			left: 0,
			top: caja.fila * geo.altoFila,
			width: geo.columnas * geo.celda,
			height: caja.alto * geo.altoFila,
			boxSizing: 'border-box',
			border: `${Math.max(2, Math.round(geo.tamanoLetra * 0.07))}px solid ${caja.color}`,
			borderRadius: Math.round(geo.altoFila * 0.3),
			opacity: caja.opacidad,
			background: caja.tipo === 'entrada' ? 'rgba(255,255,255,0.025)' : 'rgba(217,119,87,0.05)',
		}}
	/>
);

/** Pétalo (elipse alargada) a `d` em del centro, girado `grados`. */
function petalos(n: number, cx: number, cy: number, em: number, d: number, rx: number, ry: number, color: string): React.ReactNode[] {
	return Array.from({length: n}, (_, k) => {
		const a = (360 / n) * k;
		const rad = (a * Math.PI) / 180;
		const ex = cx + d * em * Math.sin(rad);
		const ey = cy - d * em * Math.cos(rad);
		return <ellipse key={k} cx={ex} cy={ey} rx={rx * em} ry={ry * em} fill={color} transform={`rotate(${a} ${ex} ${ey})`} />;
	});
}

/** Glifos que JetBrains Mono no trae, dibujados con geometría propia en su celda. */
const GlifoDibujado: React.FC<{ch: string; color: string; negrita: boolean; col: number; ancho: number; geo: GeometriaTerminal}> = ({
	ch,
	color,
	negrita,
	col,
	ancho,
	geo,
}) => {
	const em = geo.tamanoLetra;
	const w = ancho * geo.celda;
	const cx = w / 2;
	const cy = geo.centroGlifo;
	const trazo = {stroke: color, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none'};
	let dibujo: React.ReactNode = null;
	switch (ch) {
		case '⎿': {
			const x0 = cx - 0.16 * em;
			const yb = cy + 0.14 * em;
			dibujo = <path d={`M ${x0} ${cy - 0.5 * em} L ${x0} ${yb} L ${x0 + 0.5 * em} ${yb}`} {...trazo} strokeWidth={0.075 * em} />;
			break;
		}
		case '✓':
		case '✔':
			dibujo = (
				<path
					d={`M ${cx - 0.26 * em} ${cy + 0.01 * em} L ${cx - 0.08 * em} ${cy + 0.2 * em} L ${cx + 0.27 * em} ${cy - 0.25 * em}`}
					{...trazo}
					strokeWidth={(ch === '✔' || negrita ? 0.13 : 0.095) * em}
				/>
			);
			break;
		case '✗':
		case '✘': {
			const r = 0.21 * em;
			dibujo = (
				<path
					d={`M ${cx - r} ${cy - r} L ${cx + r} ${cy + r} M ${cx + r} ${cy - r} L ${cx - r} ${cy + r}`}
					{...trazo}
					strokeWidth={(ch === '✘' || negrita ? 0.13 : 0.095) * em}
				/>
			);
			break;
		}
		case '✢':
			dibujo = petalos(4, cx, cy, em, 0.15, 0.07, 0.15, color);
			break;
		case '✳':
			dibujo = Array.from({length: 8}, (_, k) => {
				const rad = (k * Math.PI) / 4;
				return (
					<line key={k} x1={cx} y1={cy} x2={cx + 0.3 * em * Math.sin(rad)} y2={cy - 0.3 * em * Math.cos(rad)} {...trazo} strokeWidth={0.07 * em} />
				);
			});
			break;
		case '✶': {
			const puntos = Array.from({length: 12}, (_, k) => {
				const r = (k % 2 === 0 ? 0.32 : 0.14) * em;
				const rad = (k * Math.PI) / 6;
				return `${cx + r * Math.sin(rad)},${cy - r * Math.cos(rad)}`;
			}).join(' ');
			dibujo = <polygon points={puntos} fill={color} />;
			break;
		}
		case '✻':
			dibujo = petalos(6, cx, cy, em, 0.16, 0.065, 0.15, color);
			break;
		case '✽':
			dibujo = petalos(8, cx, cy, em, 0.17, 0.07, 0.16, color);
			break;
		default:
			dibujo = null;
	}
	return (
		<svg
			data-glifo={ch}
			width={w}
			height={geo.altoFila}
			viewBox={`0 0 ${w} ${geo.altoFila}`}
			style={{position: 'absolute', left: col * geo.celda, top: 0, overflow: 'visible'}}
		>
			{dibujo}
		</svg>
	);
};

// ───────────────────────────── demo desde archivo ─────────────────────────────

export type PropsTerminalDesdeArchivo = Omit<PropsTerminalAnimada, 'guion'> & {
	/** URL ya resuelta (staticFile('demos/<slug>/terminal.json')). */
	src: string;
};

/**
 * Lee un archivo de demo (JSON con DemoTerminalEsquema), lo valida y dibuja la terminal. Si el archivo no existe o no
 * cumple el contrato, el render se detiene con el motivo (mejor que un reel con una terminal vacía).
 * Las props que se pasen aquí (posición, tamaño…) mandan sobre las del archivo.
 */
export const TerminalDesdeArchivo: React.FC<PropsTerminalDesdeArchivo> = ({src, ...resto}) => {
	const [demo, setDemo] = useState<DemoTerminal | null>(null);
	const [espera] = useState(() => delayRender(`Leyendo la demo de terminal ${src}`));
	useEffect(() => {
		let vivo = true;
		fetch(src)
			.then((r) => {
				if (!r.ok) throw new Error(`No pude leer la demo de terminal ${src}: respondió ${r.status}. Siguiente paso: revisa la ruta del insert.`);
				return r.json();
			})
			.then((json: unknown) => {
				const r = DemoTerminalEsquema.safeParse(json);
				if (!r.success) {
					throw new Error(`No pude usar la demo de terminal ${src}: ${erroresDemo(json).join('; ')}. Siguiente paso: corrige el archivo.`);
				}
				if (vivo) setDemo(r.data);
				continueRender(espera);
			})
			.catch((e: unknown) => cancelRender(e instanceof Error ? e : new Error(String(e))));
		return () => {
			vivo = false;
		};
	}, [src, espera]);
	if (!demo) return null;
	const desdeArchivo = ajustesDeDemo(demo);
	const definidas = Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined)) as Partial<PropsTerminalAnimada>;
	return <TerminalAnimada {...desdeArchivo} {...definidas} />;
};
