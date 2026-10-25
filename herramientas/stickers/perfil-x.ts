// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * perfil-x.ts: sticker "tarjeta de perfil" estilo X (Twitter) de una persona que mencionas: banner, foto en círculo,
 * nombre, @usuario, su sitio y el botón "Seguir". Decisión del estilo: cuando el creador nombra a alguien, además
 * del loguito, un bannercito con su nombre como el de su perfil.
 *
 *   npx tsx herramientas/stickers/perfil-x.ts --id ana-garcia --nombre "Ana García" --usuario anagarcia \
 *     --sitio anagarcia.dev --foto biblioteca/stickers/logos/fuentes/avatar-ana-garcia.jpg
 *
 * Solo datos públicos y comprobables (usuario de X y sitio salen de su perfil de GitHub); nada de bio inventada.
 * Sale en biblioteca/stickers/logos/<id>-perfil-x.png.
 *
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida (faltan datos, foto ilegible).
 */
import {existsSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';
import {abrirFuente} from '../lib/texto-ancho.ts';
import {tipoImagen} from './avatar.ts';
import {guardarPng, ponerBorde} from './lib/borde.ts';
import {DIR_LOGOS, dibujarSvg, textoATrazo} from './logo.ts';

/** Logo de X (simple-icons, viewBox 0 0 24 24). */
const RUTA_X = 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z';

export const PERFIL = {ancho: 900, alto: 470, radio: 40, banner: 170, foto: 168, margen: 40} as const;

export type DatosPerfil = {nombre: string; usuario: string; sitio?: string; foto: Buffer};

/** SVG de la tarjeta (modo oscuro de X). */
export function svgPerfil(d: DatosPerfil): string {
	const tipo = tipoImagen(d.foto);
	if (!tipo) throw fallo('armar el perfil', 'la foto no es PNG, JPEG ni WebP', 'pasa otra foto con --foto', 2);
	const P = PERFIL;
	const extra = abrirFuente(join(RAIZ, 'biblioteca/fuentes/inter/Inter-ExtraBold.ttf'));
	const semi = abrirFuente(join(RAIZ, 'biblioteca/fuentes/inter/Inter-SemiBold.ttf'));
	const nombre = textoATrazo(extra, d.nombre, 50);
	const usuario = textoATrazo(semi, `@${d.usuario}`, 34);
	const sitio = d.sitio ? textoATrazo(semi, d.sitio, 32) : null;
	const seguir = textoATrazo(extra, 'Seguir', 32);
	const fotoY = P.banner - P.foto / 2;
	const cx = P.margen + P.foto / 2;
	const yNombre = fotoY + P.foto + 62;
	const yUsuario = yNombre + 50;
	const ySitio = yUsuario + 52;
	const bw = seguir.avance + 64;
	const bx = P.ancho - P.margen - bw;
	const by = P.banner + 22;
	const datos = `data:${tipo.mime};base64,${d.foto.toString('base64')}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${P.ancho}" height="${P.alto}" viewBox="0 0 ${P.ancho} ${P.alto}">
<defs>
<clipPath id="tarjeta"><rect width="${P.ancho}" height="${P.alto}" rx="${P.radio}"/></clipPath>
<clipPath id="foto"><circle cx="${cx}" cy="${fotoY + P.foto / 2}" r="${P.foto / 2}"/></clipPath>
<linearGradient id="banner" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d9bf0"/><stop offset="1" stop-color="#0b3d63"/></linearGradient>
</defs>
<g clip-path="url(#tarjeta)">
<rect width="${P.ancho}" height="${P.alto}" fill="#000"/>
<rect width="${P.ancho}" height="${P.banner}" fill="url(#banner)"/>
<g transform="translate(${P.ancho - 92} 26) scale(2.4)"><path d="${RUTA_X}" fill="#fff"/></g>
</g>
<rect x="1.5" y="1.5" width="${P.ancho - 3}" height="${P.alto - 3}" rx="${P.radio - 1.5}" fill="none" stroke="#2f3336" stroke-width="3"/>
<circle cx="${cx}" cy="${fotoY + P.foto / 2}" r="${P.foto / 2 + 7}" fill="#000"/>
<image href="${datos}" x="${P.margen}" y="${fotoY}" width="${P.foto}" height="${P.foto}" preserveAspectRatio="xMidYMid slice" clip-path="url(#foto)"/>
<rect x="${bx}" y="${by}" width="${bw}" height="66" rx="33" fill="#eff3f4"/>
<path transform="translate(${bx + 32} ${by + 45})" d="${seguir.d}" fill="#0f1419"/>
<path transform="translate(${P.margen} ${yNombre})" d="${nombre.d}" fill="#e7e9ea"/>
<path transform="translate(${P.margen} ${yUsuario})" d="${usuario.d}" fill="#71767b"/>
${sitio ? `<path transform="translate(${P.margen} ${ySitio})" d="${sitio.d}" fill="#1d9bf0"/>` : ''}
</svg>`;
}

function principal(argv: string[]): void {
	const {values: v} = parseArgs({args: argv, options: {id: {type: 'string'}, nombre: {type: 'string'}, usuario: {type: 'string'}, sitio: {type: 'string'}, foto: {type: 'string'}}});
	if (!v.id || !v.nombre || !v.usuario || !v.foto) throw fallo('armar el perfil', 'faltan datos', 'pasa --id, --nombre, --usuario y --foto', 2);
	const rutaFoto = join(RAIZ, v.foto);
	if (!existsSync(rutaFoto)) throw fallo('armar el perfil', `no existe ${v.foto}`, 'revisa la ruta de --foto', 2);
	const svg = svgPerfil({nombre: v.nombre, usuario: v.usuario.replace(/^@/, ''), sitio: v.sitio, foto: readFileSync(rutaFoto)});
	const img = ponerBorde(dibujarSvg(svg, PERFIL.ancho)).imagen;
	const destino = join(DIR_LOGOS, `${v.id}-perfil-x.png`);
	guardarPng(destino, img);
	console.log(`Listo: ${relative(RAIZ, destino)} (${img.ancho}×${img.alto})`);
}

if (esPrincipal(import.meta.url)) correr(() => principal(process.argv.slice(2)));
