// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * direccion.md: el plan del director en español, para que Claude lo revise y decida. Cada momento con la palabra que
 * lo dispara, qué se eligió, por qué y sus alternativas; lo que se descartó y por qué; el modo de cerca y los momentos
 * que piden una demo; el titular marcado como BORRADOR; el ritmo y los tipos de tarjeta contra lo medido en tus reels y
 * de dónde sale cada número. Puro.
 */
import type {EstadoRegla, Hallazgo} from '../../validar.ts';
import {textoMedida, type EstiloDirector, type Medida, type NoMedida} from './estilo.ts';
import type {Plan} from './plan.ts';
import type {MomentoPrompt} from './tecleo.ts';

/**
 * ¿Un ritmo está dentro de lo tuyo? Con p10/p90 por reel en estilo.json: dentro de [p10, p90]. Sin ellos: a ±25 % de la
 * mediana. Devuelve la frase para direccion.md y si cumple (null si no hay medida).
 */
export function ritmoContraEstilo(valor: number, m: Medida | NoMedida): {cumple: boolean | null; frase: string} {
	if (m.valor === null) return {cumple: null, frase: 'N/A (sin medida)'};
	const mediana = m.valor;
	const desvio = mediana > 0 ? Math.round(((valor - mediana) / mediana) * 1000) / 10 : 0;
	const vsMediana = `${desvio >= 0 ? '+' : ''}${desvio} % contra tu mediana (${mediana})`;
	if (m.p10 !== undefined && m.p90 !== undefined) {
		const cumple = valor >= m.p10 - 1e-9 && valor <= m.p90 + 1e-9;
		return {cumple, frase: `${cumple ? 'dentro' : 'fuera'} de tu rango por reel [p10 ${m.p10}, p90 ${m.p90}] · ${vsMediana}`};
	}
	const cumple = Math.abs(valor - mediana) <= 0.25 * mediana + 1e-9;
	return {cumple, frase: `${cumple ? 'dentro' : 'fuera'} de ±25 % de tu mediana (${mediana}; sin p10/p90 por reel) · ${vsMediana}`};
}

export type DatosInforme = {
	slug: string;
	semilla: string;
	fecha: string;
	plan: Plan;
	estilo: EstiloDirector;
	franja: {y0: number; y1: number; fuente: string};
	banda: {p10: number | null; p50: number | null; min: number | null; n: number; boca?: {p10: number | null; p50: number | null; min: number | null}; boca_estimada?: boolean};
	sfx: Array<{id: string; tipo: string; t: number; que: string}> | null;
	validacion: {reglas: EstadoRegla[]; hallazgos: Hallazgo[]; frase: string} | null;
	insertsDisponibles: string[];
	/** Momentos en que dictas un prompt ("le dices a Claude"…): lib/director/tecleo.ts → momentosPrompt. */
	prompts?: MomentoPrompt[];
	avisos: string[];
};

const s2 = (x: number): string => x.toFixed(2);
const celda = (x: string): string => x.replace(/\|/g, '\\|').replace(/\n/g, ' / ');

