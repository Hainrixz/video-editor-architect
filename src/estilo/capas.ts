/**
 * Estilos y valores por defecto de las capas del reel: titular, tarjetas, stickers e inserts (más los parámetros
 * del zoom y del desenfoque). Todo en px de la base 1080×1920.
 *
 * Este archivo es puro: sin React, sin Remotion y sin Node (como src/estilo/fuentes.ts). Lo usan los componentes
 * de src/reel/ y lo pueden usar las herramientas (layout, validar) para saber cuánto mide cada cosa.
 *
 * De dónde salen los números: de los reels publicados del creador de referencia (solo lectura), medidos
 * cuadro por cuadro con ffmpeg y scripts de píxeles, sin gastar nada (scripts en out/f3-componentes/_medir/, datos crudos
 * en out/f3-componentes/referencia/mediciones/). Cada valor medido trae su n y su fuente en MEDICIONES_CAPAS; lo que no
 * se midió es un supuesto y lo dice. pruebas/integracion/f3-componentes.ts compara el render contra esos números. Cuando
 * estilo/estilo.json traiga lo medido con más reels (Fase 2), sus valores entran por `edicion.estilos.*`, que
 * pisan estos campo por campo.
 */
import {aCuadro, type Edicion} from '../esquema/edicion';
import {BASE_ALTO, BASE_ANCHO, candidata, esIdFuente, pesoDisponible, type IdFuente} from './fuentes';
import {
	ESCRITURA_MEDIDA,
	ESCRITURA_PROMPT_MEDIDA,
	ESCRITURA_TERMINA_MAX,
	POP_MEDIDO,
	REBOTE,
	ajustarEscritura,
	type ParamsEscritura,
	type ParamsPop,
	type ParamsResorte,
} from './animaciones';

// ───────────────────────── de dónde sale cada número ─────────────────────────

export type Medicion = {
	valor: number | string;
	/** Cuántas observaciones lo sostienen (0 = supuesto). */
	n: number;
	fuente: string;
	nota?: string;
};

const REELS_SEP = 'reel A, reel B, reel C (sep 2026), reel D (ago), reel E (jul)';

/**
 * Lo que se midió en los reels de referencia para fijar los valores por defecto del motor (2026-10-03, solo lectura).
 * Los reels van anonimizados (reel A, B…); el detalle con sus shortCodes vive en los datos del estilo de referencia.
 * Base 1080×1920. "n" cuenta observaciones independientes (reels o eventos, según diga la nota).
 */
