/**
 * Parser de la salida `-ojf` (JSON completo) de whisper-cli 1.8.4 → palabras con tiempos.
 *
 * Por qué se lee como BYTES: en la 1.8.4, `-ojf` puede partir un carácter UTF-8 entre dos tokens
 * (p. ej. la "ñ" = C3 B1 queda C3 al final de un token y B1 al inicio del siguiente). Si el archivo
 * se decodifica como UTF-8 de entrada, cada mitad se vuelve "�" y la letra se pierde. Aquí el archivo
 * se decodifica como latin1 (1 byte = 1 carácter, sin pérdida), se juntan los bytes de los tokens de
 * cada palabra y solo entonces se decodifica a UTF-8.
 *
 * Cómo se arman las palabras:
 * - Un token que empieza con espacio abre palabra nueva; los demás se pegan a la palabra en curso.
 * - Un token que empieza con un byte de continuación UTF-8 (10xxxxxx) siempre se pega, aunque venga
 *   en el segmento siguiente: es la otra mitad de un carácter partido.
 * - Se ignoran los tokens especiales: [_BEG_], [_TT_*], [_SOT_], [_EOT_]… y <|…|>.
 * - Una "palabra" que solo trae puntuación (" ...", " -") se pega a la vecina: la de apertura
 *   (¿ ¡ « “ ( [) a la siguiente y el resto a la anterior.
 *
 * Tiempos por palabra (todo en ms y ya con el desplazamiento del tramo sumado):
 * - inicioOffsetsMs: offsets.from del primer token con letras o números (así "¿Cómo" no arranca
 *   en el "¿", que no suena).
 * - inicioDtwMs: t_dtw × 10 de ese mismo token (t_dtw viene en centésimas de segundo; −1 = sin dato).
 * - finMs: offsets.to del último token de la palabra.
 * - p: probabilidad media de sus tokens.
 */
import {fallo} from './fallo';

export interface PalabraWhisper {
	/** Texto ya decodificado en UTF-8, sin espacios a los lados (puede traer puntuación pegada). */
	texto: string;
	/** Inicio por el método `offsets` (ms, línea de tiempo del audio completo). */
	inicioOffsetsMs: number | null;
	/** Inicio por el método `t_dtw` (ms, línea de tiempo del audio completo), sin corrección k. */
	inicioDtwMs: number | null;
	/** Fin: offsets.to del último token (ms, línea de tiempo del audio completo). */
	finMs: number | null;
	/** Probabilidad media de los tokens de la palabra (0–1). */
	p: number;
	/** Índice del segmento de whisper donde empieza la palabra. */
	segmento: number;
	/** Cuántos tokens de texto la forman. */
	tokens: number;
}

export interface OpcionesParseo {
	/** Inicio del tramo dentro del audio completo, en segundos. Se suma a todos los tiempos. */
	desplazamientoS: number;
}

interface TokenCrudo {
	text?: unknown;
	offsets?: {from?: unknown; to?: unknown};
	p?: unknown;
	t_dtw?: unknown;
}

interface TokenUtil {
	bytes: Uint8Array;
	desdeMs: number | null;
	hastaMs: number | null;
	dtwMs: number | null;
	p: number | null;
}

interface PalabraEnArmado {
	tokens: TokenUtil[];
	/** Segmento donde empieza la palabra. */
	segmento: number;
	/** Segmento del último token que se le pegó (una mitad de carácter puede venir del siguiente). */
	ultimoSegmento: number;
}

