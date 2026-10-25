// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Poses de los motion graphics libres (src/estilo/motion-libre.ts) cuadro por cuadro: dónde va cada pieza, con qué
 * escala, opacidad y velocidad (para el desenfoque de movimiento direccional). Las usan los componentes
 * (src/reel/motion/*) y las pruebas (que verifican que nada tape tus ojos, nariz ni boca más de 0.5 s seguidos).
 *
 * Puro: sin React, sin Remotion y sin Node. Unidades: cuadros a 30 fps desde que entra el insert y px base 1080×1920
 * (ya en PANTALLA: con el push-in del fondo flotante aplicado a tu cabeza).
 */
import {ANCLA_DISENO, ANTES_LIBRE, CUADROS_CAJA, CUADROS_CONVERGEN, ENTRADA_FONDO_LIBRE, ENTRADA_VENTANA, FOCO_SALIDA, PERIODO_BOLITA, RETICULA_OPACIDAD, SALIDA_LIBRE, lineaPantalla, lineaPlantilla, lineaPrueba, lugaresSkills, piezasComando, type FichaSkill, type LibreResuelto, type PantallaResuelto, type PlantillaResuelto, type PruebaResuelto} from './motion-libre';
import {cabezaEn, cabezaEnPantalla, cabezaFija, elipseCabeza, elipseOclusion, elipsesDeCabeza, zonaRostro, type Cabeza} from './anclaje';
import {intensidadFlotante} from './flotante';
import {CURVAS, avance, bezier} from './motion';
import {RESORTES, resorte} from './resorte';

export type Caja = {x0: number; y0: number; x1: number; y1: number};
const cl = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
export const bump = (x: number, largo: number) => (x <= 0 || x >= largo ? 0 : Math.sin((Math.PI * x) / largo));
/** Ease-in (las skills caen al cursor acelerando). */
export const EASE_IN = bezier(0.55, 0, 1, 0.45);

// ───────────────────────── fondo y cabeza ─────────────────────────

/** Intensidad 0–1 del fondo de un motion libre en su cuadro f (arranca ANTES_LIBRE cuadros antes; foco en los últimos). */
export function intensidadLibre(f: number, dur: number): number {
	return intensidadFlotante(f, [{desde: -ANTES_LIBRE, hasta: dur}], ENTRADA_FONDO_LIBRE, FOCO_SALIDA);
}

/** Tu cabeza en PANTALLA en el cuadro f (pista o fija), con el push-in del fondo. */
export function cabezaLibre(r: LibreResuelto, f: number, dur: number): Cabeza {
	let c: Cabeza;
	if (r.pista) c = cabezaEn(r.pista, f);
	else if (r.nombre === 'plantilla-apple') c = cabezaFija(r.ancla.x, r.ancla.y, r.ancla.lado);
	else c = cabezaFija(ANCLA_DISENO.x, ANCLA_DISENO.y, ANCLA_DISENO.lado);
	const k = intensidadLibre(f, dur);
	return cabezaEnPantalla(c, 1 + (r.fondo.escala - 1) * k);
}

export {elipseCabeza, elipseOclusion, elipsesDeCabeza, zonaRostro};

// ───────────────────────── M1: prueba-corregida ─────────────────────────

/**
 * Ventana del navegador [D]: 720 × 300 arriba de tu cabeza; su orilla de abajo se mete DETRÁS de tu coronilla. Las
 * ranuras de las fichas cuelgan de su orilla de abajo, en las esquinas (sobresalen 40 px a los lados: x 140–940).
 */
export const VENTANA = {w: 720, h: 300, cy: 382, y0_min: 228} as const;
/** Fichas (y sus ranuras, del mismo tamaño y forma) colgadas de la orilla de abajo de la ventana. */
export const FICHA_PRUEBA = {w: 236, h: 62, sobresale: 40} as const;

export type PoseVentana = {cx: number; cy: number; rz: number; ry: number; op: number; blur: number; vx: number; vy: number; p: number; salida: number};

function poseVentanaCruda(r: PruebaResuelto, f: number, dur: number): Omit<PoseVentana, 'vx' | 'vy'> {
	const lt = lineaPrueba(r, dur);
	const cab = cabezaLibre(r, f, dur);
	// Paralaje: la ventana está entre tu cuarto y tú → sigue tu cabeza a ~15 % (con 720 px casi no le queda juego en x).
	const rx = Math.min(945 - VENTANA.w / 2 - FICHA_PRUEBA.sobresale - 5, Math.max(135 + VENTANA.w / 2 + FICHA_PRUEBA.sobresale + 5, 540 + 0.15 * (cab.cx - 540)));
	// Su orilla de abajo se mete ~40 px detrás de tu coronilla (oclusión), sin subir de y 228 (zona segura).
	// Sigue tu coronilla a 30 % alrededor de su media en el tramo (paralaje; la máscara sí te sigue al 100 %).
	const media = r.pista ? r.pista.c.reduce((a, x) => a + x[4], 0) / r.pista.c.length : cab.coronilla;
	const cor = media + 0.3 * (cab.coronilla - media);
	const ry = Math.min(VENTANA.cy + 50, Math.max(VENTANA.y0_min + VENTANA.h / 2, cor + 40 - VENTANA.h / 2));
	// Entrada propia (corte seco desde el meme): sube 40 px, aparece y se enfoca en 6 cuadros con ease-out fuerte.
	const p = CURVAS.salida(cl((f + 1) / ENTRADA_VENTANA));
	const a = f / 30;
	const dx = 4 * Math.sin(2 * Math.PI * 0.29 * a);
	const dy = 3 * Math.sin(2 * Math.PI * 0.21 * a + 1.1);
	const q = avance(f, lt.salida, SALIDA_LIBRE, CURVAS.mover);
	return {
		cx: rx + dx,
		cy: ry + dy + 40 * (1 - p) - 80 * q,
		rz: 0.7 * Math.sin(2 * Math.PI * 0.19 * a + 0.4) - 1.2,
		ry: 2 * Math.sin(2 * Math.PI * 0.17 * a),
		op: f < 0 ? 0 : p * (1 - q),
		blur: 6 * (1 - p) + 8 * q,
		p,
		salida: q,
	};
}

export function poseVentana(r: PruebaResuelto, f: number, dur: number): PoseVentana {
	const a = poseVentanaCruda(r, f, dur);
	const b = poseVentanaCruda(r, f - 0.5, dur);
	return {...a, vx: (a.cx - b.cx) * 2, vy: (a.cy - b.cy) * 2};
}

/** Bolita de la curva: recorre la ease-out en loop (nunca se queda quieta). u 0–1 a lo largo del tiempo. */
export function bolitaCurva(f: number, inicio: number): number | null {
	if (f < inicio) return null;
	const k = ((f - inicio) % PERIODO_BOLITA) / PERIODO_BOLITA;
	return cl(k / 0.8); // 80 % del periodo recorre, 20 % espera arriba
}

function cajasPrueba(r: PruebaResuelto, f: number, dur: number): CajaPieza[] {
	const v = poseVentana(r, f, dur);
	if (v.op <= 0.02) return [];
	const s = FICHA_PRUEBA.sobresale;
	// Ventana + las ranuras que cuelgan de su orilla de abajo. No se marca `detras`: nunca llega a tu cara.
	return [{que: 'ventana', op: v.op, caja: {x0: v.cx - VENTANA.w / 2 - s, x1: v.cx + VENTANA.w / 2 + s, y0: v.cy - VENTANA.h / 2 - 6, y1: v.cy + VENTANA.h / 2 + FICHA_PRUEBA.h / 2 + 8}, detras: false}];
}

// ───────────────────────── M2: plantilla-apple ─────────────────────────

export type LugarFicha = {x0: number; y0: number; w: number; h: number; z: number};

/** Título y fichas [D]: el título y dos fichas arriba de tu cabeza; la tercera en tu pecho, bajo tu barbilla. */
export function lugaresPlantilla(cab: Cabeza): {titulo: Caja; fichas: LugarFicha[]} {
	const h = 100;
	const pecho = Math.min(1480 - h, Math.max(1384, cab.barbilla + 16));
	const cx = Math.min(945 - 170, Math.max(135 + 170, cab.cx));
	return {
		titulo: {x0: 250, y0: 232, x1: 830, y1: 298},
		fichas: [
			{x0: 150, y0: 316, w: 340, h, z: 60},
			{x0: 590, y0: 316, w: 340, h, z: 0},
			{x0: cx - 170, y0: pecho, w: 340, h, z: -60},
		],
	};
}

/**
 * Opacidad de la retícula INTERNA (la que cruza ojos, nariz y boca): sube a 0.35 en 3 cuadros desde "diseño" y se va
 * en 4 a partir de `reticulaFuera`; a los RETICULA_MAX cuadros ya no está.
 */
export function opacidadReticula(lt: {lineas: number[]; reticulaFuera: number}, f: number): number {
	return RETICULA_OPACIDAD * Math.min(cl((f - lt.lineas[0] + 1) / 3), 1 - cl((f - lt.reticulaFuera) / 4));
}

function cajasPlantilla(r: PlantillaResuelto, f: number, dur: number): CajaPieza[] {
	const lt = lineaPlantilla(r, dur);
	const cab = cabezaLibre(r, f, dur);
	const {titulo, fichas} = lugaresPlantilla(cab);
	const out: CajaPieza[] = [];
	// La retícula interna sí cruza tu cara: cuenta mientras se ve (opacidad > 0.2 la vuelve "tapa").
	const opR = opacidadReticula(lt, f);
	if (opR > 0.001) {
		const L = cab.w * 1.12;
		out.push({que: 'reticula', op: opR, caja: {x0: cab.cx - L / 2, x1: cab.cx + L / 2, y0: cab.cy - L / 2, y1: cab.cy + L / 2}, detras: false});
	}
	if (f >= lt.titulo - 1 && f < lt.salidaReticula) out.push({que: 'titulo', op: 1, caja: titulo, detras: false});
	fichas.forEach((fi, i) => {
		if (f >= lt.fichas[i] && f < lt.salidaFichas[i] + 5) out.push({que: `ficha${i}`, op: 1, caja: {x0: fi.x0, y0: fi.y0 - 12, x1: fi.x0 + fi.w, y1: fi.y0 + fi.h + 12}, detras: false});
	});
	return out;
}

// ───────────────────────── M3: pantalla-a-objeto ─────────────────────────

/** Pose final de la pantalla [D]: entera (sin recortes), arriba a la derecha, detrás de tu cabeza y arriba de tu ceja. */
export const PANTALLA_M3 = {escala: 0.26, cx: 790, cy: 474, ry: -12, rx: 5} as const;
/**
 * Recorte de la pantalla mientras se aleja [D]: del lienzo entero a la esquina de arriba a la derecha en 5 cuadros
 * (ease-out fuerte). Desde el cuadro 1 la pantalla va DETRÁS de tu cabeza entera, así que nunca queda a media opacidad
 * ni desenfocada sobre tu cara; el recorte libera tu cuerpo en 2–3 cuadros.
 */
export const RECORTE_M3 = {x0: 600, y1: 830, cuadros: 5} as const;

export type PosePantalla = {cx: number; cy: number; s: number; p: number; op: number; blur: number; z: number; recorte: Caja; detras: boolean};

export function posePantalla(r: PantallaResuelto, f: number, dur: number): PosePantalla {
	const lt = lineaPantalla(r, dur);
	const p = resorte(f, RESORTES.pesado);
	const ret = avance(f, lt.retira, 10);
	const e = CURVAS.salida(cl(f / RECORTE_M3.cuadros));
	return {
		cx: lerp(540, PANTALLA_M3.cx, p),
		cy: lerp(960, PANTALLA_M3.cy, p),
		s: 1 - (1 - PANTALLA_M3.escala) * p,
		p,
		op: 1 - ret,
		blur: 10 * ret,
		z: -300 * ret,
		recorte: {x0: lerp(0, RECORTE_M3.x0, e), y0: 0, x1: 1080, y1: lerp(1920, RECORTE_M3.y1, e)},
		detras: f >= 1,
	};
}

/** El comando baja de su lugar en la demo a tu pecho en 6 cuadros (ease-out): cruza tu boca a lo mucho 2 cuadros. */
export const VUELO_COMANDO = 6;

export function poseComando(r: PantallaResuelto, f: number, dur: number): {dx: number; dy: number; k: number; op: number; blur: number; rompe: number; vx: number; vy: number} {
	const lt = lineaPantalla(r, dur);
	const {ficha} = piezasComando(r.comando);
	const anchoTexto = r.comando.length * ficha.letra * 0.6;
	const c = r.comando_en_demo;
	const k0 = (c.x1 - c.x0) / anchoTexto;
	const inicio = {x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2};
	const fin = {x: ficha.x0 + 22 + anchoTexto / 2, y: (ficha.y0 + ficha.y1) / 2};
	const en = (t: number) => {
		const v = CURVAS.salida(cl((t - lt.despega + 1) / VUELO_COMANDO));
		return {x: (inicio.x - fin.x) * (1 - v), y: (inicio.y - fin.y) * (1 - v), v};
	};
	const a = en(f);
	const b = en(f - 0.5);
	const rompe = avance(f, lt.rompe, SALIDA_LIBRE, CURVAS.mover);
	return {dx: a.x, dy: a.y, k: (k0 + (1 - k0) * a.v) * (1 - 0.06 * rompe), op: (f >= lt.despega ? 1 : 0) * (1 - rompe), blur: 6 * rompe, rompe, vx: (a.x - b.x) * 2, vy: (a.y - b.y) * 2};
}

export type PoseSkill = {x: number; y: number; escala: number; rot: number; op: number; blur: number; vx: number; vy: number; cae: number};

/** Resorte de cada carta: las de atrás (escala menor) pesan más y llegan después. */
const resorteSkill = (escala: number) => ({damping: 16, stiffness: 210, mass: 0.6 + (1 - escala) * 2});

/** Punto de una curva cúbica de Bézier. */
function cubica(p0: {x: number; y: number}, p1: {x: number; y: number}, p2: {x: number; y: number}, p3: {x: number; y: number}, t: number) {
	const u = 1 - t;
	const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
	return {x: k[0] * p0.x + k[1] * p1.x + k[2] * p2.x + k[3] * p3.x, y: k[0] * p0.y + k[1] * p1.y + k[2] * p2.y + k[3] * p3.y};
}

/** Carril por el que bajan las cartas a la caja [D]: por tu costado izquierdo (x 170), nunca por tu cara. */
export const CARRIL_CAIDA = 170;

function poseSkillCruda(r: PantallaResuelto, fi: FichaSkill, i: number, f: number, dur: number): Omit<PoseSkill, 'vx' | 'vy'> {
	const lt = lineaPantalla(r, dur);
	const v0 = lt.vuelan[i];
	// Se reparten DESDE la pantalla (que ya está arriba a la derecha): salen chicas de ella y vuelan a su lugar.
	const pa = posePantalla(r, v0, dur);
	const origen = {x: pa.cx - 40, y: pa.cy - 60};
	if (f < v0) return {x: origen.x, y: origen.y, escala: 0.35, rot: 0, op: 0, blur: 0, cae: 0};
	const v = resorte(f - v0, resorteSkill(fi.escala));
	const vc = Math.min(1, v);
	const giro = i % 2 === 0 ? 9 : -9;
	const a = f / 30;
	const flota = cl((f - v0 - 12) / 8);
	let x = lerp(origen.x, fi.cx, v) + 5 * Math.sin(2 * Math.PI * 0.23 * a + i * 1.7) * flota;
	let y = lerp(origen.y, fi.cy, v) - 50 * bump(vc, 1) + 4 * Math.sin(2 * Math.PI * 0.31 * a + i * 2.3) * flota;
	// "literalmente": golpe de escala (la estrella más).
	let escala = lerp(0.35, fi.escala, v) * (1 + (fi.estrella ? 0.07 : 0.035) * bump(f - lt.respira, 8));
	let rot = lerp(giro, fi.rot, vc);
	let op = 1;
	const cae = avance(f, lt.convergen[i], CUADROS_CONVERGEN, EASE_IN);
	if (cae > 0) {
		const q = cubica({x, y}, {x: CARRIL_CAIDA, y}, {x: CARRIL_CAIDA, y: 900}, {x: r.cursor.x + 8, y: r.cursor.y}, cae);
		x = q.x;
		y = q.y;
		// Se encogen rápido (a 0.22 en el primer 35 %) para pasar por tu costado y terminan en el cursor.
		escala *= cae < 0.35 ? 1 - 0.78 * (cae / 0.35) : 0.22 - 0.14 * ((cae - 0.35) / 0.65);
		rot *= 1 - cae;
		op = 1 - cl((cae - 0.85) / 0.15);
	}
	return {x, y, escala, rot, op, blur: fi.blur * (1 - cae), cae};
}

export function poseSkill(r: PantallaResuelto, fi: FichaSkill, i: number, f: number, dur: number): PoseSkill {
	const a = poseSkillCruda(r, fi, i, f, dur);
	const b = poseSkillCruda(r, fi, i, f - 0.5, dur);
	return {...a, vx: (a.x - b.x) * 2, vy: (a.y - b.y) * 2};
}

/**
 * Caja blanca de la tarjeta: crece desde el cursor hacia la derecha (CUADROS_CAJA, ease-out) unos cuadros antes de
 * que caigan las cartas; ya completa, espera con su cursor y recibe las cartas. En el último cuadro mide lo que la
 * tarjeta real (relevo sin costura).
 */
export function cajaCrece(r: PantallaResuelto, f: number, dur: number): (Caja & {p: number}) | null {
	const lt = lineaPantalla(r, dur);
	if (f < lt.caja) return null;
	const p = CURVAS.salida(cl((f - lt.caja + 1) / CUADROS_CAJA));
	const t = r.tarjeta;
	return {x0: t.x0, y0: t.y0, y1: t.y1, x1: lerp(Math.min(t.x1, r.cursor.x + 30), t.x1, p), p};
}

function cajasPantalla(r: PantallaResuelto, f: number, dur: number): CajaPieza[] {
	const out: CajaPieza[] = [];
	const pa = posePantalla(r, f, dur);
	if (pa.op > 0.02) {
		const b = {x0: pa.cx - 540 * pa.s, x1: pa.cx + 540 * pa.s, y0: pa.cy - 960 * pa.s, y1: pa.cy + 960 * pa.s};
		const c = {x0: Math.max(b.x0, pa.recorte.x0), x1: Math.min(b.x1, pa.recorte.x1), y0: Math.max(b.y0, pa.recorte.y0), y1: Math.min(b.y1, pa.recorte.y1)};
		if (c.x1 > c.x0 && c.y1 > c.y0) out.push({que: 'pantalla', op: pa.op, caja: c, detras: pa.detras});
	}
	const co = poseComando(r, f, dur);
	const {ficha, tecla} = piezasComando(r.comando);
	if (co.op > 0.02) {
		const w = (ficha.x1 - ficha.x0) * co.k;
		const h = (ficha.y1 - ficha.y0) * co.k;
		const cx = (ficha.x0 + ficha.x1) / 2 + co.dx;
		const cy = (ficha.y0 + ficha.y1) / 2 + co.dy;
		out.push({que: 'comando', op: co.op, caja: {x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2}, detras: false});
		out.push({que: 'tecla', op: co.op, caja: tecla, detras: false});
	}
	lugaresSkills(r.skills).forEach((fi, i) => {
		const s = poseSkill(r, fi, i, f, dur);
		if (s.op <= 0.02) return;
		const w = (fi.w * s.escala) / 2;
		const h = (fi.h * s.escala) / 2;
		out.push({que: `skill${i}`, op: s.op, caja: {x0: s.x - w, x1: s.x + w, y0: s.y - h, y1: s.y + h}, detras: false});
	});
	// La caja blanca no cuenta aquí: es el lugar de la tarjeta que sigue (t1), que decide el director y revisa validar.ts.
	return out;
}

// ───────────────────────── verificación: ¿te tapan? ─────────────────────────

export type CajaPieza = {que: string; op: number; caja: Caja; detras: boolean};

/** Cajas visibles (px base, en pantalla) de las piezas de un motion libre en el cuadro f. `detras` = va detrás de tu cabeza. */
export function cajasLibre(r: LibreResuelto, f: number, dur: number): CajaPieza[] {
	if (r.nombre === 'prueba-corregida') return cajasPrueba(r, f, dur);
	if (r.nombre === 'plantilla-apple') return cajasPlantilla(r, f, dur);
	return cajasPantalla(r, f, dur);
}

const enciman = (a: Caja, b: Caja) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Cuadros en que alguna pieza (opacidad > 0.2) tapa tus ojos, nariz o boca (zonaRostro) y la racha más larga. Lo que va
 * DETRÁS de tu cabeza no tapa (la máscara de tu cabeza lo recorta).
 */
export function tapaRostro(r: LibreResuelto, dur: number): {cuadros: number[]; racha: number; piezas: Set<string>} {
	const cuadros: number[] = [];
	const piezas = new Set<string>();
	let racha = 0;
	let actual = 0;
	for (let f = 0; f < dur; f++) {
		const z = zonaRostro(cabezaLibre(r, f, dur));
		const tapan = cajasLibre(r, f, dur).filter((p) => p.op > 0.2 && !p.detras && enciman(p.caja, z));
		if (tapan.length) {
			cuadros.push(f);
			tapan.forEach((p) => piezas.add(p.que));
			actual++;
			racha = Math.max(racha, actual);
		} else actual = 0;
	}
	return {cuadros, racha, piezas};
}