export const MEDICIONES_CAPAS: Readonly<Record<string, Medicion>> = {
	titular_y: {valor: 302, n: 11, fuente: '11 reels (los 8 de estilo/mini-estilo.json + reel F, reel E, reel D), cuadro de t=1 s', nota: 'centro de las mayúsculas del 1.er renglón; mediana; rango 259–461'},
	titular_alto_mayuscula: {valor: 47, n: 11, fuente: 'mayúsculas al inicio de renglón en 8 reels (relleno blanco, sin contorno)', nota: 'mediana de 11 letras; rango 45–51'},
	titular_interlineado: {valor: 85, n: 11, fuente: '11 reels, línea base a línea base', nota: 'mediana; rango 76–100'},
	titular_borde: {valor: 3.4, n: 3, fuente: 'reel D, reel E, reel F', nota: 'contorno negro con uniones redondas, por fuera de la letra; corridas oscuras (<70) que tocan el blanco: 3.0, 3.75, 3.0 px. En el Chrome de Remotion el contorno se ve ~0.6 px más delgado que el trazo pedido (pedido 3 → se ve 2.4), por eso se pide 3.4: así la misma medida da 3.0 en el render (la mediana de tus 3 reels)'},
	titular_sombra: {valor: 'ninguna medible', n: 3, fuente: 'perfil de luminancia junto al contorno en los mismos 3 reels', nota: 'plano desde 2 px del contorno en 2 de 3; en reel D baja ~3 % en 8 px'},
	titular_peso: {valor: 800, n: 1, fuente: 'reel C, tallo de la "F" / alto de mayúscula = 0.25', nota: 'TikTok Sans 800 da 0.245; 600 da 0.184'},
	tarjeta_alto_mayuscula: {valor: 51, n: 5, fuente: REELS_SEP, nota: '51.0, 51.0, 49.5, 51.8, 49.5 (primera letra con tallo plano)'},
	tarjeta_alto_caja: {valor: 117.8, n: 5, fuente: REELS_SEP, nota: '2.29 × alto de mayúscula (mediana; 2.18–2.38)'},
	tarjeta_pad_arriba: {valor: 30, n: 2, fuente: 'reel E, reel A', nota: 'de la orilla de la caja al tope de las mayúsculas'},
	tarjeta_pad_abajo: {valor: 36, n: 2, fuente: 'reel E, reel A', nota: 'de la línea base a la orilla de la caja'},
	tarjeta_pad_lados: {valor: 24, n: 5, fuente: REELS_SEP, nota: 'de la tinta a la orilla (mediana; 21.4–25.1)'},
	tarjeta_radio: {valor: 15.4, n: 3, fuente: 'reel E, reel B, reel D', nota: '15.4, 15.8, 14.6; crece con la tarjeta (≈0.30 × alto de mayúscula)'},
	tarjeta_y: {valor: 1274, n: 6, fuente: `${REELS_SEP}, reel F`, nota: 'centro de la caja; mediana de las medianas por reel: 1254, 1260, 1274, 1275, 1287, 1329'},
	tarjeta_interlineado: {valor: 76, n: 3, fuente: 'reel E, reel A, reel B (tarjetas de 2 renglones, caja de 192–194)', nota: 'cada renglón lleva su propia caja (estilo del texto con fondo de Instagram)'},
	tarjeta_peso: {valor: 800, n: 2, fuente: 'reel A ("H"), reel E ("P"): tallo / mayúscula = 0.235', nota: 'TikTok Sans 800 da 0.245, 700 da 0.221 y 600 da 0.184; el ancho de tinta de "Hacer Loops" (1440p) es 564 px en tu reel, 558 con 800, 547 con 700 y 534 con 600. En reel D (ago) el tallo da 0.193: tus reels de agosto usaban un peso menor'},
	tarjeta_grande: {valor: 1.33, n: 2, fuente: 'reel E "Grafo" (×1.24), reel B "24/7" (×1.41)', nota: 'escala de la variante grande contra la normal del mismo reel'},
	tarjeta_lista_escala: {valor: 0.75, n: 4, fuente: 'listas de reel D, reel A (2) y reel B', nota: 'SUPUESTO dentro del rango medido 0.58–0.81'},
	tarjeta_separacion: {valor: 30, n: 9, fuente: 'huecos entre tarjetas apiladas en reel D, reel A y reel B', nota: 'mediana; rango 20–32'},
	tarjeta_entrada_salida: {valor: 'corte seco', n: 212, fuente: 'escaneo cuadro a cuadro de 11 reels (cajas blancas ≥ 60 × 150 px a la altura del pecho; 10 reels con tarjetas)', nota: '203 de 212 entran con corte (ancho 1.00 ±0.02 desde el 1.er cuadro) y 205 de 212 salen con corte; las que crecen son logos en caja blanca con el pop de los stickers'},
	// Escritura letra por letra (Fase 3, 2026-10-03): las 16 tarjetas que referencias/reels/<sc>/capas.json marca con
	// escritura = true, medidas cuadro por cuadro con out/f3-tarjetas/_medir/medir-escritura.mjs → out/f3-tarjetas/referencia/escritura.json.
	tarjeta_escritura_pct: {valor: 16, n: 213, fuente: 'out/f2-capas/agregado.json (totales.que_se_escriben, 9 reels con tarjetas)', nota: '16 de 213 tarjetas se escriben letra por letra; las otras entran con corte'},
	tarjeta_escritura_car_s: {valor: 40, n: 11, fuente: 'tarjetas de 1–2 renglones que se escriben: reel G (4), reel H (2), reel I (3), reel C (1), reel B (1)', nota: 'caracteres por segundo, mediana; rango 27.5–66.4. (caracteres − 1) ÷ cuadros de la 1.ª letra al texto completo × 30; cada espacio y cada salto de renglón cuentan como un carácter (en tus reels gastan su cuadro), el emoji también'},
	tarjeta_escritura_car_s_prompt: {valor: 30.7, n: 5, fuente: 'tarjetas tipo prompt (3–4 renglones): reel G t10, reel I t5 y t12, reel B t14 y t15', nota: 'mediana; rango 23.8–37.1 car/s. Con las 16 juntas la mediana es 37.9'},
	tarjeta_escritura_vacia: {valor: 1, n: 16, fuente: 'las 16 tarjetas que se escriben (5 reels)', nota: 'cuadros con la caja ya puesta y sin letras: 1 en 11 tarjetas y 2 en 5; en las tipo prompt la mediana es 2 (4 de 5)'},
	tarjeta_escritura_caja: {valor: 'tamaño final desde el 1.er cuadro', n: 16, fuente: 'las 16 tarjetas que se escriben (5 reels) + revisión a ojo de reel G t2, t8, t16 y reel I t5', nota: 'el ancho de la caja cambia ≤ 4.5 px base mientras se escribe (ruido de compresión; 14 de 16 ≤ 1.5 px). Cada renglón ya está en su lugar final y las letras salen de izquierda a derecha; una tarjeta de 2 renglones muestra sus 2 cajas desde el principio'},
	tarjeta_escritura_termina: {valor: ESCRITURA_TERMINA_MAX, n: 16, fuente: 'las 16 tarjetas que se escriben (5 reels)', nota: 'fracción del tiempo en pantalla en que el texto ya está completo: máximo 0.87, mediana 0.56; siempre quedan ≥ 9 cuadros con el texto completo'},
	tarjeta_escritura_cursor: {valor: 'sin cursor', n: 7, fuente: 'revisión cuadro a cuadro a media escritura: reel G t2, t8, t16; reel I t5; reel B t14; reel H t8; reel C t17', nota: 'ninguna lleva cursor; el cursor queda como opción (estilo.escritura.cursor)'},
	tarjeta_prompt_alineacion: {valor: 'izquierda', n: 5, fuente: 'out/f3-tarjetas/referencia/prompt.json (out/f3-tarjetas/_medir/medir-prompt.mjs): reel G t10, reel I t5 y t12, reel B t14 y t15', nota: 'una sola caja redondeada (no una por renglón), del ancho del renglón más largo, centrada en x = 540; los saltos de renglón los pones tú'},
	tarjeta_prompt_mayuscula: {valor: 33.8, n: 5, fuente: 'los mismos 5 prompts (cuadro nHasta − 3, 1440p)', nota: 'mediana; 30.0, 30.8, 33.8, 34.5, 35.3'},
	tarjeta_prompt_interlineado: {valor: 1.478, n: 5, fuente: 'los mismos 5 prompts', nota: 'línea base a línea base ÷ alto de mayúscula, mediana (1.447–1.511): 51 px con mayúscula de 33.8–35.3 y 44.5 con 30–30.8'},
	tarjeta_prompt_pad_arriba: {valor: 0.87, n: 5, fuente: 'los mismos 5 prompts', nota: 'orilla de arriba → tope de las mayúsculas del 1.er renglón ÷ alto de mayúscula (0.829–0.889); 30 px con mayúscula de 34.5'},
	tarjeta_prompt_pad_abajo: {valor: 0.978, n: 5, fuente: 'los mismos 5 prompts', nota: 'línea base del último renglón → orilla de abajo ÷ alto de mayúscula (0.957–1.022)'},
	tarjeta_prompt_pad_lados: {valor: 24.1, n: 5, fuente: 'los mismos 5 prompts', nota: 'de la tinta a la orilla izquierda (20.3–25.5) y derecha del renglón más ancho (20.3–27.8), mediana de la media: 0.713 × mayúscula'},
	tarjeta_prompt_radio: {valor: 0.201, n: 5, fuente: 'los mismos 5 prompts', nota: 'radio ÷ alto de la caja (0.199–0.206): el radio crece con la caja (34.9 px con 3 renglones chicos, 50.4 con 4); en las tarjetas normales es fijo (~15 px)'},
	tarjeta_prompt_y: {valor: 1260.4, n: 5, fuente: 'los mismos 5 prompts (3 reels)', nota: 'centro de la caja, mediana (1246.1–1280.6); dos prompts del mismo reel comparten el centro aunque midan distinto'},
	tarjeta_prompt_ancho: {valor: 845.3, n: 5, fuente: 'los mismos 5 prompts', nota: 'el más ancho; rango 702–845. ancho_max = 900 es supuesto (ninguno llega)'},
	// Listas en árbol: las 9 listas de referencias/reels/<sc>/capas.json (7 reels).
	tarjeta_lista_filas: {valor: 'mixta: 1 arriba y 2 lado a lado debajo', n: 9, fuente: 'las 9 listas de reel E, reel D, reel G, reel I, reel C, reel A (3) y reel B', nota: '7 de 9 son mixtas: [1,2] ×3, [1,2,1] ×2, [1,2,2] ×1 y [2,1] ×1; 2 verticales. Cada fila va centrada en x = 540 (±0.1) y nada se mueve cuando aparece la siguiente'},
	tarjeta_lista_separacion_h: {valor: 31.9, n: 8, fuente: 'huecos entre tarjetas lado a lado en 7 listas mixtas (5 reels)', nota: 'mediana por lista; 21.7–41.1 px base. No crece con la escala de la lista'},
	tarjeta_lista_retraso: {valor: 23, n: 21, fuente: 'retrasos entre una tarjeta de lista y la siguiente en las 9 listas', nota: 'cuadros, mediana (13–37); van en orden de lectura. Lo decide el director con el `desde` de cada tarjeta'},
	tarjeta_lista_escala_medida: {valor: 0.68, n: 9, fuente: 'mayúscula de cada lista ÷ mayúscula mediana de las tarjetas sueltas del mismo reel (9 listas, 7 reels)', nota: 'mediana 0.681 (0.58–0.86); las mixtas 0.67 (n=7). escala_lista sigue en 0.75 porque herramientas/layout.ts y sus pruebas la usan; el director puede pasar caja.escala'},
	tarjeta_emoji: {valor: 'emoji de color del sistema, al final', n: 19, fuente: 'out/f2-capas/agregado.json (totales.con_emoji)', nota: '19 de 213 tarjetas llevan emoji; se dibuja con la fuente de emoji del sistema (Apple Color Emoji en tu Mac)'},
	sticker_pop: {valor: 'lineal 0.5→1.0 en 6 cuadros, sin sobrepaso', n: 6, fuente: 'tiles de reel D, reel F, reel E, reel A; mascota de reel E; logo de reel C', nota: 'reel D a 1440p: 0.586, 0.669, 0.755, 0.839, 0.916, 1.000'},
	sticker_pop_opacidad: {valor: 0.83, n: 6, fuente: 'los mismos 6 pops: α = (cuadro − fondo) / (lleno − fondo) dentro del blanco', nota: '0.85, 0.84, 0.80, 0.74, 0.83, 0.83 en el 1.er cuadro; 1.00 desde el 2.º en los 6'},
	sticker_salida: {valor: 'corte seco', n: 3, fuente: 'tiles de reel E, reel A, reel F'},
	sticker_ancho: {valor: 316, n: 4, fuente: 'tiles de reel A (260), reel E (300), reel D (332), reel F (356)', nota: 'mediana'},
	insert_tarjeta: {valor: 'centro (540, 995), ancho 770', n: 2, fuente: 'captura de reel E (452×800, centro y 1030) y meme de reel A (770×820, centro y 960)', nota: 'una entra con corte y la otra con el pop; radio 0 y ≈52 px'},
	desenfoque_rampa: {valor: 18, n: 1, fuente: 'reel D 9.3–11.3 s (énfasis con tarjetas)', nota: 'la nitidez baja en ~20 cuadros; en reel E 1.17 s (fondo de una captura) parece entrar de golpe (n=1)'},
	zoom: {valor: 'N/A', n: 0, fuente: '—', nota: 'no medido: los zooms de tus reels se miden en la Fase 2 (cara.swift + overlays.ts); 8 cuadros es supuesto'},
	ken_burns: {valor: 'N/A', n: 0, fuente: '—', nota: 'tus inserts a pantalla completa traen el movimiento de la cámara; 1.00→1.06 es supuesto'},
};

