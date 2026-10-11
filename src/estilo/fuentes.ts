/**
 * Fuentes candidatas para los subtítulos y el estilo de subtítulo que comparten el agrupador
 * (herramientas/subtitulos.ts, en Node) y el componente (src/reel/Subtitulo.tsx, en el navegador).
 *
 * Este archivo es puro: sin React, sin Remotion y sin Node. Así lo pueden importar los dos lados y
 * el ancho que mide el agrupador sale del MISMO archivo de fuente, peso y texto que dibuja el render.
 *
 * Las tres candidatas son OFL-1.1 y vienen de github.com/google/fonts (commit fijo). Los .ttf son instancias
 * estáticas hechas con fonttools (`sh biblioteca/fuentes/preparar.sh`); no se versionan, pero su sha256 sí.
 * La fuente PROVISIONAL de la Fase 1 se elige comparando con recortes reales de tus reels; mientras tanto,
 * la activa por defecto es TikTok Sans 600 y se cambia con `fuente` en el estilo (o `--fuente` en el agrupador).
 */

export type IdFuente = 'tiktok-sans' | 'instrument-sans' | 'inter';

export type ArchivoFuente = {
	/** Ruta desde la raíz del proyecto. Es la misma para staticFile(), porque public/biblioteca → biblioteca. */
	ruta: string;
	sha256: string;
};

export type CandidataFuente = {
	id: IdFuente;
	/** Nombre de la familia tal como la publica su autor. */
	nombre: string;
	/** Nombre con el que se registra en el navegador. Es propio para no chocar con una fuente instalada en la Mac. */
	familiaCss: string;
	licencia: 'OFL-1.1';
	/** Archivo variable de origen en google/fonts, fijado por commit. */
	origen: string;
	/** Ejes fijos de las instancias, además de wght (los de sus instancias con nombre). */
	ejes: Readonly<Record<string, number>>;
	/** Archivo por peso. */
	archivos: Readonly<Record<number, ArchivoFuente>>;
	pesoBase: number;
	pesoResaltado: number;
	/** Alto de mayúscula (OS/2 sCapHeight) como fracción del em. Igual en los dos pesos; lo verifica la prueba unitaria. */
	altoMayuscula: number;
	unidadesEm: number;
};

/** Commit de github.com/google/fonts del que salieron los archivos variables (3 de octubre de 2026). */
export const COMMIT_GOOGLE_FONTS = '9710da1eacb3be272583c3224dcb70f9da6eadbb';
const RAW = `https://raw.githubusercontent.com/google/fonts/${COMMIT_GOOGLE_FONTS}/ofl`;

