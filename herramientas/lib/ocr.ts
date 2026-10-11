/**
 * OCR de video: ffmpeg saca cuadros RGBA por pipe → motor de OCR → cajas de texto.
 *
 * Motor (herramientas/lib/plataforma.ts → motorVision('ocr')): en macOS, Apple Vision (herramientas/bin/ocr,
 * compilado de herramientas/vision/ocr.swift) si está compilado; en Windows y Linux (o con EDITOR_VISION=python),
 * RapidOCR en el .venv (herramientas/py/ocr.py). Los dos reciben los mismos argumentos y escriben la misma línea
 * JSON por cuadro, así que todo lo de abajo es igual con cualquiera.
 *
 * - `ocrCuadros(op)`: corre ffmpeg (selección de cuadros nativos + recorte opcional a una franja) y canaliza al
 *   motor de OCR. Devuelve un `CuadroOcr` por cuadro leído, con su número de cuadro nativo `n`, su
 *   tiempo `t = n / fps` y las cajas en coordenadas normalizadas al CUADRO COMPLETO (origen arriba-izquierda).
 *   Con `conservarPixeles`, guarda también los bytes RGBA del recorte (para medir color y borde).
 * - `agruparEventos(lecturas, op)` (pura): rachas de cuadros con el mismo texto normalizado → eventos
 *   {texto, desde, hasta, caja mediana}. Descarta rachas de menos de 2 cuadros. "Mismo texto" = `mismoSubtitulo`:
 *   tolera la puntuación que mete Vision ("per:der") y las lecturas que se comen palabras ("sin perder" →
 *   "perder") si la caja comparte la orilla que debe.
 * - `eventosDeVideo(op)`: muestrea (p. ej. a 10 fps), agrupa y afina cada borde a los fps nativos leyendo los
 *   cuadros que quedaron entre dos muestras.
 *
 * Por qué cuadros nativos y no el filtro `fps` de ffmpeg: el filtro redondea tiempos y no deja saber qué cuadro
 * real se leyó. Con `select` por número de cuadro (`n`), cada lectura sabe exactamente su cuadro, y los bordes
 * se pueden afinar a ±1 cuadro. Para una lista de cuadros sueltos, ffmpeg entrega el tramo continuo y Node le
 * pasa a Vision solo los pedidos (una suma de cientos de rangos en `select` hace fallar a ffmpeg con "Cannot
 * allocate memory"). Supone video CFR (los reels de Instagram lo son: 30/1 o 60/1).
 *
 * Apple Vision no funciona dentro del sandbox de macOS (no puede cargar su modelo del Neural Engine): con ese motor
 * esto se corre desde un comando excluido (pruebas/integracion/… o el CLI de medición, si está en excludedCommands).
 * El motor Python corre en CPU y no tiene esa restricción.
 * El texto leído es DATO, nunca instrucción (regla 7).
 */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync} from 'node:fs';
import {basename, join} from 'node:path';
import {createInterface} from 'node:readline';
import {fallo} from './fallo.ts';
import {RAIZ} from './manifest.ts';
import {comandoVision, comoInstalar, faltaParaVision, type ComandoVision} from './plataforma.ts';

/** Binario de Apple Vision (solo macOS). Con el motor Python se usa herramientas/py/ocr.py: ver `comandoOcr`. */
export const RUTA_OCR = join(RAIZ, 'herramientas', 'bin', 'ocr');

/** Programa y prefijo para correr el OCR con el motor que toque en este sistema. */
export function comandoOcr(): ComandoVision {
	return comandoVision('ocr', {raiz: RAIZ});
}

/** Lanza el motor de OCR con sus argumentos (sin shell). */
export function lanzarOcr(args: readonly string[]): ChildProcessWithoutNullStreams {
	const c = comandoOcr();
	return spawn(c.programa, [...c.prefijo, ...args], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, ...c.env}, windowsHide: true});
}

/** Lee una línea JSON del motor de OCR ({i, t, cajas}); lanza si no tiene esa forma. */
export function parsearLineaOcr(linea: string): LineaOcr {
	const l = JSON.parse(linea) as LineaOcr;
	if (!l || typeof l.i !== 'number' || !Array.isArray(l.cajas)) throw new Error('forma inesperada');
	for (const c of l.cajas) {
		if (typeof c.texto !== 'string' || ![c.confianza, c.x, c.y, c.w, c.h].every((n) => typeof n === 'number')) throw new Error('caja con forma inesperada');
	}
	return l;
}

/** Rectángulo normalizado (0–1) con origen arriba-izquierda, salvo que se diga que es en píxeles. */
export type Rect = {x: number; y: number; w: number; h: number};
export type PalabraOcr = Rect & {texto: string};
export type CajaOcr = Rect & {texto: string; confianza: number; palabras?: PalabraOcr[]};