// ───────────────────────── tipos de estilo ─────────────────────────

export type Sombra = {activa: boolean; color: string; opacidad: number; desenfoque_px: number; dy_px: number};

export type EstiloTitular = {
	fuente: IdFuente;
	peso: number;
	/** Alto de las mayúsculas (lo visible del relleno). El tamaño de letra sale de aquí y de la fuente. */
	alto_mayuscula_px: number;
	color: string;
	/**
	 * Grosor pedido del contorno por fuera de la letra (el trazo SVG mide el doble y la mitad queda bajo el relleno).
	 * En el Chrome de Remotion se ve ~0.6 px más delgado que lo pedido (ver MEDICIONES_CAPAS.titular_borde).
	 */
	borde_px: number;
	color_borde: string;
	x: number;
	/** Centro de las mayúsculas del PRIMER renglón (si el titular no trae caja.y). */
	y: number;
	/** De línea base a línea base. */
	interlineado_px: number;
	/** Ancho máximo de cada renglón, ya con el contorno. Si no cabe, el titular se achica entero. */
	ancho_max: number;
	sombra: Sombra;
};

/** Entrada de las tarjetas: "corte" (lo de tus reels), "pop" (el de los stickers) o "escritura" (letra por letra). */
export type EntradaTarjeta = 'corte' | 'pop' | 'escritura';

/** Escritura letra por letra (entrada "escritura"). Medido en tus reels: ver MEDICIONES_CAPAS.tarjeta_escritura_*. */
export type EstiloEscritura = {
	/** Caracteres por segundo de las tarjetas normales y grandes. */
	car_s: number;
	/** Caracteres por segundo de las tipo prompt. */
	car_s_prompt: number;
	/** Cuadros con la caja puesta y sin letras (normales y grandes). */
	cuadros_vacia: number;
	/** Lo mismo en las tipo prompt. */
	cuadros_vacia_prompt: number;
	/** El texto debe quedar completo a esta fracción de su tiempo en pantalla; si no alcanza, se escribe más rápido. */
	termina_max: number;
	/** Barra de cursor al final de lo escrito (en tus reels no hay). */
	cursor: boolean;
	/** Medio ciclo del parpadeo del cursor ya con el texto completo, en cuadros (0 = fijo). */
	cursor_parpadeo_cuadros: number;
};

/**
 * Variante "prompt": texto largo en UNA caja redondeada, alineado a la izquierda (como tus prompts escritos en
 * pantalla). Medidas en px base a escala 1; caja.escala las multiplica todas (menos ancho_max).
 */
export type EstiloPrompt = {
	alto_mayuscula_px: number;
	/** De línea base a línea base. */
	interlineado_px: number;
	/** De la orilla de arriba al tope de las mayúsculas del 1.er renglón. */
	pad_arriba_px: number;
	/** De la línea base del último renglón a la orilla de abajo. */
	pad_abajo_px: number;
	/** Relleno CSS a los lados (con la sangría de las letras queda ≈ 24 px de la tinta a la orilla). */
	pad_lados_px: number;
	/** Radio de las esquinas ÷ alto de la caja. */
	radio_relativo: number;
	/** Ancho máximo de la caja; si un renglón no cabe, se parte solo. */
	ancho_max: number;
	/** Centro de la caja si la tarjeta no trae caja. */
	x: number;
	y: number;
};

export type EstiloTarjeta = {
	fuente: IdFuente;
	peso: number;
	alto_mayuscula_px: number;
	color_texto: string;
	color_fondo: string;
	/** De la orilla de arriba de la caja al tope de las mayúsculas. */
	pad_arriba_px: number;
	/** De la línea base a la orilla de abajo de la caja. */
	pad_abajo_px: number;
	/** Relleno a los lados del texto (CSS). Con la sangría de las letras queda ≈ 24 px de la tinta a la orilla. */
	pad_lados_px: number;
	radio_px: number;
	/** De línea base a línea base cuando la tarjeta tiene 2 o más renglones. */
	interlineado_px: number;
	/** Ancho máximo de la caja (no crece con la escala de la tarjeta). */
	ancho_max: number;
	/** Centro de la caja si la tarjeta no trae caja. */
	x: number;
	y: number;
	/** Escala de la variante "grande". */
	escala_grande: number;
	/** Escala de las tarjetas que van en grupo (lista), salvo que traigan caja.escala. */
	escala_lista: number;
	/** Hueco entre tarjetas apiladas de un mismo grupo. */
	separacion_px: number;
	/** Hueco horizontal entre tarjetas de una misma fila (listas en árbol). */
	separacion_h_px: number;
	/** Entrada de las tarjetas que traen "corte" (el valor por defecto de la EDL). */
	entrada: EntradaTarjeta;
	escritura: EstiloEscritura;
	prompt: EstiloPrompt;
};