export const CANDIDATAS: Readonly<Record<IdFuente, CandidataFuente>> = {
	'tiktok-sans': {
		id: 'tiktok-sans',
		nombre: 'TikTok Sans',
		familiaCss: 'Editor TikTok Sans',
		licencia: 'OFL-1.1',
		origen: `${RAW}/tiktoksans/TikTokSans%5Bopsz%2Cslnt%2Cwdth%2Cwght%5D.ttf`,
		ejes: {opsz: 36, wdth: 100, slnt: 0},
		archivos: {
			600: {
				ruta: 'biblioteca/fuentes/tiktok-sans/TikTokSans-SemiBold.ttf',
				sha256: 'd4f0326ad15b1b33e12de03906f92e1ac273b7be2855d05c80446771d687550f',
			},
			800: {
				ruta: 'biblioteca/fuentes/tiktok-sans/TikTokSans-ExtraBold.ttf',
				sha256: 'd020e2219da84f2ea17262807472e38bafe675d6493615042a5ee775b465dab6',
			},
		},
		pesoBase: 600,
		pesoResaltado: 800,
		altoMayuscula: 705 / 1000,
		unidadesEm: 1000,
	},
	'instrument-sans': {
		id: 'instrument-sans',
		nombre: 'Instrument Sans',
		familiaCss: 'Editor Instrument Sans',
		licencia: 'OFL-1.1',
		origen: `${RAW}/instrumentsans/InstrumentSans%5Bwdth%2Cwght%5D.ttf`,
		ejes: {wdth: 100},
		archivos: {
			600: {
				ruta: 'biblioteca/fuentes/instrument-sans/InstrumentSans-SemiBold.ttf',
				sha256: 'a63d55f34a30bac7377b13f3d66d1b1fae0c72f7ae5b364653a029a4e9f8da69',
			},
			700: {
				ruta: 'biblioteca/fuentes/instrument-sans/InstrumentSans-Bold.ttf',
				sha256: 'b4c8e52409c0a58a238a4e7b558f3354c8e6550b8facbe9e5f3d07af7e269124',
			},
		},
		pesoBase: 600,
		// Su eje wght llega hasta 700: es el resaltado más grueso que tiene.
		pesoResaltado: 700,
		altoMayuscula: 720 / 1000,
		unidadesEm: 1000,
	},
	inter: {
		id: 'inter',
		nombre: 'Inter',
		familiaCss: 'Editor Inter',
		licencia: 'OFL-1.1',
		origen: `${RAW}/inter/Inter%5Bopsz%2Cwght%5D.ttf`,
		// opsz 14 es el de sus instancias con nombre; "Inter Display" sería opsz 32.
		ejes: {opsz: 14},
		archivos: {
			600: {
				ruta: 'biblioteca/fuentes/inter/Inter-SemiBold.ttf',
				sha256: '4e2353ba2b6a3514acdfe5d2409ad59468bb4d0b8ee01aabf03120ecf2dae95a',
			},
			// 700: entre 600 (menos tinta que la tuya) y 800 (15 % más tinta) en la comparación de tipografía de estilo.json.
			700: {
				ruta: 'biblioteca/fuentes/inter/Inter-Bold.ttf',
				sha256: 'd289ec2c941d44e340fdc16adae7e82dbb3674c3ce6ed7d7c0d5d0558f5aa73e',
			},
			800: {
				ruta: 'biblioteca/fuentes/inter/Inter-ExtraBold.ttf',
				sha256: '0a63d47e990a5107e1fa64c5c904458fdebf11c86f3a56f9c0e07a42bd8f13e7',
			},
		},
		pesoBase: 600,
		pesoResaltado: 800,
		altoMayuscula: 1490 / 2048,
		unidadesEm: 2048,
	},
};

export const IDS_FUENTE = Object.keys(CANDIDATAS) as IdFuente[];

/** Fuente activa por defecto (provisional hasta compararla con recortes reales de tus reels). */
export const FUENTE_POR_DEFECTO: {id: IdFuente; peso: number} = {id: 'tiktok-sans', peso: 600};

export function esIdFuente(valor: unknown): valor is IdFuente {
	return typeof valor === 'string' && Object.prototype.hasOwnProperty.call(CANDIDATAS, valor);
}

export function candidata(id: IdFuente): CandidataFuente {
	if (!esIdFuente(id)) {
		throw new Error(`No conozco la fuente "${String(id)}". Las candidatas son: ${IDS_FUENTE.join(', ')}.`);
	}
	return CANDIDATAS[id];
}

/** Pesos que de verdad tiene la candidata, de menor a mayor. */
export function pesosDisponibles(id: IdFuente): number[] {
	return Object.keys(candidata(id).archivos)
		.map(Number)
		.sort((a, b) => a - b);
}

/**
 * El peso que se usa de verdad: el pedido si existe y, si no, el más cercano (empate → el más grueso).
 * El agrupador mide con este peso y el componente dibuja con este mismo peso.
 */
export function pesoDisponible(id: IdFuente, pedido: number): number {
	const pesos = pesosDisponibles(id);
	let mejor = pesos[0];
	for (const p of pesos) {
		const d = Math.abs(p - pedido);
		const dMejor = Math.abs(mejor - pedido);
		if (d < dMejor || (d === dMejor && p > mejor)) mejor = p;
	}
	return mejor;
}

export function archivoFuente(id: IdFuente, peso: number): ArchivoFuente {
	return candidata(id).archivos[pesoDisponible(id, peso)];
}

// ───────────────────────── estilo de subtítulo ─────────────────────────

export type ResaltadoSubtitulo = {
	/** Apagado por defecto: la Fase 2 mide si tus reels resaltan, con qué peso, color y escala. */
	activo: boolean;
	peso: number;
	/** null = mismo color que el resto del texto. */
	color: string | null;
	/** Escala del tamaño de letra de la palabra resaltada (1 = igual). */
	escala: number;
};

