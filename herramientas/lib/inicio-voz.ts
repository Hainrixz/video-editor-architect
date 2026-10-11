/**
 * Inicio real de la voz por energía: corrige el inicio de las palabras que arrancan después de una pausa.
 *
 * Whisper (t_dtw×10 − k) acierta qué palabra es, pero tras una pausa su inicio puede caer decenas o
 * cientos de ms antes o después de que la voz suene. Aquí se busca, alrededor de esa estimación, el
 * arranque real en la energía del audio (WAV PCM s16 mono, el audio16k.wav de la ingesta):
 *
 * 1. Señal: paso-alto Butterworth de 4.º orden a 80 Hz (quita golpes graves, retumbos y DC). Aparte,
 *    dos bandas para reconocer respiraciones: voz (300–3400 Hz) y alta (3400 Hz hasta Nyquist).
 * 2. Energía RMS (dBFS) de la señal con paso-alto en ventanas de 10 ms cada 1 ms. El tiempo de cada
 *    ventana es su FINAL: ante un arranque brusco, la primera ventana que cruza el umbral termina
 *    justo en el arranque.
 * 3. Búsqueda en [estimación − 300 ms, estimación + 200 ms] (sin pasar del inicio de la palabra
 *    anterior ni de la estimación de la siguiente):
 *    - piso de ruido local = percentil 10 de la energía en los 500 ms antes de la estimación;
 *    - umbral = piso + X dB (X se calibra con pruebas/integracion/compuerta-energia.ts);
 *    - tramos = ventanas sobre el umbral; un hueco de ≤ 20 ms no corta el tramo (la explosión de una
 *      "t" o una "k" y su vocal quedan juntas);
 *    - clic: tramo que no se sostiene 30 ms → se ignora;
 *    - respiración: tramo con buena parte de su energía sobre 300 Hz pero sin dominio de la banda de
 *      voz sobre la alta (< 10 dB en sus primeros 50 ms) y al que le sigue otro tramo dentro de la
 *      ventana → se ignora. Una "s" pegada a su vocal (sin hueco) forma un solo tramo y se respeta;
 *    - arranque = el primer tramo que queda y que empieza dentro de la ventana.
 * 4. Solo se ajustan las palabras que arrancan tras una pausa: los 150 ms antes del arranque tienen
 *    que estar bajo el umbral (los clics y respiraciones ignorados cuentan como pausa), el piso local
 *    no puede quedar más de 10 dB sobre el ruido de fondo (percentil 2 en ±5 s: si queda arriba, el
 *    "piso" es habla y no pausa) y la palabra anterior no puede haber empezado dentro de esos 150 ms.
 *    Si no, la palabra está en medio del habla y se queda con su estimación.
 * 5. Al arranque se le resta un desplazamiento fijo (desplazamientoMs, calibrado; 0 por defecto).
 *
 * Todo es local y determinista: no usa red, llaves ni dependencias.
 */
import type {Wav} from './energia';
import {fallo} from './fallo';