export type EntradaSticker = 'pop' | 'corte' | 'rebote';
export type SalidaSticker = 'corte' | 'encoger';

export type EstiloSticker = {
	entrada: EntradaSticker;
	salida: SalidaSticker;
	pop: ParamsPop;
	rebote: ParamsResorte;
	/** Cuadros de la salida "encoger". */
	cuadros_encoger: number;
	respira: {amplitud: number; periodo_s: number};
	/** Ancho si el sticker no trae caja.w. */
	ancho_px: number;
	sombra: Sombra;
};

export type EntradaInsert = 'pop' | 'deslizar' | 'corte';

export type EstiloInsert = {
	tarjeta: {x: number; y: number; ancho_px: number; radio_px: number; sombra: Sombra; entrada: EntradaInsert; deslizar_px: number; deslizar_cuadros: number};
	pantalla_completa: {ken_burns_desde: number; ken_burns_hasta: number};
};

export type ParametrosZoom = {cuadros_suave: number};
export type ParametrosDesenfoque = {rampa_entrada: number; rampa_salida: number};

// ───────────────────────── valores por defecto ─────────────────────────

export const ESTILO_TITULAR_POR_DEFECTO: EstiloTitular = {
	fuente: 'tiktok-sans',
	peso: 800,
	alto_mayuscula_px: 47,
	color: '#FFFFFF',
	// Grosor PEDIDO al trazo: con 3.4 el contorno se ve como en tus reels (ver MEDICIONES_CAPAS.titular_borde).
	borde_px: 3.4,
	color_borde: '#000000',
	x: BASE_ANCHO / 2,
	y: 302,
	interlineado_px: 85,
	ancho_max: 920,
	sombra: {activa: false, color: '#000000', opacidad: 0.35, desenfoque_px: 6, dy_px: 2},
};

export const ESTILO_TARJETA_POR_DEFECTO: EstiloTarjeta = {
	fuente: 'tiktok-sans',
	peso: 800,
	alto_mayuscula_px: 51,
	color_texto: '#000000',
	color_fondo: '#FFFFFF',
	pad_arriba_px: 30,
	pad_abajo_px: 36,
	pad_lados_px: 22,
	radio_px: 15,
	interlineado_px: 76,
	ancho_max: 940,
	x: BASE_ANCHO / 2,
	y: 1274,
	escala_grande: 1.33,
	escala_lista: 0.75,
	separacion_px: 30,
	// Listas en árbol: hueco entre las de una misma fila (MEDICIONES_CAPAS.tarjeta_lista_separacion_h).
	separacion_h_px: 31.9,
	entrada: 'corte',
	// Escritura medida (MEDICIONES_CAPAS.tarjeta_escritura_*); el cursor no está en tus reels: apagado.
	escritura: {
		car_s: ESCRITURA_MEDIDA.car_s,
		car_s_prompt: ESCRITURA_PROMPT_MEDIDA.car_s,
		cuadros_vacia: ESCRITURA_MEDIDA.cuadros_vacia,
		cuadros_vacia_prompt: ESCRITURA_PROMPT_MEDIDA.cuadros_vacia,
		termina_max: ESCRITURA_TERMINA_MAX,
		cursor: false,
		cursor_parpadeo_cuadros: 15,
	},
	// Prompt medido (MEDICIONES_CAPAS.tarjeta_prompt_*) con la mayúscula mediana (33.8 px): todo es razón de ella.
	prompt: {
		alto_mayuscula_px: 33.8,
		interlineado_px: 50,
		pad_arriba_px: 29.4,
		pad_abajo_px: 33.1,
		pad_lados_px: 22.7,
		radio_relativo: 0.201,
		ancho_max: 900,
		x: BASE_ANCHO / 2,
		y: 1260,
	},
};

export const ESTILO_STICKER_POR_DEFECTO: EstiloSticker = {
	entrada: 'pop',
	salida: 'corte',
	pop: POP_MEDIDO,
	rebote: REBOTE,
	cuadros_encoger: 3,
	respira: {amplitud: 0.015, periodo_s: 1.2},
	ancho_px: 316,
	// Supuesto: sombra suave para despegar el sticker de fondos claros (en tus reels no se mide sombra aparte).
	sombra: {activa: true, color: '#000000', opacidad: 0.28, desenfoque_px: 10, dy_px: 6},
};

export const ESTILO_INSERT_POR_DEFECTO: EstiloInsert = {
	tarjeta: {
		// Centro y ancho: los de tus 2 inserts en tarjeta medidos (MEDICIONES_CAPAS.insert_tarjeta).
		x: BASE_ANCHO / 2,
		y: 995,
		ancho_px: 770,
		// Supuestos del plan: en tus 2 inserts medidos el radio fue 0 y ≈52 px y no se ve sombra.
		radio_px: 24,
		sombra: {activa: true, color: '#000000', opacidad: 0.3, desenfoque_px: 24, dy_px: 8},
		entrada: 'pop',
		deslizar_px: 140,
		deslizar_cuadros: 6,
	},
	pantalla_completa: {ken_burns_desde: 1, ken_burns_hasta: 1.06},
};

export const ZOOM_POR_DEFECTO: ParametrosZoom = {cuadros_suave: 8};
export const DESENFOQUE_POR_DEFECTO: ParametrosDesenfoque = {rampa_entrada: 18, rampa_salida: 18};

// ───────────────────────── juntar estilos parciales (lo que llega de edicion.estilos.*) ─────────────────────────

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const numero = (v: unknown, previo: number, min = -Infinity, max = Infinity): number =>
	typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : previo;
const color = (v: unknown, previo: string): string => (typeof v === 'string' && COLOR.test(v) ? v.toUpperCase() : previo);
const booleano = (v: unknown, previo: boolean): boolean => (typeof v === 'boolean' ? v : previo);
const opcion = <T extends string>(v: unknown, opciones: readonly T[], previo: T): T =>
	typeof v === 'string' && (opciones as readonly string[]).includes(v) ? (v as T) : previo;

function juntarSombra(v: unknown, previa: Sombra): Sombra {
	if (typeof v === 'boolean') return {...previa, activa: v};
	if (!esObjeto(v)) return previa;
	return {
		activa: booleano(v.activa, previa.activa),
		color: color(v.color, previa.color),
		opacidad: numero(v.opacidad, previa.opacidad, 0, 1),
		desenfoque_px: numero(v.desenfoque_px, previa.desenfoque_px, 0, 200),
		dy_px: numero(v.dy_px, previa.dy_px, -200, 200),
	};
}

