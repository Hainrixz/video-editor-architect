/**
 * Remapeo de tiempos entre el crudo y la base ya cortada.
 *
 * `keep` es la lista de tramos del crudo que se quedan, en segundos y alineados a cuadros de 30 fps
 * (pásalos por `cuantizar`). La base es la concatenación de esos tramos, en orden.
 *
 * Reglas de keep[]:
 * - Cada tramo es semiabierto, [desde, hasta): `hasta` ya es el primer cuadro que se quitó.
 * - Van en orden, sin encimarse y con un corte de al menos un cuadro entre uno y otro
 *   (dos tramos pegados serían el mismo tramo, y cada borde de keep[] cuenta como corte).
 * Si keep[] no las cumple, las funciones fallan con código 1 (es un error del paso que lo armó).
 *
 * Para un punto (un evento, el inicio de una palabra) usa `remapear`.
 * Para un intervalo (una palabra completa, un subtítulo) usa `remapearIntervalo`:
 * trata el final como límite y dice de qué tramo salió, así nada cruza un corte.
 *
 * Los bordes de la base salen exactos (se calculan en cuadros enteros). Si necesitas uno, pídeselo a
 * este módulo (`remapear(keep, keep[i].desde)` o `duracionBase(keep.slice(0, i))`) en vez de sumar
 * segundos: una suma de punto flotante puede quedar 1e-15 s antes del borde, y ahí `aCrudo` ya
 * devuelve el final del tramo anterior.
 *
 * Velocidad: base.ts puede acelerar la base completa por un factor F (como tú aceleras tus reels: ×1.05–×1.15).
 * Todas las funciones aceptan F al final (por defecto 1, que da exactamente lo de siempre). Con F, la base es la
 * concatenación de keep[] reproducida F veces más rápido:
 *   tiempo en la base = (inicio del tramo en la base sin acelerar + (t − desde del tramo)) / F
 * y su duración es la suma de keep[] / F. F va de VELOCIDAD_MIN a VELOCIDAD_MAX (lo que aguanta un solo atempo).
 */
import {fallo} from './fallo.ts';

export const FPS = 30;

/** Rango de la velocidad de la base: lo que ffmpeg hace con UN solo atempo sin perder calidad. */
export const VELOCIDAD_MIN = 0.5;
export const VELOCIDAD_MAX = 2;

/** ¿F sirve como velocidad de la base? (número finito en [VELOCIDAD_MIN, VELOCIDAD_MAX]). */
export function esVelocidadValida(velocidad: unknown): velocidad is number {
	return typeof velocidad === 'number' && Number.isFinite(velocidad) && velocidad >= VELOCIDAD_MIN && velocidad <= VELOCIDAD_MAX;
}

/** Tramo del crudo que se queda, en segundos, con los bordes en cuadros de 30 fps. */
export type Tramo = {desde: number; hasta: number};

/** Intervalo ya pasado a la base, con el índice del tramo de keep[] del que salió. */
export type TramoBase = Tramo & {tramo: number};

/** Holgura para aceptar un borde como "en el cuadro": cubre errores de punto flotante, no medio cuadro. */
const HOLGURA_S = 1e-6;

const QUE = 'remapear los tiempos';
const SIGUIENTE_KEEP = 'revisa el paso que armó keep[] (cortes o eventos) y vuelve a correrlo';
const SIGUIENTE_TIEMPO = 'revisa de dónde salió ese tiempo (transcripción, eventos o EDL)';

type TramoInterno = {
	/** Bordes en el crudo, en cuadros enteros. */
	cuadroDesde: number;
	cuadroHasta: number;
	/** Bordes en el crudo, en segundos exactos (k/30). */
	desde: number;
	hasta: number;
	/** El mismo tramo en la base (ya acelerada), en segundos. */
	inicioBase: number;
	finBase: number;
	/** Velocidad de la base (1 = sin acelerar). */
	velocidad: number;
};

/** Redondea un tiempo al cuadro de 30 fps más cercano. */
export function cuantizar(t: number): number {
	revisarTiempo(t, 't', 'cuantizar el tiempo');
	return Math.round(t * FPS) / FPS + 0; // el + 0 convierte -0 en 0
}

/** Revisa keep[] y lanza un FalloEditor (código 1) si no está en orden, se encima o no cae en cuadros. */
export function validarKeep(keep: readonly Tramo[]): void {
	preparar(keep);
}