export interface OpcionesInicioVoz {
	/** X: dB sobre el piso de ruido local a partir de los cuales hay voz. Se calibra. */
	umbralDb: number;
	/** Se resta al arranque detectado (ms). Se calibra; 0 = sin corrección. */
	desplazamientoMs: number;
	/** Largo de cada ventana de energía (ms). */
	ventanaMs: number;
	/** Salto entre ventanas (ms). */
	saltoMs: number;
	/** La búsqueda empieza tantos ms antes de la estimación… */
	antesMs: number;
	/** …y termina tantos ms después. */
	despuesMs: number;
	/** Tramo antes de la estimación donde se mide el piso de ruido (ms). */
	pisoMs: number;
	/** Percentil (0–1) de la energía en ese tramo que se toma como piso. */
	pisoPercentil: number;
	/** El piso nunca baja de aquí (silencio digital). */
	pisoMinimoDbfs: number;
	/** Medio ancho (ms) del tramo largo donde se mide el ruido de fondo. */
	fondoMs: number;
	/** Percentil (0–1) de la energía en ese tramo que se toma como ruido de fondo. Es más bajo que el del
	 * piso porque en habla corrida el 10 % más bajo de 10 s todavía es habla; el 2 % (200 ms) ya no. */
	fondoPercentil: number;
	/** Si el piso local queda más de tantos dB sobre el ruido de fondo, ahí no hubo pausa: no se ajusta. */
	pisoSobreFondoMaxDb: number;
	/** Duración mínima de un arranque (ms); lo más corto es un clic. */
	sostenidoMs: number;
	/** Huecos bajo el umbral de hasta tantos ms no cortan un tramo. */
	huecoMs: number;
	/** Baja energía mínima antes del arranque para considerarlo "tras pausa" (ms). */
	pausaPreviaMs: number;
	/** Corte del paso-alto (Hz); 0 lo apaga. */
	pasoAltoHz: number;
	/** Banda de voz (Hz); la banda alta va del tope de esta hasta Nyquist. */
	bandaVozHz: readonly [number, number];
	/** Primeros ms de un tramo que se miran para decidir si es respiración. */
	respiracionMs: number;
	/** Si la banda de voz no supera a la alta por al menos tantos dB, el tramo parece respiración. */
	respiracionVozSobreAltaDb: number;
	/** …y solo si la energía sobre 300 Hz pesa al menos esto (dB respecto del total con paso-alto). */
	respiracionPesoAgudoDb: number;
}

/**
 * Valores fijados a priori (por fonética y señales sintéticas, no por la compuerta), salvo umbralDb y
 * desplazamientoMs, que calibra pruebas/integracion/compuerta-energia.ts (estilo/calibracion-energia.json).
 */
export const OPCIONES_INICIO_VOZ: Readonly<OpcionesInicioVoz> = Object.freeze({
	umbralDb: 20,
	desplazamientoMs: 0,
	ventanaMs: 10,
	saltoMs: 1,
	antesMs: 300,
	despuesMs: 200,
	pisoMs: 500,
	pisoPercentil: 0.1,
	pisoMinimoDbfs: -90,
	fondoMs: 5000,
	fondoPercentil: 0.02,
	pisoSobreFondoMaxDb: 10,
	sostenidoMs: 30,
	huecoMs: 20,
	pausaPreviaMs: 150,
	pasoAltoHz: 80,
	bandaVozHz: [300, 3400] as const,
	respiracionMs: 50,
	respiracionVozSobreAltaDb: 10,
	respiracionPesoAgudoDb: -6,
});

/** Palabra de entrada: solo importa su inicio estimado (ms, línea de tiempo del audio completo). */
export interface PalabraConEstimacion {
	inicioMs: number | null;
}

export type MotivoInicio = 'tras-pausa' | 'en-medio-del-habla' | 'sin-arranque' | 'sin-estimacion';

export interface ResultadoInicio {
	/** Inicio final (ms): el arranque por energía − desplazamiento si se ajustó; si no, la estimación. */
	inicioMs: number | null;
	/** La estimación que entró. */
	estimacionMs: number | null;
	ajustada: boolean;
	motivo: MotivoInicio;
	/** Arranque por energía (ms, sin desplazamiento), aunque no se haya usado. null si no hubo. */
	arranqueMs: number | null;
	pisoDbfs: number | null;
	/** Ruido de fondo (percentil bajo en ±fondoMs) con el que se comprueba que hubo pausa. */
	fondoDbfs: number | null;
	umbralDbfs: number | null;
	/** Clics y respiraciones ignorados que tocan la ventana de búsqueda o la pausa previa a ella. */
	ignorados: {clics: number; respiraciones: number};
}