/**
 * Junta el estilo de titular que llega por props (o de edicion.estilos.titular, que es un objeto libre) con el de
 * por defecto. Solo toma los campos que conoce y con el tipo correcto; lo demás se ignora.
 * Acepta `tamano_px` como alternativa a `alto_mayuscula_px`.
 */
export function resolverEstiloTitular(parcial: unknown = {}): EstiloTitular {
	const d = ESTILO_TITULAR_POR_DEFECTO;
	if (!esObjeto(parcial)) return {...d, sombra: {...d.sombra}};
	const fuente = esIdFuente(parcial.fuente) ? parcial.fuente : d.fuente;
	let alto = numero(parcial.alto_mayuscula_px, d.alto_mayuscula_px, 4, 400);
	if (parcial.alto_mayuscula_px === undefined && typeof parcial.tamano_px === 'number') {
		alto = numero(parcial.tamano_px * candidata(fuente).altoMayuscula, alto, 4, 400);
	}
	return {
		fuente,
		peso: numero(parcial.peso, d.peso, 100, 900),
		alto_mayuscula_px: alto,
		color: color(parcial.color, d.color),
		borde_px: numero(parcial.borde_px, d.borde_px, 0, 40),
		color_borde: color(parcial.color_borde, d.color_borde),
		x: numero(parcial.x, d.x),
		y: numero(parcial.y, d.y),
		interlineado_px: numero(parcial.interlineado_px, d.interlineado_px, 1, 1000),
		ancho_max: numero(parcial.ancho_max, d.ancho_max, 50, 4000),
		sombra: juntarSombra(parcial.sombra, d.sombra),
	};
}

function juntarEscritura(v: unknown, previa: EstiloEscritura): EstiloEscritura {
	if (!esObjeto(v)) return {...previa};
	return {
		car_s: numero(v.car_s, previa.car_s, 1, 1000),
		car_s_prompt: numero(v.car_s_prompt, previa.car_s_prompt, 1, 1000),
		cuadros_vacia: Math.round(numero(v.cuadros_vacia, previa.cuadros_vacia, 0, 60)),
		cuadros_vacia_prompt: Math.round(numero(v.cuadros_vacia_prompt, previa.cuadros_vacia_prompt, 0, 60)),
		termina_max: numero(v.termina_max, previa.termina_max, 0.05, 1),
		cursor: booleano(v.cursor, previa.cursor),
		cursor_parpadeo_cuadros: Math.round(numero(v.cursor_parpadeo_cuadros, previa.cursor_parpadeo_cuadros, 0, 300)),
	};
}

function juntarPrompt(v: unknown, previo: EstiloPrompt): EstiloPrompt {
	if (!esObjeto(v)) return {...previo};
	return {
		alto_mayuscula_px: numero(v.alto_mayuscula_px, previo.alto_mayuscula_px, 4, 400),
		interlineado_px: numero(v.interlineado_px, previo.interlineado_px, 1, 1000),
		pad_arriba_px: numero(v.pad_arriba_px, previo.pad_arriba_px, 0, 400),
		pad_abajo_px: numero(v.pad_abajo_px, previo.pad_abajo_px, 0, 400),
		pad_lados_px: numero(v.pad_lados_px, previo.pad_lados_px, 0, 400),
		radio_relativo: numero(v.radio_relativo, previo.radio_relativo, 0, 0.5),
		ancho_max: numero(v.ancho_max, previo.ancho_max, 50, 4000),
		x: numero(v.x, previo.x),
		y: numero(v.y, previo.y),
	};
}

export function resolverEstiloTarjeta(parcial: unknown = {}): EstiloTarjeta {
	const d = ESTILO_TARJETA_POR_DEFECTO;
	if (!esObjeto(parcial)) return {...d, escritura: {...d.escritura}, prompt: {...d.prompt}};
	return {
		fuente: esIdFuente(parcial.fuente) ? parcial.fuente : d.fuente,
		peso: numero(parcial.peso, d.peso, 100, 900),
		alto_mayuscula_px: numero(parcial.alto_mayuscula_px, d.alto_mayuscula_px, 4, 400),
		color_texto: color(parcial.color_texto, d.color_texto),
		color_fondo: color(parcial.color_fondo, d.color_fondo),
		pad_arriba_px: numero(parcial.pad_arriba_px, d.pad_arriba_px, 0, 400),
		pad_abajo_px: numero(parcial.pad_abajo_px, d.pad_abajo_px, 0, 400),
		pad_lados_px: numero(parcial.pad_lados_px, d.pad_lados_px, 0, 400),
		radio_px: numero(parcial.radio_px, d.radio_px, 0, 400),
		interlineado_px: numero(parcial.interlineado_px, d.interlineado_px, 1, 1000),
		ancho_max: numero(parcial.ancho_max, d.ancho_max, 50, 4000),
		x: numero(parcial.x, d.x),
		y: numero(parcial.y, d.y),
		escala_grande: numero(parcial.escala_grande, d.escala_grande, 0.1, 10),
		escala_lista: numero(parcial.escala_lista, d.escala_lista, 0.1, 10),
		separacion_px: numero(parcial.separacion_px, d.separacion_px, 0, 1000),
		separacion_h_px: numero(parcial.separacion_h_px, d.separacion_h_px, 0, 1000),
		entrada: opcion(parcial.entrada, ['corte', 'pop', 'escritura'] as const, d.entrada),
		escritura: juntarEscritura(parcial.escritura, d.escritura),
		prompt: juntarPrompt(parcial.prompt, d.prompt),
	};
}

export function resolverEstiloSticker(parcial: unknown = {}): EstiloSticker {
	const d = ESTILO_STICKER_POR_DEFECTO;
	if (!esObjeto(parcial)) return {...d, pop: {...d.pop}, rebote: {...d.rebote}, respira: {...d.respira}, sombra: {...d.sombra}};
	const pop = esObjeto(parcial.pop) ? parcial.pop : {};
	const rebote = esObjeto(parcial.rebote) ? parcial.rebote : {};
	const respira = esObjeto(parcial.respira) ? parcial.respira : {};
	return {
		entrada: opcion(parcial.entrada, ['pop', 'corte', 'rebote'] as const, d.entrada),
		salida: opcion(parcial.salida, ['corte', 'encoger'] as const, d.salida),
		pop: {
			escalaInicial: numero(pop.escalaInicial, d.pop.escalaInicial, 0, 1),
			cuadros: numero(pop.cuadros, d.pop.cuadros, 1, 60),
			opacidadInicial: numero(pop.opacidadInicial, d.pop.opacidadInicial, 0, 1),
			cuadrosOpacidad: numero(pop.cuadrosOpacidad, d.pop.cuadrosOpacidad, 0, 60),
		},
		rebote: {
			escalaInicial: numero(rebote.escalaInicial, d.rebote.escalaInicial, 0, 1),
			amortiguamiento: numero(rebote.amortiguamiento, d.rebote.amortiguamiento, 0.05, 2),
			frecuencia: numero(rebote.frecuencia, d.rebote.frecuencia, 0.05, 10),
		},
		cuadros_encoger: numero(parcial.cuadros_encoger, d.cuadros_encoger, 1, 30),
		respira: {amplitud: numero(respira.amplitud, d.respira.amplitud, 0, 0.5), periodo_s: numero(respira.periodo_s, d.respira.periodo_s, 0.1, 30)},
		ancho_px: numero(parcial.ancho_px, d.ancho_px, 10, 2000),
		sombra: juntarSombra(parcial.sombra, d.sombra),
	};
}

