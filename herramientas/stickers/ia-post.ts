// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * ia-post.ts (fuente 4 de stickers): post-proceso de un sticker que YA generaste con Higgsfield sobre croma.
 * No genera nada: generar cuesta créditos y solo se hace con tu sí y el costo de get_cost dicho antes
 * (eso lo hace la skill, una generación por petición). Este CLI solo limpia lo que ya existe.
 *
 *   npx tsx herramientas/stickers/ia-post.ts <png|jpg|webp> [--croma verde|azul|magenta|auto]
 *        [--id ia-mascota-laptop] [--etiquetas mascota,laptop] [--destino biblioteca/stickers/ia]
 *        [--modelo nano_banana_pro] [--prompt "…"] [--forzar] [--json]
 *
 * Pasos:
 *   1. Quita el croma (por defecto verde): el color de la orilla es la llave. Cada píxel se mide por su exceso de
 *      croma (verde: g − max(r, b)) en dos escalas, la absoluta y la relativa a su propio brillo (así una sombra
 *      sobre el verde también se va); el alfa es el menor de los dos. En la orilla se "desmezcla" el color
 *      (C − (1 − α)·llave) / α y se limita el verde al máximo de los otros canales (despill).
 *   2. Si la imagen ya trae transparencia, no se toca el alfa.
 *   3. Islas, recorte, halo (hacia blanco), borde tipo sticker y sombra: lo mismo que procesar.ts.
 *   4. Guarda <destino>/<id>.png y su fila en <destino>/catalogo.json (fuente "ia").
 *
 * Límite conocido del croma: lo que dentro del sticker sea del mismo color que el fondo se vuelve transparente.
 * Por eso el prompt pide un fondo de croma de un color que el sticker no use.
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida (no existe, no es imagen, el fondo no es croma).
 */