/** Energía y bandas de un WAV, listas para buscar arranques (se calcula una vez por WAV). */
export interface SenalInicioVoz {
	frecuencia: number;
	/** Muestras por ventana. */
	ventana: number;
	/** Muestras por salto. */
	salto: number;
	/** dBFS de la señal con paso-alto; la ventana k cubre las muestras [k·salto, k·salto + ventana). */
	energia: Float64Array;
	/** Ruido de fondo (dBFS) por segundo: percentil fondoPercentil de la energía en ±fondoMs. */
	fondo: Float64Array;
	/** Sumas acumuladas de x² (con paso-alto), banda de voz y banda alta: acum[i] = Σ x²[0..i). */
	acumTotal: Float64Array;
	acumVoz: Float64Array;
	acumAlta: Float64Array;
}

const PISO_DB = -120;
const Q_BUTTER4 = [0.5411961001461969, 1.3065629648763766] as const;

function invalida(porque: string): Error {
	return fallo('buscar el inicio de la voz', porque, 'revisa las opciones que le pasas a ajustarInicios()', 2);
}

function validar(o: OpcionesInicioVoz, frecuencia: number): void {
	const numeros: [keyof OpcionesInicioVoz, number][] = [
		['umbralDb', o.umbralDb],
		['desplazamientoMs', o.desplazamientoMs],
		['ventanaMs', o.ventanaMs],
		['saltoMs', o.saltoMs],
		['antesMs', o.antesMs],
		['despuesMs', o.despuesMs],
		['pisoMs', o.pisoMs],
		['pisoPercentil', o.pisoPercentil],
		['pisoMinimoDbfs', o.pisoMinimoDbfs],
		['fondoMs', o.fondoMs],
		['fondoPercentil', o.fondoPercentil],
		['pisoSobreFondoMaxDb', o.pisoSobreFondoMaxDb],
		['sostenidoMs', o.sostenidoMs],
		['huecoMs', o.huecoMs],
		['pausaPreviaMs', o.pausaPreviaMs],
		['pasoAltoHz', o.pasoAltoHz],
		['respiracionMs', o.respiracionMs],
		['respiracionVozSobreAltaDb', o.respiracionVozSobreAltaDb],
		['respiracionPesoAgudoDb', o.respiracionPesoAgudoDb],
	];
	for (const [nombre, valor] of numeros) {
		if (typeof valor !== 'number' || !Number.isFinite(valor)) throw invalida(`${nombre} no es un número finito`);
	}
	if (o.ventanaMs <= 0 || o.saltoMs <= 0 || o.fondoMs <= 0) throw invalida('ventanaMs, saltoMs y fondoMs tienen que ser positivos');
	if (o.pisoPercentil < 0 || o.pisoPercentil > 1 || o.fondoPercentil < 0 || o.fondoPercentil > 1) throw invalida('pisoPercentil y fondoPercentil van de 0 a 1');
	const [bajo, alto] = o.bandaVozHz;
	if (!(bajo > 0 && alto > bajo && alto < frecuencia / 2)) {
		throw invalida(`la banda de voz ${bajo}–${alto} Hz no cabe en un audio a ${frecuencia} Hz`);
	}
	if (o.pasoAltoHz < 0 || o.pasoAltoHz >= frecuencia / 2) throw invalida(`el paso-alto de ${o.pasoAltoHz} Hz no cabe en un audio a ${frecuencia} Hz`);
}

// ───────────────────────── filtros (biquads RBJ) ─────────────────────────

type Tipo = 'alto' | 'bajo';