/** Duración de la base en segundos: la suma de los tramos de keep[], dividida entre la velocidad F. */
export function duracionBase(keep: readonly Tramo[], velocidad = 1): number {
	const tramos = preparar(keep, velocidad);
	return tramos[tramos.length - 1].finBase;
}

/** Tiempo del crudo → tiempo en la base (acelerada F veces). Devuelve null si `t` cae en un corte (o antes o después de todo). */
export function remapear(keep: readonly Tramo[], t: number, velocidad = 1): number | null {
	const tramos = preparar(keep, velocidad);
	revisarTiempo(t, 't');
	const i = tramoEnCrudo(tramos, t);
	return i < 0 ? null : aBase(tramos[i], t);
}

/**
 * Intervalo del crudo [a, b] → intervalo en la base (acelerada F veces), recortado a un solo tramo.
 * Si cruza un corte, se queda con el tramo donde más dura (si empatan, el primero).
 * Devuelve null si no toca ningún tramo. Un intervalo de largo 0 se trata como punto.
 */
export function remapearIntervalo(keep: readonly Tramo[], a: number, b: number, velocidad = 1): TramoBase | null {
	const tramos = preparar(keep, velocidad);
	revisarTiempo(a, 'a');
	revisarTiempo(b, 'b');
	if (a > b) {
		throw fallo('remapear el intervalo', `empieza en ${seg(a)} y termina antes, en ${seg(b)}`, SIGUIENTE_TIEMPO, 1);
	}
	if (a === b) {
		const i = tramoEnCrudo(tramos, a);
		if (i < 0) return null;
		const t = aBase(tramos[i], a);
		return {desde: t, hasta: t, tramo: i};
	}
	let mejor = -1;
	let mejorSolape = 0;
	for (let i = 0; i < tramos.length; i++) {
		const solape = Math.min(b, tramos[i].hasta) - Math.max(a, tramos[i].desde);
		if (solape > mejorSolape) {
			mejor = i;
			mejorSolape = solape;
		}
	}
	if (mejor < 0) return null;
	const tr = tramos[mejor];
	const desde = a <= tr.desde ? tr.inicioBase : aBase(tr, a);
	const hasta = b >= tr.hasta ? tr.finBase : Math.min(tr.finBase, Math.max(desde, tr.inicioBase + (b - tr.desde) / tr.velocidad));
	return {desde, hasta, tramo: mejor};
}

/**
 * Inversa de `remapear`: tiempo en la base (acelerada F veces) → tiempo en el crudo.
 * Acepta de 0 a la duración de la base; el final exacto de la base da el `hasta` del último tramo.
 */
export function aCrudo(keep: readonly Tramo[], tBase: number, velocidad = 1): number {
	const tramos = preparar(keep, velocidad);
	revisarTiempo(tBase, 'tBase', 'pasar un tiempo de la base al crudo');
	const ultimo = tramos[tramos.length - 1];
	if (tBase < -HOLGURA_S || tBase > ultimo.finBase + HOLGURA_S) {
		throw fallo(
			'pasar un tiempo de la base al crudo',
			`${seg(tBase)} queda fuera de la base, que dura ${seg(ultimo.finBase)}`,
			SIGUIENTE_TIEMPO,
			1,
		);
	}
	if (tBase >= ultimo.finBase) return ultimo.hasta;
	const t = Math.max(0, tBase);
	for (const tr of tramos) {
		if (t < tr.finBase) return debajoDe(tr.desde + (t - tr.inicioBase) * tr.velocidad, tr.hasta);
	}
	return ultimo.hasta; // no se llega aquí: t < ultimo.finBase
}

/**
 * Valida keep[] y calcula dónde empieza y acaba cada tramo en la base (en cuadros enteros, sin deriva; con F,
 * esos cuadros enteros divididos entre F: la misma cuenta en todos lados da los mismos bordes).
 */
