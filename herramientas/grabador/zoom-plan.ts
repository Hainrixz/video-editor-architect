/**
 * Plan de zoom, cursor sintético y ondas de clic de una demo de pantalla (Fase 5).
 *
 * ESTE ARCHIVO ES PURO Y NO USA NODE: lo importa src/reel/DemoPantalla.tsx, que Remotion empaqueta para el
 * navegador. No importes aquí node:*, fallo.ts ni nada que toque archivos.
 *
 * Modelo de cámara: la toma mide `ancho × alto` px (p. ej. 2560×1600). La salida tiene un aspecto (16:10 para
 * el encuadre horizontal, el de la caja para el vertical). La "vista base" es el rectángulo más grande con ese
 * aspecto que cabe en el cuadro; con escala 1 se ve la vista base y con escala s se ve base / s.
 * La cámara nunca saca la vista del cuadro: su centro se limita en las orillas.
 *
 * Reglas (supuestos del plan v5 hasta medirlos en tus reels):
 *   - El zoom entra 400–500 ms antes del clic (ANTICIPO = 0.45 s) y se mantiene 1–1.5 s (SOSTEN = 1.2 s).
 *   - Si el siguiente evento con zoom llega en menos de 1.2 s, la cámara hace paneo (no se aleja). También hace
 *     paneo si no cabe sostener 1 s + volver a la vista completa 0.3 s + entrar de nuevo (hueco < 1.75 s): alejarse
 *     y volver a entrar en menos tiempo se ve como un parpadeo. El paneo arranca 0.45 s antes del siguiente evento,
 *     nunca antes de que acabe el actual; eventos a menos de 0.6 s se miran juntos (caja unida) si los dos caben en
 *     la vista completa, y si no, el paneo se acelera (resorte más rápido) para llegar a tiempo al siguiente.
 *   - Escala = clamp(0.7 · min(vistaW / cajaW, vistaH / cajaH), 1, 2.5).
 *   - Un scroll o una navegación después del clic sacan el zoom (el contenido se movió o cambió).
 *   - Movimiento con resorte críticamente amortiguado (ω = 14 rad/s: ~98 % del camino en 0.45 s, sin rebote),
 *     en escala logarítmica (un zoom de 1→2 se siente igual que uno de 2→4) y en el centro.
 *   - Criterio: en el instante del clic, la caja cruza la zona visible y su centro cae dentro, salvo cuando la
 *     cámara se limitó en la orilla.
 */
import {ESTILO_DEMO, type CajaPx, type EventoDemo} from '../../src/estilo/demo.ts';

export const ZOOM = {
	/** Entra 400–500 ms antes del clic. */
	anticipo_s: 0.45,
	/** Se mantiene 1–1.5 s después del evento (o de que acaba de escribir). */
	sosten_s: 1.2,
	sosten_min_s: 1.0,
	/** Si el siguiente evento con zoom llega antes de esto, paneo. */
	paneo_s: 1.2,
	/** Tiempo mínimo en la vista completa entre un zoom y el siguiente; si no cabe, paneo. */
	estancia_min_s: 0.3,
	/**
	 * Eventos con zoom más juntos que esto se miran juntos (caja unida): no hay tiempo de ir de uno a otro sin
	 * perder el primero (la entrada dura 0.45 s).
	 */
	agrupar_s: 0.6,
	factor: 0.7,
	escala_min: 1,
	escala_max: 2.5,
	/** Resorte críticamente amortiguado (rad/s). */
	omega: 14,
} as const;

export const FUENTE_ZOOM = 'supuesto (plan v5): sin medir en tus reels';

export type ParametrosZoom = {-readonly [K in keyof typeof ZOOM]: number};

export type OpcionesZoom = Partial<ParametrosZoom> & {
	/** Tamaño del cuadro grabado (px). */
	ancho: number;
	alto: number;
	/** Ancho / alto de la vista de salida. */
	aspecto: number;
};

export type Encuadre = 'horizontal' | 'vertical';

export type MotivoObjetivo = 'inicio' | 'clic' | 'tecla' | 'paneo' | 'salida' | 'scroll' | 'navegacion';