/** Aplica un biquad Butterworth (paso-alto o paso-bajo) en sitio. */
function biquad(x: Float64Array, tipo: Tipo, corteHz: number, frecuencia: number, q: number): void {
	const w = (2 * Math.PI * corteHz) / frecuencia;
	const c = Math.cos(w);
	const alfa = Math.sin(w) / (2 * q);
	const a0 = 1 + alfa;
	const b0 = (tipo === 'alto' ? (1 + c) / 2 : (1 - c) / 2) / a0;
	const b1 = (tipo === 'alto' ? -(1 + c) : 1 - c) / a0;
	const b2 = b0;
	const a1 = (-2 * c) / a0;
	const a2 = (1 - alfa) / a0;
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	for (let i = 0; i < x.length; i++) {
		const entrada = x[i];
		const salida = b0 * entrada + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
		x2 = x1;
		x1 = entrada;
		y2 = y1;
		y1 = salida;
		x[i] = salida;
	}
}

/** Butterworth de 4.º orden (dos biquads en cascada), en sitio. */
function butterworth4(x: Float64Array, tipo: Tipo, corteHz: number, frecuencia: number): void {
	for (const q of Q_BUTTER4) biquad(x, tipo, corteHz, frecuencia, q);
}

function acumulada(x: Float64Array): Float64Array {
	const acum = new Float64Array(x.length + 1);
	for (let i = 0; i < x.length; i++) acum[i + 1] = acum[i] + x[i] * x[i];
	return acum;
}

function db(potenciaMedia: number): number {
	return potenciaMedia > 0 ? Math.max(PISO_DB, 10 * Math.log10(potenciaMedia)) : PISO_DB;
}

/** Percentil con interpolación lineal (q en 0–1). */
function percentil(valores: number[], q: number): number {
	const orden = [...valores].sort((a, b) => a - b);
	if (orden.length === 0) return Number.NaN;
	const pos = (orden.length - 1) * q;
	const bajo = Math.floor(pos);
	const alto = Math.min(bajo + 1, orden.length - 1);
	return orden[bajo] + (orden[alto] - orden[bajo]) * (pos - bajo);
}

const cache = new WeakMap<Wav, Map<string, SenalInicioVoz>>();

/** Filtra el WAV y calcula la energía por ventana. Se guarda en caché por WAV y parámetros de señal. */
export function analizarSenal(wav: Wav, opciones: Partial<OpcionesInicioVoz> = {}): SenalInicioVoz {
	const o = {...OPCIONES_INICIO_VOZ, ...opciones};
	validar(o, wav.frecuencia);
	const clave = [o.ventanaMs, o.saltoMs, o.pasoAltoHz, o.bandaVozHz[0], o.bandaVozHz[1], o.fondoMs, o.fondoPercentil, o.pisoMinimoDbfs].join('|');
	const delWav = cache.get(wav) ?? new Map<string, SenalInicioVoz>();
	const previa = delWav.get(clave);
	if (previa) return previa;

	const fs = wav.frecuencia;
	const base = Float64Array.from(wav.muestras, (v) => v / 32768);
	const total = base.slice();
	if (o.pasoAltoHz > 0) butterworth4(total, 'alto', o.pasoAltoHz, fs);
	const voz = base.slice();
	butterworth4(voz, 'alto', o.bandaVozHz[0], fs);
	butterworth4(voz, 'bajo', o.bandaVozHz[1], fs);
	const alta = base; // se reutiliza: ya no hace falta la señal original
	butterworth4(alta, 'alto', o.bandaVozHz[1], fs);

	const ventana = Math.max(1, Math.round((o.ventanaMs * fs) / 1000));
	const salto = Math.max(1, Math.round((o.saltoMs * fs) / 1000));
	const acumTotal = acumulada(total);
	const n = wav.muestras.length < ventana ? 0 : Math.floor((wav.muestras.length - ventana) / salto) + 1;
	const energia = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		const a = k * salto;
		energia[k] = db((acumTotal[a + ventana] - acumTotal[a]) / ventana);
	}
	// Ruido de fondo por segundo (con una ventana de cada 10 para que sea barato).
	const segundos = Math.ceil(wav.duracionS) + 1;
	const fondo = new Float64Array(segundos);
	const cada = Math.max(1, Math.round((0.01 * fs) / salto));
	for (let i = 0; i < segundos; i++) {
		const desde = Math.max(0, Math.round(((i - o.fondoMs / 1000) * fs - ventana) / salto));
		const hasta = Math.min(n - 1, Math.round(((i + o.fondoMs / 1000) * fs - ventana) / salto));
		const valores: number[] = [];
		for (let k = desde; k <= hasta; k += cada) valores.push(energia[k]);
		fondo[i] = valores.length > 0 ? Math.max(o.pisoMinimoDbfs, percentil(valores, o.fondoPercentil)) : o.pisoMinimoDbfs;
	}
	const senal: SenalInicioVoz = {frecuencia: fs, ventana, salto, energia, fondo, acumTotal, acumVoz: acumulada(voz), acumAlta: acumulada(alta)};
	delWav.set(clave, senal);
	cache.set(wav, delWav);
	return senal;
}