/**
 * Cómo se dibuja un subtítulo. Todo en px de la base 1080×1920.
 * Los valores por defecto son SUPUESTOS hasta que medir.ts los saque de tus reels publicados.
 */
export type EstiloSubtitulo = {
	fuente: IdFuente;
	peso: number;
	/** Tamaño de letra (font-size). */
	tamano_px: number;
	color: string;
	/** Grosor VISIBLE del borde por fuera de la letra. El trazo CSS mide el doble (la mitad queda bajo el relleno). */
	borde_px: number;
	color_borde: string;
	/** Centro horizontal del subtítulo. */
	x: number;
	/** Centro vertical de las mayúsculas (punto medio entre la línea base y el alto de mayúscula), si el subtítulo no trae caja.y. */
	y: number;
	/** Ancho máximo, ya con el borde. */
	ancho_max: number;
	/** letter-spacing. */
	espaciado_px: number;
	mayusculas: boolean;
	/** Quita la puntuación de las orillas de cada palabra al dibujarla (el texto de la EDL no cambia). */
	quitar_puntuacion: boolean;
	resaltado: ResaltadoSubtitulo;
};

export type EstiloSubtituloParcial = Partial<Omit<EstiloSubtitulo, 'resaltado'>> & {resaltado?: Partial<ResaltadoSubtitulo>};

/** Lienzo base de la EDL. */
export const BASE_ANCHO = 1080;
export const BASE_ALTO = 1920;

/** Blanco con borde negro, TikTok Sans 600. Tamaño, borde, Y y ancho son supuestos hasta medirlos. */
export const ESTILO_SUBTITULO_POR_DEFECTO: EstiloSubtitulo = {
	fuente: FUENTE_POR_DEFECTO.id,
	peso: FUENTE_POR_DEFECTO.peso,
	tamano_px: 72,
	color: '#FFFFFF',
	borde_px: 5,
	color_borde: '#000000',
	x: BASE_ANCHO / 2,
	y: 1200,
	ancho_max: Math.round(BASE_ANCHO * 0.8),
	espaciado_px: 0,
	mayusculas: false,
	quitar_puntuacion: false,
	resaltado: {activo: false, peso: 800, color: null, escala: 1},
};

/** Junta un estilo parcial con el de por defecto (el resaltado también se junta campo por campo). */
export function resolverEstilo(parcial: EstiloSubtituloParcial = {}): EstiloSubtitulo {
	const definidos = Object.fromEntries(Object.entries(parcial).filter(([, v]) => v !== undefined)) as EstiloSubtituloParcial;
	const resaltado = Object.fromEntries(
		Object.entries(parcial.resaltado ?? {}).filter(([, v]) => v !== undefined),
	) as Partial<ResaltadoSubtitulo>;
	return {
		...ESTILO_SUBTITULO_POR_DEFECTO,
		...definidos,
		resaltado: {...ESTILO_SUBTITULO_POR_DEFECTO.resaltado, ...resaltado},
	} as EstiloSubtitulo;
}

const APERTURA_ORILLA = /^[¿¡«“‘"'([{]+/u;
const CIERRE_ORILLA = /[.,;:!?…»”’"')\]}]+$/u;

/**
 * Texto que se dibuja (y se mide) para una palabra: aplica `quitar_puntuacion` y `mayusculas`.
 * Si quitar la puntuación la deja vacía, se queda como estaba.
 */
export function textoVisible(t: string, estilo: Pick<EstiloSubtitulo, 'mayusculas' | 'quitar_puntuacion'>): string {
	let texto = t;
	if (estilo.quitar_puntuacion) {
		const limpio = texto.replace(APERTURA_ORILLA, '').replace(CIERRE_ORILLA, '');
		if (limpio.length > 0) texto = limpio;
	}
	return estilo.mayusculas ? texto.toLocaleUpperCase('es') : texto;
}

/** Descriptores de la fuente para el navegador: ascent = alto de mayúscula y descent = 0, así la línea base cae justo al pie de la caja. */
export function metricasCss(id: IdFuente): {ascentOverride: string; descentOverride: string; lineGapOverride: string} {
	const c = candidata(id);
	return {ascentOverride: `${(c.altoMayuscula * 100).toFixed(4)}%`, descentOverride: '0%', lineGapOverride: '0%'};
}
