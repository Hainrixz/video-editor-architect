/**
 * cortes.ts — Etapa 4 de /editar: cortes de silencios y tomas repetidas, con tu revisión del texto.
 *
 *   npx tsx herramientas/cortes.ts <slug>                              → propuesta automática
 *   npx tsx herramientas/cortes.ts <slug> --aplicar-texto <archivo>     → manda el texto que aprobaste
 *   … [--sin-calibracion]                                              → ignora estilo/calibracion-cortes.json
 *   … [--velocidad F]                                                  → fuerza la velocidad de la base (1 = sin acelerar)
 *
 * Lee proyectos/<slug>/transcripcion.json y audio16k.wav. Escribe en proyectos/<slug>/:
 * - cortes.json: {"keep": [{"desde", "hasta"}, …], "velocidad", "metodo", "parametros", …}. keep[] va en segundos
 *   del ORIGINAL, en cuadros exactos de 30 fps, en orden y con al menos un cuadro de corte entre tramos. Lo lee
 *   base.ts, que acelera la base con esa misma "velocidad".
 * - texto-propuesto.md (propuesta): el guion que quedaría, con las frases descartadas aparte y su motivo, para
 *   que lo apruebes. Con --aplicar-texto se escribe texto-aprobado.txt (tu guion tal cual se aplicó).
 * - transcripcion-base.json: las palabras que quedan, con sus tiempos en la línea de tiempo de la base YA
 *   ACELERADA (lib/remapear.ts con la velocidad F: inicio del tramo en la base + (t − desde del tramo) / F), su
 *   índice original `i` (posición en transcripcion.json → palabras[]), su posición `j` en la base y el índice
 *   `tramo` de keep[] del que salen (un subtítulo nunca debe juntar dos tramos). Lleva "velocidad" y
 *   "duracion_base_s" (= suma de keep[] / F): subtítulos, director, layout y sincronía la leen sin cambios.
 *
 * Velocidad F de la base (tú aceleras tus reels; medido en tus 4 pares: ×1.05, ×1.09, ×1.10 y ×1.15): por defecto
 * la mediana de estilo/calibracion-cortes.json → velocidad.mediana, si existe y está marcada "consistente"; si no,
 * ×1. --velocidad F la fuerza (de 0.5 a 2) y --velocidad 1 la apaga. --sin-calibracion también deja ×1. La velocidad
 * se decide AQUÍ (y no en base.ts) porque los tiempos de transcripcion-base.json dependen de ella.
 *
 * Cómo se arma keep[]:
 * 1. Bordes de cada palabra con la energía (lib/energia.ts, RMS en ventanas de 10 ms cada 1 ms): whisper alarga el
 *    final de las palabras sobre el silencio, así que se recorta el silencio de sus orillas. Umbral de voz = piso
 *    local (percentil 2 en ±5 s) + 12 dB, sin pasar de la mediana de la voz − 18 dB.
 * 2. Tomas repetidas y arranques en falso (lib/tomas.ts) → frases descartadas. Con --aplicar-texto manda tu texto.
 * 3. Se quitan las palabras descartadas y los huecos de más de 0.3 s entre palabras que se quedan, dejando un pad
 *    de 80 ms antes de cada palabra y 120 ms después. Un hueco solo se corta donde la energía TAMBIÉN dice silencio:
 *    whisper a veces deja voz sin palabras (cuando alucina o se desfasa) y esa voz nunca se corta a media pausa.
 * 4. Cada borde va al valle de energía más cercano (±80 ms), evaluado en los bordes de cuadro de 30 fps (RMS de
 *    20 ms centrado en el borde): entre los cuadros a ≤ 3 dB del más silencioso, el más cercano al objetivo.
 *    Nunca entra en una palabra; se deja una guarda de 30 ms (el fundido de 15 ms de base.ts va dentro del tramo).
 *    Si dos palabras están pegadas (sin silencio) y hay que separarlas, el corte va al valle entre las dos y se
 *    anota como "juntura" con cuánto se movió el borde de cada palabra.
 *    Un corte de silencio de menos de 0.1 s no se hace (sería un salto de imagen para nada).
 * 5. Verificación: ningún borde dentro de una palabra, cada palabra que se queda entera dentro de un solo tramo y
 *    ninguna descartada dentro de un tramo. Si algo no cuadra, sale con 1: es un error de este paso.
 *
 * Con --aplicar-texto, tu texto (un .txt, o el texto-propuesto.md editado: se lee solo la sección "## Guion") se
 * alinea contra TODAS las palabras del audio, también las descartadas (así puedes recuperar una frase), y prefiere
 * las de la propuesta. Se compara sin mayúsculas, acentos ni puntuación, y acepta la palabra corregida o la que
 * escribió whisper (t_whisper). Si pusiste palabras que no están en el audio o cambiaste el orden, sale con 2 y te
 * dice cuáles. El texto de transcripcion-base.json queda igual al tuyo, palabra por palabra.
 *
 * Parámetros calibrados: si existe estilo/calibracion-cortes.json (lo escribe herramientas/estilo/calibrar-cortes.ts
 * con lo que hiciste en tus pares crudo ↔ publicado), sus `parametros` (huecoMinimoS, padAntesS, padDespuesS y la
 * regla de tomas) se aplican encima de PARAMETROS_CORTES. Si no existe, todo queda con los valores por defecto. El
 * archivo se busca junto a la carpeta de proyectos (<raíz>/estilo/), así un proyecto de prueba en otra carpeta no lo
 * hereda. Con --sin-calibracion se usan los valores por defecto aunque el archivo exista.
 *
 * Todo es local y determinista: no usa red, llaves ni GPU (corre dentro del sandbox).
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {energiaEnIntervalo, energiaPorVentana, leerWav, mediana, type Wav} from './lib/energia.ts';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {DIR_PROYECTOS, RAIZ, dirProyecto, hashearArchivo, leerManifest, registrarEtapa, validarSlug, type ArchivoHash} from './lib/manifest.ts';
import {leerPerfilMotor} from './lib/perfil-estilo.ts';
import {duracionBase, esVelocidadValida, FPS, remapearIntervalo, validarKeep, VELOCIDAD_MAX, VELOCIDAD_MIN, type Tramo} from './lib/remapear.ts';
import {detectarTomas, normalizarPalabra, OPCIONES_TOMAS, type Frase} from './lib/tomas.ts';

const USO = 'npx tsx herramientas/cortes.ts <slug> [--aplicar-texto <archivo>] [--sin-calibracion] [--velocidad F] [--hueco-minimo S]';

export const ARCHIVOS = {
	transcripcion: 'transcripcion.json',
	audio: 'audio16k.wav',
	cortes: 'cortes.json',
	textoPropuesto: 'texto-propuesto.md',
	textoAprobado: 'texto-aprobado.txt',
	transcripcionBase: 'transcripcion-base.json',
} as const;

/** Parámetros de la etapa (van completos a cortes.json y al manifest). */
export const PARAMETROS_CORTES = Object.freeze({
	version: 1,
	fps: FPS,
	/** Se corta un hueco entre dos palabras que se quedan si dura más que esto (s). */
	huecoMinimoS: 0.3,
	/** Silencio que se deja antes del inicio de una palabra (s). */
	padAntesS: 0.08,
	/** Silencio que se deja después del final de una palabra (s). */
	padDespuesS: 0.12,
	/** Hasta dónde se busca el valle de energía alrededor del objetivo (s). */
	radioValleS: 0.08,
	/** Ventana del RMS con que se mide cada borde de cuadro candidato (s). */
	ventanaValleS: 0.02,
	/** Un cuadro es "valle" si su energía queda a ≤ esto (dB) del más silencioso de la búsqueda. */
	toleranciaValleDb: 3,
	/** Distancia mínima entre un borde y una palabra que se queda (s). */
	guardiaS: 0.03,
	/** Distancia mínima entre un borde y una palabra que se quita (s). */
	guardiaDescartadaS: 0.01,
	/** Un corte de silencio más corto que esto (s) no se hace. */
	corteMinimoS: 0.1,
	/**
	 * Un tramo que se queda SIN palabras (voz que whisper no transcribió, suelta entre dos cortes) y dura menos que
	 * esto (s) se quita: en pantalla se ve como un cuadro muerto. 0 = se quedan todos (estilo/aires.json lo enciende).
	 */
	quitarSueltosS: 0 as number,
	energia: Object.freeze({
		ventanaS: 0.01,
		saltoS: 0.001,
		/** Piso de ruido local: este percentil de la energía en ±pisoRadioS. */
		pisoPercentil: 0.02,
		pisoRadioS: 5,
		pisoMinimoDbfs: -90,
		/** Para medir el nivel de la voz solo cuentan las ventanas de las palabras a más de esto (dB) sobre el piso. */
		vozSobrePisoDb: 6,
		/** Umbral de voz = piso + esto (dB)… */
		umbralSobrePisoDb: 12,
		/** …sin pasar de la mediana de la voz − esto (dB). */
		umbralBajoVozDb: 18,
		/** Voz = racha sobre el umbral (huecos de hasta huecoVozS no la cortan) de al menos vozMinimaS… */
		huecoVozS: 0.02,
		vozMinimaS: 0.06,
		/** …que llega a la mediana de la voz − esto (dB). Lo demás (clics, respiraciones suaves) es silencio. */
		vozBajoMedianaDb: 12,
	}),
	tomas: OPCIONES_TOMAS,
	/**
	 * Voz ajena en la orilla de una palabra (ver refinarPalabras): whisper a veces estira el final de una palabra hasta el
	 * arranque de la siguiente (o la empieza en la cola de la anterior). Una racha de la orilla es de la palabra vecina si
	 * hay otra racha dentro de la palabra, las separa una pausa de al menos huecoS, la de la orilla dura dentro de la
	 * palabra a lo más maxS y sigue al menos fueraS del otro lado del borde de whisper.
	 */
	orillaAjena: Object.freeze({huecoS: 0.15, maxS: 0.25, fueraS: 0.05}),
});
/** Los números de PARAMETROS_CORTES como `number` (Object.freeze los deja como literales: 0.3, 0.08…). */
type Ensanchar<T> = T extends number ? number : T extends object ? {readonly [K in keyof T]: Ensanchar<T[K]>} : T;
export type ParametrosCortes = Ensanchar<typeof PARAMETROS_CORTES>;

// ───────────────────────── calibración con tus reels ─────────────────────────

/** Nombre del archivo de calibración dentro de estilo/ (lo escribe herramientas/estilo/calibrar-cortes.ts). */
export const ARCHIVO_CALIBRACION_CORTES = 'calibracion-cortes.json';

const segundosCalibrados = (min: number, max: number) => z.number().min(min).max(max);

/**
 * Lo que cortes.ts lee de estilo/calibracion-cortes.json: solo `parametros` (lo demás es el informe de cómo se
 * calibró). Cada valor tiene un rango sano; uno fuera de rango o con otro tipo hace fallar la lectura con código 2.
 */
export const CalibracionCortesEsquema = z.looseObject({
	version: z.literal(1),
	parametros: z.strictObject({
		huecoMinimoS: segundosCalibrados(0.05, 3).optional(),
		padAntesS: segundosCalibrados(0, 0.5).optional(),
		padDespuesS: segundosCalibrados(0, 0.5).optional(),
		tomas: z
			.strictObject({
				pausaFraseS: segundosCalibrados(0.1, 3).optional(),
				cercaniaS: segundosCalibrados(1, 120).optional(),
				similitudMinima: z.number().min(0.3).max(1).optional(),
				comunesMinimas: z.number().int().min(1).max(10).optional(),
				arranquePalabras: z.number().int().min(1).max(10).optional(),
				arranqueMinimo: z.number().int().min(1).max(10).optional(),
				arranquePosteriorMinimo: z.number().int().min(1).max(10).optional(),
				arranqueProporcionMinima: z.number().min(0).max(1).optional(),
				falsoArranqueMax: z.number().int().min(0).max(10).optional(),
				falsoArranqueDesfase: z.number().int().min(0).max(5).optional(),
			})
			.optional(),
	}),
});

export interface CalibracionCortes {
	/** PARAMETROS_CORTES con lo calibrado encima. */
	parametros: ParametrosCortes;
	/** Ruta del archivo leído y su sha256 (van a cortes.json y al manifest). */
	archivo: string;
	sha256: string;
	/** Qué valores cambió respecto a los de por defecto (para el resumen). */
	cambios: string[];
	/** La velocidad medida en tus pares (sección "velocidad"); null si el archivo no la trae o no tiene la forma esperada. */
	velocidad: VelocidadCalibrada | null;
}

/** Lo que cortes.ts usa de la sección "velocidad" de calibracion-cortes.json (la escribe calibrar-cortes.ts). */
export const VelocidadCalibradaEsquema = z.looseObject({
	mediana: z.number().nullable(),
	consistente: z.boolean(),
	n_pares: z.number().int().nonnegative().optional(),
	n_tramos: z.number().int().nonnegative().optional(),
	min: z.number().nullable().optional(),
	max: z.number().nullable().optional(),
});
export type VelocidadCalibrada = z.infer<typeof VelocidadCalibradaEsquema>;