// ───────────────────────── búsqueda del arranque ─────────────────────────

interface TramoEnergia {
	/** Primera y última ventana sobre el umbral (índices). */
	k0: number;
	k1: number;
	clase: 'clic' | 'respiracion' | 'voz';
}

/** Herramientas de tiempo ↔ índice de ventana (el tiempo de una ventana es su final). */
function reloj(s: SenalInicioVoz) {
	const finMs = (k: number) => Math.round(((k * s.salto + s.ventana) / s.frecuencia) * 1e6) / 1000;
	/** Índice de la ventana que termina en ms (redondeado, recortado al rango). */
	const indice = (ms: number) => Math.min(s.energia.length - 1, Math.max(0, Math.round(((ms / 1000) * s.frecuencia - s.ventana) / s.salto)));
	return {finMs, indice};
}

function sumaEntre(acum: Float64Array, a: number, b: number): number {
	const i = Math.max(0, Math.min(acum.length - 1, a));
	const j = Math.max(0, Math.min(acum.length - 1, b));
	return j > i ? acum[j] - acum[i] : 0;
}

/** ¿El tramo parece respiración? (sin contar todavía si lo sigue otro tramo). */
function pareceRespiracion(s: SenalInicioVoz, t: {k0: number; k1: number}, o: OpcionesInicioVoz): boolean {
	const desde = t.k0 * s.salto;
	const hasta = Math.min(t.k1 * s.salto + s.ventana, t.k0 * s.salto + s.ventana + Math.round((o.respiracionMs * s.frecuencia) / 1000));
	const total = sumaEntre(s.acumTotal, desde, hasta);
	const voz = sumaEntre(s.acumVoz, desde, hasta);
	const alta = sumaEntre(s.acumAlta, desde, hasta);
	if (total <= 0 || alta <= 0) return false;
	const pesoAgudoDb = 10 * Math.log10(Math.max(voz + alta, 1e-30) / total);
	const vozSobreAltaDb = 10 * Math.log10(Math.max(voz, 1e-30) / alta);
	return pesoAgudoDb >= o.respiracionPesoAgudoDb && vozSobreAltaDb < o.respiracionVozSobreAltaDb;
}

export interface DeteccionArranque {
	arranqueMs: number | null;
	trasPausa: boolean;
	pisoDbfs: number | null;
	fondoDbfs: number | null;
	umbralDbfs: number | null;
	ignorados: {clics: number; respiraciones: number};
}

/**
 * Busca el arranque de la voz para una estimación (ms), dentro de [desdeMs, hastaMs] (ya recortados
 * por los vecinos). Devuelve el arranque sin desplazamiento y si va precedido de pausa.
 */
