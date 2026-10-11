/**
 * Capas (overlays) de un reel: stickers, tarjetas e inserts que APARECEN, se quedan quietos mientras tú te mueves,
 * y DESAPARECEN. Todo en coordenadas base 1080×1920.
 *
 * Idea (sin Vision ni GPU: corre dentro del sandbox):
 *   1. Pasada 1 (ffmpeg → cuadros RGB a 270×480, ¼ de la base): cada píxel se parte en RACHAS donde su color no se
 *      mueve más de `eps` del color con que arrancó. Las rachas de ≥ 0.25 s se guardan (píxel, inicio, fin, color).
 *   2. Una capa es un grupo de rachas que nacen juntas (±la duración del pop) y mueren JUNTAS (±1 cuadro),
 *      vecinas en el espacio. El fondo (pared, silla, tu playera) también hace rachas largas: se descarta por
 *      RECURRENCIA (ese píxel ya tuvo ese mismo color mucho tiempo fuera del evento). Se excluyen la franja de
 *      subtítulos y el titular (texto blanco fijo arriba casi todo el video).
 *   3. Pasada 2: alrededor de cada aparición se compara el cuadro contra la plantilla de la capa ya asentada a
 *      escalas 0.2–1.4 (pop: escala inicial, sobrepaso y cuadros), y se afinan `desde` y `hasta` a los fps nativos.
 *   4. Clasificación por apariencia: tarjeta (rectángulo blanco con texto oscuro), sticker (no rectangular,
 *      colorido o app tile), insert (> 25 % del cuadro, o una toma distinta a pantalla completa), otro.
 *
 * Las tomas a pantalla completa (tu laptop) no hacen rachas (la cámara se mueve): salen del análisis de escenas
 * (`escenas`), que compara cada toma contra la toma principal (tolerando zooms).
 */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {basename} from 'node:path';
import {fallo} from './fallo.ts';

/** Base de coordenadas de la EDL. */
export const BASE_W = 1080;
export const BASE_H = 1920;
/** Resolución de análisis: ¼ de la base. Un píxel de análisis = 4×4 px base. */
export const ANALISIS_W = 270;
export const ANALISIS_H = 480;
export const ESCALA_BASE = BASE_W / ANALISIS_W; // 4

// ───────────────────────────── Arreglos que crecen ─────────────────────────────

/** Int32Array que crece (para millones de rachas sin objetos por elemento). */
export class EnterosCrecientes {
	datos: Int32Array;
	n = 0;
	constructor(capacidad = 1 << 16) {
		this.datos = new Int32Array(capacidad);
	}
	agregar(v: number): void {
		if (this.n === this.datos.length) {
			const nuevo = new Int32Array(this.datos.length * 2);
			nuevo.set(this.datos);
			this.datos = nuevo;
		}
		this.datos[this.n++] = v;
	}
	vista(): Int32Array {
		return this.datos.subarray(0, this.n);
	}
}

// ───────────────────────────── Rachas por píxel (pasada 1) ─────────────────────────────

export type Rachas = {
	w: number;
	h: number;
	/** Cuadros procesados. */
	total: number;
	/** Por racha: píxel (y·w + x), cuadro de inicio, cuadro de fin (exclusivo) y color de arranque (RGB empacado). */
	pix: Int32Array;
	ini: Int32Array;
	fin: Int32Array;
	color: Int32Array;
	n: number;
};

/**
 * Parte cada píxel en rachas de color casi constante. Una racha arranca con el color del cuadro y sigue mientras
 * cada canal esté a ≤ eps de ese color; si un solo cuadro se sale (ruido del códec) y el siguiente vuelve, la racha
 * sigue (tolera 1 cuadro). Se guardan solo las rachas de ≥ minCuadros.
 */
export class SegmentadorRachas {
	readonly w: number;
	readonly h: number;
	private readonly eps: number;
	private readonly minCuadros: number;
	private readonly ref: Uint8Array;
	/** Color del primer cuadro que se salió (para saber si la racha nueva empieza ahí o en el siguiente). */
	private readonly pendiente: Uint8Array;
	private readonly inicio: Int32Array;
	private readonly fuera: Uint8Array;
	/** Último cuadro fuera que se toleró (solo se tolera uno cada 4 cuadros: el ruido que va y viene corta). */
	private readonly ultimoFuera: Int32Array;
	private cuadros = 0;
	private readonly pix = new EnterosCrecientes();
	private readonly ini = new EnterosCrecientes();
	private readonly fin = new EnterosCrecientes();
	private readonly color = new EnterosCrecientes();

	constructor(w: number, h: number, eps: number, minCuadros: number) {
		this.w = w;
		this.h = h;
		this.eps = eps;
		this.minCuadros = minCuadros;
		this.ref = new Uint8Array(w * h * 3);
		this.pendiente = new Uint8Array(w * h * 3);
		this.inicio = new Int32Array(w * h);
		this.fuera = new Uint8Array(w * h);
		this.ultimoFuera = new Int32Array(w * h).fill(-100);
	}

	private cerrar(p: number, finCuadro: number): void {
		const ini = this.inicio[p];
		if (finCuadro - ini >= this.minCuadros) {
			this.pix.agregar(p);
			this.ini.agregar(ini);
			this.fin.agregar(finCuadro);
			const o = 3 * p;
			this.color.agregar((this.ref[o] << 16) | (this.ref[o + 1] << 8) | this.ref[o + 2]);
		}
	}

	/** Procesa el cuadro n (RGB, w·h·3 bytes). Los cuadros deben llegar en orden 0, 1, 2… */
	procesar(rgb: Uint8Array): void {
		const n = this.cuadros;
		const {ref, inicio, fuera, eps} = this;
		const np = this.w * this.h;
		if (n === 0) {
			ref.set(rgb.subarray(0, np * 3));
			inicio.fill(0);
		} else {
			for (let p = 0, o = 0; p < np; p++, o += 3) {
				const d = Math.max(Math.abs(rgb[o] - ref[o]), Math.abs(rgb[o + 1] - ref[o + 1]), Math.abs(rgb[o + 2] - ref[o + 2]));
				if (d <= eps) {
					fuera[p] = 0;
					continue;
				}
				const pend = this.pendiente;
				if (fuera[p] === 0) {
					if (n - this.ultimoFuera[p] >= 4) {
						// Primer cuadro fuera: se tolera (puede ser un parpadeo del códec); si el siguiente también se sale,
						// se corta aquí.
						fuera[p] = 1;
						this.ultimoFuera[p] = n;
						pend[o] = rgb[o];
						pend[o + 1] = rgb[o + 1];
						pend[o + 2] = rgb[o + 2];
						continue;
					}
					// Otro cuadro fuera muy pronto después del tolerado: es un píxel que se mueve; la racha acaba aquí.
					this.cerrar(p, n);
					inicio[p] = n;
					ref[o] = rgb[o];
					ref[o + 1] = rgb[o + 1];
					ref[o + 2] = rgb[o + 2];
					continue;
				}
				// Segundo cuadro seguido fuera: la racha terminó en el primero que se salió (n − 1). La nueva arranca
				// en n − 1 si ese cuadro ya tenía el color nuevo (un salto limpio) o en n si era ruido.
				this.cerrar(p, n - 1);
				const dPend = Math.max(Math.abs(rgb[o] - pend[o]), Math.abs(rgb[o + 1] - pend[o + 1]), Math.abs(rgb[o + 2] - pend[o + 2]));
				inicio[p] = dPend <= eps ? n - 1 : n;
				ref[o] = rgb[o];
				ref[o + 1] = rgb[o + 1];
				ref[o + 2] = rgb[o + 2];
				fuera[p] = 0;
			}
		}
		this.cuadros++;
	}

	/** Cierra las rachas abiertas y devuelve todo. */
	terminar(): Rachas {
		const np = this.w * this.h;
		for (let p = 0; p < np; p++) this.cerrar(p, this.fuera[p] ? this.cuadros - 1 : this.cuadros);
		return {
			w: this.w,
			h: this.h,
			total: this.cuadros,
			pix: this.pix.vista(),
			ini: this.ini.vista(),
			fin: this.fin.vista(),
			color: this.color.vista(),
			n: this.pix.n,
		};
	}
}

// ───────────────────────────── Video → cuadros (ffmpeg) ─────────────────────────────

export type OpcionesCuadros = {
	video: string;
	w?: number;
	h?: number;
	/** Recibe cada cuadro (RGB) con su número nativo. Si devuelve una promesa, se espera (contrapresión). */
	alCuadro: (rgb: Uint8Array, n: number) => void;
	/** Primer y último cuadro nativo a entregar (inclusive); por defecto todos. */
	desde?: number;
	hasta?: number;
};

/**
 * Decodifica el video con ffmpeg a w×h RGB (escalado por área) y entrega cada cuadro nativo en orden
 * (`-fps_mode passthrough`: sin duplicar ni tirar cuadros). Devuelve cuántos cuadros entregó.
 */