/** Velocidad de la base que decide esta etapa (va a cortes.json, a transcripcion-base.json y de ahí a base.ts). */
export interface VelocidadCortes {
	/** F: la base dura la suma de keep[] / F (1 = sin acelerar). */
	factor: number;
	/** De dónde salió, en una frase (con su n si es medida). */
	fuente: string;
}

/** Tu velocidad fija (estilo/velocidad.json): una decisión tuya, no una medida; manda sobre la mediana de tus pares. */
export const ARCHIVO_VELOCIDAD_PREFERIDA = 'velocidad.json';
export const VelocidadPreferidaEsquema = z.looseObject({factor: z.number(), decision: z.string().min(1)});
export type VelocidadPreferida = {archivo: string; factor: number; decision: string};

/** <carpeta de proyectos>/../estilo/velocidad.json. */
export const rutaVelocidadPreferida = (proyectos: string = DIR_PROYECTOS): string => join(dirname(resolve(proyectos)), 'estilo', ARCHIVO_VELOCIDAD_PREFERIDA);

/** Lee tu velocidad fija; null si no existe. Si existe pero está mal (o fuera de 0.5–2), sale con código 2. */
export function leerVelocidadPreferida(ruta: string = rutaVelocidadPreferida()): VelocidadPreferida | null {
	if (!existsSync(ruta)) return null;
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		throw fallo('leer tu velocidad fija', `${relativa(ruta)} no es JSON válido`, 'corrígelo o bórralo para volver a la mediana medida', 2);
	}
	const r = VelocidadPreferidaEsquema.safeParse(datos);
	if (!r.success || !esVelocidadValida(r.data.factor)) {
		throw fallo('leer tu velocidad fija', `${relativa(ruta)} necesita {"factor": ${VELOCIDAD_MIN}–${VELOCIDAD_MAX}, "decision": "…"}`, 'corrígelo o bórralo para volver a la mediana medida', 2);
	}
	return {archivo: ruta, factor: r.data.factor, decision: r.data.decision};
}

/**
 * Tus aires (estilo/aires.json): una decisión tuya, no una medida. Toda pausa entre palabras de más de
 * `hueco_minimo_s` se corta (deja solo el pad de cada orilla); manda sobre la calibración, y --hueco-minimo sobre él.
 */
export const ARCHIVO_AIRES = 'aires.json';
export const AIRES_MIN_S = 0.1;
export const AIRES_MAX_S = 1;
export const AiresEsquema = z.looseObject({
	hueco_minimo_s: z.number(),
	/** Opcional: umbral de voz sobre el piso de ruido (dB). Más alto = la cola suave de cada palabra cuenta como aire. */
	umbral_sobre_piso_db: z.number().min(6).max(30).optional(),
	/** Opcional: tramos sin palabras más cortos que esto (s) se quitan (cuadros muertos). */
	quitar_sueltos_s: z.number().min(0).max(2).optional(),
	decision: z.string().min(1),
});
export type AiresPreferidos = {archivo: string; huecoMinimoS: number; umbralSobrePisoDb?: number; quitarSueltosS?: number; decision: string};
const esAireValido = (s: number) => Number.isFinite(s) && s >= AIRES_MIN_S && s <= AIRES_MAX_S;

/** <carpeta de proyectos>/../estilo/aires.json. */
export const rutaAires = (proyectos: string = DIR_PROYECTOS): string => join(dirname(resolve(proyectos)), 'estilo', ARCHIVO_AIRES);

/** Lee tus aires; null si no existe. Si existe pero está mal (o fuera de 0.1–1 s), sale con código 2. */
export function leerAires(ruta: string = rutaAires()): AiresPreferidos | null {
	if (!existsSync(ruta)) return null;
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		throw fallo('leer tus aires', `${relativa(ruta)} no es JSON válido`, 'corrígelo o bórralo para volver a la calibración', 2);
	}
	const r = AiresEsquema.safeParse(datos);
	if (!r.success || !esAireValido(r.data.hueco_minimo_s)) {
		throw fallo('leer tus aires', `${relativa(ruta)} necesita {"hueco_minimo_s": ${AIRES_MIN_S}–${AIRES_MAX_S}, "decision": "…"}`, 'corrígelo o bórralo para volver a la calibración', 2);
	}
	return {
		archivo: ruta,
		huecoMinimoS: r.data.hueco_minimo_s,
		...(r.data.umbral_sobre_piso_db !== undefined ? {umbralSobrePisoDb: r.data.umbral_sobre_piso_db} : {}),
		...(r.data.quitar_sueltos_s !== undefined ? {quitarSueltosS: r.data.quitar_sueltos_s} : {}),
		decision: r.data.decision,
	};
}

/**
 * Velocidad y aires que decide el estilo, en este orden: perfil del estilo activo (perfil.json → motor.velocidad y
 * motor.aires, si el perfil los trae) → sus archivos de respaldo (estilo/velocidad.json y estilo/aires.json) → null
 * (la calibración y, sin ella, los valores por defecto: ×1 y PARAMETROS_CORTES, que son los de MOTOR_NEUTRO).
 * La raíz es la carpeta de arriba de `proyectos` (ahí viven creador.json y estilo/).
 */
export function preferenciasDeCortes(proyectos: string = DIR_PROYECTOS): {velocidad: VelocidadPreferida | null; aires: AiresPreferidos | null} {
	const raiz = dirname(resolve(proyectos));
	const motor = leerPerfilMotor({raiz});
	const archivo = motor.origen.archivo ? join(raiz, motor.origen.archivo) : null;
	const delPerfil = (clave: 'velocidad' | 'aires'): boolean => archivo !== null && motor.origen.claves.includes(clave) && motor[clave] !== null;
	const velocidad: VelocidadPreferida | null =
		delPerfil('velocidad') && motor.velocidad
			? {archivo: archivo!, factor: motor.velocidad.factor, decision: `motor.velocidad: ${motor.velocidad.decision}`}
			: leerVelocidadPreferida(rutaVelocidadPreferida(proyectos));
	const aires: AiresPreferidos | null =
		delPerfil('aires') && motor.aires
			? {
					archivo: archivo!,
					huecoMinimoS: motor.aires.hueco_minimo_s,
					...(motor.aires.umbral_sobre_piso_db !== undefined ? {umbralSobrePisoDb: motor.aires.umbral_sobre_piso_db} : {}),
					...(motor.aires.quitar_sueltos_s !== undefined ? {quitarSueltosS: motor.aires.quitar_sueltos_s} : {}),
					decision: `motor.aires: ${motor.aires.decision}`,
				}
			: leerAires(rutaAires(proyectos));
	return {velocidad, aires};
}

/** --hueco-minimo S → segundos de 0.1 a 1 (código 2 si no lo es). */
export function huecoMinimoDeTexto(valor: string): number {
	const n = Number(valor);
	if (valor.trim() === '' || !esAireValido(n)) {
		throw fallo('leer los argumentos', `--hueco-minimo tiene que ser un número de ${AIRES_MIN_S} a ${AIRES_MAX_S} s (me llegó "${valor}")`, `usa ${USO}`, 2);
	}
	return n;
}

/**
 * Velocidad de la base (pura): --velocidad F si la pides; si no, tu velocidad fija (estilo/velocidad.json) si la hay;
 * si no, la mediana de tus pares si calibracion-cortes.json la trae marcada "consistente" y en rango; si no, ×1.
 * Una --velocidad fuera de 0.5–2 sale con código 2.
 */
export function resolverVelocidadCortes(
	pedida: number | undefined,
	calibracion: Pick<CalibracionCortes, 'archivo' | 'velocidad'> | null,
	preferida: VelocidadPreferida | null = null,
): VelocidadCortes {
	if (pedida !== undefined) {
		if (!esVelocidadValida(pedida)) {
			throw fallo('leer los argumentos', `--velocidad tiene que ser un número de ${VELOCIDAD_MIN} a ${VELOCIDAD_MAX} (me llegó ${String(pedida)})`, `usa ${USO}`, 2);
		}
		return {factor: pedida, fuente: pedida === 1 ? '--velocidad 1 (sin acelerar)' : '--velocidad'};
	}
	if (preferida) return {factor: preferida.factor, fuente: `${relativa(preferida.archivo)} (${preferida.decision})`};
	if (!calibracion) return {factor: 1, fuente: 'sin calibración de tus reels (o --sin-calibracion): ×1'};
	const v = calibracion.velocidad;
	const archivo = relativa(calibracion.archivo);
	if (!v) return {factor: 1, fuente: `${archivo} no trae la velocidad medida: ×1`};
	if (!v.consistente) return {factor: 1, fuente: `${archivo}: la velocidad no está marcada consistente en tus pares: ×1`};
	if (!esVelocidadValida(v.mediana)) return {factor: 1, fuente: `${archivo}: la mediana de la velocidad (${String(v.mediana)}) no sirve (fuera de ${VELOCIDAD_MIN}–${VELOCIDAD_MAX}): ×1`};
	const n = [v.n_tramos !== undefined ? `n = ${v.n_tramos} tramos de habla` : null, v.n_pares !== undefined ? `${v.n_pares} pares` : null].filter(Boolean).join(' en ');
	const rango = typeof v.min === 'number' && typeof v.max === 'number' ? `, de ×${v.min} a ×${v.max}` : '';
	return {factor: v.mediana, fuente: `${archivo} → velocidad.mediana (mediana de tus reels publicados${n ? `, ${n}` : ''}${rango})`};
}

/** Dónde se busca la calibración para una carpeta de proyectos: <carpeta de proyectos>/../estilo/calibracion-cortes.json. */
export const rutaCalibracionCortes = (proyectos: string = DIR_PROYECTOS): string => join(dirname(resolve(proyectos)), 'estilo', ARCHIVO_CALIBRACION_CORTES);

/** Aplica unos parámetros calibrados (parciales) encima de unos base. Pura. */
export function aplicarCalibracion(base: ParametrosCortes, calibrados: z.infer<typeof CalibracionCortesEsquema>['parametros']): ParametrosCortes {
	const tomas = Object.freeze({...base.tomas, ...(calibrados.tomas ?? {})});
	return Object.freeze({
		...base,
		...(calibrados.huecoMinimoS !== undefined ? {huecoMinimoS: calibrados.huecoMinimoS} : {}),
		...(calibrados.padAntesS !== undefined ? {padAntesS: calibrados.padAntesS} : {}),
		...(calibrados.padDespuesS !== undefined ? {padDespuesS: calibrados.padDespuesS} : {}),
		tomas,
	});
}

/**
 * Lee estilo/calibracion-cortes.json. Devuelve null si no existe (entonces mandan los valores por defecto).
 * Si existe pero no es JSON o no cumple el esquema, falla con código 2 (no se corta con algo que no se entiende).
 */
export function leerCalibracionCortes(ruta: string = rutaCalibracionCortes(), base: ParametrosCortes = PARAMETROS_CORTES): CalibracionCortes | null {
	if (!existsSync(ruta)) return null;
	const texto = readFileSync(ruta, 'utf8');
	let datos: unknown;
	try {
		datos = JSON.parse(texto);
	} catch (error) {
		throw fallo('leer la calibración de los cortes', `${relativa(ruta)} no es JSON válido`, 'vuelve a correr npx tsx herramientas/estilo/calibrar-cortes.ts o bórralo para usar los valores por defecto', 2, error);
	}
	const r = CalibracionCortesEsquema.safeParse(datos);
	if (!r.success) {
		const primero = r.error.issues[0];
		throw fallo(
			'leer la calibración de los cortes',
			`${relativa(ruta)} no tiene la forma esperada (${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'})`,
			'vuelve a correr npx tsx herramientas/estilo/calibrar-cortes.ts o bórralo para usar los valores por defecto',
			2,
			r.error.issues,
		);
	}
	const parametros = aplicarCalibracion(base, r.data.parametros);
	const cambios: string[] = [];
	for (const clave of ['huecoMinimoS', 'padAntesS', 'padDespuesS'] as const) {
		if (parametros[clave] !== base[clave]) cambios.push(`${clave} ${base[clave]} → ${parametros[clave]}`);
	}
	for (const [clave, valor] of Object.entries(parametros.tomas)) {
		const antes = (base.tomas as Record<string, unknown>)[clave];
		if (valor !== antes) cambios.push(`tomas.${clave} ${String(antes)} → ${String(valor)}`);
	}
	// La velocidad es un dato aparte: si no tiene la forma esperada, no tumba los cortes (queda ×1 y lo dice el resumen).
	const v = VelocidadCalibradaEsquema.safeParse((datos as {velocidad?: unknown}).velocidad);
	return {parametros, archivo: ruta, sha256: sha256Texto(texto), cambios, velocidad: v.success ? v.data : null};
}

// ───────────────────────── transcripción ─────────────────────────

/** Palabra de transcripcion.json (ya saneada): i = su posición en palabras[]. */
export interface Palabra {
	i: number;
	t: string;
	d: number;
	h: number;
	/** Lo que escribió whisper si una corrección de vocabulario cambió la palabra. */
	t_whisper?: string;
}

