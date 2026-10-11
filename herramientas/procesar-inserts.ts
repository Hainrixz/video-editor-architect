/**
 * procesar-inserts.ts — Fase 4: tu material (capturas y B-roll) listo para la edición.
 *
 *   npx tsx herramientas/procesar-inserts.ts <slug> <archivo|carpeta>… [--sin-ocr] [--forzar]
 *   npx tsx herramientas/procesar-inserts.ts <slug> --escanear [--todas]   OCR de las capturas que falten
 *   npx tsx herramientas/procesar-inserts.ts <slug> --aprobar <id>          lo corres TÚ tras revisar una captura bloqueada
 *   npx tsx herramientas/procesar-inserts.ts <slug>                         estado de los inserts del proyecto
 *
 * Por cada archivo deja proyectos/<slug>/inserts/<id>.mp4|png + <id>.json (detalle en herramientas/lib/inserts.ts):
 *   - videos: autorrotados, 30 fps constantes, H.264 CRF 16 yuv420p BT.709, ancho ≤ 1440, con su audio (AAC 48 kHz);
 *   - imágenes: PNG sRGB (el perfil P3 de tu Mac o tu iPhone se convierte), lado mayor ≤ 2560, sin EXIF.
 * Las entradas (entrada/ o ~/Downloads) solo se leen; su sha256 queda en el .json. Una carpeta se procesa sin entrar a
 * subcarpetas. Lo ya procesado con el mismo original y los mismos parámetros se reutiliza (--forzar lo rehace).
 *
 * OCR de secretos en las capturas: Apple Vision NO corre dentro del sandbox. Dentro, las capturas quedan SIN_ESCANEAR
 * (no entran a la edición) y este comando te dice cómo escanearlas; fuera (comando excluido, editar.ts o las pruebas
 * de integración) se escanean solas. Si el OCR ve algo, la captura queda BLOQUEADA hasta que la revises tú.
 *
 * Sale con 0 (aunque alguna captura quede bloqueada o sin escanear: lo dice), 1 (fallo interno) o 2 (archivo que no
 * existe, tipo no soportado, video HDR, slug inválido).
 */
import {parseArgs} from 'node:util';
import {relative} from 'node:path';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {aprobarInsert, dirInserts, escanearPendientes, estadoInsert, listarMetas, procesarInserts, type MetaInsert} from './lib/inserts.ts';
import {RAIZ, validarSlug} from './lib/manifest.ts';

const USO = 'npx tsx herramientas/procesar-inserts.ts <slug> <archivo|carpeta>… [--sin-ocr] [--forzar] · <slug> --escanear · <slug> --aprobar <id>';

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Una línea por insert: qué es, cómo quedó y si puede entrar a la edición. */
export function lineaDeInsert(meta: MetaInsert, estado: {estado: string; motivo: string; usable: boolean}, extra = ''): string {
	const medida = `${meta.ancho}×${meta.alto}`;
	const rot = meta.rotacion_original !== 0 ? ` · venía rotado ${meta.rotacion_original}°` : '';
	if (meta.tipo === 'video') {
		return `${estado.usable ? '✔' : '✖'} ${meta.id} (video) ${medida} · ${meta.duracion_s} s · ${meta.fps} fps · ${meta.tiene_audio ? 'con audio' : 'sin audio'}${rot} → ${meta.asset}${extra}`;
	}
	const color = meta.detalle.color as {perfil_origen?: string; convertido_a_srgb?: boolean} | undefined;
	const perfil = color?.perfil_origen ? ` · ${color.perfil_origen}${color.convertido_a_srgb ? ' → sRGB' : ''}` : '';
	return `${estado.usable ? '✔' : '✖'} ${meta.id} (imagen) ${medida}${perfil}${rot} · OCR: ${estado.estado} → ${meta.asset}${extra}`;
}