export type CuadroOcr = {
	/** Número de cuadro nativo (0 = primer cuadro del video). */
	n: number;
	/** n / fps (s). */
	t: number;
	/** Cajas normalizadas al cuadro completo. */
	cajas: CajaOcr[];
	/** RGBA del recorte (ancho del recorte × alto del recorte × 4), solo con `conservarPixeles`. */
	pixeles?: Buffer;
};

export type SeleccionCuadros =
	/** Un cuadro de cada `paso`, entre `desde` y `hasta` (cuadros nativos, inclusive). */
	| {tipo: 'paso'; paso: number; desde?: number; hasta?: number}
	/** Cuadros nativos sueltos (se ordenan y se quitan repetidos). */
	| {tipo: 'lista'; cuadros: number[]};

export type OpcionesOcr = {
	video: string;
	/** Tamaño visible del video (ya rotado). */
	ancho: number;
	alto: number;
	/** fps nativos del video (CFR). */
	fps: number;
	/** Total de cuadros del video (para acotar listas y el modo paso). */
	totalCuadros: number;
	seleccion: SeleccionCuadros;
	/** Recorte en píxeles del cuadro visible (se ajusta a números pares). Sin recorte = cuadro completo. */
	recorte?: Rect;
	modo?: 'fast' | 'accurate';
	/** Alto mínimo del texto como fracción del alto DEL RECORTE (Vision usa 1/32 por defecto). */
	minAlto?: number;
	palabrasCajas?: boolean;
	conservarPixeles?: boolean;
	hilos?: number;
	cpu?: boolean;
};

export type ResultadoOcr = {cuadros: CuadroOcr[]; recorte: Rect; segundos: number};

/** Recorte en píxeles con origen y tamaño pares (yuv420p no admite medios píxeles de croma). */
export function recortePar(r: Rect, ancho: number, alto: number): Rect {
	let x = Math.max(0, Math.floor(r.x / 2) * 2);
	let y = Math.max(0, Math.floor(r.y / 2) * 2);
	let x1 = Math.min(ancho, Math.ceil((r.x + r.w) / 2) * 2);
	let y1 = Math.min(alto, Math.ceil((r.y + r.h) / 2) * 2);
	if (x1 - x < 2) x1 = Math.min(ancho, x + 2);
	if (y1 - y < 2) y1 = Math.min(alto, y + 2);
	if (x1 - x < 2) x = Math.max(0, x1 - 2);
	if (y1 - y < 2) y = Math.max(0, y1 - 2);
	return {x, y, w: x1 - x, h: y1 - y};
}

/** Lista de cuadros nativos que leerá una selección (ordenada, sin repetidos y dentro del video). */
export function cuadrosDeSeleccion(sel: SeleccionCuadros, totalCuadros: number): number[] {
	if (sel.tipo === 'lista') {
		return [...new Set(sel.cuadros.map((n) => Math.round(n)))].filter((n) => n >= 0 && n < totalCuadros).sort((a, b) => a - b);
	}
	const paso = Math.max(1, Math.round(sel.paso));
	const desde = Math.max(0, Math.ceil((sel.desde ?? 0) / paso) * paso);
	const hasta = Math.min(totalCuadros - 1, sel.hasta ?? totalCuadros - 1);
	const lista: number[] = [];
	for (let n = desde; n <= hasta; n += paso) lista.push(n);
	return lista;
}

/** Junta números consecutivos en rangos [a, b]. */
export function rangos(cuadros: number[]): Array<[number, number]> {
	const r: Array<[number, number]> = [];
	for (const n of cuadros) {
		const ultimo = r[r.length - 1];
		if (ultimo && n === ultimo[1] + 1) ultimo[1] = n;
		else r.push([n, n]);
	}
	return r;
}

/**
 * Expresión del filtro select de ffmpeg (va entre comillas simples en el filtergraph). Para el modo paso es un
 * solo término. Para una lista NO se arma una suma de rangos (con cientos de términos ffmpeg falla con
 * "Cannot allocate memory"): se pide el tramo continuo [primero, último] y `ocrCuadros` le pasa a Vision solo
 * los cuadros de la lista.
 */
export function expresionSelect(sel: SeleccionCuadros, totalCuadros: number): string {
	if (sel.tipo === 'paso') {
		const paso = Math.max(1, Math.round(sel.paso));
		const desde = Math.max(0, sel.desde ?? 0);
		const hasta = Math.min(totalCuadros - 1, sel.hasta ?? totalCuadros - 1);
		return `not(mod(n,${paso}))*between(n,${desde},${hasta})`;
	}
	const lista = cuadrosDeSeleccion(sel, totalCuadros);
	if (lista.length === 0) return '0';
	return `between(n,${lista[0]},${lista[lista.length - 1]})`;
}

export type LineaOcr = {i: number; t: number; cajas: CajaOcr[]};