const PalabraEsquema = z.looseObject({
	t: z.string(),
	d: z.number(),
	h: z.number(),
	t_whisper: z.string().optional(),
});
const TranscripcionEsquema = z.looseObject({palabras: z.array(PalabraEsquema)});

/**
 * Sanea las palabras: quita las vacías, hace los inicios monótonos y deja cada fin entre su inicio y el inicio
 * de la siguiente (whisper.cpp ya lo cumple; esto cubre bordes). `i` es la posición original en palabras[].
 */
export function sanearPalabras(crudas: ReadonlyArray<{t: string; d: number; h: number; t_whisper?: string}>): Palabra[] {
	const palabras: Palabra[] = [];
	crudas.forEach((p, i) => {
		if (p.t.trim() === '' || !Number.isFinite(p.d) || !Number.isFinite(p.h)) return;
		const anterior = palabras.at(-1);
		const d = Math.max(0, p.d, anterior?.d ?? 0);
		palabras.push({i, t: p.t.trim(), d, h: Math.max(d, p.h), ...(p.t_whisper ? {t_whisper: p.t_whisper} : {})});
	});
	for (let j = 0; j + 1 < palabras.length; j++) palabras[j].h = Math.min(palabras[j].h, palabras[j + 1].d);
	return palabras;
}

export function leerTranscripcion(ruta: string): Palabra[] {
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw fallo('armar los cortes', `no existe ${relativa(ruta)}`, 'corre primero npx tsx herramientas/transcribir.ts <slug>', 2);
		}
		throw fallo('armar los cortes', `${relativa(ruta)} no es JSON válido`, 'vuelve a correr npx tsx herramientas/transcribir.ts <slug>', 2, error);
	}
	const r = TranscripcionEsquema.safeParse(datos);
	if (!r.success) {
		const primero = r.error.issues[0];
		throw fallo(
			'armar los cortes',
			`${relativa(ruta)} no trae "palabras": [{t, d, h}] (${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'})`,
			'vuelve a correr npx tsx herramientas/transcribir.ts <slug>',
			2,
			r.error.issues,
		);
	}
	const palabras = sanearPalabras(r.data.palabras);
	if (palabras.length === 0) {
		throw fallo('armar los cortes', `${relativa(ruta)} no trae ninguna palabra`, 'revisa que el crudo tenga tu voz y vuelve a transcribir', 2);
	}
	return palabras;
}

// ───────────────────────── energía y bordes de palabra ─────────────────────────

export interface AnalisisEnergia {
	wav: Wav;
	/** RMS (dBFS) por ventana; la ventana k cubre [k·saltoS, k·saltoS + ventanaS). */
	dbfs: Float64Array;
	saltoS: number;
	ventanaS: number;
	/** Piso de ruido y umbral de voz por segundo (dBFS). */
	pisoDbfs: Float64Array;
	umbralDbfs: Float64Array;
	/** Mediana de la energía dentro de las palabras, sin contar lo que está a menos de vozSobrePisoDb del piso (dBFS); NaN si no hay voz. */
	vozMedianaDbfs: number;
	/**
	 * Rachas de voz de todo el audio (s), en orden y sin encimarse: ventanas sobre el umbral (huecos de hasta
	 * huecoVozS no cortan la racha) que duran al menos vozMinimaS y llegan a la mediana de la voz − vozBajoMedianaDb.
	 * Lo demás (clics, respiraciones suaves, ruido) es silencio. Los bordes de palabra, los cortes y los avisos usan
	 * esta misma definición.
	 */
	voz: Array<[number, number]>;
}

function percentil(valores: number[], q: number): number {
	const orden = [...valores].sort((a, b) => a - b);
	if (orden.length === 0) return Number.NaN;
	const pos = (orden.length - 1) * q;
	const bajo = Math.floor(pos);
	const alto = Math.min(bajo + 1, orden.length - 1);
	return orden[bajo] + (orden[alto] - orden[bajo]) * (pos - bajo);
}

const porSegundo = (serie: Float64Array, t: number): number => serie[Math.min(serie.length - 1, Math.max(0, Math.round(t)))];

/** Energía por ventana, piso de ruido local, mediana de la voz, umbral de voz por segundo y rachas de voz. */
export function analizarEnergia(
	wav: Wav,
	palabras: ReadonlyArray<{d: number; h: number}>,
	p: ParametrosCortes['energia'] = PARAMETROS_CORTES.energia,
): AnalisisEnergia {
	const {dbfs, saltoS, ventanaS} = energiaPorVentana(wav, p.ventanaS, p.saltoS);
	const n = dbfs.length;
	const indice = (t: number) => (t - ventanaS / 2) / saltoS; // ventana cuyo centro cae en t
	const centro = (k: number) => k * saltoS + ventanaS / 2;

	// Piso de ruido local por segundo.
	const segundos = Math.max(1, Math.ceil(wav.duracionS) + 1);
	const pisoDbfs = new Float64Array(segundos);
	const cada = Math.max(1, Math.round(0.005 / saltoS));
	for (let s = 0; s < segundos; s++) {
		const k0 = Math.max(0, Math.ceil(indice(s - p.pisoRadioS)));
		const k1 = Math.min(n - 1, Math.floor(indice(s + p.pisoRadioS)));
		const valores: number[] = [];
		for (let k = k0; k <= k1; k += cada) valores.push(dbfs[k]);
		pisoDbfs[s] = valores.length > 0 ? Math.max(p.pisoMinimoDbfs, percentil(valores, p.pisoPercentil)) : p.pisoMinimoDbfs;
	}

	// Nivel de la voz: mediana de las ventanas dentro de las palabras que quedan claramente sobre el piso local.
	// (Whisper estira las palabras sobre los silencios: sin ese filtro, en un crudo con muchas pausas la "voz"
	// sería casi puro ruido.)
	const enVoz: number[] = [];
	for (const w of palabras) {
		const k0 = Math.max(0, Math.ceil(indice(w.d) - 1e-9));
		const k1 = Math.min(n - 1, Math.floor(indice(w.h) + 1e-9));
		for (let k = k0; k <= k1; k += 2) if (dbfs[k] > porSegundo(pisoDbfs, centro(k)) + p.vozSobrePisoDb) enVoz.push(dbfs[k]);
	}
	const vozMedianaDbfs = enVoz.length > 0 ? mediana(enVoz) : Number.NaN;

	const umbralDbfs = new Float64Array(segundos);
	for (let s = 0; s < segundos; s++) {
		const sobrePiso = pisoDbfs[s] + p.umbralSobrePisoDb;
		umbralDbfs[s] = Number.isFinite(vozMedianaDbfs) ? Math.min(sobrePiso, vozMedianaDbfs - p.umbralBajoVozDb) : sobrePiso;
	}

	// Rachas de voz de todo el audio.
	const huecoMax = Math.round(p.huecoVozS / saltoS);
	const pisoVoz = Number.isFinite(vozMedianaDbfs) ? vozMedianaDbfs - p.vozBajoMedianaDb : -Infinity;
	const voz: Array<[number, number]> = [];
	let racha: {k0: number; k1: number; max: number} | null = null;
	const cerrar = () => {
		if (!racha) return;
		const x = Math.max(0, centro(racha.k0) - ventanaS / 2);
		const y = Math.min(wav.duracionS, centro(racha.k1) + ventanaS / 2);
		if (y - x >= p.vozMinimaS - 1e-9 && racha.max >= pisoVoz) voz.push([x, y]);
	};
	for (let k = 0; k < n; k++) {
		if (dbfs[k] < porSegundo(umbralDbfs, centro(k))) continue;
		if (racha && k - racha.k1 - 1 <= huecoMax) {
			racha.k1 = k;
			racha.max = Math.max(racha.max, dbfs[k]);
		} else {
			cerrar();
			racha = {k0: k, k1: k, max: dbfs[k]};
		}
	}
	cerrar();
	return {wav, dbfs, saltoS, ventanaS, pisoDbfs, umbralDbfs, vozMedianaDbfs, voz};
}

/** Las rachas de voz (ver AnalisisEnergia.voz) recortadas a [a, b] (s). */
export function rachasDeVoz(e: AnalisisEnergia, a: number, b: number): Array<[number, number]> {
	if (!(b > a)) return [];
	// Primera racha que termina después de a (búsqueda binaria: las rachas van en orden).
	let lo = 0;
	let hi = e.voz.length;
	while (lo < hi) {
		const medio = (lo + hi) >> 1;
		if (e.voz[medio][1] <= a) lo = medio + 1;
		else hi = medio;
	}
	const salida: Array<[number, number]> = [];
	for (let k = lo; k < e.voz.length && e.voz[k][0] < b; k++) salida.push([Math.max(a, e.voz[k][0]), Math.min(b, e.voz[k][1])]);
	return salida;
}

/** Tramos de [a, b] (s) sin voz (el complemento de rachasDeVoz). */
export function silenciosEn(e: AnalisisEnergia, a: number, b: number): Array<[number, number]> {
	const salida: Array<[number, number]> = [];
	let cursor = a;
	for (const [x, y] of rachasDeVoz(e, a, b)) {
		if (x > cursor) salida.push([cursor, x]);
		cursor = Math.max(cursor, y);
	}
	if (b > cursor) salida.push([cursor, b]);
	return salida;
}

/** Inicio y fin (s) de una palabra en el crudo. */
export interface Limites {
	d: number;
	h: number;
}

/** La racha de voz completa (sin recortar) que contiene t; null si t cae en silencio. */
function rachaCompleta(e: AnalisisEnergia, t: number): [number, number] | null {
	let lo = 0;
	let hi = e.voz.length;
	while (lo < hi) {
		const medio = (lo + hi) >> 1;
		if (e.voz[medio][1] < t) lo = medio + 1;
		else hi = medio;
	}
	const r = e.voz[lo];
	return r && r[0] <= t + 1e-9 && r[1] >= t - 1e-9 ? r : null;
}

/**
 * Recorta el silencio de las orillas de cada palabra: el inicio pasa al inicio de la primera racha de voz que toca
 * [d, h] y el fin al final de la última. Nunca agranda la palabra ni toca su interior. Si ninguna racha de voz toca
 * la palabra, queda igual y se marca `sinVoz` (whisper la puso donde casi no se oye nada: vale la pena revisarla).
 *
 * Voz ajena en las orillas: si whisper estiró el final de la palabra sobre una pausa hasta el arranque de la siguiente
 * (IMG_5199: «construye,» hasta 116.44 s cuando la voz de «literalmente» arranca en 116.31 s tras 0.25 s de silencio),
 * esa última racha es de la palabra siguiente y no cuenta para el final (ni la primera para el inicio, si whisper
 * empezó la palabra en la cola de la anterior). Ver PARAMETROS_CORTES.orillaAjena. Sin esto, un corte que quita la
 * palabra siguiente deja pasar su arranque.
 */
export function refinarPalabras(
	e: AnalisisEnergia,
	palabras: ReadonlyArray<{d: number; h: number}>,
	orilla: ParametrosCortes['orillaAjena'] = PARAMETROS_CORTES.orillaAjena,
): {limites: Limites[]; sinVoz: boolean[]} {
	const limites: Limites[] = [];
	const sinVoz: boolean[] = [];
	for (const w of palabras) {
		if (!(w.h - w.d > 1e-9)) {
			limites.push({d: w.d, h: w.h});
			sinVoz.push(false);
			continue;
		}
		let voz = rachasDeVoz(e, w.d, w.h);
		if (voz.length === 0) {
			limites.push({d: w.d, h: w.h});
			sinVoz.push(true);
			continue;
		}
		if (voz.length >= 2) {
			const [x, y] = voz.at(-1)!;
			const completa = rachaCompleta(e, x);
			if (completa && completa[1] >= w.h + orilla.fueraS && x - voz.at(-2)![1] >= orilla.huecoS && y - x <= orilla.maxS) voz = voz.slice(0, -1);
		}
		if (voz.length >= 2) {
			const [x, y] = voz[0];
			const completa = rachaCompleta(e, y);
			if (completa && completa[0] <= w.d - orilla.fueraS && voz[1][0] - y >= orilla.huecoS && y - x <= orilla.maxS) voz = voz.slice(1);
		}
		const d = voz[0][0];
		limites.push({d, h: Math.max(d, voz.at(-1)![1])});
		sinVoz.push(false);
	}
	return {limites, sinVoz};
}

// ───────────────────────── keep[] ─────────────────────────

export type MotivoCorte = 'inicio' | 'final' | 'silencio' | 'descartadas';

export interface Corte {
	/** Lo que se quita del crudo, en segundos (bordes de cuadro). */
	desde: number;
	hasta: number;
	motivo: MotivoCorte;
	/** Posiciones (en palabras[]) de las palabras que se quitan con este corte. */
	palabras: number[];
	/** Voz (ver rachasDeVoz) que cae dentro del corte (s). */
	vozS: number;
	/** …y la que no cubre ninguna palabra quitada: voz que whisper no transcribió y que se va (s). */
	vozSinPalabrasS: number;
}

export interface Juntura {
	/** Posición de la palabra en palabras[]. */
	palabra: number;
	/** Qué borde de la palabra movió el corte. */
	lado: 'inicio' | 'fin';
	desplazamientoMs: number;
	/** El corte (s, borde de cuadro): el nuevo borde de la palabra. */
	borde: number;
}