export function detectarArranque(s: SenalInicioVoz, estimacionMs: number, desdeMs: number, hastaMs: number, opciones: Partial<OpcionesInicioVoz> = {}): DeteccionArranque {
	const o = {...OPCIONES_INICIO_VOZ, ...opciones};
	const vacio: DeteccionArranque = {arranqueMs: null, trasPausa: false, pisoDbfs: null, fondoDbfs: null, umbralDbfs: null, ignorados: {clics: 0, respiraciones: 0}};
	if (s.energia.length === 0 || hastaMs < desdeMs) return vacio;
	const {finMs, indice} = reloj(s);
	const pasoMs = (s.salto / s.frecuencia) * 1000;

	// Piso de ruido local: percentil bajo de la energía antes de la estimación.
	const kPiso0 = indice(estimacionMs - o.pisoMs);
	const kPiso1 = indice(estimacionMs);
	const muestrasPiso: number[] = [];
	for (let k = kPiso0; k <= kPiso1; k++) muestrasPiso.push(s.energia[k]);
	if (muestrasPiso.length < 5) return vacio;
	const pisoDbfs = Math.max(o.pisoMinimoDbfs, percentil(muestrasPiso, o.pisoPercentil));
	const umbralDbfs = pisoDbfs + o.umbralDb;
	const fondoDbfs = s.fondo[Math.min(s.fondo.length - 1, Math.max(0, Math.round(estimacionMs / 1000)))];

	// Región a recorrer: la ventana de búsqueda, más la pausa previa por delante y lo que haga falta
	// por detrás para saber si el último tramo se sostiene.
	const kA = indice(desdeMs - o.pausaPreviaMs - o.huecoMs - o.sostenidoMs);
	const kB = indice(hastaMs + o.sostenidoMs + o.huecoMs);
	const huecoMax = Math.round(o.huecoMs / pasoMs);
	const tramos: TramoEnergia[] = [];
	let abierto: {k0: number; k1: number} | null = null;
	for (let k = kA; k <= kB; k++) {
		if (s.energia[k] < umbralDbfs) continue;
		if (abierto && k - abierto.k1 - 1 <= huecoMax) {
			abierto.k1 = k;
		} else {
			if (abierto) tramos.push({...abierto, clase: 'voz'});
			abierto = {k0: k, k1: k};
		}
	}
	if (abierto) tramos.push({...abierto, clase: 'voz'});

	// Clases: clic (no se sostiene) y respiración (parece respiración y la sigue otro tramo sostenido
	// que empieza dentro de la ventana). Un tramo que ya venía sonando al inicio de la región no se
	// sabe dónde empezó: cuenta como voz (así el final de la palabra anterior nunca pasa por pausa).
	const sostenido = (t: {k0: number; k1: number}) => finMs(t.k1) - finMs(t.k0) >= o.sostenidoMs;
	const truncado = (t: {k0: number}) => t.k0 === kA && kA > 0;
	for (const t of tramos) if (!truncado(t) && !sostenido(t)) t.clase = 'clic';
	for (let i = 0; i < tramos.length; i++) {
		const t = tramos[i];
		if (t.clase !== 'voz' || truncado(t) || !pareceRespiracion(s, t, o)) continue;
		const loSigue = tramos.slice(i + 1).some((u) => u.clase !== 'clic' && finMs(u.k0) <= hastaMs);
		if (loSigue) t.clase = 'respiracion';
	}

	const dentro = (t: TramoEnergia) => finMs(t.k0) >= desdeMs && finMs(t.k0) <= hastaMs;
	// Ignorados que pesaron en la decisión: los que tocan la ventana o la pausa previa a ella.
	const pesa = (t: TramoEnergia) => finMs(t.k1) >= desdeMs - o.pausaPreviaMs && finMs(t.k0) <= hastaMs;
	const ignorados = {
		clics: tramos.filter((t) => t.clase === 'clic' && pesa(t)).length,
		respiraciones: tramos.filter((t) => t.clase === 'respiracion' && pesa(t)).length,
	};
	const candidato = tramos.find((t) => t.clase === 'voz' && dentro(t));
	if (!candidato) return {arranqueMs: null, trasPausa: false, pisoDbfs, fondoDbfs, umbralDbfs, ignorados};

	// ¿Tras pausa? Nada de voz sostenida en los pausaPreviaMs anteriores (los clics y respiraciones
	// ignorados cuentan como pausa; el inicio del archivo también) y un piso local de pausa de verdad:
	// en medio del habla el "piso" es la energía de las consonantes, muy por encima del ruido de fondo.
	const arranqueMs = finMs(candidato.k0);
	const kPausa0 = indice(arranqueMs - o.pausaPreviaMs);
	const trasPausa =
		pisoDbfs <= fondoDbfs + o.pisoSobreFondoMaxDb &&
		!tramos.some((t) => t !== candidato && t.clase === 'voz' && t.k1 >= kPausa0 && t.k0 < candidato.k0);
	return {arranqueMs, trasPausa, pisoDbfs, fondoDbfs, umbralDbfs, ignorados};
}

