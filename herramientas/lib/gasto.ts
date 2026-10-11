/**
 * Candado de gasto para scripts (reglas 2 y 3 de la casa).
 *
 * Todo script que gaste dinero o créditos (Gemini, Apify…) llama a `exigirSiGasto(process.argv, …)`
 * al principio de su `main`, ANTES de cualquier llamada de red. Solo sigue si en la línea de comandos viene
 * `--si-gasto=<monto en USD>` y ese monto cubre el estimado. El monto sale de tu "sí" en el chat:
 * primero te digo cuánto cuesta y después corro el comando con ese número.
 *
 * Códigos de salida:
 *   3  falta tu sí o lo que aprobaste no alcanza
 *   2  la bandera viene mal escrita (vacía, con $ o comas, repetida…)
 *   1  el script pasó un estimado roto (NaN, negativo, infinito): sin estimado válido no se gasta nada
 */
import {fallo} from './fallo.ts';

const BANDERA = '--si-gasto';
const EJEMPLO = `${BANDERA}=0.05`;

/** Solo dígitos y punto decimal: nada de $, comas, signos, exponentes ni Infinity. */
const MONTO_VALIDO = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

/** Margen para errores de punto flotante (0.1 + 0.2 da 0.30000000000000004); queda muy por debajo de un centavo. */
const TOLERANCIA_USD = 1e-9;

export type OpcionesGasto = {
	/** Servicio que cobra, tal como lo vas a leer en el mensaje (por ejemplo 'Gemini' o 'Apify'). */
	servicio: string;
	/** Costo estimado de esta corrida, en dólares. */
	estimadoUsd: number;
};

/**
 * Lee `--si-gasto=<monto>` de argv (sirve `process.argv` completo o ya recortado).
 * Devuelve el monto aprobado en USD, o null si la bandera no viene.
 * Lo que va después de `--` son datos y no opciones, así que ahí no se busca.
 * Si la bandera viene mal escrita lanza un FalloEditor con código 2.
 */
export function parsearSiGasto(argv: readonly string[]): number | null {
	const valores: string[] = [];
	for (const arg of argv) {
		if (arg === '--') break;
		if (arg === BANDERA) {
			throw fallo(`leer ${BANDERA}`, 'viene sin monto', `escríbelo pegado con signo igual, como ${EJEMPLO}`, 2);
		}
		if (arg.startsWith(`${BANDERA}=`)) valores.push(arg.slice(BANDERA.length + 1));
	}
	if (valores.length === 0) return null;
	if (valores.length > 1) {
		throw fallo(
			`leer ${BANDERA}`,
			`viene ${valores.length} veces y no sé cuál vale`,
			`déjalo una sola vez, como ${EJEMPLO}`,
			2,
		);
	}
	const texto = valores[0];
	// Number() de un número enorme da Infinity: también se rechaza, sería un sí sin tope.
	const monto = MONTO_VALIDO.test(texto) ? Number(texto) : Number.NaN;
	if (!Number.isFinite(monto)) {
		const porque = texto === '' ? 'viene sin monto' : `«${mostrar(texto)}» no es un monto en dólares`;
		throw fallo(`leer ${BANDERA}`, porque, `escríbelo solo con números y punto decimal, como ${EJEMPLO}`, 2);
	}
	return monto;
}

/**
 * El candado: lanza un FalloEditor con código 3 si no aprobaste el gasto o si lo aprobado no cubre el estimado.
 * Es síncrona a propósito: llámala antes del primer `await` que toque la red.
 * Devuelve el monto que aprobaste, que sirve de tope durante la corrida.
 */
export function exigirSiGasto(argv: readonly string[], opciones: OpcionesGasto): number {
	const servicio = revisarServicio(opciones?.servicio);
	const estimado = revisarEstimado(opciones?.estimadoUsd, servicio);
	const aprobado = parsearSiGasto(argv);
	const pedir = montoParaAprobar(estimado);
	const siguientePaso = `dime sí a US$${pedir} y lo corro con ${BANDERA}=${pedir}`;
	if (aprobado === null) {
		throw fallo(
			`usar ${servicio}`,
			`el gasto estimado es US$${formatearUsd(estimado)} y no tengo tu sí (falta ${BANDERA})`,
			siguientePaso,
			3,
			{servicio, estimadoUsd: estimado},
		);
	}
	if (aprobado + TOLERANCIA_USD < estimado) {
		throw fallo(
			`usar ${servicio}`,
			`el gasto estimado es US$${formatearUsd(estimado)} y solo aprobaste US$${formatearUsd(aprobado)}`,
			siguientePaso,
			3,
			{servicio, estimadoUsd: estimado, aprobadoUsd: aprobado},
		);
	}
	return aprobado;
}

/**
 * Monto que te pido aprobar para un estimado: centavos redondeados hacia arriba
 * (mínimo US$0.01 si cuesta algo), como texto listo para `--si-gasto=`.
 * Ese monto siempre pasa el candado con el mismo estimado.
 */
export function montoParaAprobar(estimadoUsd: number): string {
	const estimado = revisarEstimado(estimadoUsd);
	const centavos = Math.ceil(estimado * 100 - TOLERANCIA_USD * 100);
	const minimo = estimado > TOLERANCIA_USD ? 1 : 0;
	return (Math.max(minimo, centavos) / 100).toFixed(2);
}

function revisarServicio(servicio: unknown): string {
	if (typeof servicio !== 'string' || servicio.trim() === '') {
		throw fallo(
			'revisar el gasto',
			'el script no dijo qué servicio cobra',
			'pásale a exigirSiGasto el nombre del servicio, como Gemini o Apify',
			1,
		);
	}
	return servicio.trim();
}

function revisarEstimado(estimado: unknown, servicio = 'este servicio'): number {
	if (typeof estimado !== 'number' || !Number.isFinite(estimado) || estimado < 0) {
		throw fallo(
			`calcular el gasto de ${servicio}`,
			`el estimado (${String(estimado)}) no es un monto en dólares válido`,
			'arregla el cálculo del costo en el script, porque sin un estimado válido no gasto nada',
			1,
		);
	}
	return estimado;
}

/** Centavos exactos con 2 decimales (1.90); fracciones de centavo con hasta 6 (0.0026). */
function formatearUsd(monto: number): string {
	const centavos = monto * 100;
	if (Math.abs(centavos - Math.round(centavos)) < 1e-6) return (Math.round(centavos) / 100).toFixed(2);
	const texto = monto.toFixed(6).replace(/0+$/, '');
	return texto.endsWith('.') ? `${texto}00` : texto;
}

/** Lo que escribiste en la bandera, corto y sin caracteres raros, para citarlo en el mensaje. */
function mostrar(texto: string): string {
	const limpio = texto.replace(/[^\x20-\x7E]/g, '?');
	return limpio.length > 20 ? `${limpio.slice(0, 20)}…` : limpio;
}