export interface ResultadoKeep {
	keep: Tramo[];
	cortes: Corte[];
	junturas: Juntura[];
	/** Bordes finales de cada palabra (refinados y, si hubo juntura, movidos al corte). */
	limites: Limites[];
	/** Tramo de keep[] de cada palabra; −1 si no se queda. */
	tramoDe: number[];
}

export interface EntradaKeep {
	/** Bordes de cada palabra (refinados con la energía), en orden. */
	limites: readonly Limites[];
	/** true = la palabra se queda. */
	seleccion: readonly boolean[];
	/** j tal que las palabras j y j+1 forman una sola palabra de tu texto: entre ellas no se corta. */
	juntas?: ReadonlySet<number>;
	energia: AnalisisEnergia;
	/** Último segundo útil del crudo (lo más corto entre video, audio y wav); se lleva a cuadro hacia abajo. */
	limiteS: number;
	parametros?: ParametrosCortes;
}

const cuadroArriba = (t: number): number => Math.ceil(t * FPS - 1e-6);
const cuadroAbajo = (t: number): number => Math.floor(t * FPS + 1e-6);

/** RMS (dBFS) de la ventana de valle centrada en el borde del cuadro f. */
function energiaEnCuadro(e: AnalisisEnergia, f: number, ventanaS: number): number {
	const t = f / FPS;
	return energiaEnIntervalo(e.wav, t - ventanaS / 2, t + ventanaS / 2);
}

/** De los cuadros [f0, f1], el del valle: a ≤ tolerancia del más silencioso y, entre esos, el más cercano a `objetivo`. */
function cuadroDeValle(e: AnalisisEnergia, f0: number, f1: number, objetivo: number, p: ParametrosCortes): number {
	const energias: number[] = [];
	for (let f = f0; f <= f1; f++) energias.push(energiaEnCuadro(e, f, p.ventanaValleS));
	const minimo = Math.min(...energias);
	let mejor = f0;
	let distancia = Infinity;
	for (let f = f0; f <= f1; f++) {
		if (energias[f - f0] > minimo + p.toleranciaValleDb) continue;
		const dist = Math.abs(f / FPS - objetivo);
		if (dist < distancia - 1e-9) {
			mejor = f;
			distancia = dist;
		}
	}
	return mejor;
}

/**
 * Borde (en cuadros) dentro de [a, b] (s): el valle de energía más cercano al objetivo en ±radio. Si en ese radio
 * todo suena (voz que whisper no cubrió, una respiración fuerte), busca el cuadro en silencio más cercano en todo
 * [a, b]; si no hay ninguno, se queda con el valle del radio. null si en [a, b] no cae ningún borde de cuadro.
 */
function ubicarBorde(e: AnalisisEnergia, objetivo: number, a: number, b: number, p: ParametrosCortes): number | null {
	if (!(b >= a - 1e-9)) return null;
	const fa = cuadroArriba(a);
	const fb = cuadroAbajo(b);
	if (fa > fb) return null;
	const obj = Math.min(b, Math.max(a, objetivo));
	const f0 = Math.max(fa, cuadroArriba(obj - p.radioValleS));
	const f1 = Math.min(fb, cuadroAbajo(obj + p.radioValleS));
	const silencioso = (f: number) => energiaEnCuadro(e, f, p.ventanaValleS) < porSegundo(e.umbralDbfs, f / FPS);
	if (f0 <= f1) {
		for (let f = f0; f <= f1; f++) if (silencioso(f)) return cuadroDeValle(e, f0, f1, obj, p);
	}
	let mejor = -1;
	let distancia = Infinity;
	for (let f = fa; f <= fb; f++) {
		if (!silencioso(f)) continue;
		const dist = Math.abs(f / FPS - obj);
		if (dist < distancia - 1e-9) {
			mejor = f;
			distancia = dist;
		}
	}
	if (mejor >= 0) return mejor;
	return f0 <= f1 ? cuadroDeValle(e, f0, f1, obj, p) : cuadroDeValle(e, fa, fb, obj, p);
}

/**
 * Construye keep[] a partir de qué palabras se quedan (ver encabezado, pasos 3–4). Solo mueve los bordes de una
 * palabra en una juntura (palabras pegadas que hay que separar) y lo anota.
 */
export function construirKeep(entrada: EntradaKeep): ResultadoKeep {
	const p = entrada.parametros ?? PARAMETROS_CORTES;
	const {seleccion, energia: e} = entrada;
	const juntas = entrada.juntas ?? new Set<number>();
	const L: Limites[] = entrada.limites.map((x) => ({d: x.d, h: x.h}));
	const n = L.length;
	if (seleccion.length !== n) throw fallo('armar los cortes', 'la selección no tiene una marca por palabra', 'revisa proyectos/_logs/fallos.log y avísame', 1);
	const fLimite = cuadroAbajo(entrada.limiteS);
	if (fLimite < 1) throw fallo('armar los cortes', 'el crudo dura menos de un cuadro', 'revisa la ingesta del proyecto', 2);
	const limiteS = fLimite / FPS;
	const minimoCuadros = Math.max(1, Math.round(p.corteMinimoS * FPS));
	const junturas: Juntura[] = [];

	// 1. Grupos de palabras que se quedan, separados por palabras quitadas o por un hueco de más de huecoMinimoS.
	type Grupo = {primera: number; ultima: number};
	const grupos: Grupo[] = [];
	for (let j = 0; j < n; j++) {
		if (!seleccion[j]) continue;
		const g = grupos.at(-1);
		if (g && j === g.ultima + 1 && (L[j].d - L[g.ultima].h <= p.huecoMinimoS || juntas.has(g.ultima))) g.ultima = j;
		else grupos.push({primera: j, ultima: j});
	}
	if (grupos.length === 0) {
		throw fallo('armar los cortes', 'no queda ninguna palabra que conservar', 'revisa el texto (no puede quedar vacío) y vuelve a correr', 2);
	}

	const moverInicio = (j: number, t: number) => {
		if (j >= 0 && j < n && L[j].d < t - 1e-9) {
			junturas.push({palabra: j, lado: 'inicio', desplazamientoMs: Math.round((t - L[j].d) * 1000), borde: t});
			L[j].d = Math.min(L[j].h, t);
		}
	};
	const moverFin = (j: number, t: number) => {
		if (j >= 0 && j < n && L[j].h > t + 1e-9) {
			junturas.push({palabra: j, lado: 'fin', desplazamientoMs: Math.round((L[j].h - t) * 1000), borde: t});
			L[j].h = Math.max(L[j].d, t);
		}
	};
	/**
	 * Corte entre lo que suena hasta `x` y lo que empieza en `y` cuando no hay silencio donde ponerlo: el valle de
	 * energía entre los dos (±40 ms, sin pasar de la mitad de las palabras `izq`/`der` si se dan). Si cae dentro de una
	 * de esas palabras, su borde se mueve al corte y se anota como juntura.
	 */
	const valleEntre = (x: number, y: number, izq: number, der: number): number => {
		const centro = (x + y) / 2;
		const lo = Math.max(izq >= 0 ? (L[izq].d + L[izq].h) / 2 : -Infinity, centro - 0.04, 0);
		const hi = Math.min(der >= 0 ? (L[der].d + L[der].h) / 2 : Infinity, centro + 0.04, limiteS);
		let f0 = cuadroArriba(lo);
		let f1 = cuadroAbajo(hi);
		if (f0 > f1) f0 = f1 = Math.min(fLimite, Math.max(0, Math.round(centro * FPS)));
		const f = cuadroDeValle(e, f0, f1, centro, p);
		moverFin(izq, f / FPS);
		moverInicio(der, f / FPS);
		return f;
	};
	/** Cortes de silencio en [x, y] (s): solo donde la energía también dice silencio, con pad hacia lo que suena. */
	const cortesDeSilencio = (x: number, y: number): Array<[number, number]> =>
		silenciosEn(e, x, y)
			.filter(([a, b]) => b - a > p.huecoMinimoS)
			.flatMap(([a, b]): Array<[number, number]> => {
				const fin = ubicarBorde(e, a + p.padDespuesS, a + p.guardiaS, b - p.guardiaS, p);
				const ini = ubicarBorde(e, b - p.padAntesS, a + p.guardiaS, b - p.guardiaS, p);
				return fin !== null && ini !== null && ini - fin >= minimoCuadros ? [[fin, ini]] : [];
			});

	/**
	 * Cortes (en cuadros) entre la última palabra A de un grupo y la primera C del siguiente, en orden. Si entre las
	 * dos hay palabras quitadas, el corte obligatorio se lleva esas palabras y la voz pegada a ellas (a menos de
	 * huecoMinimoS); la voz sin palabras que no está pegada se queda, y los silencios largos se cortan como pausas.
	 */
	const cortesEntre = (A: number, C: number): Array<{f0: number; f1: number; obligatorio: boolean}> => {
		const a = L[A].h;
		const c = L[C].d;
		const pausa = (x: number, y: number) => cortesDeSilencio(x, y).map(([f0, f1]) => ({f0, f1, obligatorio: false}));
		if (C === A + 1) return pausa(a, c);
		let s0 = L[A + 1].d;
		let s1 = L[C - 1].h;
		const voz = rachasDeVoz(e, a, c);
		// La voz que arranca justo donde termina A es la cola de A, y la que acaba justo donde empieza C es de C.
		for (let k = voz.length - 1; k >= 0; k--) {
			const [x, y] = voz[k];
			if (x < s0 && y >= s0 - p.huecoMinimoS && x > a + 1e-6) s0 = x;
		}
		for (const [x, y] of voz) {
			if (y > s1 && x <= s1 + p.huecoMinimoS && y < c - 1e-6) s1 = y;
		}
		const antes = voz.filter(([, y]) => y <= s0 + 1e-9).reduce((m, [, y]) => Math.max(m, y), a);
		const despues = voz.filter(([x]) => x >= s1 - 1e-9).reduce((m, [x]) => Math.min(m, x), c);
		const izq = antes <= a + 1e-9 ? A : -1;
		const der = despues >= c - 1e-9 ? C : -1;
		const fin =
			ubicarBorde(e, antes + p.padDespuesS, antes + p.guardiaS, s0 - p.guardiaDescartadaS, p) ??
			ubicarBorde(e, antes + p.padDespuesS, antes, s0, p) ??
			valleEntre(antes, s0, izq, s0 <= L[A + 1].d + 1e-9 ? A + 1 : -1);
		const ini =
			ubicarBorde(e, despues - p.padAntesS, s1 + p.guardiaDescartadaS, despues - p.guardiaS, p) ??
			ubicarBorde(e, despues - p.padAntesS, s1, despues, p) ??
			valleEntre(s1, despues, s1 >= L[C - 1].h - 1e-9 ? C - 1 : -1, der);
		return [...pausa(a, antes), {f0: fin, f1: Math.max(ini, fin + 1), obligatorio: true}, ...pausa(despues, c)];
	};

	/** Borde de entrada del primer grupo: se va todo lo de antes (lo que suena antes de tu primera palabra). */
	const entradaDe = (r: number): number => {
		const C = grupos[r].primera;
		const P = C - 1;
		const piso = P < 0 ? 0 : L[P].h;
		const guarda = P < 0 ? 0 : p.guardiaDescartadaS;
		return (
			ubicarBorde(e, L[C].d - p.padAntesS, piso + guarda, L[C].d - p.guardiaS, p) ??
			ubicarBorde(e, L[C].d - p.padAntesS, piso, L[C].d, p) ??
			(P < 0 ? 0 : valleEntre(piso, L[C].d, P, C))
		);
	};
	/** Borde de salida del último grupo: se va todo lo de después. */
	const salidaDe = (r: number): number => {
		const A = grupos[r].ultima;
		const N = A + 1;
		const techo = N >= n ? limiteS : Math.min(limiteS, L[N].d);
		const guarda = N >= n ? 0 : p.guardiaDescartadaS;
		const f =
			ubicarBorde(e, L[A].h + p.padDespuesS, L[A].h + p.guardiaS, techo - guarda, p) ??
			ubicarBorde(e, L[A].h + p.padDespuesS, L[A].h, techo, p);
		if (f !== null) return f;
		if (N < n) return valleEntre(L[A].h, techo, A, N);
		moverFin(A, limiteS);
		return fLimite;
	};

	// 2. Bloques que se quedan (en cuadros). Un bloque sin grupos guarda voz que whisper no transcribió.
	type Bloque = {desde: number; hasta: number; grupos: number[]; obligatorio: boolean};
	const bloques: Bloque[] = [];
	let actual: Bloque = {desde: entradaDe(0), hasta: -1, grupos: [0], obligatorio: true};
	for (let r = 1; r < grupos.length; r++) {
		const cortes = cortesEntre(grupos[r - 1].ultima, grupos[r].primera);
		if (cortes.length === 0) {
			actual.grupos.push(r);
			continue;
		}
		actual.hasta = cortes[0].f0;
		bloques.push(actual);
		for (let k = 1; k < cortes.length; k++) bloques.push({desde: cortes[k - 1].f1, hasta: cortes[k].f0, grupos: [], obligatorio: cortes[k - 1].obligatorio});
		actual = {desde: cortes.at(-1)!.f1, hasta: -1, grupos: [r], obligatorio: cortes.at(-1)!.obligatorio};
	}
	actual.hasta = salidaDe(grupos.length - 1);
	bloques.push(actual);

	// 3. Cada bloque dura al menos un cuadro y entre dos bloques hay al menos un cuadro de corte. Un corte de pausa
	//    que no cabe se deshace; uno obligatorio se fuerza (solo pasa con palabras quitadas de duración casi nula).
	for (let k = 0; k < bloques.length; k++) {
		const b = bloques[k];
		if (b.hasta < b.desde + 1) b.hasta = b.desde + 1;
		const sig = bloques[k + 1];
		if (!sig || sig.desde >= b.hasta + 1) continue;
		if (!sig.obligatorio) {
			b.hasta = Math.max(b.hasta, sig.hasta);
			b.grupos.push(...sig.grupos);
			bloques.splice(k + 1, 1);
			k--;
			continue;
		}
		sig.desde = b.hasta + 1;
		if (sig.grupos.length > 0) moverInicio(grupos[sig.grupos[0]].primera, sig.desde / FPS);
		if (sig.hasta < sig.desde + 1) sig.hasta = sig.desde + 1;
	}
	if (bloques.at(-1)!.hasta > fLimite) {
		throw fallo('armar los cortes', 'el último tramo quedó después del final del crudo', 'revisa proyectos/_logs/fallos.log y avísame', 1, {bloques, fLimite});
	}

	const quedan = p.quitarSueltosS > 0 ? bloques.filter((b) => b.grupos.length > 0 || (b.hasta - b.desde) / FPS >= p.quitarSueltosS) : bloques;
	const keep: Tramo[] = quedan.map((b) => ({desde: b.desde / FPS, hasta: b.hasta / FPS}));
	const tramoDe = new Array<number>(n).fill(-1);
	quedan.forEach((b, k) => {
		for (const r of b.grupos) for (let j = grupos[r].primera; j <= grupos[r].ultima; j++) tramoDe[j] = k;
	});

	// 4. Cortes (el complemento de keep[]) con su motivo, las palabras que se van y la voz que se llevan.
	const huecos: Array<[number, number]> = [];
	if (keep[0].desde > 0) huecos.push([0, keep[0].desde]);
	for (let k = 1; k < keep.length; k++) huecos.push([keep[k - 1].hasta, keep[k].desde]);
	if (keep.at(-1)!.hasta < limiteS - 1e-9) huecos.push([keep.at(-1)!.hasta, limiteS]);
	const cortes: Corte[] = huecos.map(([desde, hasta]) => {
		const palabras: number[] = [];
		for (let j = 0; j < n; j++) if (!seleccion[j] && L[j].h > desde - 1e-9 && L[j].d < hasta + 1e-9) palabras.push(j);
		const voz = rachasDeVoz(e, desde, hasta);
		const vozS = voz.reduce((s, [x, y]) => s + (y - x), 0);
		const vozSinPalabrasS = voz.reduce((s, [x, y]) => s + restarIntervalos(x, y, palabras.map((j) => [L[j].d, L[j].h] as [number, number])), 0);
		const motivo: MotivoCorte = desde <= 1e-9 ? 'inicio' : hasta >= limiteS - 1e-9 ? 'final' : palabras.length > 0 ? 'descartadas' : 'silencio';
		return {desde, hasta, motivo, palabras, vozS, vozSinPalabrasS};
	});

	return {keep, cortes, junturas, limites: L, tramoDe};
}