function avisosDe(meta: MetaInsert): string[] {
	const salida = meta.avisos.map((a) => `    aviso: ${a}`);
	if (meta.revision.estado === 'BLOQUEADA') {
		salida.push(`    BLOQUEADA: ${meta.revision.motivo}. No la abras ni la uses hasta que la revise el creador.`);
		for (const h of meta.revision.hallazgos) salida.push(`      ${h.tipo} ${h.muestra} en (${h.caja.x}, ${h.caja.y}) ${h.caja.w}×${h.caja.h} px`);
		if (meta.revision.siguiente_paso) salida.push(`    Siguiente paso: ${meta.revision.siguiente_paso}.`);
	} else if (meta.revision.estado === 'SIN_ESCANEAR') {
		salida.push(`    SIN_ESCANEAR: ${meta.revision.motivo}.`);
		if (meta.revision.siguiente_paso) salida.push(`    Siguiente paso: ${meta.revision.siguiente_paso}.`);
	}
	return salida;
}

async function main(): Promise<void> {
	const {values, positionals} = parseArgs({
		allowPositionals: true,
		options: {
			'sin-ocr': {type: 'boolean', default: false},
			forzar: {type: 'boolean', default: false},
			escanear: {type: 'boolean', default: false},
			todas: {type: 'boolean', default: false},
			aprobar: {type: 'string'},
		},
	});
	const [slugCrudo, ...entradas] = positionals;
	if (!slugCrudo) throw fallo('procesar los inserts', 'falta el slug del proyecto', `usa ${USO}`, 2);
	const slug = validarSlug(slugCrudo);
	const dir = dirInserts(slug);

	if (values.aprobar !== undefined) {
		console.log('Ojo: --aprobar es tuyo (del creador); Claude no lo corre por su cuenta.');
		const meta = aprobarInsert(dir, values.aprobar);
		console.log(`${meta.id}: ${meta.revision.estado} — ${meta.revision.motivo}.`);
		return;
	}

	if (values.escanear) {
		const metas = await escanearPendientes({slug, todas: values.todas});
		if (metas.length === 0) console.log('No hay capturas pendientes de escanear.');
		for (const m of metas) {
			console.log(lineaDeInsert(m, estadoInsert(dir, m)));
			for (const l of avisosDe(m)) console.log(l);
		}
		return;
	}

	if (entradas.length === 0) {
		const metas = listarMetas(dir);
		if (metas.length === 0) {
			console.log(`proyectos/${slug}/inserts/ no tiene inserts todavía. Usa ${USO}`);
			return;
		}
		for (const m of metas) {
			console.log(lineaDeInsert(m, estadoInsert(dir, m)));
			for (const l of avisosDe(m)) console.log(l);
		}
		return;
	}

	const resultados = await procesarInserts({slug, entradas, ocr: !values['sin-ocr'], forzar: values.forzar, avisar: (m) => console.log(m)});
	let bloqueadas = 0;
	let sinEscanear = 0;
	for (const r of resultados) {
		const estado = estadoInsert(dir, r.meta);
		console.log(lineaDeInsert(r.meta, estado, r.reutilizado ? ' (ya estaba)' : ` (${r2(r.segundos)} s)`));
		for (const l of avisosDe(r.meta)) console.log(l);
		if (r.meta.revision.estado === 'BLOQUEADA') bloqueadas++;
		if (r.meta.revision.estado === 'SIN_ESCANEAR') sinEscanear++;
	}
	const nuevos = resultados.filter((r) => !r.reutilizado).length;
	console.log(
		`Listo: ${resultados.length} insert(s) en ${relative(RAIZ, dir)}/ (${nuevos} nuevo(s), ${resultados.length - nuevos} ya estaban).` +
			(bloqueadas ? ` ${bloqueadas} captura(s) BLOQUEADA(s) hasta que las revises.` : '') +
			(sinEscanear ? ` ${sinEscanear} captura(s) sin escanear (no entran a la edición hasta pasar por el OCR).` : ''),
	);
}

if (esPrincipal(import.meta.url)) void correr(main);