const ESPACIO = 0x20;
const APERTURA = /^[¿¡«“‘"'(\[{]+$/u;
const CONTENIDO = /[\p{L}\p{N}]/u;

/** Tokens especiales de whisper.cpp: [_BEG_], [_TT_123], [_SOT_], [_EOT_], [_LANG_es]… y <|…|>. */
export function esTokenEspecial(texto: string): boolean {
	return /^\[_.*\]$/s.test(texto) || /^<\|.*\|>$/s.test(texto);
}

/**
 * Deja el JSON crudo (leído como latin1) listo para JSON.parse sin perder bytes:
 * - Dentro de strings, un carácter de control suelto (<0x20) se escapa como \u00XX (whisper.cpp
 *   solo escapa comillas y barras invertidas).
 * - Un escape \uXXXX ≥ 0x80 (por si una versión futura los usa) se convierte a sus bytes UTF-8,
 *   para que después de parsear cada carácter ≤ 0xFF sea exactamente un byte.
 */
export function normalizarJsonCrudo(crudo: string): string {
	let salida = '';
	let enString = false;
	for (let i = 0; i < crudo.length; i++) {
		const c = crudo[i];
		const codigo = crudo.charCodeAt(i);
		if (!enString) {
			if (c === '"') enString = true;
			salida += c;
			continue;
		}
		if (c === '"') {
			enString = false;
			salida += c;
			continue;
		}
		if (c === '\\') {
			const sig = crudo[i + 1];
			if (sig === 'u' && /^[0-9a-fA-F]{4}$/.test(crudo.slice(i + 2, i + 6))) {
				let punto = parseInt(crudo.slice(i + 2, i + 6), 16);
				let largo = 6;
				// Par sustituto 😀 → un solo punto de código.
				if (punto >= 0xd800 && punto <= 0xdbff && crudo.slice(i + 6, i + 8) === '\\u') {
					const bajo = parseInt(crudo.slice(i + 8, i + 12), 16);
					if (bajo >= 0xdc00 && bajo <= 0xdfff) {
						punto = 0x10000 + ((punto - 0xd800) << 10) + (bajo - 0xdc00);
						largo = 12;
					}
				}
				if (punto < 0x80) {
					salida += crudo.slice(i, i + largo);
				} else {
					salida += Buffer.from(String.fromCodePoint(punto), 'utf8').toString('latin1');
				}
				i += largo - 1;
				continue;
			}
			// Cualquier otro escape (\" \\ \/ \n…) pasa tal cual, con su carácter siguiente.
			salida += c + (sig ?? '');
			i += 1;
			continue;
		}
		if (codigo < 0x20) {
			salida += `\\u${codigo.toString(16).padStart(4, '0')}`;
			continue;
		}
		salida += c;
	}
	return salida;
}

function numeroOnull(valor: unknown): number | null {
	return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

function redondear(ms: number): number {
	return Math.round(ms * 1000) / 1000;
}

/** Arma el texto de una palabra y dice qué tokens traen letras o números. */
function decodificar(tokens: TokenUtil[]): {texto: string; conContenido: boolean[]} {
	const decodificador = new TextDecoder('utf-8');
	const conContenido: boolean[] = [];
	let texto = '';
	for (const token of tokens) {
		const parte = decodificador.decode(token.bytes, {stream: true});
		conContenido.push(CONTENIDO.test(parte));
		texto += parte;
	}
	texto += decodificador.decode();
	return {texto, conContenido};
}

/**
 * Convierte el JSON de `whisper-cli -ojf` (como Buffer, sin decodificar) en palabras con tiempos.
 * Lanza un FalloEditor (código 1) si el archivo no tiene la forma esperada.
 */
export function parsearWhisperJson(buffer: Uint8Array, opciones: OpcionesParseo): PalabraWhisper[] {
	const desplazamientoMs = opciones.desplazamientoS * 1000;
	const crudo = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('latin1');

	let datos: unknown;
	try {
		datos = JSON.parse(normalizarJsonCrudo(crudo));
	} catch (error) {
		throw fallo(
			'leer la transcripción de whisper',
			'el JSON de -ojf no se pudo parsear',
			'revisa el log del tramo en proyectos/<slug>/tramos/ y vuelve a correr transcribir.ts',
			1,
			{error: String(error)},
		);
	}

	const segmentos = (datos as {transcription?: unknown})?.transcription;
	if (!Array.isArray(segmentos)) {
		throw fallo(
			'leer la transcripción de whisper',
			'el JSON no trae la lista "transcription"',
			'confirma que whisper-cli corrió con -ojf y vuelve a correr transcribir.ts',
			1,
		);
	}

	const enArmado: PalabraEnArmado[] = [];
	segmentos.forEach((segmento, iSegmento) => {
		const tokens = (segmento as {tokens?: unknown})?.tokens;
		if (!Array.isArray(tokens)) return;
		for (const token of tokens as TokenCrudo[]) {
			if (typeof token?.text !== 'string') continue;
			const texto = token.text;
			if (texto.length === 0 || esTokenEspecial(texto)) continue;

			const desde = numeroOnull(token.offsets?.from);
			const hasta = numeroOnull(token.offsets?.to);
			const dtw = numeroOnull(token.t_dtw);
			const util: TokenUtil = {
				bytes: Uint8Array.from(Buffer.from(texto, 'latin1')),
				desdeMs: desde === null ? null : desde + desplazamientoMs,
				hastaMs: hasta === null ? null : hasta + desplazamientoMs,
				// t_dtw viene en centésimas de segundo; −1 significa "sin dato".
				dtwMs: dtw === null || dtw < 0 ? null : dtw * 10 + desplazamientoMs,
				p: numeroOnull(token.p),
			};

			const primerByte = util.bytes[0];
			const esContinuacion = (primerByte & 0xc0) === 0x80;
			const abrePalabra = primerByte === ESPACIO;
			const actual = enArmado.at(-1);
			// Dentro de un segmento, sin espacio = sigue la palabra. Entre segmentos solo se pega
			// la otra mitad de un carácter partido.
			const pegar =
				actual !== undefined &&
				(esContinuacion || (!abrePalabra && actual.ultimoSegmento === iSegmento));
			if (pegar) {
				actual.tokens.push(util);
				actual.ultimoSegmento = iSegmento;
			} else {
				enArmado.push({tokens: [util], segmento: iSegmento, ultimoSegmento: iSegmento});
			}
		}
	});

	// Decodifica cada palabra y calcula sus tiempos.
	type PalabraTemp = PalabraWhisper & {soloPuntuacion: boolean};
	const temporales: PalabraTemp[] = [];
	for (const palabra of enArmado) {
		const {texto: conEspacios, conContenido} = decodificar(palabra.tokens);
		const texto = conEspacios.trim();
		if (texto.length === 0) continue;

		const iContenido = conContenido.indexOf(true);
		const tokenInicio = palabra.tokens[iContenido >= 0 ? iContenido : 0];
		const inicioOffsets =
			tokenInicio.desdeMs ?? palabra.tokens.find((t) => t.desdeMs !== null)?.desdeMs ?? null;
		const inicioDtw =
			tokenInicio.dtwMs ?? palabra.tokens.find((t) => t.dtwMs !== null)?.dtwMs ?? null;
		const conFin = palabra.tokens.filter((t) => t.hastaMs !== null);
		const fin = conFin.length > 0 ? conFin[conFin.length - 1].hastaMs : null;
		const probabilidades = palabra.tokens.map((t) => t.p).filter((p): p is number => p !== null);
		const p =
			probabilidades.length > 0
				? probabilidades.reduce((a, b) => a + b, 0) / probabilidades.length
				: 0;

		temporales.push({
			texto,
			inicioOffsetsMs: inicioOffsets === null ? null : redondear(inicioOffsets),
			inicioDtwMs: inicioDtw === null ? null : redondear(inicioDtw),
			finMs: fin === null ? null : redondear(fin),
			p: Math.round(p * 1e6) / 1e6,
			segmento: palabra.segmento,
			tokens: palabra.tokens.length,
			soloPuntuacion: iContenido < 0,
		});
	}

	// Las "palabras" que son solo puntuación se pegan a su vecina y no cuentan como palabra.
	const resultado: PalabraWhisper[] = [];
	let aperturaPendiente = '';
	for (const palabra of temporales) {
		const {soloPuntuacion, ...limpia} = palabra;
		if (!soloPuntuacion) {
			resultado.push({...limpia, texto: aperturaPendiente + limpia.texto});
			aperturaPendiente = '';
			continue;
		}
		const anterior = resultado.at(-1);
		if (APERTURA.test(palabra.texto) || anterior === undefined) {
			aperturaPendiente += palabra.texto;
		} else {
			anterior.texto += palabra.texto;
		}
	}
	if (aperturaPendiente && resultado.length > 0) resultado[resultado.length - 1].texto += aperturaPendiente;

	return resultado;
}