export function informeDireccion(d: DatosInforme): string {
	const {plan, estilo} = d;
	const r = plan.ritmo;
	const lineas: string[] = [];
	lineas.push(`# Dirección · ${d.slug}`);
	lineas.push('');
	lineas.push(`> BORRADOR del director (herramientas/director.ts, ${d.fecha}, semilla "${d.semilla}"). Claude lo revisa: lo que decidas a mano va en \`proyectos/${d.slug}/notas-director.json\` (titular, tarjetas_forzadas, stickers_forzados, inserts, quitar, sin_tarjetas, sin_stickers) y manda sobre este borrador. Vuelve a correr \`npx tsx herramientas/director.ts ${d.slug}\` y luego \`npx tsx herramientas/armar-edl.ts ${d.slug}\`.`);
	lineas.push('');
	lineas.push('## Resumen');
	lineas.push('');
	lineas.push(`- Duración de la base: ${s2(r.duracion_s)} s.`);
	const rt = ritmoContraEstilo(r.tarjetas_por_min, estilo.ritmo.tarjetas_por_min);
	const rk = ritmoContraEstilo(r.stickers_por_min, estilo.ritmo.stickers_por_min);
	lineas.push(`- Tarjetas: ${r.tarjetas} (${r.tarjetas_por_min}/min): **${rt.frase}**. En tus reels: ${textoMedida(estilo.ritmo.tarjetas_por_min, '/min')}. Objetivo para esta duración: ${r.objetivo_tarjetas}.`);
	lineas.push(`- Stickers: ${r.stickers} (${r.stickers_por_min}/min): **${rk.frase}**. En tus reels: ${textoMedida(estilo.ritmo.stickers_por_min, '/min')}. Objetivo: ${r.objetivo_stickers}.`);
	lineas.push(`- Tarjetas por sticker: ${r.stickers ? s2(r.tarjetas / r.stickers) : 'N/A'} (tus reels: ${estilo.ritmo.stickers_por_min.valor ? s2(estilo.ritmo.tarjetas_por_min.valor / estilo.ritmo.stickers_por_min.valor) : 'N/A'}).`);
	lineas.push(`- Inserts: ${r.inserts} (los que pide notas-director.json y, en el modo de cerca, las demos grabadas que emparejan con un momento de acción).`);
	lineas.push(`- Modo de cerca: ${plan.cerca.activo ? '**sí**' : 'no'} (alto de tu cara p50 ${plan.cerca.alto_cara_p50 ?? 'N/A'} px contra ${plan.cerca.umbral !== null ? `${plan.cerca.umbral} px` : 'N/A'}: ${plan.cerca.fuente}).`);
	const b = d.banda;
	lineas.push(
		`- Zona libre (hasta la franja de subtítulos ${d.franja.y0}–${d.franja.y1}, n = ${b.n} ventanas de 1 s): debajo de tu boca (boca máx + ${estilo.cabeza.margen_boca.valor} px, el límite)${b.boca_estimada ? ' — boca ESTIMADA (cara.json sin boca)' : ''}: ${b.n && b.boca ? `p10 ${b.boca.p10} px · p50 ${b.boca.p50} px · mín ${b.boca.min} px` : 'N/A (sin cara.json)'}; debajo de tu barbilla (barbilla máx + ${estilo.cabeza.margen_barbilla.valor} px, la preferencia): ${b.n ? `p10 ${b.p10} px · p50 ${b.p50} px · mín ${b.min} px` : 'N/A'}.`,
	);
	const noCaben = plan.descartes.filter((x) => /no cabe|ninguna de sus/.test(x.motivo)).length;
	const chocan = plan.descartes.filter((x) => /^choca con/.test(x.motivo)).length;
	const porRitmo = plan.descartes.filter((x) => /ritmo objetivo/.test(x.motivo)).length;
	lineas.push(`- Descartados: ${plan.descartes.length} (${noCaben} no caben debajo de tu boca, ${chocan} chocan con otra capa en el mismo momento, ${porRitmo} por el ritmo, ${plan.descartes.length - noCaben - chocan - porRitmo} por otras razones; ver "Descartados").`);
	const tipos = r.tipos_tarjeta;
	const totalTipos = Object.values(tipos).reduce((a, x) => a + x, 0);
	const pct = (n: number, t: number) => (t ? `${Math.round((100 * n) / t)} %` : 'N/A');
	const suyos = estilo.tipos_tarjeta;
	const totalSuyos = suyos.valor ? Object.values(suyos.valor).reduce((a, x) => a + x, 0) : 0;
	const orden = ['clave', 'frase', 'cifra', 'producto', 'pregunta', 'comando', 'notas'];
	const nombres = [...new Set([...orden, ...Object.keys(tipos), ...Object.keys(suyos.valor ?? {})])].filter((k) => (tipos[k] ?? 0) > 0 || (suyos.valor?.[k] ?? 0) > 0);
	lineas.push(
		`- Tipos de tarjeta: ${nombres.map((k) => `${k} ${tipos[k] ?? 0} (${pct(tipos[k] ?? 0, totalTipos)})`).join(' · ')}. Tus reels: ${suyos.valor ? `${nombres.map((k) => `${k} ${pct(suyos.valor![k] ?? 0, totalSuyos)}`).join(' · ')} (n = ${totalSuyos} tarjetas; ${suyos.fuente})` : `N/A (${suyos.nota})`}.`,
	);
	if (d.validacion) lineas.push(`- validar.ts sobre la edición que armaría armar-edl: **${d.validacion.frase}**${d.validacion.hallazgos.length ? ` · ${d.validacion.hallazgos.length} FAIL` : ''}.`);
	lineas.push('');

	lineas.push('## Titular');
	lineas.push('');
	if (plan.titular) {
		lineas.push(`- Texto: «${plan.titular.texto.replace(/\n/g, ' / ')}»${plan.titularInfo.borrador ? ' — **borrador: true** (reescríbelo con la voz del creador y ponlo en notas-director.json → titular)' : ''}.`);
		lineas.push(`- De dónde sale: ${plan.titularInfo.origen}.`);
		const rev = plan.titularInfo.revision;
		if (rev) {
			lineas.push(`- voice.md: ${rev.prohibidas.length === 0 ? 'nada de la lista "Prohibido"' : `trae ${rev.prohibidas.map((x) => x.descripcion).join(', ')}`}. Hook: ${rev.hook.cumple ? 'cumple' : '**no cumple**'} (número: ${rev.hook.numero ? 'sí' : 'no'} · "tú/tu": ${rev.hook.tu ? 'sí' : 'no'} · tensión: ${rev.hook.tension ? 'sí' : 'no'}; voice.md pide al menos uno).`);
			for (const a of rev.avisos) lineas.push(`- Aviso de voz: ${a.descripcion} («${a.texto}»).`);
		} else lineas.push('- voice.md: N/A (creador.json → voz no apunta a un voice.md que exista).');
		lineas.push(`- Caja: y = ${plan.titular.caja?.y}${plan.titular.caja?.escala ? `, escala ${plan.titular.caja.escala}` : ''} · todo el video · tapaCabeza = true (excepción medida: va arriba de tu cabeza).`);
	} else lineas.push(`- Sin titular. ${plan.titularInfo.origen}`);
	for (const a of plan.titularInfo.avisos) lineas.push(`- Layout: ${a}.`);
	lineas.push('');

	lineas.push('## Momentos');
	lineas.push('');
	lineas.push('| id | tiempo | palabra | qué | por qué | alternativas | layout |');
	lineas.push('|---|---|---|---|---|---|---|');
	for (const m of [...plan.decisiones].sort((a, b) => a.t - b.t)) {
		lineas.push(`| ${m.id} | ${s2(m.t)}–${s2(m.hasta)} s | «${celda(m.palabra)}» | ${celda(m.que)}${m.tipo_palabra ? ` [${m.tipo_palabra}]` : ''} | ${celda(m.motivo)}${m.origen === 'notas' ? ' (notas)' : ''} | ${celda(m.alternativas.join('; ') || '—')} | ${celda(m.avisos.join('; ') || 'en su lugar medido')} |`);
	}
	if (plan.decisiones.length === 0) lineas.push('| — | — | — | nada | — | — | — |');
	lineas.push('');

	if (plan.cerca.activo) {
		lineas.push('## Modo de cerca');
		lineas.push('');
		lineas.push(`- Tu cara mide ${plan.cerca.alto_cara_p50} px de alto (p50 de ${plan.cerca.n_cuadros} cuadros con cara) y el p90 de tus reels recientes es ${plan.cerca.umbral} px (${plan.cerca.fuente}): es una toma de cerca.`);
		lineas.push('- Como en tus tomas de cerca: las tarjetas y los logos van en su lugar de siempre, encima de tu barba y tu cuello, tocando la barbilla pero nunca tu boca, nariz ni ojos; tarjetas y stickers siguen a su ritmo.');
		lineas.push('- Prioridad: demos a pantalla completa en los momentos de acción (se reservan antes que tarjetas y stickers).');
		for (const x of plan.cerca.demos) lineas.push(`  - ${s2(x.t)} s · ${x.accion}: «${x.frase}» → ${x.asset}${x.id ? ` (${x.id})` : ' (no entró)'} · en común: ${x.comunes.join(', ')}.`);
		if (plan.cerca.demos.length === 0) lineas.push('  - Ninguna demo grabada empareja con tus momentos de acción.');
		if (plan.cerca.sin_demo.length) lineas.push(`- Sin demo grabada (grábala con /grabar-demo si la quieres): ${plan.cerca.sin_demo.map((m) => `${s2(m.t)} s «${m.frase}»`).join('; ')}.`);
		lineas.push('');
	}

	lineas.push('## Momentos que piden una demo (decide tú)');
	lineas.push('');
	if (plan.demos.length === 0) lineas.push('- Ninguno.');
	for (const m of plan.demos) lineas.push(`- ${s2(m.t)} s · ${m.accion}: «${m.frase}»${plan.cerca.demos.some((x) => Math.abs(x.t - m.t) < 0.01) ? ' — con demo (modo de cerca)' : ''}`);
	if (d.insertsDisponibles.length) lineas.push(`- Inserts disponibles en el proyecto: ${d.insertsDisponibles.join(', ')}.`);
	lineas.push('- Para meter uno: `inserts: [{"asset": "p/<slug>/inserts/x.mp4", "desde_palabra": "te vas a la parte", "duracion": 3, "layout": "pantalla-completa"}]` en notas-director.json.');
	lineas.push('');

	lineas.push('## Prompts dictados (decide tú)');
	lineas.push('');
	const prompts = d.prompts ?? [];
	const tarjetasPrompt = plan.tarjetas.filter((t) => t.variante === 'prompt');
	if (prompts.length === 0) lineas.push('- Ninguno ("le dices / decirle / le pides / le escribes a Claude" no aparece).');
	for (const m of prompts) {
		const puesto = tarjetasPrompt.some((t) => t.desde >= m.t - 0.5 && t.desde <= m.hasta + 0.5);
		lineas.push(`- PROMPT ${s2(m.desde)}–${s2(m.hasta)} s, tras «${m.disparo}»: aquí dicta un prompt; ponlo en tarjetas_forzadas variante prompt con el texto literal${puesto ? ' (ya hay una tarjeta prompt aquí)' : ''}. Lo que dijo: «${m.texto}».`);
		lineas.push(`  - \`{"texto": "<el prompt literal, sin muletillas>", "variante": "prompt", "desde_palabra": "${m.desde_palabra}"}\`: entra escribiéndose (~31 car/s) con tu tecleo; si pasa de ~120 caracteres se parte solo en dos tarjetas seguidas.`);
	}
	lineas.push('');

	lineas.push('## Descartados');
	lineas.push('');
	if (plan.descartes.length === 0) lineas.push('- Nada.');
	for (const x of plan.descartes) lineas.push(`- ${s2(x.t)} s «${x.palabra}» · ${x.que}: ${x.motivo}.`);
	lineas.push('');

	lineas.push('## Zooms, efectos y resaltado');
	lineas.push('');
	lineas.push(`- Zooms: ninguno (${textoMedida(estilo.zooms_por_min)}).`);
	lineas.push(plan.efectos.length ? `- Desenfoque: ${plan.efectos.map((x) => `${s2(x.desde)}–${s2(x.hasta)} s`).join(', ')} (${textoMedida(estilo.desenfoque_por_min, '/min')}; siempre con tarjetas encima, máx. 1 cada 30 s).` : `- Desenfoque: ninguno (${textoMedida(estilo.desenfoque_por_min)}).`);
	lineas.push(`- Resaltado en subtítulos: resaltar_palabras = [] (${textoMedida(estilo.resaltado_pct, ' %')}).`);
	lineas.push('');

	lineas.push('## SFX');
	lineas.push('');
	if (!d.sfx) lineas.push('- Sin SFX (--sin-sfx): elígelos después con `npx tsx herramientas/sfx/elegir.ts --edicion … --salida …`.');
	else for (const x of d.sfx) lineas.push(`- ${s2(x.t)} s · ${x.id} (${x.tipo}): ${x.que}`);
	lineas.push('');

	if (d.validacion && d.validacion.hallazgos.length) {
		lineas.push('## FAIL de validar.ts');
		lineas.push('');
		for (const h of d.validacion.hallazgos) lineas.push(`- [${h.numero ?? h.regla}] ${h.donde}: ${h.detalle}`);
		lineas.push('');
	}

	lineas.push('## Estilo usado (cada número con su n y su fuente)');
	lineas.push('');
	const filas: Array<[string, string]> = [
		['Tarjetas por minuto', textoMedida(estilo.ritmo.tarjetas_por_min)],
		['Stickers por minuto', textoMedida(estilo.ritmo.stickers_por_min)],
		['Duración de tarjeta p10/p50', `${textoMedida(estilo.duracion.tarjeta.p10, ' s')} · ${textoMedida(estilo.duracion.tarjeta.p50, ' s')}`],
		['Duración de sticker p10/p50', `${textoMedida(estilo.duracion.sticker.p10, ' s')} · ${textoMedida(estilo.duracion.sticker.p50, ' s')}`],
		['Separación mínima', textoMedida(estilo.separacion_min_s, ' s')],
		['Mínimo por palabra', textoMedida(estilo.min_por_palabra_s, ' s')],
		['Desfase de aparición', textoMedida(estilo.desfase_aparicion_s, ' s')],
		['Ancho de sticker p10/p50 (visible)', `${textoMedida(estilo.sticker.ancho_p10, ' px')} · ${textoMedida(estilo.sticker.ancho_p50, ' px')}`],
		['Centro y de los stickers', textoMedida(estilo.sticker.centro_y, ' px')],
		['Tarjeta: y, separación, escala de lista', `${textoMedida(estilo.tarjeta.y, ' px')} · ${textoMedida(estilo.tarjeta.separacion_px, ' px')} · ${textoMedida(estilo.tarjeta.escala_lista)}`],
		['Tarjeta: rango del centro en un reel (p10–p90)', `${textoMedida(estilo.tarjeta.y_rango.p10, ' px')} · ${textoMedida(estilo.tarjeta.y_rango.p90, ' px')}`],
		['Zona protegida: margen debajo de tu boca', textoMedida(estilo.cabeza.margen_boca, ' px')],
		['Preferencia: aire debajo de tu barbilla', textoMedida(estilo.cabeza.margen_barbilla, ' px')],
		['Alto de cara de tus reels (umbral del modo de cerca = su p90)', textoMedida(estilo.encuadre.alto_cara, ' px')],
		['Duración de tus inserts (las demos propuestas duran su p90)', `${textoMedida(estilo.insert.duracion_p50, ' s')} · p90 ${textoMedida(estilo.insert.duracion_p90, ' s')}`],
		['Titular: y', textoMedida(estilo.titular.y, ' px')],
		['Franja de subtítulos', `${d.franja.y0}–${d.franja.y1} (${d.franja.fuente})`],
		['Zona UI arriba / lados', `${textoMedida(estilo.zona_ui.arriba, ' px')} · ${textoMedida(estilo.zona_ui.izquierda, ' px')}`],
		['tapaCabeza por reel (p90)', textoMedida(estilo.tapa_cabeza_p90)],
	];
	lineas.push('| qué | valor |');
	lineas.push('|---|---|');
	for (const [a, b] of filas) lineas.push(`| ${a} | ${celda(b)} |`);
	lineas.push('');
	const todos = [...plan.avisos, ...d.avisos];
	if (todos.length) {
		lineas.push('## Avisos');
		lineas.push('');
		for (const a of todos) lineas.push(`- ${a}`);
		lineas.push('');
	}
	return `${lineas.join('\n')}\n`;
}