/** Cuánto de [x, y] no cubre ninguno de los intervalos dados. */
function restarIntervalos(x: number, y: number, intervalos: ReadonlyArray<[number, number]>): number {
	const recortes = intervalos
		.map(([a, b]) => [Math.max(x, a), Math.min(y, b)] as const)
		.filter(([a, b]) => b > a)
		.sort((u, v) => u[0] - v[0]);
	let cubierto = 0;
	let cursor = x;
	for (const [a, b] of recortes) {
		if (b <= cursor) continue;
		cubierto += b - Math.max(a, cursor);
		cursor = b;
	}
	return Math.max(0, y - x - cubierto);
}

// ───────────────────────── verificación ─────────────────────────

export interface Verificacion {
	/** Bordes de keep[] que caen dentro de una palabra (deben ser 0). */
	dentroDePalabra: Array<{borde: number; palabra: number}>;
	/** Palabras que se quedan pero no caen enteras dentro de un solo tramo (deben ser 0). */
	partidas: number[];
	/** Palabras que se quitan pero tocan un tramo (deben ser 0). */
	descartadasDentro: number[];
	bordes: number;
}

/** Revisa keep[] contra los bordes finales de las palabras (ver encabezado, paso 5). */
export function verificarCortes(keep: readonly Tramo[], limites: readonly Limites[], seleccion: readonly boolean[]): Verificacion {
	const eps = 1e-6;
	const bordes = keep.flatMap((t) => [t.desde, t.hasta]);
	const dentroDePalabra: Verificacion['dentroDePalabra'] = [];
	for (const b of bordes) {
		limites.forEach((w, j) => {
			if (w.h - w.d > 2 * eps && b > w.d + eps && b < w.h - eps) dentroDePalabra.push({borde: b, palabra: j});
		});
	}
	const partidas: number[] = [];
	const descartadasDentro: number[] = [];
	limites.forEach((w, j) => {
		if (seleccion[j]) {
			if (!keep.some((t) => t.desde - eps <= w.d && w.h <= t.hasta + eps)) partidas.push(j);
		} else if (w.h - w.d > 2 * eps && keep.some((t) => t.desde < w.h - eps && t.hasta > w.d + eps)) {
			descartadasDentro.push(j);
		}
	});
	return {dentroDePalabra, partidas, descartadasDentro, bordes: bordes.length};
}

const verificacionLimpia = (v: Verificacion): boolean => v.dentroDePalabra.length === 0 && v.partidas.length === 0 && v.descartadasDentro.length === 0;

// ───────────────────────── texto aprobado ─────────────────────────

export interface Token {
	/** Como lo escribiste (con la puntuación pegada). */
	texto: string;
	/** Normalizado: minúsculas, sin acentos ni puntuación. Nunca vacío. */
	norm: string;
	/** Renglón (desde 1) del archivo donde está. */
	linea: number;
}