function preparar(keep: readonly Tramo[], velocidad = 1): TramoInterno[] {
	if (!esVelocidadValida(velocidad)) {
		throw fallo(QUE, `la velocidad ${String(velocidad)} no es un número de ${VELOCIDAD_MIN} a ${VELOCIDAD_MAX}`, 'revisa de dónde salió la velocidad (cortes.json o el manifest de la base)', 1);
	}
	if (!Array.isArray(keep)) throw fallo(QUE, 'keep[] no es una lista de tramos', SIGUIENTE_KEEP, 1);
	if (keep.length === 0) throw fallo(QUE, 'keep[] está vacío y no queda nada del crudo', SIGUIENTE_KEEP, 1);
	const tramos: TramoInterno[] = [];
	let cuadrosBase = 0;
	keep.forEach((tramo: unknown, i) => {
		if (typeof tramo !== 'object' || tramo === null) {
			throw fallo(QUE, `keep[${i}] no es un tramo {desde, hasta}`, SIGUIENTE_KEEP, 1);
		}
		const {desde, hasta} = tramo as Partial<Tramo>;
		const cuadroDesde = aCuadroExacto(desde, `keep[${i}].desde`);
		const cuadroHasta = aCuadroExacto(hasta, `keep[${i}].hasta`);
		const texto = `${seg(cuadroDesde / FPS)}–${seg(cuadroHasta / FPS)}`;
		if (cuadroDesde < 0) throw fallo(QUE, `el tramo ${i} (${texto}) empieza antes del segundo 0`, SIGUIENTE_KEEP, 1);
		if (cuadroHasta <= cuadroDesde) throw fallo(QUE, `el tramo ${i} (${texto}) no dura ni un cuadro`, SIGUIENTE_KEEP, 1);
		const anterior = tramos[i - 1];
		if (anterior) {
			const textoAnterior = `${seg(anterior.desde)}–${seg(anterior.hasta)}`;
			if (cuadroDesde < anterior.cuadroDesde) {
				const porque = `el tramo ${i} (${texto}) va antes que el tramo ${i - 1} (${textoAnterior}) y keep[] tiene que ir en orden`;
				throw fallo(QUE, porque, SIGUIENTE_KEEP, 1);
			}
			if (cuadroDesde < anterior.cuadroHasta) {
				throw fallo(QUE, `el tramo ${i} (${texto}) se encima con el tramo ${i - 1} (${textoAnterior})`, SIGUIENTE_KEEP, 1);
			}
			if (cuadroDesde === anterior.cuadroHasta) {
				throw fallo(
					QUE,
					`el tramo ${i} empieza justo donde acaba el tramo ${i - 1} (${seg(anterior.hasta)}), sin corte en medio`,
					'une esos dos tramos en uno solo en el paso que armó keep[] y vuelve a correrlo',
					1,
				);
			}
		}
		const largo = cuadroHasta - cuadroDesde;
		tramos.push({
			cuadroDesde,
			cuadroHasta,
			desde: cuadroDesde / FPS,
			hasta: cuadroHasta / FPS,
			// Con F = 1, x / 1 === x: los bordes salen idénticos a los de antes de la velocidad.
			inicioBase: cuadrosBase / FPS / velocidad,
			finBase: (cuadrosBase + largo) / FPS / velocidad,
			velocidad,
		});
		cuadrosBase += largo;
	});
	return tramos;
}

function aCuadroExacto(valor: unknown, etiqueta: string): number {
	if (typeof valor !== 'number' || !Number.isFinite(valor)) {
		throw fallo(QUE, `${etiqueta} no es un número válido (${String(valor)})`, SIGUIENTE_KEEP, 1);
	}
	const cuadro = Math.round(valor * FPS);
	if (Math.abs(valor - cuadro / FPS) > HOLGURA_S) {
		throw fallo(
			QUE,
			`${etiqueta} = ${valor} s no cae en un cuadro de 30 fps`,
			'pasa los bordes de keep[] por cuantizar() antes de usarlos',
			1,
		);
	}
	return cuadro;
}

function revisarTiempo(t: unknown, etiqueta: string, que = QUE): void {
	if (typeof t !== 'number' || !Number.isFinite(t)) {
		throw fallo(que, `${etiqueta} no es un tiempo válido (${String(t)})`, SIGUIENTE_TIEMPO, 1);
	}
}

function tramoEnCrudo(tramos: readonly TramoInterno[], t: number): number {
	return tramos.findIndex((tr) => t >= tr.desde && t < tr.hasta);
}

function aBase(tr: TramoInterno, t: number): number {
	return debajoDe(tr.inicioBase + (t - tr.desde) / tr.velocidad, tr.finBase);
}

/**
 * `x` si queda por debajo de `limite`; si no, el número inmediatamente menor que `limite`.
 * Evita que un redondeo de punto flotante mande un tiempo del final de un tramo al tramo siguiente.
 */
function debajoDe(x: number, limite: number): number {
	if (x < limite) return x;
	const numero = new Float64Array([limite]);
	const bits = new BigInt64Array(numero.buffer);
	bits[0] -= 1n; // para un limite > 0, restar 1 a sus bits da el double anterior
	return numero[0];
}

function seg(t: number): string {
	return `${t.toFixed(3)} s`;
}