/** A partir de `t`, la cámara va (con resorte) hacia esta escala y este centro. */
export type Objetivo = {
	t: number;
	escala: number;
	cx: number;
	cy: number;
	/** El centro pedido no cabía con esta escala y se limitó en la orilla. */
	limitado: boolean;
	motivo: MotivoObjetivo;
	/** Índices (en la lista original) de los eventos que lo causaron. */
	eventos: number[];
	/**
	 * Resorte de este tramo (rad/s), si no es el normal: cuando el siguiente evento llega antes de 0.45 s, el paneo
	 * se acelera para llegar a tiempo (~98 % del camino en el tiempo que haya).
	 */
	omega?: number;
};

export type PlanZoom = {
	version: 1;
	ancho: number;
	alto: number;
	aspecto: number;
	base: {w: number; h: number};
	omega: number;
	parametros: ParametrosZoom;
	objetivos: Objetivo[];
};

export type Camara = {
	t: number;
	escala: number;
	/** Centro de la vista y rectángulo visible, en px del cuadro. */
	cx: number;
	cy: number;
	x: number;
	y: number;
	w: number;
	h: number;
	/** La vista está pegada a una orilla porque el centro pedido la sacaba del cuadro. */
	limitada: boolean;
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** ω·τ para llegar a ~98.7 % del camino con un resorte críticamente amortiguado: (1 + x)·e^(−x) = 0.013. */
const LLEGADA_OMEGA_TAU = 6.3;
/** Tope del resorte rápido (a 400 rad/s el paneo dura ~16 ms: un corte). */
const OMEGA_MAX = 400;
const centroDe = (c: CajaPx) => ({cx: c.x + c.w / 2, cy: c.y + c.h / 2});

/** Aspecto de la vista: horizontal = el del cuadro; vertical = el de la caja de salida (9:16 si no se da). */
export function aspectoDeEncuadre(encuadre: Encuadre, ancho: number, alto: number, salida?: {ancho: number; alto: number}): number {
	if (encuadre === 'horizontal') return ancho / alto;
	if (salida && salida.ancho > 0 && salida.alto > 0) return salida.ancho / salida.alto;
	return 9 / 16;
}

/** El rectángulo más grande con ese aspecto que cabe en el cuadro. */
export function vistaBase(ancho: number, alto: number, aspecto: number): {w: number; h: number} {
	if (ancho / alto > aspecto) return {w: alto * aspecto, h: alto};
	return {w: ancho, h: ancho / aspecto};
}

/** Escala = clamp(factor · min(vistaW / cajaW, vistaH / cajaH), mín, máx). Una caja de menos de 1 px cuenta como 1 px. */
export function escalaParaCaja(caja: CajaPx, base: {w: number; h: number}, p: Pick<ParametrosZoom, 'factor' | 'escala_min' | 'escala_max'> = ZOOM): number {
	const w = Math.max(1, caja.w);
	const h = Math.max(1, caja.h);
	return clamp(p.factor * Math.min(base.w / w, base.h / h), p.escala_min, p.escala_max);
}

/** Lleva el centro de una vista w×h a donde la vista quepa completa en el cuadro. */
export function limitarCentro(cx: number, cy: number, w: number, h: number, ancho: number, alto: number): {cx: number; cy: number; limitada: boolean} {
	const lx = w >= ancho ? ancho / 2 : clamp(cx, w / 2, ancho - w / 2);
	const ly = h >= alto ? alto / 2 : clamp(cy, h / 2, alto - h / 2);
	return {cx: lx, cy: ly, limitada: Math.abs(lx - cx) > 1e-6 || Math.abs(ly - cy) > 1e-6};
}

function unirCajas(a: CajaPx, b: CajaPx): CajaPx {
	const x0 = Math.min(a.x, b.x);
	const y0 = Math.min(a.y, b.y);
	const x1 = Math.max(a.x + a.w, b.x + b.w);
	const y1 = Math.max(a.y + a.h, b.y + b.h);
	return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
}

/** ini: primer evento; ultimo: último evento (su inicio); fin: cuando acaba el último (con su duración). */
type Foco = {ini: number; ultimo: number; fin: number; caja: CajaPx; eventos: number[]; tipo: 'clic' | 'tecla'};

function revisarOpciones(op: OpcionesZoom): void {
	for (const [nombre, valor] of [['ancho', op.ancho], ['alto', op.alto], ['aspecto', op.aspecto]] as const) {
		if (!(typeof valor === 'number' && Number.isFinite(valor) && valor > 0)) {
			throw new Error(`No pude planear el zoom: ${nombre} (${String(valor)}) debe ser un número mayor que 0. Siguiente paso: revisa toma.json.`);
		}
	}
}

/**
 * Eventos → plan de zoom (lista de objetivos en el tiempo de la toma).
 * Los eventos no tienen que venir en orden; los de tipo clic/tecla con caja de área > 0 son "focos".
 */
export function planDeZoom(eventos: readonly EventoDemo[], op: OpcionesZoom): PlanZoom {
	revisarOpciones(op);
	const p: ParametrosZoom = {...ZOOM};
	for (const k of Object.keys(ZOOM) as Array<keyof ParametrosZoom>) {
		const v = op[k];
		if (typeof v === 'number' && Number.isFinite(v)) p[k] = v;
	}
	const {ancho, alto, aspecto} = op;
	const base = vistaBase(ancho, alto, aspecto);
	const orden = eventos.map((e, i) => ({...e, i})).sort((a, b) => a.t - b.t || a.i - b.i);

	// 1) Focos: clics y teclas con caja. Los muy juntos se miran juntos.
	const focos: Foco[] = [];
	for (const e of orden) {
		if ((e.tipo !== 'clic' && e.tipo !== 'tecla') || !(e.caja.w > 0 && e.caja.h > 0)) continue;
		const fin = e.t + (e.dur ?? 0);
		const ultimo = focos[focos.length - 1];
		if (ultimo && e.t - ultimo.fin < p.agrupar_s) {
			// Se miran juntos solo si los dos caben en la vista completa; si no, paneo rápido (abajo).
			const union = unirCajas(ultimo.caja, e.caja);
			if (union.w <= base.w && union.h <= base.h) {
				ultimo.fin = Math.max(ultimo.fin, fin);
				ultimo.ultimo = e.t;
				ultimo.caja = union;
				ultimo.eventos.push(e.i);
				continue;
			}
		}
		focos.push({ini: e.t, ultimo: e.t, fin, caja: {...e.caja}, eventos: [e.i], tipo: e.tipo});
	}
	// 2) Cortes: scroll y navegación sacan el zoom.
	const cortes = orden.filter((e) => e.tipo === 'scroll' || e.tipo === 'navegacion');

	const objetivos: Objetivo[] = [];
	/**
	 * Agrega un objetivo con su centro limitado a la orilla. Si es un foco y se limitó, el resorte apunta un poco más
	 * allá del límite (5 % de la vista base, sin pasar del centro pedido): así la vista toca la orilla antes del clic
	 * en vez de quedarse a ~1 % del camino (la evaluación siempre limita, así que nunca sale del cuadro).
	 */
	const agregar = (o: Omit<Objetivo, 'limitado'>, foco = false) => {
		const vw = base.w / o.escala;
		const vh = base.h / o.escala;
		const lim = limitarCentro(o.cx, o.cy, vw, vh, ancho, alto);
		const mas = (limite: number, pedido: number, margen: number) => limite + Math.sign(pedido - limite) * Math.min(Math.abs(pedido - limite), margen);
		const cx = foco && lim.limitada ? mas(lim.cx, o.cx, 0.05 * base.w) : lim.cx;
		const cy = foco && lim.limitada ? mas(lim.cy, o.cy, 0.05 * base.h) : lim.cy;
		const t = Math.max(o.t, objetivos.length ? objetivos[objetivos.length - 1].t : 0);
		objetivos.push({...o, t, cx, cy, limitado: lim.limitada});
	};

	const primero = focos[0] ? centroDe(focos[0].caja) : {cx: ancho / 2, cy: alto / 2};
	agregar({t: 0, escala: 1, cx: primero.cx, cy: alto / 2, motivo: 'inicio', eventos: []});

	const umbralPaneo = Math.max(p.paneo_s, p.sosten_min_s + p.anticipo_s + p.estancia_min_s);
	let enZoom = false;
	for (let k = 0; k < focos.length; k++) {
		const f = focos[k];
		const c = centroDe(f.caja);
		const escala = escalaParaCaja(f.caja, base, p);
		// Un paneo nunca arranca antes de que acabe el foco anterior (en su clic la cámara debe seguir ahí): sale
		// 50 ms después, o a la mitad del hueco si es más corto.
		let entrada = Math.max(0, f.ini - p.anticipo_s);
		if (enZoom && k > 0) {
			// Si el foco anterior sigue (p. ej. escribía) cuando llega este, el nuevo manda: el anterior se suelta a
			// tiempo para llegar, pero nunca antes de su último evento (en ese clic la cámara debe seguir ahí).
			const ant = focos[k - 1];
			const suelta = ant.fin <= f.ini ? ant.fin : Math.max(ant.ultimo, f.ini - p.anticipo_s);
			entrada = Math.max(entrada, suelta + Math.min(0.05, Math.max(0, f.ini - suelta) / 2));
		}
		entrada = Math.max(entrada, objetivos[objetivos.length - 1].t);
		// Si queda menos tiempo que la entrada normal, el resorte se acelera para llegar en el clic.
		const disponible = f.ini - entrada;
		const omega = disponible < p.anticipo_s - 1e-9 ? Math.min(OMEGA_MAX, Math.max(p.omega, LLEGADA_OMEGA_TAU / Math.max(disponible, 1e-3))) : undefined;
		agregar({t: entrada, escala, cx: c.cx, cy: c.cy, motivo: enZoom ? 'paneo' : f.tipo, eventos: f.eventos, ...(omega ? {omega} : {})}, true);
		enZoom = true;

		const sig = focos[k + 1];
		const limiteSig = sig ? Math.max(sig.ini - p.anticipo_s, f.ini) : Number.POSITIVE_INFINITY;
		// Un scroll o navegación desde el clic (no antes: el scroll que acerca el botón llega justo antes del clic).
		const corte = cortes.find((e) => e.t >= f.ini);
		if (corte && corte.t < limiteSig && corte.t < f.fin + p.sosten_s) {
			agregar({t: corte.t, escala: 1, cx: c.cx, cy: alto / 2, motivo: corte.tipo === 'scroll' ? 'scroll' : 'navegacion', eventos: [corte.i]});
			enZoom = false;
			continue;
		}
		if (sig && sig.ini - f.fin < umbralPaneo) continue; // paneo: el siguiente objetivo llega sin alejarse
		const salida = Math.max(f.fin + p.sosten_min_s, Math.min(f.fin + p.sosten_s, limiteSig - p.estancia_min_s));
		agregar({t: salida, escala: 1, cx: c.cx, cy: alto / 2, motivo: 'salida', eventos: []});
		enZoom = false;
	}

	return {version: 1, ancho, alto, aspecto, base, omega: p.omega, parametros: p, objetivos};
}

/** Avanza un resorte críticamente amortiguado τ segundos hacia `destino` (solución exacta, sin integrar). */
function avanzar(x0: number[], v0: number[], destino: number[], tau: number, omega: number): {x: number[]; v: number[]} {
	const e = Math.exp(-omega * tau);
	const x: number[] = [];
	const v: number[] = [];
	for (let i = 0; i < x0.length; i++) {
		const c1 = x0[i] - destino[i];
		const c2 = v0[i] + omega * c1;
		x.push(destino[i] + (c1 + c2 * tau) * e);
		v.push((c2 - omega * (c1 + c2 * tau)) * e);
	}
	return {x, v};
}

const estadoDe = (o: Objetivo) => [Math.log(o.escala), o.cx, o.cy];

/**
 * Cámara en el instante t (s de la toma). Determinista y sin estado: cada cuadro se calcula desde el inicio
 * del plan, así el render da lo mismo en cualquier orden de cuadros.
 */
export function evaluarCamara(plan: PlanZoom, t: number): Camara {
	const obj = plan.objetivos;
	let x = estadoDe(obj[0]);
	let v = [0, 0, 0];
	let destino = x;
	let tAnterior = obj[0].t;
	let actual = obj[0];
	for (let j = 1; j < obj.length && obj[j].t <= t; j++) {
		({x, v} = avanzar(x, v, destino, obj[j].t - tAnterior, actual.omega ?? plan.omega));
		tAnterior = obj[j].t;
		destino = estadoDe(obj[j]);
		actual = obj[j];
	}
	if (t > tAnterior) ({x} = avanzar(x, v, destino, t - tAnterior, actual.omega ?? plan.omega));
	const escala = Math.max(1, Math.exp(x[0]));
	const w = plan.base.w / escala;
	const h = plan.base.h / escala;
	const lim = limitarCentro(x[1], x[2], w, h, plan.ancho, plan.alto);
	return {t, escala, cx: lim.cx, cy: lim.cy, x: lim.cx - w / 2, y: lim.cy - h / 2, w, h, limitada: lim.limitada || actual.limitado};
}

export type RevisionClic = {cruza: boolean; centroDentro: boolean; limitada: boolean; pasa: boolean; camara: Camara};

/** Criterio de la Fase 5 para un clic: la caja cruza la vista y su centro cae dentro (salvo vista limitada en la orilla). */
export function revisarClic(plan: PlanZoom, evento: {t: number; caja: CajaPx}): RevisionClic {
	const cam = evaluarCamara(plan, evento.t);
	const c = evento.caja;
	const cruza = c.x < cam.x + cam.w && c.x + Math.max(c.w, 1e-9) > cam.x && c.y < cam.y + cam.h && c.y + Math.max(c.h, 1e-9) > cam.y;
	const {cx, cy} = centroDe(c);
	const centroDentro = cx >= cam.x && cx <= cam.x + cam.w && cy >= cam.y && cy <= cam.y + cam.h;
	return {cruza, centroDentro, limitada: cam.limitada, pasa: cruza && (centroDentro || cam.limitada), camara: cam};
}

// ───────────────────────── cursor sintético y ondas ─────────────────────────

const C = ESTILO_DEMO.cursor;
const O = ESTILO_DEMO.onda;

/** Curva suave de entrada y salida (cúbica). */
export function suave(p: number): number {
	const x = clamp(p, 0, 1);
	return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export type EstadoCursor = {x: number; y: number; escala: number};

function clicsDe(eventos: readonly EventoDemo[]): EventoDemo[] {
	return eventos.filter((e) => e.tipo === 'clic' && e.caja.w > 0 && e.caja.h > 0).sort((a, b) => a.t - b.t);
}

/**
 * Dónde va el cursor sintético en t (px del cuadro): descansa, viaja con curva suave hacia cada clic y llega
 * justo en el instante del clic; ahí se encoge un poco (escala) y regresa. Entre clics se queda quieto.
 */
export function posicionCursor(eventos: readonly EventoDemo[], t: number, op: {ancho: number; alto: number}): EstadoCursor {
	const clics = clicsDe(eventos);
	let previo = {x: C.reposo.x * op.ancho, y: C.reposo.y * op.alto};
	let tPrevio = 0;
	let pos = previo;
	let resuelto = false;
	for (const c of clics) {
		const punto = {x: c.caja.x + c.caja.w / 2, y: c.caja.y + c.caja.h / 2};
		if (t < c.t) {
			const viaje = Math.min(C.viaje_max_s, C.viaje_frac * Math.max(0, c.t - tPrevio));
			const inicio = c.t - viaje;
			if (viaje <= 1e-6 || t <= inicio) pos = previo;
			else {
				const k = suave((t - inicio) / viaje);
				pos = {x: previo.x + (punto.x - previo.x) * k, y: previo.y + (punto.y - previo.y) * k};
			}
			resuelto = true;
			break;
		}
		previo = punto;
		tPrevio = c.t;
	}
	if (!resuelto) pos = previo;
	// Pulso de clic: baja en 80 ms hasta la escala mínima y regresa en 140 ms.
	let pulso = 0;
	for (const c of clics) {
		const d = t - c.t;
		if (d >= -0.08 && d <= 0) pulso = Math.max(pulso, 1 + d / 0.08);
		else if (d > 0 && d <= 0.14) pulso = Math.max(pulso, 1 - d / 0.14);
	}
	return {x: pos.x, y: pos.y, escala: 1 - (1 - C.escala_clic) * pulso};
}

export type Onda = {x: number; y: number; radio: number; grosor: number; opacidad: number};

/** Ondas de clic vivas en t (px del cuadro): un anillo que crece y se desvanece en ~0.55 s. */
export function ondasActivas(eventos: readonly EventoDemo[], t: number, op: {alto: number}): Onda[] {
	const ondas: Onda[] = [];
	for (const c of clicsDe(eventos)) {
		const d = t - c.t;
		if (d < 0 || d > O.duracion_s) continue;
		const p = d / O.duracion_s;
		const crecer = 1 - Math.pow(1 - p, 3);
		ondas.push({
			x: c.caja.x + c.caja.w / 2,
			y: c.caja.y + c.caja.h / 2,
			radio: (O.radio_ini_rel + (O.radio_fin_rel - O.radio_ini_rel) * crecer) * op.alto,
			grosor: O.grosor_rel * op.alto * (1 - 0.5 * p),
			opacidad: O.opacidad_max * Math.pow(1 - p, 1.5),
		});
	}
	return ondas;
}