/** Pasa una caja normalizada al recorte → normalizada al cuadro completo. */
function aCuadroCompleto<T extends Rect>(c: T, recorte: Rect, ancho: number, alto: number): T {
	return {
		...c,
		x: (recorte.x + c.x * recorte.w) / ancho,
		y: (recorte.y + c.y * recorte.h) / alto,
		w: (c.w * recorte.w) / ancho,
		h: (c.h * recorte.h) / alto,
	};
}

/** Revisa que exista el motor de OCR (binario de Vision o el .venv con herramientas/py/ocr.py). */
export function asegurarOcr(): void {
	const c = comandoOcr();
	const falta = faltaParaVision(c, existsSync);
	if (falta) {
		throw fallo('leer texto con el OCR', `no existe ${falta === c.programa && c.motor === 'python' ? 'el Python del .venv' : c.nombre}`, c.comoInstalar, 2);
	}
}

/**
 * Corre ffmpeg | ocr sobre los cuadros elegidos. Devuelve los cuadros en orden, con su `n` nativo.
 * Fallos: código 2 si falta el binario o ffmpeg; código 1 si ffmpeg u ocr terminan con error.
 */
export function ocrCuadros(op: OpcionesOcr): Promise<ResultadoOcr> {
	asegurarOcr();
	if (!existsSync(op.video)) {
		throw fallo(`leer ${basename(op.video)}`, `no existe ${op.video}`, 'revisa la ruta', 2);
	}
	const recorte = recortePar(op.recorte ?? {x: 0, y: 0, w: op.ancho, h: op.alto}, op.ancho, op.alto);
	const lista = cuadrosDeSeleccion(op.seleccion, op.totalCuadros);
	const t0 = performance.now();
	if (lista.length === 0) return Promise.resolve({cuadros: [], recorte, segundos: 0});

	const filtros = [`select='${expresionSelect(op.seleccion, op.totalCuadros)}'`];
	if (recorte.w !== op.ancho || recorte.h !== op.alto || recorte.x !== 0 || recorte.y !== 0) {
		filtros.push(`crop=${recorte.w}:${recorte.h}:${recorte.x}:${recorte.y}:exact=1`);
	}
	const argsFf = [
		'-v', 'error', '-nostdin', '-i', op.video,
		'-map', '0:v:0', '-an', '-sn', '-dn',
		'-vf', filtros.join(','),
		'-fps_mode', 'passthrough',
		'-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
	];
	const argsOcr = [
		'--ancho', String(recorte.w), '--alto', String(recorte.h),
		'--fps', String(op.fps), '--modo', op.modo ?? 'accurate',
		'--hilos', String(op.hilos ?? 2),
	];
	if (op.minAlto !== undefined) argsOcr.push('--min-alto', String(Math.min(1, Math.max(0, op.minAlto))));
	if (op.palabrasCajas) argsOcr.push('--palabras-cajas');
	if (op.cpu) argsOcr.push('--cpu');

	const bytesCuadro = recorte.w * recorte.h * 4;
	const que = `leer el texto de ${basename(op.video)}`;
	// Qué cuadro nativo es el k-ésimo que entrega ffmpeg y si va a Vision.
	const quiero = new Set(lista);
	const nDeSalida = (k: number) => (op.seleccion.tipo === 'paso' ? lista[k] : lista[0] + k);

	return new Promise<ResultadoOcr>((resolver, rechazar) => {
		const motor = comandoOcr();
		const ff = spawn('ffmpeg', argsFf, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
		const oc = lanzarOcr(argsOcr);
		let errFf = '';
		let errOc = '';
		let terminado = false;
		const lineas: LineaOcr[] = [];
		const pixeles: Buffer[] = [];
		/** Cuadros nativos enviados a Vision, en orden: la línea k de ocr es del cuadro enviados[k]. */
		const enviados: number[] = [];
		let codigoFf: number | null | undefined;
		let codigoOc: number | null | undefined;

		const abortar = (error: unknown) => {
			if (terminado) return;
			terminado = true;
			ff.kill('SIGKILL');
			oc.kill('SIGKILL');
			rechazar(error);
		};

		ff.stderr.on('data', (d: Buffer) => {
			errFf = (errFf + d.toString()).slice(-6000);
		});
		oc.stderr.on('data', (d: Buffer) => {
			errOc = (errOc + d.toString()).slice(-6000);
		});
		ff.on('error', (e: NodeJS.ErrnoException) =>
			abortar(
				e.code === 'ENOENT'
					? fallo(que, 'no encuentro ffmpeg en el PATH', `instala ffmpeg (${comoInstalar('ffmpeg')})`, 2, e)
					: fallo(que, `no pude arrancar ffmpeg (${e.message})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, e),
			),
		);
		oc.on('error', (e: NodeJS.ErrnoException) =>
			abortar(fallo(que, `no pude arrancar ${motor.nombre} (${e.message})`, motor.comoInstalar, 1, e)),
		);
		// Si ocr muere antes de tiempo, escribir en su stdin da EPIPE: lo reporta su propio cierre.
		oc.stdin.on('error', () => {});

		// Node arma los cuadros que entrega ffmpeg y le pasa a Vision solo los pedidos (con contrapresión).
		let partes: Buffer[] = [];
		let llenos = 0;
		let indice = 0;
		ff.stdout.on('data', (trozo: Buffer) => {
			let desde = 0;
			while (desde < trozo.length) {
				const toma = Math.min(bytesCuadro - llenos, trozo.length - desde);
				partes.push(trozo.subarray(desde, desde + toma));
				llenos += toma;
				desde += toma;
				if (llenos < bytesCuadro) break;
				const n = nDeSalida(indice++);
				if (quiero.has(n)) {
					const cuadro = partes.length === 1 ? partes[0] : Buffer.concat(partes, bytesCuadro);
					enviados.push(n);
					if (op.conservarPixeles) pixeles.push(Buffer.from(cuadro));
					if (!oc.stdin.write(cuadro) && !ff.stdout.isPaused()) {
						ff.stdout.pause();
						oc.stdin.once('drain', () => ff.stdout.resume());
					}
				}
				partes = [];
				llenos = 0;
			}
		});
		ff.stdout.on('end', () => oc.stdin.end());

		createInterface({input: oc.stdout}).on('line', (linea) => {
			if (!linea.trim()) return;
			try {
				lineas.push(parsearLineaOcr(linea));
			} catch (error) {
				abortar(fallo(que, `${motor.nombre} devolvió una línea que no es JSON válido`, motor.comoInstalar, 1, {error: String(error), linea: linea.slice(0, 500)}));
			}
		});

		const alCerrar = () => {
			if (terminado || codigoFf === undefined || codigoOc === undefined) return;
			terminado = true;
			if (codigoOc !== 0) {
				// ocr ya imprime una frase "No pude …. Siguiente paso: …." en español: se respeta tal cual.
				// (macOS a veces imprime su propio aviso pegado antes, sin salto de línea: se busca la frase donde esté.)
				const desde = errOc.lastIndexOf('No pude ');
				const frase = desde >= 0 ? errOc.slice(desde).split('\n')[0].trim() : undefined;
				const motivo = frase ? frase.replace(/^No pude [^:]*: /, '').replace(/\. Siguiente paso:.*$/, '') : `ocr salió con ${codigoOc}`;
				const siguiente = frase?.match(/Siguiente paso: (.*)\.$/)?.[1] ?? 'revisa proyectos/_logs/fallos.log y avísame';
				rechazar(fallo(que, motivo, siguiente, codigoOc === 2 ? 2 : 1, {argsOcr, stderr: errOc}));
				return;
			}
			if (codigoFf !== 0) {
				const ultima = errFf.trim().split('\n').pop() || `código ${codigoFf}`;
				rechazar(fallo(que, `ffmpeg terminó con error (${ultima})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {argsFf, stderr: errFf}));
				return;
			}
			if (lineas.length !== enviados.length) {
				rechazar(fallo(que, `el OCR devolvió ${lineas.length} lecturas para ${enviados.length} cuadros`, `${motor.comoInstalar} y avísame`, 1, {argsFf, argsOcr, motor: motor.motor}));
				return;
			}
			const cuadros: CuadroOcr[] = lineas.map((l, k) => {
				const n = enviados[k];
				const cuadro: CuadroOcr = {
					n,
					t: n / op.fps,
					cajas: l.cajas.map((c) => {
						const caja = aCuadroCompleto(c, recorte, op.ancho, op.alto);
						if (c.palabras) caja.palabras = c.palabras.map((p) => aCuadroCompleto(p, recorte, op.ancho, op.alto));
						return caja;
					}),
				};
				if (op.conservarPixeles && pixeles[k]) cuadro.pixeles = pixeles[k];
				return cuadro;
			});
			resolver({cuadros, recorte, segundos: (performance.now() - t0) / 1000});
		};
		ff.on('close', (codigo) => {
			codigoFf = codigo;
			alCerrar();
		});
		oc.on('close', (codigo) => {
			codigoOc = codigo;
			// Si ocr se fue antes que ffmpeg (falló Vision), nadie va a leer más cuadros: ffmpeg se quedaría
			// esperando con la tubería llena. Se termina para poder reportar el fallo.
			if (codigoFf === undefined) {
				ff.stdout.resume();
				ff.kill('SIGKILL');
			}
			alCerrar();
		});
	});
}