export function resolverEstiloInsert(parcial: unknown = {}): EstiloInsert {
	const d = ESTILO_INSERT_POR_DEFECTO;
	const p = esObjeto(parcial) ? parcial : {};
	const t = esObjeto(p.tarjeta) ? p.tarjeta : {};
	const pc = esObjeto(p.pantalla_completa) ? p.pantalla_completa : {};
	return {
		tarjeta: {
			x: numero(t.x, d.tarjeta.x),
			y: numero(t.y, d.tarjeta.y),
			ancho_px: numero(t.ancho_px, d.tarjeta.ancho_px, 10, 4000),
			radio_px: numero(t.radio_px, d.tarjeta.radio_px, 0, 1000),
			sombra: juntarSombra(t.sombra, d.tarjeta.sombra),
			entrada: opcion(t.entrada, ['pop', 'deslizar', 'corte'] as const, d.tarjeta.entrada),
			deslizar_px: numero(t.deslizar_px, d.tarjeta.deslizar_px, 0, 2000),
			deslizar_cuadros: numero(t.deslizar_cuadros, d.tarjeta.deslizar_cuadros, 1, 60),
		},
		pantalla_completa: {
			ken_burns_desde: numero(pc.ken_burns_desde, d.pantalla_completa.ken_burns_desde, 0.5, 3),
			ken_burns_hasta: numero(pc.ken_burns_hasta, d.pantalla_completa.ken_burns_hasta, 0.5, 3),
		},
	};
}

// ───────────────────────── tipografía ─────────────────────────

/** Tamaño de letra (font-size) que da ese alto de mayúscula con esa fuente. */
export function tamanoDeLetra(fuente: IdFuente, altoMayuscula: number): number {
	return altoMayuscula / candidata(fuente).altoMayuscula;
}

/** El peso que se dibuja de verdad (el más cercano que tiene la fuente en biblioteca/fuentes). */
export function pesoReal(fuente: IdFuente, peso: number): number {
	return pesoDisponible(fuente, peso);
}

/** Renglones del titular: parte en "\n" y quita espacios de las orillas; los renglones vacíos no cuentan. */
export function renglones(texto: string): string[] {
	return texto
		.split(/\r?\n/)
		.map((r) => r.trim().replace(/\s+/g, ' '))
		.filter((r) => r.length > 0);
}

/**
 * Parte un renglón en dos lo más parejos posible (el renglón más ancho de los dos, lo más angosto que se pueda).
 * `medir` da el ancho de un texto (en el navegador, getComputedTextLength; en pruebas, una función cualquiera).
 * Con empate gana el corte con el 1.er renglón más corto. Devuelve null si hay una sola palabra.
 */
export function partirEnDos(renglon: string, medir: (texto: string) => number): [string, string] | null {
	const palabras = renglon.trim().split(/\s+/).filter(Boolean);
	if (palabras.length < 2) return null;
	let mejor: [string, string] | null = null;
	let mejorMax = Infinity;
	let mejorA = Infinity;
	for (let k = 1; k < palabras.length; k++) {
		const a = palabras.slice(0, k).join(' ');
		const b = palabras.slice(k).join(' ');
		const wa = medir(a);
		const m = Math.max(wa, medir(b));
		if (m < mejorMax - 1e-6 || (Math.abs(m - mejorMax) <= 1e-6 && wa < mejorA)) {
			mejor = [a, b];
			mejorMax = m;
			mejorA = wa;
		}
	}
	return mejor;
}

// ───────────────────────── tarjetas: medidas y grupos ─────────────────────────

type TarjetaEdl = Edicion['tarjetas'][number];

export type GeometriaTarjeta = {
	escala: number;
	tamano_px: number;
	alto_mayuscula_px: number;
	interlineado_px: number;
	pad_arriba_px: number;
	pad_abajo_px: number;
	pad_lados_px: number;
	radio_px: number;
	/** Medio interlineado: (interlineado − alto de mayúscula) / 2. Con la fuente registrada con ascenso = mayúscula y descenso = 0. */
	medio_interlineado_px: number;
};

/** Escala total de una tarjeta: variante × (caja.escala, o la de lista si va en grupo y no trae escala). */
export function escalaDeTarjeta(t: Pick<TarjetaEdl, 'variante' | 'grupo' | 'caja'>, estilo: EstiloTarjeta): number {
	const variante = t.variante === 'grande' ? estilo.escala_grande : 1;
	const caja = t.caja?.escala ?? (t.grupo ? estilo.escala_lista : 1);
	return variante * caja;
}

export function geometriaTarjeta(estilo: EstiloTarjeta, escala: number): GeometriaTarjeta {
	const alto = estilo.alto_mayuscula_px * escala;
	const interlineado = estilo.interlineado_px * escala;
	return {
		escala,
		tamano_px: tamanoDeLetra(estilo.fuente, alto),
		alto_mayuscula_px: alto,
		interlineado_px: interlineado,
		pad_arriba_px: estilo.pad_arriba_px * escala,
		pad_abajo_px: estilo.pad_abajo_px * escala,
		pad_lados_px: estilo.pad_lados_px * escala,
		radio_px: estilo.radio_px * escala,
		medio_interlineado_px: (interlineado - alto) / 2,
	};
}

/** Alto visible de la caja con n renglones: mayúscula + (n − 1) interlineados + rellenos de arriba y abajo. */
export function altoCajaTarjeta(g: GeometriaTarjeta, renglonesN: number): number {
	const n = Math.max(1, Math.round(renglonesN));
	return g.alto_mayuscula_px + (n - 1) * g.interlineado_px + g.pad_arriba_px + g.pad_abajo_px;
}

export type GrupoTarjetas = {
	/** Id del grupo o, si la tarjeta va sola, el de la tarjeta. */
	id: string;
	/** En orden de aparición (desde, y luego el orden de la EDL). La primera manda la posición. */
	tarjetas: TarjetaEdl[];
	/** Cuadro en que aparece la primera. */
	desde: number;
	/** Cuadro (exclusivo) en que se van todas juntas: el `hasta` más tardío del grupo. */
	hasta: number;
};

/**
 * Agrupa las tarjetas: las de un mismo `grupo` forman una lista (cada una aparece en su desde y se van todas juntas
 * en el hasta más tardío); las que no tienen grupo van solas. Tiempos en cuadros (mismo redondeo que el resto).
 */