const APERTURA = /^[¿¡«“‘(\[{]+$/u;

/**
 * Lee tu texto aprobado. Si trae una sección "## Guion" (el texto-propuesto.md editado), lee solo esa sección;
 * si no, todo el archivo. Ignora comentarios HTML. La puntuación suelta ("—", "-") se pega a la palabra vecina.
 */
export function leerTextoAprobado(contenido: string): Token[] {
	const sinComentarios = contenido.replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
	const lineas = sinComentarios.split(/\r?\n/);
	let desde = 0;
	let hasta = lineas.length;
	const guion = lineas.findIndex((l) => /^\s*##\s+guion\s*$/i.test(l.normalize('NFD').replace(/\p{M}/gu, '')));
	if (guion >= 0) {
		desde = guion + 1;
		const fin = lineas.findIndex((l, k) => k > guion && /^\s*#{1,6}\s/.test(l));
		hasta = fin < 0 ? lineas.length : fin;
	}
	const tokens: Token[] = [];
	let pendiente = '';
	for (let k = desde; k < hasta; k++) {
		for (const crudo of lineas[k].split(/\s+/).filter(Boolean)) {
			const norm = normalizarPalabra(crudo);
			if (norm === '') {
				// La de apertura (¿ ¡ « “ ( [) va con la palabra siguiente; el resto, con la anterior.
				const ultimo = tokens.at(-1);
				if (ultimo && !APERTURA.test(crudo)) ultimo.texto = `${ultimo.texto} ${crudo}`;
				else pendiente = pendiente ? `${pendiente} ${crudo}` : crudo;
				continue;
			}
			tokens.push({texto: pendiente ? `${pendiente} ${crudo}` : crudo, norm, linea: k + 1});
			pendiente = '';
		}
	}
	return tokens;
}

/** Tokens [t0, t1] de tu texto ↔ palabras [w0, w1] del audio (índices incluidos). */
export interface ParAlineado {
	t0: number;
	t1: number;
	w0: number;
	w1: number;
}

export interface Alineacion {
	pares: ParAlineado[];
	/** Tokens de tu texto que no se encontraron en el audio (en ese orden). */
	faltantes: number[];
}

/** Costos enteros (exactos en punto flotante): usar una palabra fuera de la propuesta, saltar, no encontrar. */
const COSTO = {fueraDePropuesta: 1000, salto: 300, union: 10, faltante: 1_000_000} as const;

/**
 * Correcciones de biblioteca/vocabulario.json ({"cloud": "Claude"}) como equivalencias para alinear tu texto: así
 * "Claude" en tu texto empata con "Cloud" en una transcripción que todavía no pasó por las correcciones. Solo se
 * lee; si el archivo no existe o no se puede leer, no hay equivalencias (transcribir.ts ya valida ese archivo).
 */
export function leerEquivalencias(ruta = resolve(RAIZ, 'biblioteca', 'vocabulario.json')): Map<string, string[]> {
	const mapa = new Map<string, string[]>();
	let datos: {correcciones?: unknown};
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8')) as {correcciones?: unknown};
	} catch {
		return mapa;
	}
	if (!datos.correcciones || typeof datos.correcciones !== 'object') return mapa;
	for (const [de, a] of Object.entries(datos.correcciones as Record<string, unknown>)) {
		if (typeof a !== 'string') continue;
		const clave = de.trim().split(/\s+/).map(normalizarPalabra).join('');
		const valor = normalizarPalabra(a);
		if (!clave || !valor || clave === valor) continue;
		mapa.set(clave, [...(mapa.get(clave) ?? []), valor]);
		mapa.set(valor, [...(mapa.get(valor) ?? []), clave]);
	}
	return mapa;
}

/** Claves con que una palabra del audio empata con tu texto: la palabra, lo que escribió whisper y sus equivalencias. */
function clavesDe(p: Palabra, equivalencias: ReadonlyMap<string, string[]> = new Map()): string[] {
	const base = [normalizarPalabra(p.t), normalizarPalabra(p.t_whisper ?? '')].filter(Boolean);
	return [...new Set([...base, ...base.flatMap((c) => equivalencias.get(c) ?? [])])];
}

/**
 * Alinea tu texto contra TODAS las palabras del audio, en orden (programación dinámica). Cada token se empareja con
 * una palabra igual (normalizada, o igual a lo que escribió whisper), dos tokens con una palabra que es su unión
 * ("en frente" ↔ "enfrente") o un token con dos palabras seguidas. Minimiza: palabras fuera de la propuesta (1000),
 * saltos entre palabras no contiguas (300) y uniones (10). Un token sin pareja cuesta 1 000 000 y queda en `faltantes`.
 */
export function alinearTexto(
	tokens: readonly Token[],
	palabras: readonly Palabra[],
	propuesta: readonly boolean[],
	equivalencias: ReadonlyMap<string, string[]> = new Map(),
): Alineacion {
	const m = tokens.length;
	const n = palabras.length;
	const W = n + 1;
	const listas = palabras.map((p) => clavesDe(p, equivalencias));
	const claves = listas.map((l) => new Set(l));
	const parejas = palabras.map((_, k) => {
		const s = new Set<string>();
		if (k + 1 >= n) return s;
		for (const a of listas[k]) for (const b of listas[k + 1]) s.add(a + b);
		return s;
	});
	const f = new Float64Array((m + 1) * W).fill(Infinity);
	const previo = new Int32Array((m + 1) * W).fill(-1);
	const tipo = new Uint8Array((m + 1) * W); // 1 = 1:1 · 2 = dos tokens, una palabra · 3 = un token, dos palabras · 4 = faltante
	f[0] = 0;
	const costo = (k: number) => (propuesta[k] ? 0 : COSTO.fueraDePropuesta);
	const relajar = (i: number, j: number, valor: number, desde: number, tp: number) => {
		const x = i * W + j;
		if (valor < f[x]) {
			f[x] = valor;
			previo[x] = desde;
			tipo[x] = tp;
		}
	};
	// Estado j: la última pareja terminó en la palabra j−1 (j = 0: todavía ninguna).
	for (let i = 0; i < m; i++) {
		const fila = i * W;
		for (let j = 0; j <= n; j++) if (f[fila + j] < Infinity) relajar(i + 1, j, f[fila + j] + COSTO.faltante, j, 4);
		let minSalto = Infinity;
		let argSalto = -1;
		const tk = tokens[i].norm;
		const tk2 = i + 1 < m ? tk + tokens[i + 1].norm : null;
		for (let k = 0; k < n; k++) {
			if (k - 1 >= 1 && f[fila + k - 1] < minSalto) {
				minSalto = f[fila + k - 1];
				argSalto = k - 1;
			}
			let base = Infinity;
			let desde = -1;
			if (k >= 1 && f[fila + k] < base) {
				base = f[fila + k];
				desde = k; // contigua
			}
			if (f[fila] < base) {
				base = f[fila];
				desde = 0; // primera pareja
			}
			if (minSalto + COSTO.salto < base) {
				base = minSalto + COSTO.salto;
				desde = argSalto;
			}
			if (base === Infinity) continue;
			if (claves[k].has(tk)) relajar(i + 1, k + 1, base + costo(k), desde, 1);
			if (parejas[k].has(tk)) relajar(i + 1, k + 2, base + costo(k) + costo(k + 1) + COSTO.union, desde, 3);
			if (tk2 !== null && claves[k].has(tk2)) relajar(i + 2, k + 1, base + costo(k) + COSTO.union, desde, 2);
		}
	}
	let j = 0;
	for (let x = 1; x <= n; x++) if (f[m * W + x] < f[m * W + j]) j = x;
	const pares: ParAlineado[] = [];
	const faltantes: number[] = [];
	let i = m;
	while (i > 0) {
		const x = i * W + j;
		const tp = tipo[x];
		const pj = previo[x];
		if (tp === 4) {
			faltantes.push(i - 1);
			i -= 1;
		} else if (tp === 1) {
			pares.push({t0: i - 1, t1: i - 1, w0: j - 1, w1: j - 1});
			i -= 1;
		} else if (tp === 3) {
			pares.push({t0: i - 1, t1: i - 1, w0: j - 2, w1: j - 1});
			i -= 1;
		} else if (tp === 2) {
			pares.push({t0: i - 2, t1: i - 1, w0: j - 1, w1: j - 1});
			i -= 2;
		} else {
			throw fallo('alinear el texto aprobado', 'la alineación quedó incompleta', 'revisa proyectos/_logs/fallos.log y avísame', 1);
		}
		j = pj;
	}
	return {pares: pares.reverse(), faltantes: faltantes.reverse()};
}

/** Explica, para el creador, por qué cada token faltante no se pudo usar. */
export function explicarFaltantes(
	alineacion: Alineacion,
	tokens: readonly Token[],
	palabras: readonly Palabra[],
	equivalencias: ReadonlyMap<string, string[]> = new Map(),
): string[] {
	const todas = new Set(palabras.flatMap((p) => clavesDe(p, equivalencias)));
	return alineacion.faltantes.map((ti) => {
		const tok = tokens[ti];
		const antes = [...alineacion.pares].reverse().find((p) => p.t1 < ti);
		const despues = alineacion.pares.find((p) => p.t0 > ti);
		const etiqueta = `«${tok.texto}» (renglón ${tok.linea})`;
		if (todas.has(tok.norm)) return `${etiqueta} sí está en el audio, pero no en ese lugar (¿la repetiste o cambiaste el orden?)`;
		if (antes && despues && despues.w0 - antes.w1 - 1 >= 1 && despues.w0 - antes.w1 - 1 <= 3) {
			const dice = palabras.slice(antes.w1 + 1, despues.w0).map((p) => p.t).join(' ');
			return `${etiqueta} no está en el audio: ahí dijiste «${dice}»`;
		}
		return `${etiqueta} no está en el audio`;
	});
}

// ───────────────────────── transcripción de la base ─────────────────────────

/** Palabra que sale a la base: su texto y de qué palabras del audio sale ([desde, hasta] incluidos). */
export interface PalabraSalida {
	t: string;
	desde: number;
	hasta: number;
	/** Si dos palabras de tu texto comparten una del audio: qué fracción de su duración le toca a esta. */
	parte?: [number, number];
}

export interface PalabraBase {
	/** Posición original en transcripcion.json → palabras[]. */
	i: number;
	/** Solo si esta palabra de tu texto junta dos del audio ("en frente" ↔ "enfrente"): la posición de la segunda. */
	i_hasta?: number;
	/** Posición en la base (0, 1, 2…). */
	j: number;
	t: string;
	/** Inicio y fin en la línea de tiempo de la base (s). */
	d: number;
	h: number;
	/** Tramo de keep[] del que sale. */
	tramo: number;
}

const redondo6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * Pasa cada palabra que se queda a la base con lib/remapear.ts. Usa el inicio y el fin de transcripcion.json (el
 * inicio ya trae la calibración de sincronía) recortados a su tramo: así nada cruza un corte.
 * Con velocidad F, d y h salen en la base ya acelerada: inicio del tramo en la base + (t − desde del tramo) / F.
 */
export function armarTranscripcionBase(
	keep: readonly Tramo[],
	palabras: readonly Palabra[],
	salida: readonly PalabraSalida[],
	tramoDe: readonly number[],
	velocidad = 1,
): PalabraBase[] {
	return salida.map((s, j) => {
		const k = tramoDe[s.desde];
		if (k < 0 || tramoDe[s.hasta] !== k) {
			throw fallo('pasar las palabras a la base', `«${s.t}» no cae entera en un tramo`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {s, k});
		}
		let d = Math.min(...palabras.slice(s.desde, s.hasta + 1).map((p) => p.d));
		let h = Math.max(...palabras.slice(s.desde, s.hasta + 1).map((p) => p.h));
		if (s.parte) [d, h] = [d + (h - d) * s.parte[0], d + (h - d) * s.parte[1]];
		const tramo = keep[k];
		let a = Math.min(tramo.hasta, Math.max(d, tramo.desde));
		const b = Math.max(tramo.desde, Math.min(h, tramo.hasta));
		if (b - a < 1e-6) a = Math.max(tramo.desde, b - 1e-6);
		const r = remapearIntervalo(keep, a, b, velocidad);
		if (!r || r.tramo !== k) {
			throw fallo('pasar las palabras a la base', `«${s.t}» no quedó en su tramo al remapear`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {s, k, r});
		}
		return {
			i: palabras[s.desde].i,
			...(s.hasta > s.desde ? {i_hasta: palabras[s.hasta].i} : {}),
			j,
			t: s.t,
			d: redondo6(r.desde),
			h: redondo6(Math.max(r.desde, r.hasta)),
			tramo: k,
		};
	});
}

/** Palabras normalizadas de un texto (sin las vacías): con esto se compara "sin contar puntuación". */
export const palabrasNormalizadas = (textos: readonly string[]): string[] =>
	textos.flatMap((t) => t.split(/\s+/)).map(normalizarPalabra).filter(Boolean);

/** Palabras distintas entre dos textos (distancia de edición por palabras, sin contar puntuación). */
export function palabrasDistintas(a: readonly string[], b: readonly string[]): number {
	const x = palabrasNormalizadas(a);
	const y = palabrasNormalizadas(b);
	let previa = Array.from({length: y.length + 1}, (_, k) => k);
	for (let i = 1; i <= x.length; i++) {
		const actual = [i];
		for (let k = 1; k <= y.length; k++) actual[k] = Math.min(previa[k] + 1, actual[k - 1] + 1, previa[k - 1] + (x[i - 1] === y[k - 1] ? 0 : 1));
		previa = actual;
	}
	return previa[y.length];
}

// ───────────────────────── texto-propuesto.md ─────────────────────────

const seg = (t: number, decimales = 2): string => `${t.toFixed(decimales)} s`;
/** Un corte que se lleva al menos esto de voz sin palabras (s) se marca para revisar (una respiración fuerte dura ~0.2 s). */
const VOZ_A_REVISAR_S = 0.25;
const pct = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} %`;

export interface DatosTexto {
	slug: string;
	duracionOriginalS: number;
	/** Lo que va a durar la base (ya acelerada). */
	duracionBaseS: number;
	/** Velocidad de la base (sin el dato: ×1). */
	velocidad?: number;
	keep: readonly Tramo[];
	cortes: readonly Corte[];
	frases: readonly Frase[];
	palabras: readonly Palabra[];
	sinVoz: readonly boolean[];
	seleccion: readonly boolean[];
	junturas: readonly Juntura[];
	/** Hueco mínimo que se corta (s), para el resumen. */
	huecoMinimoS: number;
}

export function resumenCortes(d: Pick<DatosTexto, 'cortes'>): {silencios: number; silenciosS: number; descartadas: number; descartadasS: number; orillasS: number} {
	const suma = (cs: readonly Corte[]) => cs.reduce((s, c) => s + (c.hasta - c.desde), 0);
	const silencios = d.cortes.filter((c) => c.motivo === 'silencio');
	const descartadas = d.cortes.filter((c) => c.motivo === 'descartadas');
	return {
		silencios: silencios.length,
		silenciosS: suma(silencios),
		descartadas: descartadas.length,
		descartadasS: suma(descartadas),
		orillasS: suma(d.cortes.filter((c) => c.motivo === 'inicio' || c.motivo === 'final')),
	};
}

/** El texto que apruebas: guion (una frase por párrafo), frases descartadas con su motivo y lo que vale revisar. */
export function textoPropuestoMd(d: DatosTexto): string {
	const r = resumenCortes(d);
	const cambio = d.duracionOriginalS > 0 ? (d.duracionBaseS - d.duracionOriginalS) / d.duracionOriginalS : 0;
	const lineas: string[] = [
		`# Texto propuesto · ${d.slug}`,
		'',
		'<!--',
		'Esto es lo que quedaría en el video. Para quitar algo, bórralo del guion (solo de la sección "Guion").',
		'Para recuperar una frase descartada, pégala donde iba. Luego corre:',
		`  npx tsx herramientas/cortes.ts ${d.slug} --aplicar-texto proyectos/${d.slug}/texto-propuesto.md`,
		'Solo puedo quitar o recuperar lo que dijiste en el audio: no puedo agregar palabras ni cambiar el orden.',
		'-->',
		'',
		`- Crudo: ${seg(d.duracionOriginalS)} → base: ${seg(d.duracionBaseS)}${d.velocidad !== undefined && d.velocidad !== 1 ? ` a ×${d.velocidad} (${seg(d.duracionBaseS * d.velocidad)} sin acelerar)` : ''} (${pct(cambio)}), ${d.keep.length} tramo${d.keep.length === 1 ? '' : 's'}.`,
		`- Cortes: ${r.silencios} silencio${r.silencios === 1 ? '' : 's'} de más de ${d.huecoMinimoS} s (${seg(r.silenciosS, 1)}), ` +
			`${r.descartadas} con frases descartadas (${seg(r.descartadasS, 1)}) y ${seg(r.orillasS, 1)} de silencio al inicio y al final.`,
		'',
		'## Guion',
		'',
	];
	for (const frase of d.frases) {
		if (frase.descartada) continue;
		const texto = d.palabras
			.slice(frase.i0, frase.i1 + 1)
			.filter((_, k) => d.seleccion[frase.i0 + k])
			.map((p) => p.t)
			.join(' ');
		if (texto) lineas.push(texto, '');
	}
	const descartadas = d.frases.filter((f) => f.descartada);
	lineas.push('## Frases descartadas', '');
	if (descartadas.length === 0) lineas.push('Ninguna: no encontré tomas repetidas ni arranques en falso.', '');
	descartadas.forEach((f, k) => {
		lineas.push(`${k + 1}. «${f.texto}» (${seg(f.d)}–${seg(f.h)}) — ${f.motivo}.`);
	});
	if (descartadas.length > 0) lineas.push('');

	const revisar: string[] = [];
	const mudas = d.palabras.filter((_, j) => d.sinVoz[j] && d.seleccion[j]);
	if (mudas.length > 0) {
		revisar.push(`- Palabras que casi no se oyen (¿de verdad las dijiste?): ${mudas.map((p) => `«${p.t}» (${seg(p.d)})`).join(', ')}.`);
	}
	const cortadas = d.frases.filter((f) => f.cortada && !f.descartada);
	if (cortadas.length > 0) {
		revisar.push(`- Frases que terminan cortadas: ${cortadas.map((f) => `«${f.texto}» (${seg(f.d)})`).join(', ')}.`);
	}
	const conVoz = d.cortes.filter((c) => c.vozSinPalabrasS >= VOZ_A_REVISAR_S);
	if (conVoz.length > 0) {
		revisar.push(
			`- ${conVoz.length === 1 ? 'Un corte quita' : `${conVoz.length} cortes quitan`} sonido que whisper no transcribió (¿una respiración o algo que no entendió?; escúchalo en el borrador): ` +
				`${conVoz.map((c) => `${seg(c.desde)}–${seg(c.hasta)} (${seg(c.vozSinPalabrasS)})`).join(', ')}.`,
		);
	}
	if (d.junturas.length > 0) {
		const max = Math.max(...d.junturas.map((j) => j.desplazamientoMs));
		revisar.push(`- ${d.junturas.length} corte${d.junturas.length === 1 ? '' : 's'} entre palabras pegadas (sin silencio en medio); el borde se movió hasta ${max} ms. Escúchalos en el borrador.`);
	}
	lineas.push('## Para revisar', '');
	lineas.push(...(revisar.length > 0 ? revisar : ['Nada en especial.']), '');
	return conHuella(lineas.join('\n'));
}

const HUELLA = /\n<!-- huella ([0-9a-f]{64}) -->\n$/;
const sha256Texto = (texto: string): string => createHash('sha256').update(texto).digest('hex');

/** Firma el texto generado con su sha256 (en un comentario al final) para saber después si alguien lo editó. */
function conHuella(texto: string): string {
	return `${texto}\n<!-- huella ${sha256Texto(texto)} -->\n`;
}

/** ¿El archivo sigue tal como lo generó cortes.ts? (false si lo editaste o si no trae huella). */
export function sinEditar(contenido: string): boolean {
	const m = HUELLA.exec(contenido);
	return m !== null && sha256Texto(contenido.slice(0, m.index)) === m[1];
}

/**
 * Antes de reescribir texto-propuesto.md: si lo editaste a mano (y todavía no lo aplicaste), guarda una copia
 * numerada (texto-propuesto.editado-N.md) para no perder tus cambios. Devuelve la ruta de la copia, si hizo una.
 */
function respaldarSiEditado(ruta: string, nuevo: string): string | null {
	if (!existsSync(ruta)) return null;
	const actual = readFileSync(ruta, 'utf8');
	if (actual === nuevo || sinEditar(actual)) return null;
	let k = 1;
	const nombre = (x: number) => ruta.replace(/\.md$/, `.editado-${x}.md`);
	while (existsSync(nombre(k))) k++;
	writeFileSync(nombre(k), actual);
	return nombre(k);
}

// ───────────────────────── etapa completa ─────────────────────────

export interface OpcionesCortes {
	slug: string;
	/** Ruta del texto aprobado (un .txt o el texto-propuesto.md editado). Sin esto: propuesta automática. */
	aplicarTexto?: string;
	proyectos?: string;
	/** Parámetros explícitos: mandan sobre la calibración (y entonces no se lee ningún archivo). */
	parametros?: ParametrosCortes;
	/**
	 * Calibración: ruta de calibracion-cortes.json, o false para no usarla. Por defecto se busca en
	 * <carpeta de proyectos>/../estilo/calibracion-cortes.json; si no existe, quedan los valores por defecto.
	 */
	calibracion?: string | false;
	/** Ruta de vocabulario.json (sus correcciones valen como equivalencias al alinear tu texto). */
	vocabulario?: string;
	/**
	 * Velocidad de la base (--velocidad F, de 0.5 a 2; 1 = sin acelerar). Sin valor: la mediana de tus pares de
	 * calibracion-cortes.json si está marcada consistente; si no, ×1 (ver resolverVelocidadCortes).
	 */
	velocidad?: number;
	/** Pausa entre palabras (s) desde la que se corta (--hueco-minimo); sin valor: estilo/aires.json o la calibración. */
	huecoMinimo?: number;
}

export interface ResultadoCortes {
	slug: string;
	modo: 'propuesta' | 'aprobado';
	keep: Tramo[];
	duracionOriginalS: number;
	/** Lo que dura la base ya acelerada: suma de keep[] / F. */
	duracionBaseS: number;
	/** La suma de keep[] (la base a ×1). */
	duracionSinAcelerarS: number;
	velocidad: VelocidadCortes;
	frases: Frase[];
	cortes: Corte[];
	junturas: Juntura[];
	verificacion: Verificacion;
	palabrasBase: PalabraBase[];
	/** El texto final (las palabras de la base, unidas con espacios). */
	texto: string;
	/** Palabras del audio que ya no van (respecto a todas las de la transcripción). */
	palabrasQuitadas: number;
	archivos: {cortes: string; transcripcionBase: string; texto: string};
	/** Copia de tu texto-propuesto.md editado a mano, si había uno sin aplicar antes de reescribirlo. */
	respaldo: string | null;
	/** La calibración que se usó (null: valores por defecto o parámetros explícitos). */
	calibracion: {archivo: string; sha256: string; cambios: string[]} | null;
	/** De dónde salió huecoMinimoS si no fue de la calibración (--hueco-minimo o estilo/aires.json). */
	aires: {huecoMinimoS: number; umbralSobrePisoDb?: number; fuente: string} | null;
	segundos: number;
}

/** Cuadros útiles del crudo: lo más corto entre el wav y lo que la ingesta midió del original (video, audio y contenedor). */
export function limiteDelCrudo(slug: string, proyectos: string, wav: Wav): number {
	const delWav = wav.duracionS;
	const sondeo = (leerManifest(slug, proyectos) as {sondeo?: {duracion?: unknown; video?: {duracion?: unknown}; audio?: {duracion?: unknown}}} | null)?.sondeo;
	const numero = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
	const candidatos = [delWav, numero(sondeo?.duracion), numero(sondeo?.video?.duracion), numero(sondeo?.audio?.duracion)].filter((x): x is number => x !== null);
	return cuadroAbajo(Math.min(...candidatos)) / FPS;
}

const relativa = (ruta: string): string => {
	const r = relative(RAIZ, ruta);
	return r.startsWith('..') ? ruta : r;
};

/** Escribe un archivo de forma atómica (temporal + rename): nunca queda a medias. */
function escribirAtomico(ruta: string, contenido: string): void {
	const temporal = `${ruta}.tmp-${process.pid}`;
	writeFileSync(temporal, contenido);
	renameSync(temporal, ruta);
}

export async function ejecutarCortes(opciones: OpcionesCortes): Promise<ResultadoCortes> {
	const t0 = performance.now();
	const proyectos = opciones.proyectos ?? DIR_PROYECTOS;
	const calibracion =
		opciones.parametros !== undefined || opciones.calibracion === false
			? null
			: leerCalibracionCortes(opciones.calibracion ?? rutaCalibracionCortes(proyectos));
	const p0 = opciones.parametros ?? calibracion?.parametros ?? PARAMETROS_CORTES;
	// Tus aires: estilo/aires.json (no con parámetros explícitos ni --sin-calibracion); --hueco-minimo solo cambia el
	// hueco y conserva el umbral y los sueltos del archivo.
	const sinPreferencias = opciones.parametros !== undefined || opciones.calibracion === false;
	const preferencias = sinPreferencias ? {velocidad: null, aires: null} : preferenciasDeCortes(proyectos);
	const airesArchivo = (() => {
		const a = preferencias.aires;
		return a ? {huecoMinimoS: a.huecoMinimoS, umbralSobrePisoDb: a.umbralSobrePisoDb, quitarSueltosS: a.quitarSueltosS, fuente: `${relativa(a.archivo)} (${a.decision})`} : null;
	})();
	const aires =
		opciones.huecoMinimo !== undefined
			? {
					huecoMinimoS: opciones.huecoMinimo,
					umbralSobrePisoDb: airesArchivo?.umbralSobrePisoDb,
					quitarSueltosS: airesArchivo?.quitarSueltosS,
					fuente: airesArchivo ? `--hueco-minimo; umbral y sueltos de ${airesArchivo.fuente}` : '--hueco-minimo',
				}
			: airesArchivo;
	const p: ParametrosCortes = aires
		? {
				...p0,
				huecoMinimoS: aires.huecoMinimoS,
				...(aires.umbralSobrePisoDb !== undefined ? {energia: {...p0.energia, umbralSobrePisoDb: aires.umbralSobrePisoDb}} : {}),
				...(aires.quitarSueltosS !== undefined ? {quitarSueltosS: aires.quitarSueltosS} : {}),
			}
		: p0;
	const velocidad = resolverVelocidadCortes(
		opciones.velocidad,
		calibracion,
		preferencias.velocidad,
	);
	const F = velocidad.factor;
	const slug = validarSlug(opciones.slug);
	const dir = dirProyecto(slug, proyectos);
	const rutaTranscripcion = resolve(dir, ARCHIVOS.transcripcion);
	const rutaAudio = resolve(dir, ARCHIVOS.audio);

	const palabras = leerTranscripcion(rutaTranscripcion);
	if (!existsSync(rutaAudio)) {
		throw fallo('armar los cortes', `no existe ${relativa(rutaAudio)}`, `corre primero la ingesta del crudo con --slug ${slug}`, 2);
	}
	const wav = leerWav(rutaAudio, 16000);
	const limiteS = limiteDelCrudo(slug, proyectos, wav);

	// 1–2. Bordes por energía y tomas repetidas (con los bordes ya refinados: las pausas se miden mejor).
	const energia = analizarEnergia(wav, palabras, p.energia);
	const {limites, sinVoz} = refinarPalabras(energia, palabras, p.orillaAjena);
	const {frases} = detectarTomas(
		palabras.map((w, j) => ({t: w.t, d: limites[j].d, h: limites[j].h})),
		p.tomas,
	);
	const propuesta = new Array<boolean>(palabras.length).fill(false);
	for (const f of frases) if (!f.descartada) for (let j = f.i0; j <= f.i1; j++) propuesta[j] = true;

	// Selección: la propuesta, o lo que diga tu texto.
	let seleccion = propuesta;
	let salida: PalabraSalida[] = palabras.flatMap((w, j) => (propuesta[j] ? [{t: w.t, desde: j, hasta: j}] : []));
	const juntas = new Set<number>();
	let textoAprobado: {ruta: string; tokens: Token[]; contenido: string} | null = null;
	if (opciones.aplicarTexto !== undefined) {
		const ruta = resolve(opciones.aplicarTexto);
		let contenido: string;
		try {
			contenido = readFileSync(ruta, 'utf8');
		} catch {
			throw fallo('aplicar el texto aprobado', `no existe ${relativa(ruta)}`, 'revisa la ruta del archivo con tu texto', 2);
		}
		const tokens = leerTextoAprobado(contenido);
		if (tokens.length === 0) {
			throw fallo('aplicar el texto aprobado', `${relativa(ruta)} no trae ninguna palabra (o su sección "## Guion" está vacía)`, 'pon el guion que quieres que quede y vuelve a correr', 2);
		}
		const equivalencias = leerEquivalencias(opciones.vocabulario);
		const alineacion = alinearTexto(tokens, palabras, propuesta, equivalencias);
		if (alineacion.faltantes.length > 0) {
			const explicaciones = explicarFaltantes(alineacion, tokens, palabras, equivalencias);
			const lista = explicaciones.slice(0, 5).join('; ') + (explicaciones.length > 5 ? `; y ${explicaciones.length - 5} más` : '');
			throw fallo(
				'aplicar el texto aprobado',
				`${explicaciones.length === 1 ? '1 palabra de tu texto no está' : `${explicaciones.length} palabras de tu texto no están`} en el audio en ese orden: ${lista}`,
				'quítalas o déjalas como las dijiste (solo puedo quitar o recuperar lo que está en el audio, no agregar ni reordenar); si whisper entendió mal un nombre, agrega la corrección en biblioteca/vocabulario.json y vuelve a transcribir',
				2,
				{faltantes: alineacion.faltantes.map((k) => tokens[k])},
			);
		}
		seleccion = new Array<boolean>(palabras.length).fill(false);
		salida = [];
		for (const par of alineacion.pares) {
			for (let w = par.w0; w <= par.w1; w++) seleccion[w] = true;
			if (par.w1 > par.w0) juntas.add(par.w0);
			if (par.t1 > par.t0) {
				const l0 = tokens[par.t0].norm.length;
				const corte = l0 / (l0 + tokens[par.t1].norm.length);
				salida.push({t: tokens[par.t0].texto, desde: par.w0, hasta: par.w1, parte: [0, corte]});
				salida.push({t: tokens[par.t1].texto, desde: par.w0, hasta: par.w1, parte: [corte, 1]});
			} else {
				salida.push({t: tokens[par.t0].texto, desde: par.w0, hasta: par.w1});
			}
		}
		textoAprobado = {ruta, tokens, contenido};
	}

	// 3–4. keep[].
	const r = construirKeep({limites, seleccion, juntas, energia, limiteS, parametros: p});
	validarKeep(r.keep);

	// 5. Verificación.
	const verificacion = verificarCortes(r.keep, r.limites, seleccion);
	if (!verificacionLimpia(verificacion)) {
		throw fallo(
			'verificar los cortes',
			`${verificacion.dentroDePalabra.length} bordes dentro de una palabra, ${verificacion.partidas.length} palabras partidas y ${verificacion.descartadasDentro.length} descartadas dentro de un tramo`,
			'revisa proyectos/_logs/fallos.log y avísame (es un error de cortes.ts)',
			1,
			verificacion,
		);
	}

	const palabrasBase = armarTranscripcionBase(r.keep, palabras, salida, r.tramoDe, F);
	const esperado = textoAprobado ? textoAprobado.tokens.map((t) => t.texto) : salida.map((s) => s.t);
	const distintas = palabrasDistintas(palabrasBase.map((w) => w.t), esperado);
	if (distintas !== 0 || palabrasBase.map((w) => w.t).join(' ') !== esperado.join(' ')) {
		throw fallo('verificar el texto de la base', `quedaron ${distintas} palabras distintas al texto esperado`, 'revisa proyectos/_logs/fallos.log y avísame (es un error de cortes.ts)', 1);
	}

	const duracionOriginalS = limiteS;
	const duracionSinAcelerarS = duracionBase(r.keep);
	const duracionBaseS = duracionBase(r.keep, F);
	const modo = textoAprobado ? 'aprobado' : 'propuesta';

	// Archivos.
	const rutaCortes = resolve(dir, ARCHIVOS.cortes);
	const rutaBase = resolve(dir, ARCHIVOS.transcripcionBase);
	const rutaTexto = resolve(dir, textoAprobado ? ARCHIVOS.textoAprobado : ARCHIVOS.textoPropuesto);
	const resumen = resumenCortes(r);
	const texto = palabrasBase.map((w) => w.t).join(' ');
	let respaldo: string | null = null;

	escribirAtomico(
		rutaCortes,
		`${JSON.stringify(
			{
				keep: r.keep,
				// base.ts acelera la base con esta velocidad (los tiempos de transcripcion-base.json ya van divididos entre ella).
				velocidad: F,
				velocidad_fuente: velocidad.fuente,
				...(aires ? {aires: {hueco_minimo_s: aires.huecoMinimoS, umbral_sobre_piso_db: aires.umbralSobrePisoDb ?? null, fuente: aires.fuente}} : {}),
				metodo: textoAprobado
					? `texto aprobado (${relativa(textoAprobado.ruta)}) + silencios de más de ${p.huecoMinimoS} s`
					: `propuesta automática: silencios de más de ${p.huecoMinimoS} s y tomas repetidas`,
				parametros: p,
				calibracion: calibracion
					? {archivo: relativa(calibracion.archivo), sha256: calibracion.sha256, cambios: calibracion.cambios}
					: {archivo: null, nota: opciones.parametros !== undefined ? 'parámetros explícitos' : 'valores por defecto (sin calibracion-cortes.json)'},
				texto: textoAprobado
					? {modo, archivo: relativa(textoAprobado.ruta), sha256: sha256Texto(textoAprobado.contenido)}
					: {modo, archivo: ARCHIVOS.textoPropuesto},
				duracion_original_s: redondo6(duracionOriginalS),
				duracion_base_s: redondo6(duracionBaseS),
				duracion_sin_acelerar_s: redondo6(duracionSinAcelerarS),
				tramos: r.keep.length,
				resumen: {
					silencios: resumen.silencios,
					silencios_s: redondo6(resumen.silenciosS),
					cortes_con_descartadas: resumen.descartadas,
					descartadas_s: redondo6(resumen.descartadasS),
					inicio_y_final_s: redondo6(resumen.orillasS),
					frases: frases.length,
					frases_descartadas: frases.filter((f) => f.descartada).length,
					palabras: palabras.length,
					palabras_que_quedan: palabrasBase.length,
				},
				cortes: r.cortes.map((c) => ({
					desde: c.desde,
					hasta: c.hasta,
					duracion_s: redondo6(c.hasta - c.desde),
					motivo: c.motivo,
					palabras: c.palabras.map((j) => palabras[j].i),
					voz_s: redondo6(c.vozS),
					voz_sin_palabras_s: redondo6(c.vozSinPalabrasS),
				})),
				frases: frases.map((f) => ({
					i0: palabras[f.i0].i,
					i1: palabras[f.i1].i,
					texto: f.texto,
					d: redondo6(f.d),
					h: redondo6(f.h),
					descartada: f.descartada,
					motivo: f.motivo,
					...(f.descartada ? {tipo: f.tipo, por: f.por, similitud: f.similitud} : {}),
				})),
				verificacion: {
					bordes: verificacion.bordes,
					dentro_de_palabra: verificacion.dentroDePalabra.length,
					palabras_partidas: verificacion.partidas.length,
					descartadas_dentro: verificacion.descartadasDentro.length,
					junturas: r.junturas.map((j) => ({i: palabras[j.palabra].i, t: palabras[j.palabra].t, lado: j.lado, desplazamiento_ms: j.desplazamientoMs, borde_s: j.borde})),
					palabras_distintas_al_texto: distintas,
				},
				energia: {
					voz_mediana_dbfs: redondo6(energia.vozMedianaDbfs),
					umbral_mediano_dbfs: redondo6(mediana(energia.umbralDbfs)),
					piso_mediano_dbfs: redondo6(mediana(energia.pisoDbfs)),
					palabras_recortadas: limites.filter((l, j) => l.d > palabras[j].d + 1e-9 || l.h < palabras[j].h - 1e-9).length,
					palabras_sin_voz: palabras.flatMap((w, j) => (sinVoz[j] ? [{i: w.i, t: w.t, d: w.d}] : [])),
				},
			},
			null,
			'\t',
		)}\n`,
	);
	escribirAtomico(
		rutaBase,
		`${JSON.stringify(
			{
				fuente: ARCHIVOS.transcripcion,
				cortes: ARCHIVOS.cortes,
				texto: modo,
				// d y h van en la base ya acelerada por esta velocidad; duracion_base_s = suma de keep[] / velocidad.
				velocidad: F,
				duracion_base_s: redondo6(duracionBaseS),
				duracion_sin_acelerar_s: redondo6(duracionSinAcelerarS),
				tramos: r.keep.length,
				palabras: palabrasBase,
			},
			null,
			'\t',
		)}\n`,
	);
	if (textoAprobado) {
		if (resolve(textoAprobado.ruta) !== rutaTexto) {
			const porLinea = new Map<number, string[]>();
			for (const t of textoAprobado.tokens) porLinea.set(t.linea, [...(porLinea.get(t.linea) ?? []), t.texto]);
			escribirAtomico(rutaTexto, `${[...porLinea.values()].map((ws) => ws.join(' ')).join('\n')}\n`);
		}
	} else {
		const md = textoPropuestoMd({slug, duracionOriginalS, duracionBaseS, velocidad: F, keep: r.keep, cortes: r.cortes, frases, palabras, sinVoz, seleccion, junturas: r.junturas, huecoMinimoS: p.huecoMinimoS});
		respaldo = respaldarSiEditado(rutaTexto, md);
		escribirAtomico(rutaTexto, md);
	}

	// Manifest: la etapa con sus entradas y salidas (base.ts hashea cortes.json por su cuenta). Los archivos no llevan
	// fecha: con las mismas entradas salen idénticos y base.ts no tiene que volver a codificar (la fecha queda aquí).
	const segundos = (performance.now() - t0) / 1000;
	const entradas: ArchivoHash[] = [await hashearArchivo(rutaTranscripcion), await hashearArchivo(rutaAudio)];
	if (textoAprobado) entradas.push(await hashearArchivo(textoAprobado.ruta));
	if (calibracion) entradas.push(await hashearArchivo(calibracion.archivo));
	const salidas: ArchivoHash[] = [await hashearArchivo(rutaCortes, dir), await hashearArchivo(rutaBase, dir), await hashearArchivo(rutaTexto, dir)];
	registrarEtapa(
		slug,
		'cortes',
		{
			estado: 'terminada',
			entradas,
			parametros: {...p, modo, velocidad: F},
			salidas,
			extra: {
				duracion_proceso_s: Number(segundos.toFixed(3)),
				duracion_original_s: redondo6(duracionOriginalS),
				duracion_base_s: redondo6(duracionBaseS),
				duracion_sin_acelerar_s: redondo6(duracionSinAcelerarS),
				velocidad_fuente: velocidad.fuente,
				tramos: r.keep.length,
				dentro_de_palabra: verificacion.dentroDePalabra.length,
				junturas: r.junturas.length,
			},
		},
		proyectos,
	);

	return {
		slug,
		modo,
		keep: r.keep,
		duracionOriginalS,
		duracionBaseS,
		duracionSinAcelerarS,
		velocidad,
		frases,
		cortes: r.cortes,
		junturas: r.junturas,
		verificacion,
		palabrasBase,
		texto,
		palabrasQuitadas: palabras.length - seleccion.filter(Boolean).length,
		archivos: {cortes: rutaCortes, transcripcionBase: rutaBase, texto: rutaTexto},
		respaldo,
		calibracion: calibracion ? {archivo: calibracion.archivo, sha256: calibracion.sha256, cambios: calibracion.cambios} : null,
		aires,
		segundos,
	};
}

export function resumenResultado(r: ResultadoCortes): string {
	const c = resumenCortes(r);
	const cambio = r.duracionOriginalS > 0 ? (r.duracionBaseS - r.duracionOriginalS) / r.duracionOriginalS : 0;
	const descartadas = r.frases.filter((f) => f.descartada).length;
	const lineas = [
		`Cortes listos (${r.modo === 'aprobado' ? 'texto aprobado' : 'propuesta'}): ${seg(r.duracionOriginalS)} → ${seg(r.duracionBaseS)} (${pct(cambio)}), ${r.keep.length} tramo${r.keep.length === 1 ? '' : 's'}.`,
		r.velocidad.factor === 1
			? `  Velocidad: ×1, la base no se acelera (${r.velocidad.fuente}).`
			: `  Velocidad: ×${r.velocidad.factor} (${r.velocidad.fuente}): ${seg(r.duracionSinAcelerarS)} sin acelerar → ${seg(r.duracionBaseS)}; los tiempos de ${ARCHIVOS.transcripcionBase} ya van en la base acelerada.`,
		`  Cortes: ${c.silencios} silencios (${seg(c.silenciosS, 1)}), ${c.descartadas} con palabras quitadas (${seg(c.descartadasS, 1)}), inicio y final (${seg(c.orillasS, 1)}).`,
		`  Frases: ${r.frases.length}, descartadas por la propuesta: ${descartadas}. Palabras que quedan: ${r.palabrasBase.length} (se quitan ${r.palabrasQuitadas}).`,
		`  Verificación: ${r.verificacion.dentroDePalabra.length} bordes dentro de una palabra (de ${r.verificacion.bordes}), ${r.junturas.length} junturas entre palabras pegadas.`,
		r.calibracion
			? `  Parámetros calibrados con tus reels (${relativa(r.calibracion.archivo)}): ${r.calibracion.cambios.length > 0 ? r.calibracion.cambios.join(', ') : 'iguales a los de por defecto'}.`
			: '  Parámetros: los de por defecto (no hay estilo/calibracion-cortes.json o pediste --sin-calibracion).',
		...(r.aires
			? [`  Aires: se corta toda pausa de más de ${r.aires.huecoMinimoS} s${r.aires.umbralSobrePisoDb !== undefined ? ` y la voz empieza a ${r.aires.umbralSobrePisoDb} dB sobre el piso` : ''} (${r.aires.fuente}).`]
			: []),
		`  Archivos: ${relativa(r.archivos.cortes)}, ${relativa(r.archivos.transcripcionBase)}, ${relativa(r.archivos.texto)} (${r.segundos.toFixed(2)} s).`,
	];
	if (r.respaldo) lineas.push(`  Tu ${ARCHIVOS.textoPropuesto} tenía cambios a mano: los guardé en ${relativa(r.respaldo)} antes de reescribirlo.`);
	if (r.modo === 'propuesta') {
		lineas.push(`  Siguiente paso: revisa ${relativa(r.archivos.texto)}; si quitas o recuperas algo, corre npx tsx herramientas/cortes.ts ${r.slug} --aplicar-texto ${relativa(r.archivos.texto)}.`);
	}
	return lineas.join('\n');
}

async function main(): Promise<void> {
	let valores;
	let posicionales: string[];
	try {
		({values: valores, positionals: posicionales} = parseArgs({
			allowPositionals: true,
			options: {
				'aplicar-texto': {type: 'string'},
				'sin-calibracion': {type: 'boolean', default: false},
				velocidad: {type: 'string'},
				'hueco-minimo': {type: 'string'},
				ayuda: {type: 'boolean', short: 'h', default: false},
			},
		}));
	} catch (error) {
		const mensaje = error instanceof Error ? error.message : String(error);
		const desconocida = /Unknown option '([^']+)'/.exec(mensaje);
		const sinValor = /argument missing/.test(mensaje);
		const opcion = /'(--[a-z-]+)/.exec(mensaje)?.[1];
		const porque = desconocida
			? `no conozco la opción ${desconocida[1]}`
			: sinValor
				? opcion === '--velocidad' || opcion === '--hueco-minimo'
					? `a ${opcion} le falta el número`
					: 'a --aplicar-texto le falta la ruta del archivo'
				: 'los argumentos no tienen la forma esperada';
		throw fallo('leer los argumentos', porque, `usa ${USO}`, 2, mensaje);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	if (posicionales.length !== 1) {
		throw fallo('armar los cortes', posicionales.length === 0 ? 'falta el slug del proyecto' : 'me pasaste más de un slug', `usa ${USO}`, 2);
	}
	const resultado = await ejecutarCortes({
		slug: posicionales[0],
		aplicarTexto: valores['aplicar-texto'],
		...(valores['sin-calibracion'] ? {calibracion: false as const} : {}),
		...(valores.velocidad !== undefined ? {velocidad: velocidadDeTexto(valores.velocidad)} : {}),
		...(valores['hueco-minimo'] !== undefined ? {huecoMinimo: huecoMinimoDeTexto(valores['hueco-minimo'])} : {}),
	});
	console.log(resumenResultado(resultado));
}

/** --velocidad F → número de 0.5 a 2 (código 2 si no lo es). */
export function velocidadDeTexto(valor: string): number {
	const n = Number(valor);
	if (valor.trim() === '' || !esVelocidadValida(n)) {
		throw fallo('leer los argumentos', `--velocidad tiene que ser un número de ${VELOCIDAD_MIN} a ${VELOCIDAD_MAX} (me llegó "${valor}")`, `usa ${USO}`, 2);
	}
	return n;
}

if (esPrincipal(import.meta.url)) void correr(main);