import {existsSync, readFileSync} from 'node:fs';
import {basename, join, relative, resolve, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';
import {distanciaA, guardarPng, nuevaImagen, sha256, type ImagenRGBA, type Rgb} from './lib/borde.ts';
import {
	aSlug,
	armarSticker,
	colorDeFondo,
	decodificarImagen,
	etiquetasDeNombre,
	guardarCatalogo,
	idParaArchivo,
	leerCatalogo,
	ponerFila,
	revisarDestino,
	traeAlfaPropio,
	type FilaCatalogo,
} from './procesar.ts';

export type Croma = 'verde' | 'azul' | 'magenta';

/** Exceso de croma de un color: cuánto le sobra del canal de la llave sobre los demás. */
export function excesoCroma(r: number, g: number, b: number, croma: Croma): number {
	if (croma === 'verde') return g - Math.max(r, b);
	if (croma === 'azul') return b - Math.max(r, g);
	return Math.min(r, b) - g;
}

/** Brillo del canal (o canales) de la llave: para medir el exceso relativo. */
function brilloCroma(r: number, g: number, b: number, croma: Croma): number {
	if (croma === 'verde') return g;
	if (croma === 'azul') return b;
	return Math.min(r, b);
}

/** Qué croma parece tener la orilla (null si ninguno es claro). */
export function detectarCroma(color: Rgb): Croma | null {
	const candidatos: Croma[] = ['verde', 'azul', 'magenta'];
	let mejor: Croma | null = null;
	let mejorExceso = 40;
	for (const c of candidatos) {
		const e = excesoCroma(color[0], color[1], color[2], c);
		if (e > mejorExceso) {
			mejorExceso = e;
			mejor = c;
		}
	}
	return mejor;
}

export type ResultadoCroma = {imagen: ImagenRGBA; llave: Rgb; croma: Croma};

/**
 * Quita el fondo de croma con despill. Puro: sin archivos.
 *   - alfa_abs = rampa del exceso absoluto entre 20 % y 80 % del exceso de la llave;
 *   - alfa_rel = rampa del exceso relativo al brillo entre 30 % y 85 % del de la llave;
 *   - alfa = mín(alfa_abs, alfa_rel); con exceso ≤ 12 % del de la llave el píxel es del sticker (alfa 1).
 */
export function quitarCroma(img: ImagenRGBA, croma: Croma | 'auto' = 'verde'): ResultadoCroma {
	const {color: llave} = colorDeFondo(img);
	const elegido = croma === 'auto' ? detectarCroma(llave) : croma;
	const hex = `#${llave.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
	if (!elegido) {
		throw fallo('quitar el croma', `la orilla de la imagen (${hex}) no parece verde, azul ni magenta`, 'pásame el sticker sobre croma, o usa procesar.ts para fondos lisos', 2);
	}
	const sK = excesoCroma(llave[0], llave[1], llave[2], elegido);
	const qK = sK / Math.max(1, brilloCroma(llave[0], llave[1], llave[2], elegido));
	if (sK < 40 || qK < 0.25) {
		throw fallo('quitar el croma', `la orilla de la imagen (${hex}) no parece croma ${elegido}`, `revisa --croma (verde, azul o magenta) o usa --croma auto`, 2);
	}
	const {ancho, alto, datos} = img;
	const n = ancho * alto;
	const salida = nuevaImagen(ancho, alto);
	const s = salida.datos;
	for (let i = 0; i < n; i++) {
		const o = i * 4;
		const r = datos[o];
		const g = datos[o + 1];
		const b = datos[o + 2];
		const e = excesoCroma(r, g, b, elegido);
		let a = 1;
		if (e > 0.12 * sK) {
			const aAbs = (0.8 * sK - e) / (0.6 * sK);
			const q = e / Math.max(1, brilloCroma(r, g, b, elegido));
			const aRel = (0.85 * qK - q) / (0.55 * qK);
			a = Math.min(1, Math.max(0, Math.min(aAbs, aRel)));
		}
		a *= datos[o + 3] / 255;
		if (a <= 0) continue;
		let cr = r;
		let cg = g;
		let cb = b;
		if (a < 1) {
			// Desmezcla: el píxel de la orilla es α·sticker + (1 − α)·llave.
			cr = Math.min(255, Math.max(0, (r - (1 - a) * llave[0]) / a));
			cg = Math.min(255, Math.max(0, (g - (1 - a) * llave[1]) / a));
			cb = Math.min(255, Math.max(0, (b - (1 - a) * llave[2]) / a));
		}
		s[o] = Math.round(cr);
		s[o + 1] = Math.round(cg);
		s[o + 2] = Math.round(cb);
		s[o + 3] = Math.round(a * 255);
	}
	// Despill en la banda de la orilla (≤ 3 px de lo transparente): el canal de la llave no puede sobrar.
	const exterior = new Uint8Array(n);
	for (let i = 0; i < n; i++) exterior[i] = s[i * 4 + 3] < 128 ? 1 : 0;
	const dist = distanciaA(exterior, ancho, alto);
	for (let i = 0; i < n; i++) {
		const o = i * 4;
		if (s[o + 3] === 0 || dist[i] > 3) continue;
		const e = excesoCroma(s[o], s[o + 1], s[o + 2], elegido);
		if (e <= 0) continue;
		if (elegido === 'verde') s[o + 1] -= e;
		else if (elegido === 'azul') s[o + 2] -= e;
		else {
			s[o] -= e;
			s[o + 2] -= e;
		}
	}
	return {imagen: salida, llave, croma: elegido};
}

async function main(): Promise<void> {
	const {values, positionals} = parseArgs({
		allowPositionals: true,
		options: {
			croma: {type: 'string', default: 'verde'},
			id: {type: 'string'},
			etiquetas: {type: 'string', default: ''},
			destino: {type: 'string', default: 'biblioteca/stickers/ia'},
			modelo: {type: 'string'},
			prompt: {type: 'string'},
			forzar: {type: 'boolean', default: false},
			json: {type: 'boolean', default: false},
		},
	});
	if (positionals.length !== 1) {
		throw fallo('leer los argumentos', 'espero exactamente una imagen', 'usa: npx tsx herramientas/stickers/ia-post.ts <png> [--croma verde]', 2);
	}
	const croma = values.croma as Croma | 'auto';
	if (!['verde', 'azul', 'magenta', 'auto'].includes(croma)) {
		throw fallo('leer las opciones', `--croma debe ser verde, azul, magenta o auto (llegó ${values.croma})`, 'usa --croma verde', 2);
	}
	const ruta = resolve(positionals[0]);
	if (!existsSync(ruta)) throw fallo('leer la imagen', `no existe ${positionals[0]}`, 'revisa la ruta del PNG que bajaste de Higgsfield', 2);
	const destino = revisarDestino(values.destino!);
	const rutaCatalogo = join(destino, 'catalogo.json');
	let catalogo = leerCatalogo(rutaCatalogo);

	const bytes = readFileSync(ruta);
	const origenSha = sha256(bytes);
	const ocupados = new Map(catalogo.map((f) => [f.id, String((f.origen as {sha256?: string} | undefined)?.sha256 ?? '')]));
	const id = values.id ? aSlug(values.id) : idParaArchivo('ia', basename(ruta), ocupados, origenSha);
	if (!id) throw fallo('leer las opciones', '--id quedó vacío', 'usa letras y números (ej. --id ia-mascota-laptop)', 2);
	const previa = catalogo.find((f) => f.id === id);
	const archivoSalida = join(destino, `${id}.png`);
	if (previa && !values.forzar && existsSync(archivoSalida) && (previa.origen as {sha256?: string} | undefined)?.sha256 === origenSha) {
		console.log(`Saltado: ${relative(RAIZ, archivoSalida)} ya está en el catálogo con la misma imagen (usa --forzar para rehacerlo).`);
		return;
	}
	if (previa && !values.forzar && (previa.origen as {sha256?: string} | undefined)?.sha256 !== origenSha) {
		throw fallo('guardar el sticker', `ya existe ${id} hecho con otra imagen`, 'elige otro --id o usa --forzar para reemplazarlo', 2);
	}

	const original = decodificarImagen(ruta);
	let conAlfa: ImagenRGBA;
	let metodo: string;
	let llave: Rgb | null = null;
	if (traeAlfaPropio(original)) {
		conAlfa = original;
		metodo = 'alfa-propio';
	} else {
		const r = quitarCroma(original, croma);
		conAlfa = r.imagen;
		llave = r.llave;
		metodo = `croma-${r.croma}`;
	}
	const sticker = armarSticker(conAlfa, {fondo: llave, alfaPropio: metodo === 'alfa-propio'});
	const {sha256: shaPng} = guardarPng(archivoSalida, sticker.imagen);
	const etiquetas = [...new Set([...etiquetasDeNombre(basename(ruta)).filter((e) => !/^hf$/.test(e)), ...values.etiquetas!.split(',').map(aSlug).filter(Boolean), 'ia'])];
	const fila: FilaCatalogo = {
		id,
		fuente: 'ia',
		archivo: relative(RAIZ, archivoSalida).split(sep).join('/'),
		ancho: sticker.imagen.ancho,
		alto: sticker.imagen.alto,
		caja_tinta: sticker.cuerpo,
		etiquetas,
		licencia: 'propia: generada por ti con Higgsfield (revisa los términos de tu plan)',
		origen: {archivo: basename(ruta), sha256: origenSha},
		generado_con: {servicio: 'Higgsfield', modelo: values.modelo ?? null, prompt: values.prompt ?? null},
		metodo_alfa: metodo,
		llave: llave ? `#${llave.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : null,
		borde_px: sticker.conservado ? null : sticker.grosor,
		borde: sticker.conservado ? 'propio' : 'blanco',
		sombra: sticker.conservado ? 'propia' : sticker.sombra !== null,
		sha256: shaPng,
		procesado_en: new Date().toISOString().slice(0, 10),
	};
	catalogo = ponerFila(catalogo, fila);
	guardarCatalogo(rutaCatalogo, catalogo);
	if (values.json) console.log(JSON.stringify({catalogo: relative(RAIZ, rutaCatalogo), fila}));
	else console.log(`Listo: ${fila.archivo} (${metodo}, ${fila.ancho}×${fila.alto}, borde ${fila.borde_px} px).`);
}

if (esPrincipal(import.meta.url)) void correr(main);