// ───────────────────────────── Texto y eventos (puro) ─────────────────────────────

/** Minúsculas, sin acentos ni puntuación, espacios simples. "¡Está bien!" → "esta bien". */
export function normalizarTexto(texto: string): string {
	return texto
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** Texto compacto para comparar lecturas: como normalizarTexto pero SIN espacios ("per:der" = "perder"). */
export function compactarTexto(texto: string): string {
	return normalizarTexto(texto).replace(/\s+/g, '');
}

/** Distancia de edición (Levenshtein) entre dos cadenas. */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let previa = Array.from({length: b.length + 1}, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const actual = [i];
		for (let j = 1; j <= b.length; j++) {
			actual[j] = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previa = actual;
	}
	return previa[b.length];
}

/** Similitud 0–1 entre dos textos ya normalizados (1 − distancia / largo mayor). */
export function similitud(a: string, b: string): number {
	if (!a && !b) return 1;
	return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Dónde cae mejor `corta` dentro de `larga` (ventanas de su largo ±1): [inicio, fin) y distancia de edición. */
export function alineacionParcial(corta: string, larga: string): {inicio: number; fin: number; distancia: number} {
	let mejor = {inicio: 0, fin: Math.min(larga.length, corta.length), distancia: Number.POSITIVE_INFINITY};
	for (const largo of [corta.length, corta.length - 1, corta.length + 1]) {
		if (largo < 1 || largo > larga.length) continue;
		for (let i = 0; i + largo <= larga.length; i++) {
			const d = levenshtein(corta, larga.slice(i, i + largo));
			if (d < mejor.distancia) mejor = {inicio: i, fin: i + largo, distancia: d};
		}
	}
	return mejor;
}

export type OpcionesComparar = {
	/** Similitud mínima entre textos compactos completos (por defecto 0.8). */
	similitudMin?: number;
	/** Similitud mínima de la lectura corta dentro de la larga (por defecto 0.85). */
	parcialMin?: number;
};

type ConTexto = {texto: string; caja: Rect | null};

/**
 * ¿Dos lecturas son el mismo subtítulo? (puro)
 * - Mismo texto compacto, o parecido (≥ similitudMin), con cajas que se enciman en vertical; o
 * - lectura parcial: Vision (.fast sobre todo) a veces se come palabras ("sin perder" → "perder"). Vale si la
 *   corta (≥3 letras) aparece dentro de la larga (≥ parcialMin) y su caja comparte la orilla que debe: si le
 *   faltan palabras al principio, la orilla derecha; si le faltan al final, la izquierda. Un subtítulo nuevo
 *   que se parece ("una hora" → "ahora") se vuelve a centrar y no comparte orillas, así que no se confunde.
 */
export function mismoSubtitulo(a: ConTexto, b: ConTexto, op: OpcionesComparar = {}): boolean {
	const ca = compactarTexto(a.texto);
	const cb = compactarTexto(b.texto);
	if (!ca || !cb) return false;
	if (a.caja && b.caja && solapeVertical(a.caja, b.caja) <= 0.3) return false;
	if (ca === cb || similitud(ca, cb) >= (op.similitudMin ?? 0.8)) return true;
	const [corta, larga] = ca.length <= cb.length ? [a, b] : [b, a];
	const cc = ca.length <= cb.length ? ca : cb;
	const cl = ca.length <= cb.length ? cb : ca;
	if (cc.length < 3 || !corta.caja || !larga.caja) return false;
	const al = alineacionParcial(cc, cl);
	if (1 - al.distancia / cc.length < (op.parcialMin ?? 0.85)) return false;
	const anchoLetra = larga.caja.w / Math.max(1, normalizarTexto(larga.texto).length);
	const tol = Math.max(0.006, 0.6 * anchoLetra);
	const orillaIzq = Math.abs(corta.caja.x - larga.caja.x) <= tol;
	const orillaDer = Math.abs(corta.caja.x + corta.caja.w - (larga.caja.x + larga.caja.w)) <= tol;
	const esPrefijo = al.inicio <= 1;
	const esSufijo = al.fin >= cl.length - 1;
	if (esPrefijo && esSufijo) return orillaIzq || orillaDer;
	if (esSufijo) return orillaDer;
	if (esPrefijo) return orillaIzq;
	// Le faltan palabras de los dos lados: la caja corta debe quedar adentro de la larga.
	return corta.caja.x >= larga.caja.x - tol && corta.caja.x + corta.caja.w <= larga.caja.x + larga.caja.w + tol;
}

/** Lo que se leyó en un cuadro, ya filtrado a lo que interesa (p. ej. la línea del subtítulo). */
export type LecturaCuadro = {n: number; t: number; texto: string; caja: Rect | null};

export type EventoTexto = {
	/** Texto más frecuente de la racha, tal como lo leyó Vision. */
	texto: string;
	normalizado: string;
	/** Primer cuadro nativo con el texto y primer cuadro nativo ya sin él: [nDesde, nHasta). */
	nDesde: number;
	nHasta: number;
	/** nDesde / fps y nHasta / fps (s). */
	desde: number;
	hasta: number;
	/** Caja mediana (por componente) de las lecturas de la racha. */
	caja: Rect;
	/** Cuántas lecturas (cuadros leídos) vieron este texto. */
	lecturas: number;
	/** Cuadro leído justo antes de la racha (sin este texto) y justo después; null si no hubo. */
	nAntes: number | null;
	nDespues: number | null;
	/** Primera y última lectura de la racha (para comparar con los cuadros vecinos al afinar). */
	lecturaInicial: LecturaCuadro;
	lecturaFinal: LecturaCuadro;
};

export type OpcionesAgrupar = OpcionesComparar & {
	fps: number;
	/** Rachas con menos lecturas se descartan (por defecto 2). */
	minLecturas?: number;
	/** Une dos rachas del mismo texto separadas por a lo más este número de lecturas raras o vacías (por defecto 1). */
	huecoMax?: number;
};

function mediana(v: number[]): number {
	const s = [...v].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Caja mediana por componente. */
export function cajaMediana(cajas: Rect[]): Rect {
	return {x: mediana(cajas.map((c) => c.x)), y: mediana(cajas.map((c) => c.y)), w: mediana(cajas.map((c) => c.w)), h: mediana(cajas.map((c) => c.h))};
}

/** ¿Dos rectángulos se enciman en vertical (fracción del más bajo)? */
function solapeVertical(a: Rect, b: Rect): number {
	const sup = Math.max(a.y, b.y);
	const inf = Math.min(a.y + a.h, b.y + b.h);
	return Math.max(0, inf - sup) / Math.max(1e-9, Math.min(a.h, b.h));
}

type Racha = {lecturas: LecturaCuadro[]; nAntes: number | null; nDespues: number | null};

/**
 * Rachas de lecturas consecutivas del mismo subtítulo → eventos de texto (puro).
 * "Mismo subtítulo" = `mismoSubtitulo` (texto compacto igual o parecido, o lectura parcial con la orilla
 * correcta). Las rachas de menos de `minLecturas` se descartan, y dos rachas del mismo texto separadas por
 * ≤ `huecoMax` lecturas raras o vacías (OCR que falló un cuadro) se unen.
 * Los bordes quedan en las lecturas: nDesde = primera lectura, nHasta = última lectura + 1. `afinarBordes`
 * los lleva a los fps nativos.
 */
export function agruparEventos(lecturas: LecturaCuadro[], op: OpcionesAgrupar): EventoTexto[] {
	const minLecturas = op.minLecturas ?? 2;
	const huecoMax = op.huecoMax ?? 1;
	const orden = [...lecturas].sort((a, b) => a.n - b.n);
	const mismo = (a: LecturaCuadro, b: LecturaCuadro) => mismoSubtitulo(a, b, op);
	/** ¿La lectura `l` sigue la racha? Se compara con sus últimas lecturas (una sola lectura parcial no la corta). */
	const sigue = (r: Racha, l: LecturaCuadro) => r.lecturas.slice(-3).some((x) => mismo(x, l));

	// 1) Rachas crudas.
	const rachas: Racha[] = [];
	let actual: Racha | null = null;
	for (let k = 0; k < orden.length; k++) {
		const l = orden[k];
		const vacia = !compactarTexto(l.texto);
		if (actual && !vacia && sigue(actual, l)) {
			actual.lecturas.push(l);
			continue;
		}
		if (actual) {
			actual.nDespues = l.n;
			rachas.push(actual);
			actual = null;
		}
		if (!vacia) actual = {lecturas: [l], nAntes: k > 0 ? orden[k - 1].n : null, nDespues: null};
	}
	if (actual) rachas.push(actual);

	// 2) Unir rachas del mismo texto separadas por un hueco corto (lecturas vacías o raras). El hueco puede
	//    traer su propia racha corta de basura (A · X · A): se brinca mientras el hueco sume ≤ huecoMax lecturas.
	const indice = new Map(orden.map((l, k) => [l, k]));
	const unidas: Racha[] = [];
	for (const r of rachas) {
		let unida = false;
		for (let j = unidas.length - 1; j >= 0; j--) {
			const previa = unidas[j];
			const enMedio = indice.get(r.lecturas[0])! - indice.get(previa.lecturas[previa.lecturas.length - 1])! - 1;
			if (enMedio > huecoMax) break;
			if (r.lecturas.slice(0, 3).some((l) => sigue(previa, l))) {
				previa.lecturas.push(...r.lecturas);
				previa.nDespues = r.nDespues;
				unidas.length = j + 1; // las rachas cortas del hueco eran ruido
				unida = true;
				break;
			}
		}
		if (!unida) unidas.push({...r, lecturas: [...r.lecturas]});
	}

	// 3) Eventos (descartando rachas cortas). El texto que representa la racha es el más frecuente.
	return unidas
		.filter((r) => r.lecturas.length >= minLecturas)
		.map((r) => {
			const cuenta = new Map<string, {n: number; l: LecturaCuadro}>();
			for (const l of r.lecturas) {
				const c = compactarTexto(l.texto);
				const previo = cuenta.get(c);
				if (previo) previo.n++;
				else cuenta.set(c, {n: 1, l});
			}
			const masFrecuente = [...cuenta.values()].sort((a, b) => b.n - a.n || compactarTexto(b.l.texto).length - compactarTexto(a.l.texto).length)[0].l;
			const cajas = r.lecturas.map((l) => l.caja).filter((c): c is Rect => c !== null);
			const nDesde = r.lecturas[0].n;
			const nHasta = r.lecturas[r.lecturas.length - 1].n + 1;
			return {
				texto: masFrecuente.texto.trim(),
				normalizado: normalizarTexto(masFrecuente.texto),
				nDesde,
				nHasta,
				desde: nDesde / op.fps,
				hasta: nHasta / op.fps,
				caja: cajas.length ? cajaMediana(cajas) : {x: 0, y: 0, w: 0, h: 0},
				lecturas: r.lecturas.length,
				nAntes: r.nAntes,
				nDespues: r.nDespues,
				lecturaInicial: r.lecturas[0],
				lecturaFinal: r.lecturas[r.lecturas.length - 1],
			};
		});
}

/**
 * Cuadros nativos que hay que leer para afinar los bordes de cada evento: los que quedaron entre la muestra
 * vecina y el borde. Si la muestra vecina salió vacía (Vision no leyó nada), la ventana se abre una muestra
 * más, por si el subtítulo ya estaba ahí y fue un cuadro fallido.
 */
export function cuadrosParaAfinar(eventos: EventoTexto[], lecturas: LecturaCuadro[], paso: number, totalCuadros: number): number[] {
	const porCuadro = new Map(lecturas.map((l) => [l.n, l]));
	const vacia = (n: number | null) => n !== null && !compactarTexto(porCuadro.get(n)?.texto ?? '');
	const set = new Set<number>();
	for (const e of eventos) {
		let iniMin = e.nAntes !== null ? e.nAntes + 1 : Math.max(0, e.nDesde - paso + 1);
		if (vacia(e.nAntes)) iniMin = Math.max(0, e.nAntes! - paso + 1);
		for (let n = iniMin; n < e.nDesde; n++) if (!porCuadro.has(n)) set.add(n);
		const ultimo = e.nHasta - 1;
		let finMax = e.nDespues !== null ? e.nDespues - 1 : Math.min(totalCuadros - 1, ultimo + paso - 1);
		if (vacia(e.nDespues)) finMax = Math.min(totalCuadros - 1, e.nDespues! + paso - 1);
		for (let n = ultimo + 1; n <= finMax; n++) if (!porCuadro.has(n)) set.add(n);
	}
	return [...set].filter((n) => n >= 0 && n < totalCuadros).sort((a, b) => a - b);
}

/**
 * Lleva los bordes de cada evento a los fps nativos (puro). `lecturas` trae TODO lo leído: muestras y cuadros
 * intermedios. Camina hacia atrás desde nDesde y hacia adelante desde el último cuadro mientras el cuadro sea
 * el mismo subtítulo; un solo cuadro vacío en medio no lo corta si el siguiente sí coincide.
 */
export function afinarBordes(eventos: EventoTexto[], lecturas: LecturaCuadro[], op: OpcionesComparar & {fps: number}): EventoTexto[] {
	const porCuadro = new Map(lecturas.map((l) => [l.n, l]));
	const coincide = (ref: LecturaCuadro, n: number) => {
		const l = porCuadro.get(n);
		return !!l && mismoSubtitulo(ref, l, op);
	};
	const vacio = (n: number) => {
		const l = porCuadro.get(n);
		return !!l && !compactarTexto(l.texto);
	};
	return eventos.map((e, i) => {
		const limiteIzq = i > 0 ? eventos[i - 1].nHasta - 1 : -1;
		const limiteDer = i + 1 < eventos.length ? eventos[i + 1].nDesde : Number.POSITIVE_INFINITY;
		let nDesde = e.nDesde;
		for (;;) {
			if (nDesde - 1 > limiteIzq && coincide(e.lecturaInicial, nDesde - 1)) nDesde -= 1;
			else if (nDesde - 2 > limiteIzq && vacio(nDesde - 1) && coincide(e.lecturaInicial, nDesde - 2)) nDesde -= 2;
			else break;
		}
		let ultimo = e.nHasta - 1;
		for (;;) {
			if (ultimo + 1 < limiteDer && coincide(e.lecturaFinal, ultimo + 1)) ultimo += 1;
			else if (ultimo + 2 < limiteDer && vacio(ultimo + 1) && coincide(e.lecturaFinal, ultimo + 2)) ultimo += 2;
			else break;
		}
		const nHasta = ultimo + 1;
		return {...e, nDesde, nHasta, desde: nDesde / op.fps, hasta: nHasta / op.fps};
	});
}

/**
 * Une las cajas de un cuadro en líneas (por solape vertical) y las ordena para leerlas:
 * de arriba abajo y, dentro de cada línea, de izquierda a derecha.
 */
export function lineasDeCajas(cajas: CajaOcr[]): Array<{texto: string; caja: Rect; cajas: CajaOcr[]; confianza: number}> {
	const orden = [...cajas].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
	const lineas: CajaOcr[][] = [];
	for (const c of orden) {
		const linea = lineas.find((l) => l.some((o) => solapeVertical(o, c) > 0.5));
		if (linea) linea.push(c);
		else lineas.push([c]);
	}
	return lineas
		.map((l) => {
			const ord = [...l].sort((a, b) => a.x - b.x);
			const x0 = Math.min(...ord.map((c) => c.x));
			const y0 = Math.min(...ord.map((c) => c.y));
			const x1 = Math.max(...ord.map((c) => c.x + c.w));
			const y1 = Math.max(...ord.map((c) => c.y + c.h));
			return {
				texto: ord.map((c) => c.texto.trim()).join(' '),
				caja: {x: x0, y: y0, w: x1 - x0, h: y1 - y0},
				cajas: ord,
				confianza: Math.min(...ord.map((c) => c.confianza)),
			};
		})
		.sort((a, b) => a.caja.y - b.caja.y);
}

export type OpcionesEventosVideo = Omit<OpcionesOcr, 'seleccion' | 'conservarPixeles' | 'palabrasCajas'> & {
	/** Cada cuántos cuadros nativos se muestrea (p. ej. 3 para 30 fps → 10 fps). */
	paso: number;
	/** Convierte las cajas de un cuadro en la lectura que interesa (por defecto: todas las líneas juntas). */
	lectura?: (cuadro: CuadroOcr) => {texto: string; caja: Rect | null};
	agrupar?: Omit<OpcionesAgrupar, 'fps'>;
};

export type ResultadoEventosVideo = {
	eventos: EventoTexto[];
	/** Eventos antes de afinar (con bordes de muestreo), para diagnóstico. */
	eventosMuestreo: EventoTexto[];
	lecturas: LecturaCuadro[];
	/** Lecturas de los cuadros intermedios usados para afinar bordes. */
	lecturasIntermedias: LecturaCuadro[];
	cuadrosLeidos: {muestreo: number; afinado: number};
	segundos: {muestreo: number; afinado: number};
};

/** Lectura por defecto: todas las líneas del cuadro, de arriba abajo. */
export function lecturaTodas(cuadro: CuadroOcr): {texto: string; caja: Rect | null} {
	const lineas = lineasDeCajas(cuadro.cajas);
	if (lineas.length === 0) return {texto: '', caja: null};
	const x0 = Math.min(...lineas.map((l) => l.caja.x));
	const y0 = Math.min(...lineas.map((l) => l.caja.y));
	const x1 = Math.max(...lineas.map((l) => l.caja.x + l.caja.w));
	const y1 = Math.max(...lineas.map((l) => l.caja.y + l.caja.h));
	return {texto: lineas.map((l) => l.texto).join(' '), caja: {x: x0, y: y0, w: x1 - x0, h: y1 - y0}};
}

/**
 * Eventos de texto de un video: muestreo cada `paso` cuadros → rachas → bordes afinados a los fps nativos.
 * Las rachas de menos de 2 lecturas se descartan (con paso 3 a 30 fps, un texto de <0.2 s puede perderse).
 */
export async function eventosDeVideo(op: OpcionesEventosVideo): Promise<ResultadoEventosVideo> {
	const lectura = op.lectura ?? lecturaTodas;
	const base = {...op};
	delete (base as Partial<OpcionesEventosVideo>).lectura;
	delete (base as Partial<OpcionesEventosVideo>).agrupar;

	const muestreo = await ocrCuadros({...base, seleccion: {tipo: 'paso', paso: op.paso}});
	const lecturas: LecturaCuadro[] = muestreo.cuadros.map((c) => ({n: c.n, t: c.t, ...lectura(c)}));
	const eventosMuestreo = agruparEventos(lecturas, {fps: op.fps, ...op.agrupar});

	const intermedios = cuadrosParaAfinar(eventosMuestreo, lecturas, op.paso, op.totalCuadros);
	let afinado: ResultadoOcr = {cuadros: [], recorte: muestreo.recorte, segundos: 0};
	if (intermedios.length > 0) {
		afinado = await ocrCuadros({...base, seleccion: {tipo: 'lista', cuadros: intermedios}});
	}
	const lecturasIntermedias: LecturaCuadro[] = afinado.cuadros.map((c) => ({n: c.n, t: c.t, ...lectura(c)}));
	const eventos = afinarBordes(eventosMuestreo, [...lecturas, ...lecturasIntermedias], {fps: op.fps, ...op.agrupar});
	return {
		eventos,
		eventosMuestreo,
		lecturas,
		lecturasIntermedias,
		cuadrosLeidos: {muestreo: muestreo.cuadros.length, afinado: afinado.cuadros.length},
		segundos: {muestreo: muestreo.segundos, afinado: afinado.segundos},
	};
}