export function agruparTarjetas(tarjetas: readonly TarjetaEdl[]): GrupoTarjetas[] {
	const grupos = new Map<string, TarjetaEdl[]>();
	const orden: string[] = [];
	for (const t of tarjetas) {
		const clave = t.grupo ? `g:${t.grupo}` : `t:${t.id}`;
		if (!grupos.has(clave)) {
			grupos.set(clave, []);
			orden.push(clave);
		}
		grupos.get(clave)!.push(t);
	}
	return orden.map((clave) => {
		const lista = grupos
			.get(clave)!
			.map((t, i) => ({t, i}))
			.sort((a, b) => aCuadro(a.t.desde) - aCuadro(b.t.desde) || a.i - b.i)
			.map((x) => x.t);
		const desde = Math.min(...lista.map((t) => aCuadro(t.desde)));
		const hasta = Math.max(...lista.map((t) => aCuadro(t.hasta)));
		return {id: clave.slice(2), tarjetas: lista, desde, hasta: Math.max(desde + 1, hasta)};
	});
}

// ───────────────────────── tarjetas: texto, escritura, prompt y filas (Fase 3) ─────────────────────────

/** Fuentes de emoji del sistema (19 de tus 213 tarjetas llevan uno): van detrás de la fuente de la tarjeta. */
export const FUENTES_EMOJI = ['Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Emoji'] as const;

/** font-family CSS de una tarjeta: su fuente y, para los emoji, la de color del sistema. */
export function familiaTarjeta(fuente: IdFuente): string {
	return [candidata(fuente).familiaCss, ...FUENTES_EMOJI].map((f) => `"${f}"`).join(', ');
}

/** El texto tal como se dibuja: cada renglón ("\n") sin espacios en las orillas. */
export function textoTarjeta(texto: string): string {
	return texto
		.split(/\r?\n/)
		.map((r) => r.trim())
		.join('\n');
}

const segmentador = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('es', {granularity: 'grapheme'}) : null;

/** Grafemas: lo que se ve como UN carácter (una letra con tilde, un emoji con tono de piel o una familia ZWJ). */
export function grafemas(texto: string): string[] {
	if (segmentador) return Array.from(segmentador.segment(texto), (s) => s.segment);
	return Array.from(texto);
}

/** Parte el texto en lo ya escrito (los primeros `visibles` grafemas) y lo que falta, que ocupa su lugar sin verse. */
export function partirEscritura(texto: string, visibles: number): {visible: string; oculto: string} {
	const g = grafemas(texto);
	const n = Math.max(0, Math.min(g.length, Math.floor(visibles)));
	return {visible: g.slice(0, n).join(''), oculto: g.slice(n).join('')};
}

/**
 * Entrada de una tarjeta: la suya si es "pop" o "escritura"; si trae "corte" (el valor por defecto de la EDL) o nada,
 * la del estilo (así estilos.tarjetas.entrada = "pop" sigue cambiando todas, como antes).
 */
export function entradaDeTarjeta(t: {entrada?: string | null}, estilo: EstiloTarjeta): EntradaTarjeta {
	if (t.entrada === 'pop' || t.entrada === 'escritura') return t.entrada;
	return estilo.entrada;
}

/** Escritura medida de una variante: la del prompt o la de las demás. */
export function escrituraDeVariante(variante: string | null | undefined, estilo: EstiloTarjeta): ParamsEscritura {
	const e = estilo.escritura;
	return variante === 'prompt' ? {car_s: e.car_s_prompt, cuadros_vacia: e.cuadros_vacia_prompt} : {car_s: e.car_s, cuadros_vacia: e.cuadros_vacia};
}

/**
 * Cómo se escribe una tarjeta que se ve `cuadrosEnPantalla` cuadros: la escritura de su variante, más rápida si a esa
 * velocidad no queda completa a `escritura.termina_max` de su tiempo en pantalla. `total` = grafemas del texto dibujado.
 */
export function escrituraDeTarjeta(
	t: {texto: string; variante?: string | null},
	estilo: EstiloTarjeta,
	cuadrosEnPantalla: number,
): {total: number; params: ParamsEscritura} {
	const total = grafemas(textoTarjeta(t.texto)).length;
	return {total, params: ajustarEscritura(total, cuadrosEnPantalla, escrituraDeVariante(t.variante, estilo), estilo.escritura.termina_max)};
}

/** Un punto del horario de escritura (tarjeta.escritura en la EDL): en el segundo `t` del video ya se ven `car` grafemas. */
export type PuntoEscritura = {car: number; t: number};

/**
 * Grafemas que se ven en el segundo `s` con un horario de escritura (al compás de tu voz): antes del primer punto,
 * ninguno; entre dos puntos, lineal y redondeado hacia arriba (la letra sale en cuanto empieza su tramo, así cada
 * palabra asoma cuando la empiezas a decir y queda completa cuando la terminas); después del último, los suyos.
 */
export function visiblesPorHorario(s: number, horario: readonly PuntoEscritura[], total: number): number {
	const n = Math.max(0, Math.floor(total));
	if (horario.length === 0 || s < horario[0].t - 1e-9) return 0;
	let k = 0;
	while (k + 1 < horario.length && horario[k + 1].t <= s + 1e-9) k++;
	const a = horario[k];
	if (k + 1 >= horario.length) return Math.min(n, a.car);
	const b = horario[k + 1];
	const v = a.car + ((b.car - a.car) * (s - a.t)) / (b.t - a.t);
	return Math.max(0, Math.min(n, Math.ceil(v - 1e-9)));
}

/**
 * Cuadros (absolutos, del video) de una tarjeta con horario: `primera` = el primero con alguna letra, `completo` = el
 * primero con el texto entero. Busca entre `desde` y `hasta` (cuadros, `hasta` exclusivo); null si nunca sale nada.
 */
export function cuadrosDeHorario(horario: readonly PuntoEscritura[], total: number, desde: number, hasta: number, fps = 30): {primera: number; completo: number} | null {
	let primera: number | null = null;
	for (let f = desde; f < hasta; f++) {
		const v = visiblesPorHorario(f / fps, horario, total);
		if (v > 0 && primera === null) primera = f;
		if (v >= total) return {primera: primera ?? f, completo: f};
	}
	return primera === null ? null : {primera, completo: hasta - 1};
}

export type GeometriaPrompt = {
	escala: number;
	tamano_px: number;
	alto_mayuscula_px: number;
	interlineado_px: number;
	/** Lo que se ve: de la orilla de arriba al tope de las mayúsculas y de la última línea base a la orilla de abajo. */
	pad_arriba_px: number;
	pad_abajo_px: number;
	/** Rellenos CSS de la caja: lo que se ve menos el medio interlineado (la fuente va con ascenso = mayúscula). */
	css_arriba_px: number;
	css_abajo_px: number;
	pad_lados_px: number;
	radio_relativo: number;
	ancho_max: number;
};