/**
 * Ajusta el inicio de cada palabra que arranca tras una pausa (ver encabezado). Las palabras van en
 * orden de tiempo; su inicioMs es la estimación (p. ej. t_dtw×10 − k). Devuelve un resultado por
 * palabra, en el mismo orden. Las palabras en medio del habla conservan su estimación.
 */
export function ajustarInicios(wav: Wav, palabras: readonly PalabraConEstimacion[], opciones: Partial<OpcionesInicioVoz> = {}): ResultadoInicio[] {
	const o = {...OPCIONES_INICIO_VOZ, ...opciones};
	const s = analizarSenal(wav, o);
	const duracionMs = wav.duracionS * 1000;
	const resultados: ResultadoInicio[] = [];
	let anteriorMs = -Infinity;
	for (let j = 0; j < palabras.length; j++) {
		const est = palabras[j].inicioMs;
		if (est === null || !Number.isFinite(est)) {
			resultados.push({inicioMs: null, estimacionMs: null, ajustada: false, motivo: 'sin-estimacion', arranqueMs: null, pisoDbfs: null, fondoDbfs: null, umbralDbfs: null, ignorados: {clics: 0, respiraciones: 0}});
			continue;
		}
		let siguienteMs = Infinity;
		for (let i = j + 1; i < palabras.length; i++) {
			const sig = palabras[i].inicioMs;
			if (sig !== null && Number.isFinite(sig)) {
				if (sig > est) siguienteMs = sig;
				break;
			}
		}
		const desdeMs = Math.max(est - o.antesMs, anteriorMs + 1, 0);
		const hastaMs = Math.min(est + o.despuesMs, siguienteMs, duracionMs);
		const d = detectarArranque(s, est, desdeMs, hastaMs, o);
		// Tampoco es "tras pausa" si la palabra anterior empezó hace menos de pausaPreviaMs: ahí hay habla
		// aunque la energía haya quedado bajo el umbral (evita que dos palabras tomen el mismo arranque).
		const ajustada = d.arranqueMs !== null && d.trasPausa && d.arranqueMs - anteriorMs >= o.pausaPreviaMs;
		const inicioMs = ajustada ? Math.max(anteriorMs + 1, (d.arranqueMs as number) - o.desplazamientoMs) : est;
		resultados.push({
			inicioMs,
			estimacionMs: est,
			ajustada,
			motivo: ajustada ? 'tras-pausa' : d.arranqueMs === null ? 'sin-arranque' : 'en-medio-del-habla',
			arranqueMs: d.arranqueMs,
			pisoDbfs: d.pisoDbfs === null ? null : Math.round(d.pisoDbfs * 10) / 10,
			fondoDbfs: d.fondoDbfs === null ? null : Math.round(d.fondoDbfs * 10) / 10,
			umbralDbfs: d.umbralDbfs === null ? null : Math.round(d.umbralDbfs * 10) / 10,
			ignorados: d.ignorados,
		});
		anteriorMs = Math.max(anteriorMs, inicioMs);
	}
	return resultados;
}
