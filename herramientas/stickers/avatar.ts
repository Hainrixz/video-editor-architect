/**
 * avatar.ts: sticker de una persona que mencionas (su foto o avatar público), con el mismo look que los logos:
 *   - "tile": cuadro blanco redondeado con el avatar en círculo y su nombre abajo (como el tile de Claude).
 *   - "solo": el avatar en círculo con borde blanco tipo sticker.
 * Va al catálogo de logos (biblioteca/stickers/logos/catalogo.json) para que el director lo encuentre por nombre
 * (stickers_forzados con id_catalogo "logo-<id>-tile") y lo proponga cuando lo mencionas.
 *
 *   npx tsx herramientas/stickers/avatar.ts --id ana-garcia --nombre "Ana García" \
 *     --url https://github.com/<usuario>.png?size=460 --etiquetas ana,garcia,diseno,animaciones
 *   npx tsx herramientas/stickers/avatar.ts --id ana-garcia --nombre "Ana García" --archivo foto.jpg
 *
 * Licencias (decisión del creador): lo que se sube a Instagram puede llevar logos, fotos y GIFs de cualquier fuente;
 * solo se anota de dónde salió (fuente_url). La imagen original se guarda en logos/fuentes/avatar-<id>.<ext>.
 *
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida (falta --id/--nombre, imagen ilegible) · 3 la red falló.
 */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {CANDIDATAS} from '../../src/estilo/fuentes.ts';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';
import {abrirFuente} from '../lib/texto-ancho.ts';
import {guardarPng, ponerSombra, sha256, type ResultadoBorde} from './lib/borde.ts';
import {armarSolo, bajar, DIR_FUENTES, DIR_LOGOS, dibujarSvg, LADO_TILE, PESO_NOMBRE, tamanoNombre, textoATrazo, TILE} from './logo.ts';
import type {FuenteFk} from '../lib/texto-ancho.ts';
import {guardarCatalogo, leerCatalogo, ponerFila, type FilaCatalogo} from './procesar.ts';

/** Tipo de imagen por sus primeros bytes (solo PNG, JPEG y WebP, que resvg sabe leer). */
export function tipoImagen(buf: Buffer): {mime: string; ext: string} | null {
	if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return {mime: 'image/png', ext: 'png'};
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return {mime: 'image/jpeg', ext: 'jpg'};
	if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return {mime: 'image/webp', ext: 'webp'};
	return null;
}

/**
 * SVG cuadrado con la imagen recortada en círculo (centrada, sin deformar: "slice" llena el círculo). Sirve como
 * "logo" para armarTile/armarSolo de logo.ts.
 */
export function svgAvatarCircular(buf: Buffer, mime: string, lado = 512): string {
	const r = lado / 2;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${lado} ${lado}">` +
		`<defs><clipPath id="c"><circle cx="${r}" cy="${r}" r="${r}"/></clipPath></defs>` +
		`<image x="0" y="0" width="${lado}" height="${lado}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)" href="data:${mime};base64,${buf.toString('base64')}"/>` +
		`</svg>`
	);
}

/**
 * Tile de persona: la misma geometría que el tile de logos (logo.ts → armarTile), con el avatar en un círculo del
 * alto de la caja del logo y un anillo gris muy suave para que se separe del blanco. La imagen va directa en el SVG
 * (resvg no carga una imagen rasterizada metida dentro de otro SVG embebido).
 */
export function armarTileAvatar(buf: Buffer, mime: string, nombre: string, fuente: FuenteFk, lado = LADO_TILE): ResultadoBorde {
	const d = Math.min(TILE.logoAncho, TILE.logoAlto) * lado;
	const cx = lado / 2;
	const cy = TILE.logoCentroY * lado;
	let tamano = tamanoNombre(fuente, lado);
	let trazo = textoATrazo(fuente, nombre, tamano);
	const anchoMax = TILE.nombreAnchoMax * lado;
	if (trazo.tinta.x1 - trazo.tinta.x0 > anchoMax) {
		tamano *= anchoMax / (trazo.tinta.x1 - trazo.tinta.x0);
		trazo = textoATrazo(fuente, nombre, tamano);
	}
	const tx = lado / 2 - (trazo.tinta.x0 + trazo.tinta.x1) / 2;
	const ty = TILE.nombreBase * lado;
	const r = TILE.radio * lado;
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${lado} ${lado}">` +
		`<defs><clipPath id="c"><circle cx="${cx}" cy="${cy}" r="${d / 2}"/></clipPath></defs>` +
		`<rect x="0" y="0" width="${lado}" height="${lado}" rx="${r}" ry="${r}" fill="#FFFFFF"/>` +
		`<image x="${(cx - d / 2).toFixed(2)}" y="${(cy - d / 2).toFixed(2)}" width="${d.toFixed(2)}" height="${d.toFixed(2)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)" href="data:${mime};base64,${buf.toString('base64')}"/>` +
		`<circle cx="${cx}" cy="${cy}" r="${(d / 2 - 1).toFixed(2)}" fill="none" stroke="#000000" stroke-opacity="0.08" stroke-width="2"/>` +
		`<path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)})" fill="${TILE.colorNombre}" d="${trazo.d}"/>` +
		`</svg>`;
	return ponerSombra(dibujarSvg(svg, lado));
}