/** Medidas de una tarjeta "prompt" con esa escala total (caja.escala); el ancho máximo no crece con la escala. */
export function geometriaPrompt(estilo: EstiloTarjeta, escala: number): GeometriaPrompt {
	const p = estilo.prompt;
	const alto = p.alto_mayuscula_px * escala;
	const interlineado = p.interlineado_px * escala;
	const medio = (interlineado - alto) / 2;
	return {
		escala,
		tamano_px: tamanoDeLetra(estilo.fuente, alto),
		alto_mayuscula_px: alto,
		interlineado_px: interlineado,
		pad_arriba_px: p.pad_arriba_px * escala,
		pad_abajo_px: p.pad_abajo_px * escala,
		css_arriba_px: Math.max(0, p.pad_arriba_px * escala - medio),
		css_abajo_px: Math.max(0, p.pad_abajo_px * escala - medio),
		pad_lados_px: p.pad_lados_px * escala,
		radio_relativo: p.radio_relativo,
		ancho_max: p.ancho_max,
	};
}

/** Alto de la caja de un prompt con n renglones (= arriba + mayúscula + (n − 1) interlineados + abajo). */
export function altoCajaPrompt(g: GeometriaPrompt, renglonesN: number): number {
	const n = Math.max(1, Math.round(renglonesN));
	return g.css_arriba_px + n * g.interlineado_px + g.css_abajo_px;
}

/** Radio de las esquinas de un prompt: crece con su caja (en tus reels, 0.201 × alto). */
export function radioPrompt(g: GeometriaPrompt, alto: number): number {
	return g.radio_relativo * alto;
}

/** Centro por defecto de una tarjeta sin caja (el prompt tiene el suyo). */
export function centroPorDefecto(t: {variante?: string | null}, estilo: EstiloTarjeta): {x: number; y: number} {
	return t.variante === 'prompt' ? {x: estilo.prompt.x, y: estilo.prompt.y} : {x: estilo.x, y: estilo.y};
}

/** Ancho máximo de una tarjeta: caja.w o el del estilo (el del prompt en la variante prompt). */
export function anchoMaxDeTarjeta(t: {caja?: {w?: number} | null; variante?: string | null}, estilo: EstiloTarjeta): number {
	return t.caja?.w ?? (t.variante === 'prompt' ? estilo.prompt.ancho_max : estilo.ancho_max);
}

/**
 * Renglones de un grupo, de arriba abajo. Las que traen la misma `fila` van lado a lado, de izquierda a derecha en su
 * orden de aparición. Las que no traen fila van cada una en su renglón, como si su fila fuera su lugar de aparición
 * en el grupo (0, 1, 2…): sin ninguna fila queda la lista apilada de antes. Los renglones se ordenan por fila y, si
 * empatan, por cuál apareció primero; si las filas se saltan números (0, 2) no quedan huecos.
 * `tarjetas` en orden de aparición (como las deja agruparTarjetas).
 */
export function filasDeGrupo<T extends {fila?: number | null}>(tarjetas: readonly T[]): T[][] {
	type Renglon = {clave: number; primera: number; tarjetas: T[]};
	const numeradas = new Map<number, Renglon>();
	const todos: Renglon[] = [];
	tarjetas.forEach((t, i) => {
		const fila = typeof t.fila === 'number' && Number.isInteger(t.fila) && t.fila >= 0 ? t.fila : null;
		if (fila === null) {
			todos.push({clave: i, primera: i, tarjetas: [t]});
			return;
		}
		let r = numeradas.get(fila);
		if (!r) {
			r = {clave: fila, primera: i, tarjetas: []};
			numeradas.set(fila, r);
			todos.push(r);
		}
		r.tarjetas.push(t);
	});
	return todos.sort((a, b) => a.clave - b.clave || a.primera - b.primera).map((r) => r.tarjetas);
}

/** Centro x de un renglón: el promedio de las caja.x de sus tarjetas (en tus reels todas van en 540). */
export function xDeFila(fila: readonly {caja?: {x?: number} | null; variante?: string | null}[], estilo: EstiloTarjeta): number {
	const xs = fila.map((t) => t.caja?.x ?? centroPorDefecto(t, estilo).x);
	return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
}

/** Centro y del renglón de arriba de un grupo: la caja.y de su primera tarjeta. */
export function yDeGrupo(primera: {caja?: {y?: number} | null; variante?: string | null}, estilo: EstiloTarjeta): number {
	return primera.caja?.y ?? centroPorDefecto(primera, estilo).y;
}

/** Caja de una tarjeta dentro de su grupo: centro y tamaño VISIBLES en px base, y su renglón (0 = arriba). */
export type CajaDispuesta = {id: string; fila: number; x: number; y: number; ancho: number; alto: number};

/**
 * Dónde queda cada tarjeta de un grupo, igual que en Tarjeta.tsx: el renglón de arriba centrado en (xDeFila,
 * yDeGrupo); los demás bajan con `separacion_px` entre renglones, cada uno centrado en su xDeFila; dentro de un renglón
 * van lado a lado con `separacion_h_px`, centradas en vertical. Las que aún no aparecen ya ocupan su lugar (nada se
 * mueve). `medir` da el ancho y el alto visibles de cada tarjeta (en las herramientas, layout.medirTarjeta).
 */
export function disponerGrupo<T extends {id: string; fila?: number | null; caja?: {x?: number; y?: number} | null; variante?: string | null}>(
	tarjetas: readonly T[],
	estilo: EstiloTarjeta,
	medir: (t: T) => {ancho: number; alto: number},
): CajaDispuesta[] {
	const filas = filasDeGrupo(tarjetas);
	if (filas.length === 0) return [];
	const salida: CajaDispuesta[] = [];
	let tope = 0;
	filas.forEach((fila, i) => {
		const medidas = fila.map((t) => medir(t));
		const anchoFila = medidas.reduce((s, m) => s + m.ancho, 0) + estilo.separacion_h_px * (fila.length - 1);
		const altoFila = Math.max(...medidas.map((m) => m.alto));
		if (i === 0) tope = yDeGrupo(fila[0], estilo) - altoFila / 2;
		const y = tope + altoFila / 2;
		let x = xDeFila(fila, estilo) - anchoFila / 2;
		fila.forEach((t, k) => {
			salida.push({id: t.id, fila: i, x: x + medidas[k].ancho / 2, y, ancho: medidas[k].ancho, alto: medidas[k].alto});
			x += medidas[k].ancho + estilo.separacion_h_px;
		});
		tope += altoFila + estilo.separacion_px;
	});
	return salida;
}

// ───────────────────────── tiempos ─────────────────────────

/** Cuadros [desde, hasta) de un elemento de la EDL, con el mismo redondeo que Reel.tsx; dura al menos 1 cuadro. */
export function cuadrosDe(el: {desde: number; hasta: number}): {desde: number; hasta: number; duracion: number} {
	const desde = aCuadro(el.desde);
	const hasta = Math.max(desde + 1, aCuadro(el.hasta));
	return {desde, hasta, duracion: hasta - desde};
}

/** Lienzo base (para quien necesite las orillas). */
export const BASE = {ancho: BASE_ANCHO, alto: BASE_ALTO} as const;