export function leerCuadros(op: OpcionesCuadros): Promise<number> {
	const w = op.w ?? ANALISIS_W;
	const h = op.h ?? ANALISIS_H;
	const nombre = basename(op.video);
	const que = `leer los cuadros de ${nombre}`;
	if (!existsSync(op.video)) return Promise.reject(fallo(que, `no existe ${op.video}`, 'revisa la ruta', 2));
	const filtros = [`scale=${w}:${h}:flags=area`];
	if (op.desde !== undefined || op.hasta !== undefined) {
		filtros.unshift(`select='between(n,${op.desde ?? 0},${op.hasta ?? 1e9})'`);
	}
	const args = ['-v', 'error', '-nostdin', '-i', op.video, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filtros.join(','), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
	const bytes = w * h * 3;
	return new Promise<number>((resolver, rechazar) => {
		const ff = spawn('ffmpeg', args, {stdio: ['ignore', 'pipe', 'pipe']});
		let errores = '';
		let buf = Buffer.alloc(bytes);
		let llenos = 0;
		let k = 0;
		const n0 = op.desde ?? 0;
		ff.stderr.on('data', (d: Buffer) => {
			errores = (errores + d.toString()).slice(-4000);
		});
		ff.stdout.on('data', (trozo: Buffer) => {
			let i = 0;
			while (i < trozo.length) {
				const toma = Math.min(bytes - llenos, trozo.length - i);
				trozo.copy(buf, llenos, i, i + toma);
				llenos += toma;
				i += toma;
				if (llenos === bytes) {
					op.alCuadro(new Uint8Array(buf.buffer, buf.byteOffset, bytes), n0 + k++);
					buf = Buffer.alloc(bytes);
					llenos = 0;
				}
			}
		});
		ff.on('error', (e: NodeJS.ErrnoException) =>
			rechazar(
				e.code === 'ENOENT'
					? fallo(que, 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú)', 2, e)
					: fallo(que, `no pude arrancar ffmpeg (${e.message})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, e),
			),
		);
		ff.on('close', (codigo) => {
			if (codigo !== 0) {
				rechazar(fallo(que, `ffmpeg terminó con error (${errores.trim().split('\n').pop() ?? codigo})`, 'revisa que el video esté completo', 1, {args, errores}));
				return;
			}
			resolver(k);
		});
	});
}

// ───────────────────────────── Máscaras y componentes ─────────────────────────────

export type Caja = {x0: number; y0: number; x1: number; y1: number};

/** Componentes conexas (8-vecinos) de una máscara binaria. Devuelve etiquetas (0 = fondo) y cuántas hay. */
export function componentes(mascara: Uint8Array, w: number, h: number): {etiquetas: Int32Array; n: number; tamanos: number[]; cajas: Caja[]} {
	const etiquetas = new Int32Array(w * h);
	const tamanos: number[] = [0];
	const cajas: Caja[] = [{x0: 0, y0: 0, x1: 0, y1: 0}];
	const pila = new Int32Array(w * h);
	let n = 0;
	for (let p0 = 0; p0 < w * h; p0++) {
		if (!mascara[p0] || etiquetas[p0]) continue;
		n++;
		let tope = 0;
		pila[tope++] = p0;
		etiquetas[p0] = n;
		let tam = 0;
		const caja = {x0: w, y0: h, x1: -1, y1: -1};
		while (tope > 0) {
			const p = pila[--tope];
			tam++;
			const x = p % w;
			const y = (p - x) / w;
			if (x < caja.x0) caja.x0 = x;
			if (x > caja.x1) caja.x1 = x;
			if (y < caja.y0) caja.y0 = y;
			if (y > caja.y1) caja.y1 = y;
			for (let dy = -1; dy <= 1; dy++) {
				const yy = y + dy;
				if (yy < 0 || yy >= h) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
					const q = yy * w + xx;
					if (mascara[q] && !etiquetas[q]) {
						etiquetas[q] = n;
						pila[tope++] = q;
					}
				}
			}
		}
		tamanos.push(tam);
		cajas.push(caja);
	}
	return {etiquetas, n, tamanos, cajas};
}

/** Dilatación (r > 0) o erosión (r < 0) cuadrada de radio |r| sobre una máscara binaria. */
export function morfologia(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
	if (r === 0) return Uint8Array.from(m);
	const dil = r > 0;
	const k = Math.abs(r);
	// Separable: primero horizontal, luego vertical.
	const tmp = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let v = dil ? 0 : 1;
			for (let d = -k; d <= k; d++) {
				const xx = x + d;
				const b = xx < 0 || xx >= w ? (dil ? 0 : 0) : m[y * w + xx];
				if (dil && b) {
					v = 1;
					break;
				}
				if (!dil && !b) {
					v = 0;
					break;
				}
			}
			tmp[y * w + x] = v;
		}
	}
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let v = dil ? 0 : 1;
			for (let d = -k; d <= k; d++) {
				const yy = y + d;
				const b = yy < 0 || yy >= h ? 0 : tmp[yy * w + x];
				if (dil && b) {
					v = 1;
					break;
				}
				if (!dil && !b) {
					v = 0;
					break;
				}
			}
			out[y * w + x] = v;
		}
	}
	return out;
}

export const areaCaja = (c: Caja): number => Math.max(0, c.x1 - c.x0 + 1) * Math.max(0, c.y1 - c.y0 + 1);

/**
 * Solidez de un conjunto de píxeles: cuántos hay ÷ área de su envolvente convexa (de las esquinas de cada píxel).
 * Una estrella o una flecha con borde son sólidas (≥ 0.6) aunque llenen poco su caja; las manchas ralas de fondo no.
 */
export function solidez(pixeles: ArrayLike<number>, w: number): number {
	if (pixeles.length === 0) return 0;
	// Por fila, los extremos; los puntos son las esquinas de esos píxeles.
	const minX = new Map<number, number>();
	const maxX = new Map<number, number>();
	for (let i = 0; i < pixeles.length; i++) {
		const p = pixeles[i];
		const x = p % w;
		const y = (p - x) / w;
		if (!minX.has(y) || x < minX.get(y)!) minX.set(y, x);
		if (!maxX.has(y) || x > maxX.get(y)!) maxX.set(y, x);
	}
	const pts: Array<[number, number]> = [];
	for (const [y, x] of minX) pts.push([x, y], [x, y + 1]);
	for (const [y, x] of maxX) pts.push([x + 1, y], [x + 1, y + 1]);
	pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cruz = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const abajo: Array<[number, number]> = [];
	for (const q of pts) {
		while (abajo.length >= 2 && cruz(abajo[abajo.length - 2], abajo[abajo.length - 1], q) <= 0) abajo.pop();
		abajo.push(q);
	}
	const arriba: Array<[number, number]> = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const q = pts[i];
		while (arriba.length >= 2 && cruz(arriba[arriba.length - 2], arriba[arriba.length - 1], q) <= 0) arriba.pop();
		arriba.push(q);
	}
	const hull = [...abajo.slice(0, -1), ...arriba.slice(0, -1)];
	let area2 = 0;
	for (let i = 0; i < hull.length; i++) {
		const [x1, y1] = hull[i];
		const [x2, y2] = hull[(i + 1) % hull.length];
		area2 += x1 * y2 - x2 * y1;
	}
	const area = Math.abs(area2) / 2;
	return area > 0 ? Math.min(1, pixeles.length / area) : 0;
}

/** IoU de dos cajas inclusivas (mismas unidades). */
export function iou(a: Caja, b: Caja): number {
	const x0 = Math.max(a.x0, b.x0);
	const y0 = Math.max(a.y0, b.y0);
	const x1 = Math.min(a.x1, b.x1);
	const y1 = Math.min(a.y1, b.y1);
	const inter = x1 < x0 || y1 < y0 ? 0 : (x1 - x0 + 1) * (y1 - y0 + 1);
	const union = areaCaja(a) + areaCaja(b) - inter;
	return union > 0 ? inter / union : 0;
}

// ───────────────────────────── Rachas → eventos de capa ─────────────────────────────

const R_ = (c: number) => (c >> 16) & 255;
const G_ = (c: number) => (c >> 8) & 255;
const B_ = (c: number) => c & 255;
const distColor = (a: number, b: number) => Math.max(Math.abs(R_(a) - R_(b)), Math.abs(G_(a) - G_(b)), Math.abs(B_(a) - B_(b)));

/** Blanco (min canal ≥ 215, sin tinte), vivo (saturación ≥ 0.5, brillo ≥ 100) o natural. */
export function tipoDeColor(c: number): 'blanco' | 'vivo' | 'natural' {
	const mx = Math.max(R_(c), G_(c), B_(c));
	const mn = Math.min(R_(c), G_(c), B_(c));
	if (mn >= 215 && mx - mn <= 25) return 'blanco';
	return mx >= 100 && (mx - mn) / mx >= 0.5 ? 'vivo' : 'natural';
}

export type EventoCrudo = {
	/** Cuadro en que la capa ya quedó quieta (moda de los nacimientos de sus rachas). */
	asentado: number;
	/** Primer cuadro en que ya no está (fin exclusivo de sus rachas). */
	fin: number;
	/** Píxeles de análisis de la capa (índices y·w + x) y el color de cada uno (RGB empacado). */
	pixeles: Int32Array;
	colores: Int32Array;
	/** Caja en píxeles de análisis (inclusiva). */
	caja: Caja;
};

export type OpcionesAgrupar = {
	fps: number;
	/** Píxeles excluidos (franja de subtítulos y titular), w·h. */
	excluir?: Uint8Array;
	/** Área mínima de una capa en píxeles de análisis (1 = 16 px base). */
	minPixeles?: number;
	/** Tolerancia de la muerte (± cuadros) para que dos rachas sean la misma capa. */
	tolFin?: number;
	/** Cuánto antes de la moda puede nacer una racha de la misma capa (el pop), en segundos. */
	ventanaPopS?: number;
	/** Un píxel es fondo si ese mismo color (±epsFondo) duró ≥ fondoS (o fondoFrac del video) fuera del evento. */
	epsFondo?: number;
	fondoS?: number;
	fondoFrac?: number;
	/** Para colores vivos el umbral de fondo es más alto (s o fracción del video, el mayor). */
	fondoVivoS?: number;
	fondoVivoFrac?: number;
};

/**
 * Agrupa rachas en eventos de capa: mismas muertes (±tolFin), nacimientos cerca de una moda (−ventanaPop…+2),
 * vecinas en el espacio; quita los píxeles de FONDO (su color se repite fuera del evento).
 */
export function eventosDeRachas(r: Rachas, op: OpcionesAgrupar): EventoCrudo[] {
	const {w, h, total} = r;
	const np = w * h;
	const minPix = op.minPixeles ?? 120;
	const tolFin = op.tolFin ?? 1;
	const ventanaPop = Math.round((op.ventanaPopS ?? 0.4) * op.fps);
	const epsFondo = op.epsFondo ?? 18;
	const fondoCuadros = Math.max(Math.round((op.fondoS ?? 3) * op.fps), Math.round((op.fondoFrac ?? 0.15) * total));

	// Índice por píxel (CSR), en orden de tiempo.
	const cuenta = new Int32Array(np + 1);
	for (let i = 0; i < r.n; i++) cuenta[r.pix[i] + 1]++;
	for (let p = 0; p < np; p++) cuenta[p + 1] += cuenta[p];
	const porPixel = new Int32Array(r.n);
	const lleno = cuenta.slice(0, np);
	for (let i = 0; i < r.n; i++) porPixel[lleno[r.pix[i]]++] = i;

	/**
	 * ¿El color de la racha i se repite en ese píxel fuera de [ini − margen, fin + margen] por ≥ fondoCuadros?
	 * El blanco nunca cuenta como fondo (muchas tarjetas blancas caen en el mismo lugar a propósito). Un color vivo
	 * solo es fondo si se repite mucho más (≥ fondoVivoCuadros: una pared naranja, no los stickers en el pecho).
	 */
	const margen = Math.round(0.5 * op.fps);
	const fondoVivo = Math.max(Math.round((op.fondoVivoS ?? 10) * op.fps), Math.round((op.fondoVivoFrac ?? 0.3) * total));
	const esFondo = (i: number): boolean => {
		const p = r.pix[i];
		const c = r.color[i];
		const tipo = tipoDeColor(c);
		if (tipo === 'blanco') return false;
		const limite = tipo === 'vivo' ? fondoVivo : fondoCuadros;
		const a = r.ini[i] - margen;
		const b = r.fin[i] + margen;
		let suma = 0;
		for (let k = cuenta[p]; k < cuenta[p + 1]; k++) {
			const j = porPixel[k];
			if (j === i || (r.fin[j] > a && r.ini[j] < b)) continue;
			if (distColor(r.color[j], c) <= epsFondo) {
				suma += r.fin[j] - r.ini[j];
				if (suma >= limite) return true;
			}
		}
		return false;
	};

	// Cubetas por cuadro de muerte.
	const usada = new Uint8Array(r.n);
	const porFin: number[][] = Array.from({length: total + 1}, () => []);
	for (let i = 0; i < r.n; i++) {
		if (op.excluir?.[r.pix[i]]) continue;
		if (r.ini[i] === 0 && r.fin[i] >= total) continue; // quieto todo el video: fondo o titular
		porFin[Math.min(total, r.fin[i])].push(i);
	}
	const ordenFin = [...porFin.keys()].filter((e) => porFin[e].length >= minPix).sort((a, b) => porFin[b].length - porFin[a].length);
	const eventos: EventoCrudo[] = [];
	const colorDe = new Int32Array(np);
	for (const e of ordenFin) {
		// Rachas que mueren en e ± tolFin y no se han usado.
		let grupo: number[] = [];
		for (let d = -tolFin; d <= tolFin; d++) {
			const lista = porFin[e + d];
			if (!lista) continue;
			for (const i of lista) if (!usada[i]) grupo.push(i);
		}
		while (grupo.length >= minPix) {
			// Moda de los nacimientos.
			const hist = new Map<number, number>();
			for (const i of grupo) hist.set(r.ini[i], (hist.get(r.ini[i]) ?? 0) + 1);
			let moda = -1;
			let max = 0;
			for (const [k, v] of hist) if (v > max || (v === max && k > moda)) {
				max = v;
				moda = k;
			}
			const dentro = grupo.filter((i) => r.ini[i] >= moda - ventanaPop && r.ini[i] <= moda + 2);
			const resto = grupo.filter((i) => !(r.ini[i] >= moda - ventanaPop && r.ini[i] <= moda + 2));
			for (const i of dentro) usada[i] = 1;
			grupo = resto;
			if (dentro.length < minPix) continue;
			// Quita el fondo y arma la máscara.
			const pixs: number[] = [];
			for (const i of dentro) {
				if (esFondo(i)) continue;
				const p = r.pix[i];
				colorDe[p] = r.color[i];
				pixs.push(p);
			}
			if (pixs.length >= minPix) {
				// Cierre (dilata 2, erosiona 2) para unir letras y trazos, en una ventana local; componentes.
				let bx0 = w;
				let by0 = h;
				let bx1 = 0;
				let by1 = 0;
				for (const p of pixs) {
					const x = p % w;
					const y = (p - x) / w;
					if (x < bx0) bx0 = x;
					if (x > bx1) bx1 = x;
					if (y < by0) by0 = y;
					if (y > by1) by1 = y;
				}
				bx0 = Math.max(0, bx0 - 3);
				by0 = Math.max(0, by0 - 3);
				bx1 = Math.min(w - 1, bx1 + 3);
				by1 = Math.min(h - 1, by1 + 3);
				const lw = bx1 - bx0 + 1;
				const lh = by1 - by0 + 1;
				const local = new Uint8Array(lw * lh);
				for (const p of pixs) {
					const x = p % w;
					const y = (p - x) / w;
					local[(y - by0) * lw + (x - bx0)] = 1;
				}
				const cerrada = morfologia(morfologia(local, lw, lh, 2), lw, lh, -2);
				const comp = componentes(cerrada, lw, lh);
				for (let c = 1; c <= comp.n; c++) {
					if (comp.tamanos[c] < minPix) continue;
					const k = comp.cajas[c];
					const pxs: number[] = [];
					for (let y = k.y0; y <= k.y1; y++) {
						for (let x = k.x0; x <= k.x1; x++) {
							if (comp.etiquetas[y * lw + x] !== c || !local[y * lw + x]) continue;
							pxs.push((y + by0) * w + (x + bx0));
						}
					}
					if (pxs.length < minPix * 0.6) continue;
					eventos.push({
						asentado: moda,
						fin: e,
						pixeles: Int32Array.from(pxs),
						colores: Int32Array.from(pxs, (p) => colorDe[p]),
						caja: {x0: k.x0 + bx0, y0: k.y0 + by0, x1: k.x1 + bx0, y1: k.y1 + by0},
					});
				}
			}
		}
	}
	return eventos.sort((a, b) => a.asentado - b.asentado || a.caja.y0 - b.caja.y0);
}

// ───────────────────────────── Máscaras de exclusión ─────────────────────────────

/** Franja de subtítulos por defecto (base 1920), según el encargo: y 1420–1580. */
export const FRANJA_SUBTITULOS: [number, number] = [1420, 1580];

/** Máscara (w·h) de la franja horizontal [y0, y1] en coordenadas base. */
export function mascaraFranja(w: number, h: number, y0Base: number, y1Base: number): Uint8Array {
	const m = new Uint8Array(w * h);
	const esc = BASE_H / h;
	const a = Math.max(0, Math.floor(y0Base / esc));
	const b = Math.min(h - 1, Math.ceil(y1Base / esc));
	for (let y = a; y <= b; y++) m.fill(1, y * w, (y + 1) * w);
	return m;
}

/**
 * Titular: píxeles del 45 % de arriba con una racha BLANCA (min canal ≥ 200) que dura ≥ fraccion del video,
 * dilatados `dilatar` px (la sombra). Devuelve la máscara y su caja (null si no hay titular).
 */
export function mascaraTitular(r: Rachas, fraccion = 0.6, dilatar = 4): {mascara: Uint8Array; caja: Caja | null; pixeles: number} {
	const {w, h} = r;
	const base = new Uint8Array(w * h);
	let pixeles = 0;
	for (let i = 0; i < r.n; i++) {
		const p = r.pix[i];
		if (p >= Math.floor(0.45 * h) * w) continue;
		if (r.fin[i] - r.ini[i] < fraccion * r.total) continue;
		const c = r.color[i];
		if (Math.min(R_(c), G_(c), B_(c)) < 200) continue;
		if (!base[p]) pixeles++;
		base[p] = 1;
	}
	if (pixeles < 40) return {mascara: new Uint8Array(w * h), caja: null, pixeles: 0};
	const comp = componentes(morfologia(base, w, h, 3), w, h);
	let caja: Caja | null = null;
	for (let c = 1; c <= comp.n; c++) {
		if (comp.tamanos[c] < 40) continue;
		const k = comp.cajas[c];
		caja = caja ? {x0: Math.min(caja.x0, k.x0), y0: Math.min(caja.y0, k.y0), x1: Math.max(caja.x1, k.x1), y1: Math.max(caja.y1, k.y1)} : {...k};
	}
	return {mascara: morfologia(base, w, h, dilatar), caja, pixeles};
}

// ───────────────────────────── Fusión, apariencia y clase ─────────────────────────────

/**
 * Junta fragmentos de la misma capa: mismo fin (±tolFin) y cajas que se enciman en ≥ `solape` de la más chica, si la
 * unión sigue llena (≥ minRelleno). Caso típico: una tarjeta cuyo texto se va escribiendo (cada palabra nace en su
 * momento y todo muere junto); la capa empieza en el fragmento más temprano.
 * Excepción (reemplazo): si en el lugar del fragmento tardío ACABA otra capa justo cuando él nace (una tarjeta que
 * cambia por otra en el mismo sitio y comparten el blanco), la unión empieza en el fragmento tardío.
 * Las tarjetas apiladas en lista (una debajo de otra, sin encimarse) quedan separadas.
 */
export function fusionarFragmentos(eventos: EventoCrudo[], tolFin = 2, solape = 0.5, minRelleno = 0.45): EventoCrudo[] {
	const vivos: Array<EventoCrudo | null> = eventos.map((e) => ({...e}));
	const interseccion = (a: Caja, b: Caja) => {
		const x0 = Math.max(a.x0, b.x0);
		const y0 = Math.max(a.y0, b.y0);
		const x1 = Math.min(a.x1, b.x1);
		const y1 = Math.min(a.y1, b.y1);
		return x1 < x0 || y1 < y0 ? 0 : (x1 - x0 + 1) * (y1 - y0 + 1);
	};
	// Otra capa GRANDE (≥ 15 % del área de la unión) que acaba donde y cuando nace el fragmento tardío.
	const terminaAhi = (caja: Caja, union: Caja, cuadro: number, excepto: Set<number>) =>
		vivos.some(
			(o, k) =>
				o !== null &&
				!excepto.has(k) &&
				Math.abs(o.fin - cuadro) <= tolFin &&
				o.pixeles.length >= 0.15 * areaCaja(union) &&
				interseccion(o.caja, caja) >= 0.3 * Math.min(areaCaja(o.caja), areaCaja(caja)),
		);
	let cambio = true;
	while (cambio) {
		cambio = false;
		const orden = vivos.map((e, k) => [e, k] as const).filter(([e]) => e !== null).sort((x, y) => x[0]!.fin - y[0]!.fin);
		for (let ii = 0; ii < orden.length; ii++) {
			const [a, i] = orden[ii];
			if (!a || vivos[i] === null) continue;
			for (let jj = ii + 1; jj < orden.length && orden[jj][0]!.fin - a.fin <= tolFin; jj++) {
				const [b, j] = orden[jj];
				if (!b || vivos[j] === null) continue;
				if (interseccion(a.caja, b.caja) < solape * Math.min(areaCaja(a.caja), areaCaja(b.caja))) continue;
				const union: Caja = {x0: Math.min(a.caja.x0, b.caja.x0), y0: Math.min(a.caja.y0, b.caja.y0), x1: Math.max(a.caja.x1, b.caja.x1), y1: Math.max(a.caja.y1, b.caja.y1)};
				if ((a.pixeles.length + b.pixeles.length) / areaCaja(union) < minRelleno) continue;
				const tarde = a.asentado >= b.asentado ? a : b;
				const reemplazo =
					Math.abs(a.asentado - b.asentado) > tolFin &&
					tarde.pixeles.length >= 0.3 * (a.pixeles.length + b.pixeles.length) &&
					terminaAhi(tarde.caja, union, tarde.asentado, new Set([i, j]));
				const pix = new Int32Array(a.pixeles.length + b.pixeles.length);
				pix.set(a.pixeles);
				pix.set(b.pixeles, a.pixeles.length);
				const col = new Int32Array(a.colores.length + b.colores.length);
				col.set(a.colores);
				col.set(b.colores, a.colores.length);
				vivos[i] = {
					asentado: reemplazo ? tarde.asentado : Math.min(a.asentado, b.asentado),
					fin: Math.max(a.fin, b.fin),
					pixeles: pix,
					colores: col,
					caja: union,
				};
				vivos[j] = null;
				cambio = true;
				break;
			}
		}
	}
	return (vivos.filter((e) => e !== null) as EventoCrudo[]).sort((a, b) => a.asentado - b.asentado || a.caja.y0 - b.caja.y0);
}

/**
 * Núcleo sólido de una capa pegada a manchas de fondo (pasa cuando la capa nace o muere justo en un corte y el
 * fondo quieto de esa toma se le pega): apertura (erosiona `r`, dilata `r`), la componente más grande y sus
 * píxeles originales. null si no queda nada sólido.
 */
export function nucleoSolido(e: EventoCrudo, w: number, r = 2, minSolidez = 0.6, minPixeles = 250): EventoCrudo | null {
	const x0 = Math.max(0, e.caja.x0 - r - 1);
	const y0 = Math.max(0, e.caja.y0 - r - 1);
	const lw = e.caja.x1 - x0 + r + 2;
	const lh = e.caja.y1 - y0 + r + 2;
	const local = new Uint8Array(lw * lh);
	const colorDe = new Map<number, number>();
	e.pixeles.forEach((p, i) => {
		const x = p % w;
		const y = (p - x) / w;
		local[(y - y0) * lw + (x - x0)] = 1;
		colorDe.set(p, e.colores[i]);
	});
	const abierta = morfologia(morfologia(local, lw, lh, -r), lw, lh, r);
	const comp = componentes(abierta, lw, lh);
	let mejor = 0;
	for (let c = 1; c <= comp.n; c++) if (mejor === 0 || comp.tamanos[c] > comp.tamanos[mejor]) mejor = c;
	if (mejor === 0) return null;
	const k = comp.cajas[mejor];
	const pix: number[] = [];
	for (let y = k.y0; y <= k.y1; y++) {
		for (let x = k.x0; x <= k.x1; x++) {
			if (comp.etiquetas[y * lw + x] !== mejor || !local[y * lw + x]) continue;
			pix.push((y + y0) * w + (x + x0));
		}
	}
	if (pix.length < minPixeles || solidez(pix, w) < minSolidez) return null;
	return {
		asentado: e.asentado,
		fin: e.fin,
		pixeles: Int32Array.from(pix),
		colores: Int32Array.from(pix, (p) => colorDe.get(p) ?? 0),
		caja: {x0: k.x0 + x0, y0: k.y0 + y0, x1: k.x1 + x0, y1: k.y1 + y0},
	};
}

export type Apariencia = {
	/** Fracción de píxeles blancos (min canal ≥ 225, sin tinte). */
	blanco: number;
	/** Fracción de píxeles oscuros (max canal ≤ 45). */
	oscuro: number;
	/** Fracción de píxeles de color vivo (saturación ≥ 0.55, brillo ≥ 100). */
	vivo: number;
	/** Fracción de píxeles sin color (máx − mín de canales ≤ 30): blanco, grises y negro (texto con antialias). */
	acromatico: number;
	/** Píxeles de la capa ÷ área de su caja. */
	relleno: number;
	/** Píxeles de la capa ÷ área de su envolvente convexa. */
	solidez: number;
	/** Fracción de píxeles en sus 4 colores más comunes (cubetas de 16 niveles por canal): ~1 en gráficos planos. */
	paleta: number;
	/** Ancho ÷ alto de la caja. */
	aspecto: number;
	/** Área de la caja ÷ área del cuadro. */
	areaCuadro: number;
};

export function apariencia(e: EventoCrudo, w: number, h: number): Apariencia {
	let blanco = 0;
	let oscuro = 0;
	let vivo = 0;
	let acromatico = 0;
	const cubetas = new Map<number, number>();
	for (const c of e.colores) {
		const k = ((R_(c) >> 4) << 8) | ((G_(c) >> 4) << 4) | (B_(c) >> 4);
		cubetas.set(k, (cubetas.get(k) ?? 0) + 1);
		const R = R_(c);
		const G = G_(c);
		const B = B_(c);
		const mx = Math.max(R, G, B);
		const mn = Math.min(R, G, B);
		if (mx - mn <= 30) acromatico++;
		if (mn >= 225 && mx - mn <= 20) blanco++;
		else if (mx <= 45) oscuro++;
		else if (mx >= 100 && (mx - mn) / mx >= 0.55) vivo++;
	}
	const n = Math.max(1, e.colores.length);
	const bw = e.caja.x1 - e.caja.x0 + 1;
	const bh = e.caja.y1 - e.caja.y0 + 1;
	return {
		blanco: blanco / n,
		oscuro: oscuro / n,
		vivo: vivo / n,
		acromatico: acromatico / n,
		relleno: e.pixeles.length / (bw * bh),
		solidez: solidez(e.pixeles, w),
		paleta: [...cubetas.values()].sort((x, y) => y - x).slice(0, 4).reduce((s, v) => s + v, 0) / n,
		aspecto: bw / bh,
		areaCuadro: (bw * bh) / (w * h),
	};
}

export type ClaseCapa = 'tarjeta' | 'sticker' | 'insert' | 'otro';

export type OpcionesClase = {
	/** Una capa "gráfica" tiene ≥ esto de blanco + color vivo (tus tarjetas, stickers y app tiles). */
	minGrafico?: number;
	/** O es un rectángulo lleno (relleno ≥ minRelleno) de al menos `minAreaRect` del cuadro (capturas, fotos). */
	minRelleno?: number;
	minAreaRect?: number;
	/** Área de la caja sobre la que una capa es insert. */
	areaInsert?: number;
};

/**
 * ¿Es una capa (y de qué clase) o es fondo/persona que se quedó quieta un rato? null = se descarta.
 * - insert: caja > 25 % del cuadro.
 * - tarjeta: mayormente blanca (≥ 45 %), sin color (≥ 85 % de píxeles blancos, grises o negros: el texto), sin
 *   color vivo (≤ 5 %), más ancha que alta, llena (≥ 60 % de su caja) y con texto (no un blanco liso). Lo blanco
 *   que no cumple la forma se descarta: es pared o ventana. Una tarjeta con emoji (≤ 12 % de color vivo, ≥ 80 %
 *   sin color, aspecto ≥ 1.5) también es tarjeta.
 * - sticker: gráfica (blanco + color vivo) que no es tarjeta, o una tarjeta de imagen colorida: formas, app tiles,
 *   mascotas, logos.
 * - otro: rectángulo lleno grande que no es blanco ni colorido (p. ej. una foto chica).
 */
export function clasificar(a: Apariencia, op: OpcionesClase = {}): ClaseCapa | null {
	const grafico = a.blanco + a.vivo;
	const esGrafica = grafico >= (op.minGrafico ?? 0.25);
	const esRectangulo = a.relleno >= (op.minRelleno ?? 0.8) && a.areaCuadro >= (op.minAreaRect ?? 0.03);
	if (!esGrafica && !esRectangulo) return null;
	if (a.areaCuadro > (op.areaInsert ?? 0.25)) return 'insert';
	// Tarjeta con emoji (✅, 😎): ancha, casi toda blanca y gris, con un poco de color.
	if (a.blanco >= 0.45 && a.acromatico >= 0.8 && a.vivo <= 0.12 && a.aspecto >= 1.5 && a.relleno >= 0.6) return 'tarjeta';
	if (a.blanco >= 0.45 && a.acromatico >= 0.85 && a.vivo <= 0.05) {
		// Blanco sin color: es tarjeta si tiene forma de tarjeta (más ancha que alta, llena) y algo de texto; si no,
		// es una zona clara del fondo (pared, ventana) y se descarta.
		const conTexto = !(a.paleta >= 0.93 && a.oscuro < 0.01);
		return a.aspecto >= 1 && a.relleno >= 0.6 && conTexto ? 'tarjeta' : null;
	}
	if (esGrafica || a.vivo >= 0.1) return 'sticker';
	return 'otro';
}

// ───────────────────────────── Pasada 2: bordes finos y pop ─────────────────────────────

/** Recorte RGB de un cuadro: región [x0, x0+w) × [y0, y0+h) en píxeles de análisis. */
export type Recorte = {x0: number; y0: number; w: number; h: number; rgb: Uint8Array};

export function recortar(rgb: Uint8Array, W: number, x0: number, y0: number, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) out.set(rgb.subarray(((y0 + y) * W + x0) * 3, ((y0 + y) * W + x0 + w) * 3), y * w * 3);
	return out;
}

/**
 * Error medio (0–255) entre la plantilla (píxeles de la capa ya asentada) y un cuadro, si la capa estuviera a
 * escala `s` alrededor de su centro: cada píxel q de la plantilla cae en c + s·(q − c) del cuadro (vecino más
 * cercano). Devuelve NaN si casi ningún píxel cae dentro del recorte.
 */
export function errorAEscala(
	plantilla: {x: Int16Array; y: Int16Array; rgb: Uint8Array},
	cuadro: Recorte,
	cx: number,
	cy: number,
	s: number,
): number {
	let suma = 0;
	let n = 0;
	const {x, y, rgb} = plantilla;
	for (let i = 0; i < x.length; i++) {
		const px = Math.round(cx + s * (x[i] - cx)) - cuadro.x0;
		const py = Math.round(cy + s * (y[i] - cy)) - cuadro.y0;
		if (px < 0 || py < 0 || px >= cuadro.w || py >= cuadro.h) continue;
		const o = (py * cuadro.w + px) * 3;
		suma += Math.abs(cuadro.rgb[o] - rgb[3 * i]) + Math.abs(cuadro.rgb[o + 1] - rgb[3 * i + 1]) + Math.abs(cuadro.rgb[o + 2] - rgb[3 * i + 2]);
		n++;
	}
	return n < Math.max(12, 0.5 * x.length * Math.min(1, s * s)) ? Number.NaN : suma / (3 * n);
}

/**
 * Mejor escala (y su error) de la plantilla en un cuadro, buscando en [0.2, 1.4] cada 0.02. Entre casi empates
 * (error ≤ mínimo·1.01 + 0.05: la capa es chica y 2 % no alcanza a mover sus orillas un píxel) gana la más
 * cercana a 1.
 */
export function mejorEscala(plantilla: {x: Int16Array; y: Int16Array; rgb: Uint8Array}, cuadro: Recorte, cx: number, cy: number): {s: number; error: number} {
	const errores: Array<[number, number]> = [];
	let minimo = Number.POSITIVE_INFINITY;
	for (let k = 10; k <= 70; k++) {
		const s = k / 50;
		const e = errorAEscala(plantilla, cuadro, cx, cy, s);
		if (!Number.isFinite(e)) continue;
		errores.push([s, e]);
		if (e < minimo) minimo = e;
	}
	let mejor = {s: 1, error: Number.POSITIVE_INFINITY};
	for (const [s, e] of errores) {
		if (e > minimo * 1.01 + 0.05) continue;
		if (mejor.error === Number.POSITIVE_INFINITY || Math.abs(s - 1) < Math.abs(mejor.s - 1)) mejor = {s, error: e};
	}
	return mejor;
}

export type Pop = {
	/** Cuadros desde el primero visible hasta que la escala queda en 1 ± 0.02. */
	cuadros: number;
	/** Escala del primer cuadro visible (1 = tamaño final). */
	escala_inicial: number;
	/** Máximo de la escala − 1 durante la entrada (0 si no se pasa de 1.02). */
	sobrepaso: number;
	/** Escala de cada cuadro de la entrada, del primero visible al asentado. */
	escalas: number[];
};

export type Refinado = {
	/** Primer cuadro visible y primer cuadro en que ya no está (fin exclusivo), a fps nativos. */
	desde: number;
	hasta: number;
	pop: Pop | null;
	/** Errores de referencia: asentado, ausente (antes de la entrada) y umbral de visibilidad. */
	error_asentado: number;
	error_ausente: number | null;
	umbral: number | null;
	nota: string | null;
};

type Ventanas = {inicio: [number, number]; fin: [number, number]; region: {x0: number; y0: number; w: number; h: number}};

/** Ventanas de cuadros y región de recorte que necesita la pasada 2 para un evento. */
export function ventanasDe(e: EventoCrudo, W: number, H: number, total: number, popMax: number): Ventanas {
	const bw = e.caja.x1 - e.caja.x0 + 1;
	const bh = e.caja.y1 - e.caja.y0 + 1;
	const mx = Math.ceil(bw * 0.25) + 2;
	const my = Math.ceil(bh * 0.25) + 2;
	const x0 = Math.max(0, e.caja.x0 - mx);
	const y0 = Math.max(0, e.caja.y0 - my);
	const x1 = Math.min(W - 1, e.caja.x1 + mx);
	const y1 = Math.min(H - 1, e.caja.y1 + my);
	return {
		inicio: [Math.max(0, e.asentado - popMax - 8), Math.min(total - 1, e.asentado + popMax + 1)],
		fin: [Math.max(0, e.fin - 4), Math.min(total - 1, e.fin + 3)],
		region: {x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1},
	};
}

/**
 * Afina un evento con sus recortes (cuadro → recorte) a fps nativos:
 *   - plantilla = sus píxeles en el cuadro asentado + 1;
 *   - hacia atrás desde el asentado, cada cuadro se compara a escalas 0.2–1.4: es visible si su mejor error
 *     queda por debajo de la mitad del camino entre el error asentado y el error "ausente" (antes de la entrada);
 *   - `desde` = primer cuadro de la racha visible; pop = escalas de esa racha;
 *   - `hasta` = primer cuadro (desde fin − 4) en que ya no es visible a escala 1.
 */
export function refinarEvento(e: EventoCrudo, W: number, recortes: Map<number, Recorte>, popMax: number, total: number, fps = 30): Refinado {
	const cx = (e.caja.x0 + e.caja.x1) / 2;
	const cy = (e.caja.y0 + e.caja.y1) / 2;
	// La plantilla sale de un cuadro ya quieto: 0.3 s después de la moda de nacimientos (el centro de un sticker
	// se queda quieto antes que sus orillas, así que la moda puede caer en plena entrada), sin pasar del final.
	const nRef = Math.max(e.asentado, Math.min(e.asentado + Math.round(0.3 * fps), e.asentado + popMax, e.fin - 1, total - 1));
	const ref = recortes.get(nRef) ?? recortes.get(e.asentado);
	const base: Refinado = {desde: e.asentado, hasta: e.fin, pop: null, error_asentado: Number.NaN, error_ausente: null, umbral: null, nota: null};
	if (!ref) return {...base, nota: 'sin cuadro asentado para la plantilla'};
	// Plantilla: los píxeles de la capa con su color en el cuadro asentado.
	const xs: number[] = [];
	const ys: number[] = [];
	const cols: number[] = [];
	for (const p of e.pixeles) {
		const x = p % W;
		const y = (p - x) / W;
		const lx = x - ref.x0;
		const ly = y - ref.y0;
		if (lx < 0 || ly < 0 || lx >= ref.w || ly >= ref.h) continue;
		const o = (ly * ref.w + lx) * 3;
		xs.push(x);
		ys.push(y);
		cols.push(ref.rgb[o], ref.rgb[o + 1], ref.rgb[o + 2]);
	}
	const plantilla = {x: Int16Array.from(xs), y: Int16Array.from(ys), rgb: Uint8Array.from(cols)};
	const eAsentado = errorAEscala(plantilla, ref, cx, cy, 1);
	// Error "ausente": mediana del mejor error en los cuadros antes de la ventana del pop.
	const ausentes: number[] = [];
	for (let k = e.asentado - popMax - 8; k <= e.asentado - popMax - 3; k++) {
		const c = recortes.get(k);
		if (c) ausentes.push(mejorEscala(plantilla, c, cx, cy).error);
	}
	const finitos = ausentes.filter(Number.isFinite).sort((a, b) => a - b);
	const eAusente = finitos.length ? finitos[finitos.length >> 1] : null;
	// Hasta: primer cuadro desde fin − 4 que ya no se parece a la plantilla a escala 1.
	const umbralFin = eAusente !== null ? eAsentado + 0.5 * Math.max(0, eAusente - eAsentado) : Math.max(12, 3 * eAsentado);
	let hasta = e.fin;
	for (let k = Math.max(nRef + 1, e.fin - 4); k <= Math.min(total, e.fin + 3); k++) {
		const c = recortes.get(k);
		if (!c) {
			hasta = k;
			break;
		}
		const err = errorAEscala(plantilla, c, cx, cy, 1);
		if (!(err <= umbralFin)) {
			hasta = k;
			break;
		}
		hasta = k + 1;
	}
	if (eAusente === null || e.asentado === 0) {
		return {...base, hasta, error_asentado: eAsentado, nota: e.asentado === 0 ? 'ya está en el primer cuadro' : 'no hay cuadros antes de la entrada'};
	}
	if (eAusente - eAsentado < 6) {
		return {...base, hasta, error_asentado: eAsentado, error_ausente: eAusente, nota: 'la capa se parece demasiado al fondo para medir su entrada'};
	}
	const umbral = eAsentado + 0.5 * (eAusente - eAsentado);
	// Hacia atrás desde el cuadro de la plantilla: mientras sea visible a alguna escala.
	const escalas: number[] = [];
	let desde = nRef;
	for (let k = nRef; k >= Math.max(0, e.asentado - popMax); k--) {
		const c = recortes.get(k);
		if (!c) break;
		const m = mejorEscala(plantilla, c, cx, cy);
		if (!(m.error <= umbral)) break;
		escalas.unshift(m.s);
		desde = k;
	}
	if (escalas.length === 0) return {...base, hasta, error_asentado: eAsentado, error_ausente: eAusente, umbral, nota: 'no se ve en el cuadro asentado'};
	// Cuadros hasta quedar en 1 ± 0.02 para siempre.
	let k1 = escalas.length - 1;
	while (k1 > 0 && Math.abs(escalas[k1 - 1] - 1) <= 0.02) k1--;
	const maximo = Math.max(...escalas);
	const pop: Pop = {
		cuadros: k1,
		escala_inicial: escalas[0],
		sobrepaso: maximo > 1.02 ? Number((maximo - 1).toFixed(2)) : 0,
		escalas,
	};
	return {desde, hasta, pop, error_asentado: eAsentado, error_ausente: eAusente, umbral, nota: null};
}

// ───────────────────────────── Análisis completo de un video ─────────────────────────────

export type OpcionesCapas = {
	fps: number;
	totalCuadros: number;
	/** Franja de subtítulos (base 1920). */
	franja?: [number, number];
	/** Tolerancia de color de una racha (0–255 por canal). */
	eps?: number;
	/** Duración mínima de una capa (s). */
	minS?: number;
	/** Duración máxima de la entrada (pop), s. */
	popMaxS?: number;
	clase?: OpcionesClase;
	alProgreso?: (mensaje: string) => void;
};

export type CajaBase = {x: number; y: number; w: number; h: number};

export type Capa = {
	clase: ClaseCapa;
	desde_cuadro: number;
	hasta_cuadro: number;
	/** Caja en base 1080×1920 (x, y = esquina superior izquierda). */
	caja: CajaBase;
	apariencia: Apariencia;
	pop: Pop | null;
	nota: string | null;
	/** Píxeles de análisis de la capa (para depurar; no va al JSON). */
	pixeles?: Int32Array;
};

export type PorCuadro = {
	/** Fracción de píxeles (sin titular ni franja) que cambian > 25 contra el cuadro anterior. */
	cambio: Float32Array;
	/** Miniatura de luma 27×48 por cuadro (bloques de 10×10 del cuadro de análisis). */
	miniaturas: Uint8Array;
	/** La misma miniatura en RGB (3 bytes por bloque), para comparar tomas por color. */
	miniaturasRgb: Uint8Array;
	/** Nitidez: media de |laplaciano| de la luma (sin titular ni franja). */
	nitidez: Float32Array;
};

export const MINI_W = 27;
export const MINI_H = 48;

/** Caja de análisis (inclusiva) → caja base. */
export const aCajaBase = (c: Caja): CajaBase => ({
	x: c.x0 * ESCALA_BASE,
	y: c.y0 * ESCALA_BASE,
	w: (c.x1 - c.x0 + 1) * ESCALA_BASE,
	h: (c.y1 - c.y0 + 1) * ESCALA_BASE,
});

/** Pasada 1 sobre un video: rachas + estadísticas por cuadro. */
export async function pasada1(video: string, op: OpcionesCapas): Promise<{rachas: Rachas; porCuadro: PorCuadro; leidos: number}> {
	const W = ANALISIS_W;
	const H = ANALISIS_H;
	const minCuadros = Math.max(2, Math.round((op.minS ?? 0.25) * op.fps));
	const seg = new SegmentadorRachas(W, H, op.eps ?? 12, minCuadros);
	const franja = mascaraFranja(W, H, ...(op.franja ?? FRANJA_SUBTITULOS));
	const yTitulo = Math.floor(0.25 * H);
	const total = op.totalCuadros + 8;
	const cambio = new Float32Array(total);
	const nitidez = new Float32Array(total);
	const miniaturas = new Uint8Array(total * MINI_W * MINI_H);
	const miniaturasRgb = new Uint8Array(total * MINI_W * MINI_H * 3);
	let previo: Uint8Array | null = null;
	const leidos = await leerCuadros({
		video,
		alCuadro: (rgb, n) => {
			seg.procesar(rgb);
			if (n >= total) return;
			// Cambio contra el cuadro anterior y nitidez (sin el cuarto de arriba ni la franja).
			let cambian = 0;
			let cuenta = 0;
			let lap = 0;
			let nlap = 0;
			for (let y = yTitulo; y < H - 1; y++) {
				for (let x = 1; x < W - 1; x++) {
					const p = y * W + x;
					if (franja[p]) continue;
					const o = 3 * p;
					if (previo) {
						cuenta++;
						if (Math.max(Math.abs(rgb[o] - previo[o]), Math.abs(rgb[o + 1] - previo[o + 1]), Math.abs(rgb[o + 2] - previo[o + 2])) > 25) cambian++;
					}
					if ((x & 1) === 0 && (y & 1) === 0) {
						const l = (c: number) => rgb[c] * 0.299 + rgb[c + 1] * 0.587 + rgb[c + 2] * 0.114;
						lap += Math.abs(4 * l(o) - l(o - 3) - l(o + 3) - l(o - 3 * W) - l(o + 3 * W));
						nlap++;
					}
				}
			}
			cambio[n] = cuenta ? cambian / cuenta : 0;
			nitidez[n] = nlap ? lap / nlap : 0;
			// Miniatura (luma y RGB) por bloques de 10×10.
			const mo = n * MINI_W * MINI_H;
			for (let by = 0; by < MINI_H; by++) {
				for (let bx = 0; bx < MINI_W; bx++) {
					let sr = 0;
					let sg = 0;
					let sb = 0;
					for (let y = by * 10; y < by * 10 + 10; y++) {
						for (let x = bx * 10; x < bx * 10 + 10; x++) {
							const o = 3 * (y * W + x);
							sr += rgb[o];
							sg += rgb[o + 1];
							sb += rgb[o + 2];
						}
					}
					const b = by * MINI_W + bx;
					miniaturas[mo + b] = Math.round((sr * 0.299 + sg * 0.587 + sb * 0.114) / 100);
					miniaturasRgb[3 * (mo + b)] = Math.round(sr / 100);
					miniaturasRgb[3 * (mo + b) + 1] = Math.round(sg / 100);
					miniaturasRgb[3 * (mo + b) + 2] = Math.round(sb / 100);
				}
			}
			previo = Uint8Array.from(rgb);
		},
	});
	const rachas = seg.terminar();
	return {
		rachas,
		porCuadro: {
			cambio: cambio.subarray(0, leidos),
			nitidez: nitidez.subarray(0, leidos),
			miniaturas: miniaturas.subarray(0, leidos * MINI_W * MINI_H),
			miniaturasRgb: miniaturasRgb.subarray(0, leidos * MINI_W * MINI_H * 3),
		},
		leidos,
	};
}

/** Pasada 2: recortes de los cuadros que necesita cada evento. */
export async function pasada2(video: string, eventos: EventoCrudo[], total: number, popMax: number): Promise<Map<number, Recorte>[]> {
	const W = ANALISIS_W;
	const H = ANALISIS_H;
	const vent = eventos.map((e) => ventanasDe(e, W, H, total, popMax));
	const recortes = eventos.map(() => new Map<number, Recorte>());
	const porCuadro = new Map<number, number[]>();
	vent.forEach((v, i) => {
		for (const [a, b] of [v.inicio, v.fin]) {
			for (let n = a; n <= b; n++) {
				const l = porCuadro.get(n) ?? [];
				if (!l.includes(i)) l.push(i);
				porCuadro.set(n, l);
			}
		}
	});
	if (porCuadro.size === 0) return recortes;
	await leerCuadros({
		video,
		alCuadro: (rgb, n) => {
			const l = porCuadro.get(n);
			if (!l) return;
			for (const i of l) {
				const r = vent[i].region;
				recortes[i].set(n, {...r, rgb: recortar(rgb, W, r.x0, r.y0, r.w, r.h)});
			}
		},
	});
	return recortes;
}

/** Del cuadro de análisis al de capas: rachas → eventos → clases → bordes finos y pop. */
export async function capasDeVideo(
	video: string,
	op: OpcionesCapas,
): Promise<{capas: Capa[]; porCuadro: PorCuadro; titular: CajaBase | null; total: number; descartados: number; segundos: {pasada1: number; agrupar: number; pasada2: number}}> {
	const W = ANALISIS_W;
	const H = ANALISIS_H;
	const t0 = performance.now();
	op.alProgreso?.('pasada 1: rachas por píxel');
	const {rachas, porCuadro, leidos} = await pasada1(video, op);
	const t1 = performance.now();
	const franja = op.franja ?? FRANJA_SUBTITULOS;
	const excluir = mascaraFranja(W, H, franja[0], franja[1]);
	const tit = mascaraTitular(rachas);
	for (let p = 0; p < W * H; p++) if (tit.mascara[p]) excluir[p] = 1;
	op.alProgreso?.(`agrupando ${rachas.n} rachas`);
	const crudos = eventosDeRachas(rachas, {fps: op.fps, excluir, minPixeles: 60});
	// Se quitan los ralos (manchas de fondo), se juntan los fragmentos y se exige que la capa quede llena.
	const fusionados = fusionarFragmentos(crudos.filter((e) => e.pixeles.length / areaCaja(e.caja) >= 0.1))
		.map((e) => (e.pixeles.length >= 250 && solidez(e.pixeles, W) < 0.6 ? nucleoSolido(e, W) : e))
		.filter((e): e is EventoCrudo => e !== null && e.pixeles.length >= 250 && solidez(e.pixeles, W) >= 0.6);
	const aceptados: Array<{e: EventoCrudo; clase: ClaseCapa; ap: Apariencia}> = [];
	let descartados = 0;
	const yFranja0 = franja[0] / ESCALA_BASE;
	const yFranja1 = franja[1] / ESCALA_BASE;
	for (const e of fusionados) {
		const ap = apariencia(e, W, H);
		const clase = clasificar(ap, op.clase);
		// Restos de subtítulos pegados a la franja: texto bajo (≤ 100 px base), poco relleno y breve.
		const cy = (e.caja.y0 + e.caja.y1) / 2;
		const restoSub = cy >= yFranja0 - 20 && cy <= yFranja1 + 20 && (e.caja.y1 - e.caja.y0 + 1) * ESCALA_BASE <= 100 && ap.relleno < 0.6;
		// Muy chica para ser una capa de las tuyas: < 60 × 48 px base (UI, letras sueltas); un sticker u "otro" de
		// < 140 px base de lado o muy alargado (aspecto fuera de 1/3–3) suele ser un pedazo quieto de cara o fondo.
		const anchoBase = (e.caja.x1 - e.caja.x0 + 1) * ESCALA_BASE;
		const altoBase = (e.caja.y1 - e.caja.y0 + 1) * ESCALA_BASE;
		const chica =
			anchoBase < 60 ||
			altoBase < 48 ||
			((clase === 'sticker' || clase === 'otro') && (anchoBase < 140 || altoBase < 140 || ap.aspecto < 1 / 3 || ap.aspecto > 3));
		// Pegada al borde izquierdo o derecho (tus capas van centradas; el fondo sí toca el borde), salvo inserts.
		const enBorde = (e.caja.x0 <= 3 || e.caja.x1 >= W - 4) && ap.areaCuadro < 0.25;
		// Debajo de la franja de subtítulos (brazos, mesa, laptop): tus capas van arriba de los subtítulos.
		const abajo = clase !== 'insert' && ((e.caja.y0 + e.caja.y1 + 1) / 2) * ESCALA_BASE > franja[1] + 20;
		// Blanco liso casi sin nada más (una pared clara), salvo que sea un rectángulo limpio. Ojo: el texto de tus
		// tarjetas a ¼ de resolución sale gris (antialias), no negro; por eso se mira el blanco ≥ 85 %.
		const blancoLiso = ap.blanco >= 0.85 && ap.oscuro < 0.01 && ap.vivo < 0.02 && !(ap.solidez >= 0.9 && ap.relleno >= 0.85);
		// Sticker u "otro" en la orilla (centro a menos del 15 % del ancho de un lado): tus capas van al centro.
		const cxBase = ((e.caja.x0 + e.caja.x1 + 1) / 2) * ESCALA_BASE;
		const orilla = clase !== 'tarjeta' && clase !== 'insert' && (cxBase < 0.15 * BASE_W || cxBase > 0.85 * BASE_W);
		if (!clase || restoSub || chica || enBorde || abajo || blancoLiso || orilla) {
			descartados++;
			continue;
		}
		aceptados.push({e, clase, ap});
	}
	const t2 = performance.now();
	const popMax = Math.round((op.popMaxS ?? 0.5) * op.fps);
	op.alProgreso?.(`pasada 2: bordes y pop de ${aceptados.length} capas`);
	const recortes = await pasada2(video, aceptados.map((a) => a.e), leidos, popMax);
	const capas: Capa[] = aceptados.map(({e, clase, ap}, i) => {
		const r = refinarEvento(e, W, recortes[i], popMax, leidos, op.fps);
		return {
			clase,
			desde_cuadro: r.desde,
			hasta_cuadro: Math.max(r.desde + 1, r.hasta),
			caja: aCajaBase(e.caja),
			apariencia: ap,
			pop: r.pop,
			nota: r.nota,
			pixeles: e.pixeles,
		};
	});
	const t3 = performance.now();
	return {
		capas,
		porCuadro,
		titular: tit.caja ? aCajaBase(tit.caja) : null,
		total: leidos,
		descartados,
		segundos: {pasada1: (t1 - t0) / 1000, agrupar: (t2 - t1) / 1000, pasada2: (t3 - t2) / 1000},
	};
}

// ───────────────────────────── Tomas: inserts a pantalla completa y desenfoque ─────────────────────────────

export type Toma = {desde: number; hasta: number; principal: boolean; similitud: number; color: number; zoom: number};

/** Filas de la miniatura (48) que se usan para comparar tomas: sin el cuarto de arriba (titular) ni la franja. */
function filasUtiles(franja: [number, number]): number[] {
	const f: number[] = [];
	const y0 = Math.floor((franja[0] / BASE_H) * MINI_H);
	const y1 = Math.ceil((franja[1] / BASE_H) * MINI_H);
	for (let y = Math.ceil(0.25 * MINI_H); y < MINI_H; y++) if (y < y0 || y > y1) f.push(y);
	return f;
}

/** Histograma de color (4×4×4 cubetas, normalizado) de varios cuadros de la miniatura RGB (filas útiles). */
export function histogramaColor(rgb: Uint8Array, cuadros: number[], filas: number[]): Float64Array {
	const h = new Float64Array(64);
	let n = 0;
	for (const c of cuadros) {
		const o = c * MINI_W * MINI_H;
		for (const y of filas) {
			for (let x = 0; x < MINI_W; x++) {
				const b = 3 * (o + y * MINI_W + x);
				h[((rgb[b] >> 6) << 4) | ((rgb[b + 1] >> 6) << 2) | (rgb[b + 2] >> 6)]++;
				n++;
			}
		}
	}
	if (n > 0) for (let i = 0; i < 64; i++) h[i] /= n;
	return h;
}

/** Intersección de dos histogramas normalizados (0–1). */
export function interseccionHisto(a: Float64Array, b: Float64Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += Math.min(a[i], b[i]);
	return s;
}

/** Diferencia media de luma entre las miniaturas de dos cuadros (filas útiles). */
function difMini(m: Uint8Array, a: number, b: number, filas: number[]): number {
	let s = 0;
	let n = 0;
	const oa = a * MINI_W * MINI_H;
	const ob = b * MINI_W * MINI_H;
	for (const y of filas) {
		for (let x = 0; x < MINI_W; x++) {
			s += Math.abs(m[oa + y * MINI_W + x] - m[ob + y * MINI_W + x]);
			n++;
		}
	}
	return n ? s / n : 0;
}

/**
 * Parecido entre dos miniaturas (0–1): fracción de bloques a ≤ 14 niveles tras igualar el brillo medio, probando
 * zooms 1–1.6 de una contra otra (tus cortes con punch-in). Devuelve el mejor parecido y su zoom.
 */
export function parecidoMini(a: Float32Array, b: Float32Array, filas: number[]): {similitud: number; zoom: number} {
	let mejor = {similitud: 0, zoom: 1};
	const media = (m: Float32Array) => {
		let s = 0;
		for (const y of filas) for (let x = 0; x < MINI_W; x++) s += m[y * MINI_W + x];
		return s / (filas.length * MINI_W);
	};
	const ma = media(a);
	const mb = media(b);
	const cx = (MINI_W - 1) / 2;
	const cy = (MINI_H - 1) / 2;
	for (const [p, q, mp, mq] of [[a, b, ma, mb], [b, a, mb, ma]] as const) {
		for (let z = 1; z <= 1.6001; z += 0.1) {
			let ok = 0;
			let n = 0;
			for (const y of filas) {
				for (let x = 0; x < MINI_W; x++) {
					// q visto con zoom z (acercamiento) debe parecerse a p.
					const qx = Math.round(cx + (x - cx) / z);
					const qy = Math.round(cy + (y - cy) / z);
					if (qx < 0 || qy < 0 || qx >= MINI_W || qy >= MINI_H) continue;
					n++;
					if (Math.abs(p[y * MINI_W + x] - mp - (q[qy * MINI_W + qx] - mq)) <= 14) ok++;
				}
			}
			const sim = n ? ok / n : 0;
			if (sim > mejor.similitud) mejor = {similitud: sim, zoom: Number(z.toFixed(1))};
		}
	}
	return mejor;
}

/**
 * Tomas del video: cortes donde la miniatura salta (≥ max(8, 3× la mediana local)); la toma "principal" es el grupo
 * de tomas parecidas entre sí (≥ 0.55, tolerando zoom) con más duración. Las demás tomas son inserts a pantalla
 * completa (tu laptop, una captura a todo el cuadro…).
 */
export function tomasDeVideo(pc: PorCuadro, fps: number, franja: [number, number] = FRANJA_SUBTITULOS): {cortes: number[]; tomas: Toma[]} {
	const n = pc.cambio.length;
	const filas = filasUtiles(franja);
	const d = new Float64Array(n);
	for (let t = 1; t < n; t++) d[t] = difMini(pc.miniaturas, t, t - 1, filas);
	const cortes: number[] = [];
	const r = Math.round(fps);
	for (let t = 1; t < n; t++) {
		const v: number[] = [];
		for (let k = Math.max(1, t - r); k <= Math.min(n - 1, t + r); k++) if (k !== t) v.push(d[k]);
		v.sort((x, y) => x - y);
		const med = v.length ? v[v.length >> 1] : 0;
		if (d[t] >= Math.max(8, 3 * med) && d[t] >= (d[t - 1] ?? 0) && d[t] >= (d[t + 1] ?? 0)) cortes.push(t);
	}
	const limites = [0, ...cortes, n];
	const firmas: Float32Array[] = [];
	const histos: Float64Array[] = [];
	const tramos: Array<[number, number]> = [];
	for (let i = 0; i + 1 < limites.length; i++) {
		const a = limites[i];
		const b = limites[i + 1];
		if (b <= a) continue;
		// Firma: mediana por bloque de hasta 9 cuadros repartidos en la toma.
		const muestras: number[] = [];
		for (let k = 0; k < 9; k++) muestras.push(Math.min(b - 1, a + Math.floor(((k + 0.5) * (b - a)) / 9)));
		const firma = new Float32Array(MINI_W * MINI_H);
		const v = new Array<number>(muestras.length);
		for (let p = 0; p < MINI_W * MINI_H; p++) {
			for (let k = 0; k < muestras.length; k++) v[k] = pc.miniaturas[muestras[k] * MINI_W * MINI_H + p];
			v.sort((x, y) => x - y);
			firma[p] = v[v.length >> 1];
		}
		firmas.push(firma);
		histos.push(histogramaColor(pc.miniaturasRgb, muestras, filas));
		tramos.push([a, b]);
	}
	// Grupos de tomas parecidas (unión-búsqueda).
	const padre = tramos.map((_, i) => i);
	const raiz = (i: number): number => (padre[i] === i ? i : (padre[i] = raiz(padre[i])));
	// Misma escena si se parecen en el espacio (tolerando zoom) o en su paleta de color (un reencuadre de la misma
	// toma cambia el lugar de las cosas pero no sus colores; tu laptop cambia los dos).
	const misma = (i: number, j: number) => parecidoMini(firmas[i], firmas[j], filas).similitud >= 0.55 || interseccionHisto(histos[i], histos[j]) >= 0.7;
	for (let i = 0; i < tramos.length; i++) {
		for (let j = i + 1; j < tramos.length; j++) {
			if (misma(i, j)) padre[raiz(i)] = raiz(j);
		}
	}
	const duracion = new Map<number, number>();
	tramos.forEach(([a, b], i) => duracion.set(raiz(i), (duracion.get(raiz(i)) ?? 0) + (b - a)));
	let principal = -1;
	let max = -1;
	for (const [k, v] of duracion) if (v > max) {
		max = v;
		principal = k;
	}
	// Firma de referencia de la principal: su toma más larga.
	let ref = -1;
	tramos.forEach(([a, b], i) => {
		if (raiz(i) === principal && (ref < 0 || b - a > tramos[ref][1] - tramos[ref][0])) ref = i;
	});
	const tomas: Toma[] = tramos.map(([a, b], i) => {
		const p = ref >= 0 ? parecidoMini(firmas[i], firmas[ref], filas) : {similitud: 1, zoom: 1};
		const color = ref >= 0 ? interseccionHisto(histos[i], histos[ref]) : 1;
		return {desde: a, hasta: b, principal: raiz(i) === principal, similitud: Number(p.similitud.toFixed(2)), color: Number(color.toFixed(2)), zoom: p.zoom};
	});
	return {cortes, tomas};
}

/**
 * Tramos desenfocados de la toma principal: la nitidez cae a < `factor` de su mediana por ≥ minS segundos.
 * Devuelve [desde, hasta) en cuadros.
 */
export function tramosDesenfocados(pc: PorCuadro, tomas: Toma[], fps: number, factor = 0.5, minS = 0.25): Array<[number, number]> {
	const valores: number[] = [];
	for (const t of tomas) if (t.principal) for (let k = t.desde; k < t.hasta; k++) valores.push(pc.nitidez[k]);
	if (valores.length === 0) return [];
	valores.sort((a, b) => a - b);
	const med = valores[valores.length >> 1];
	const out: Array<[number, number]> = [];
	for (const t of tomas) {
		if (!t.principal) continue;
		let a = -1;
		for (let k = t.desde; k <= t.hasta; k++) {
			const bajo = k < t.hasta && pc.nitidez[k] < factor * med;
			if (bajo && a < 0) a = k;
			if (!bajo && a >= 0) {
				if (k - a >= minS * fps) out.push([a, k]);
				a = -1;
			}
		}
	}
	return out;
}