export type OpcionesAvatar = {id: string; nombre: string; url?: string; archivo?: string; etiquetas?: string[]; destino?: string};

export function generarAvatar(op: OpcionesAvatar): FilaCatalogo[] {
	if (!/^[a-z0-9-]+$/.test(op.id)) throw fallo('hacer el avatar', `el id "${op.id}" no es válido`, 'usa minúsculas, números y guiones (ej. ana-garcia)', 2);
	if (!op.url && !op.archivo) throw fallo('hacer el avatar', 'falta de dónde sacar la imagen', 'pasa --url o --archivo', 2);
	const buf = op.archivo ? readFileSync(op.archivo) : bajar(op.url!);
	const tipo = tipoImagen(buf);
	if (!tipo) throw fallo('hacer el avatar', 'la imagen no es PNG, JPEG ni WebP', 'baja otra versión de la foto', 2);
	const original = join(DIR_FUENTES, `avatar-${op.id}.${tipo.ext}`);
	writeFileSync(original, buf);
	const archivoFuente = CANDIDATAS['tiktok-sans'].archivos[PESO_NOMBRE];
	if (!archivoFuente) throw fallo('hacer el avatar', `TikTok Sans no tiene el peso ${PESO_NOMBRE}`, 'revisa src/estilo/fuentes.ts', 1);
	const fuente = abrirFuente(join(RAIZ, archivoFuente.ruta));
	const svg = svgAvatarCircular(buf, tipo.mime);
	const destino = op.destino ?? DIR_LOGOS;
	const rutaCatalogo = join(destino, 'catalogo.json');
	const nuevas: FilaCatalogo[] = [];
	for (const variante of ['tile', 'solo'] as const) {
		const res = variante === 'tile' ? armarTileAvatar(buf, tipo.mime, op.nombre, fuente) : armarSolo(svg);
		const archivo = join(destino, `${op.id}-${variante}.png`);
		const {sha256: sha} = guardarPng(archivo, res.imagen);
		nuevas.push({
			id: `logo-${op.id}-${variante}`,
			fuente: 'logo',
			marca: op.nombre,
			archivo: relative(RAIZ, archivo).split(sep).join('/'),
			variante,
			ancho: res.imagen.ancho,
			alto: res.imagen.alto,
			caja_tinta: res.cuerpo,
			etiquetas: [...new Set([...(op.etiquetas ?? []), 'persona', 'avatar', variante])],
			licencia: 'Avatar público de la persona; decisión del creador: para Instagram las licencias no importan, solo se anota el origen',
			fuente_url: op.url ?? relative(RAIZ, op.archivo!),
			fuente_repo: 'avatar',
			commit: null,
			color: null,
			guia_marca_url: null,
			uso: 'editorial',
			sha256: sha,
			svg: null,
			original: relative(RAIZ, original).split(sep).join('/'),
			original_sha256: sha256(buf),
		});
	}
	// Leer y escribir al final (otros procesos pueden tocar el catálogo): solo se reemplazan estas filas.
	let catalogo = existsSync(rutaCatalogo) ? leerCatalogo(rutaCatalogo) : [];
	for (const f of nuevas) catalogo = ponerFila(catalogo, f);
	guardarCatalogo(rutaCatalogo, catalogo);
	return nuevas;
}

async function main(): Promise<void> {
	const {values} = parseArgs({options: {id: {type: 'string'}, nombre: {type: 'string'}, url: {type: 'string'}, archivo: {type: 'string'}, etiquetas: {type: 'string'}}});
	if (!values.id || !values.nombre) throw fallo('hacer el avatar', 'faltan --id o --nombre', 'ej.: --id ana-garcia --nombre "Ana García" --url <imagen>', 2);
	const filas = generarAvatar({
		id: values.id,
		nombre: values.nombre,
		url: values.url,
		archivo: values.archivo,
		etiquetas: values.etiquetas?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
	});
	console.log(`Listo: ${filas.map((f) => f.archivo).join(' y ')} (ids ${filas.map((f) => f.id).join(', ')}) en el catálogo de logos.`);
}

if (esPrincipal(import.meta.url)) void correr(main);
