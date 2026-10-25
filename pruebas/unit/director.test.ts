// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas del director (herramientas/director.ts y herramientas/lib/director/*): texto (cifras en dígitos, frases
 * nominales, textos de tarjeta), momentos (marcas, tarjetas por tipo de palabra —clave, frase, cifra, producto,
 * pregunta—, listas, stickers por concepto, demos), titular borrador y voice.md, estilo con su fuente, el plan (ritmo
 * medido, separación, una capa a la vez debajo de tu boca, pose de mascota, listas en árbol, notas-director.json que
 * mandan, determinismo), el modo de cerca con sus demos y el CLI sobre un proyecto de prueba (direccion.json y .md, sin
 * pisar ediciones a mano).
 * Todo en el sandbox: cara sintética, sin Chrome ni Vision.
 */
import {mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {dirigir, editadaAMano, huellaDe} from '../../herramientas/director.ts';
import {anchoMinimoLogo, cajaVisibleSticker, crearContexto, type InfoPng} from '../../herramientas/layout.ts';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {buscarNumero, estiloDesde, type EstiloDirector} from '../../herramientas/lib/director/estilo.ts';
import {candidatosListas, candidatosStickers, candidatosTarjetas, detectarMarcas, emparejarDemos, momentosDemo, raicesDe, trimDeDemo, type DemoDisponible} from '../../herramientas/lib/director/momentos.ts';
import {cabeEnAgenda, leerNotas, modoDeCerca, planear, resolverDesde, type EntradasPlan} from '../../herramientas/lib/director/plan.ts';
import {ritmoContraEstilo} from '../../herramientas/lib/director/informe.ts';
import {leerCatalogosStickers, opcionesSticker, type EntradaMascota, type EntradaLogo} from '../../herramientas/lib/director/stickers.ts';
import {capitalizar, detectarCifras, fraseNominal, limpiar, normalizar, numeroEnPalabras, textoDeTarjeta, type Palabra} from '../../herramientas/lib/director/texto.ts';
import {borradorTitular, partirTitular, revisarTitular} from '../../herramientas/lib/director/titular.ts';
import {reglasDeVoz, revisarVoz, seccionProhibido} from '../../herramientas/lib/director/voz.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {RAIZ} from '../../herramientas/lib/manifest.ts';
import {HAY_FUENTES} from './requisitos.ts';

/** Palabras con tiempos: una cada `paso` s (dura paso − 0.05). */
function palabrasDe(texto: string, paso = 0.35, t0 = 0): Palabra[] {
	return texto
		.split(/\s+/)
		.filter(Boolean)
		.map((t, i) => ({i, t, d: Math.round((t0 + i * paso) * 1000) / 1000, h: Math.round((t0 + i * paso + paso - 0.05) * 1000) / 1000}));
}

/** Cara quieta. Con `boca`, el cara.json la trae medida (si no, se estima con barbilla − 0.18 × alto de la cara). */
function cara(barbilla: number, coronilla = 500, segundos = 40, boca?: number, altoCara?: number): CaraConsultable {
	const h = altoCara ?? barbilla - coronilla - 150;
	return {
		fps: 30,
		cuadros: Array.from({length: segundos * 30}, (_, j) => ({t: j / 30, cara: {x: 400, y: barbilla - h, w: 300, h}, barbilla_y: barbilla, coronilla_y: coronilla, cabeza: {x: 380, y: coronilla, w: 340, h: barbilla - coronilla}, ...(boca !== undefined ? {boca_y: boca} : {})})),
	};
}

const VOZ = '## Prohibido\n- usted / corporativo.\n- Hype: "revolucionario", "cambiará tu vida".\n- El tic "no es X, es Y".\n- Signos de más: "!!!", MAYÚSCULAS gritando, em-dash decorativo.\n## Hooks\n- "El 99% usa la IA."\n';

const tinta = (w: number, h: number): InfoPng => ({ancho: 1024, alto: 1024, tinta: {x: (1024 - w) / 2, y: (1024 - h) / 2, w, h}});
const mascota = (id: string, pose: string | null, etiquetas: string[], png: InfoPng, extra: Partial<EntradaMascota> = {}): EntradaMascota => ({id, archivo: `biblioteca/stickers/mascota/${id}.png`, ancho: png.ancho, alto: png.alto, caja_tinta: png.tinta!, pose, ojos: pose ? 'felices' : null, prop: null, texto: null, etiquetas, ...extra});
const CATALOGOS: {mascotas: EntradaMascota[]; logos: EntradaLogo[]} = {
	mascotas: [
		mascota('mascota-frente-moneda', 'frente', ['gratis', 'dinero', 'mascota'], tinta(940, 500), {prop: 'moneda'}),
		mascota('letrero-gratis', null, ['gratis', 'letrero'], tinta(940, 292), {texto: 'GRATIS'}),
		mascota('mascota-frente-laptop', 'frente', ['laptop', 'trabajo', 'mascota'], tinta(940, 488), {prop: 'laptop'}),
		mascota('mascota-lado-laptop', 'lado', ['laptop', 'trabajo', 'mascota'], tinta(940, 520), {prop: 'laptop'}),
		mascota('mascota-celebrando-destellos', 'celebrando', ['impresionante', 'wow', 'mascota'], tinta(780, 940), {prop: 'destellos'}),
		mascota('letrero-comenta', null, ['comenta', 'letrero'], tinta(940, 264), {texto: 'COMENTA'}),
	],
	logos: [{id: 'logo-claude-tile', marca: 'Claude', archivo: 'biblioteca/stickers/logos/claude-tile.png', variante: 'tile', ancho: 650, alto: 650, caja_tinta: {x: 25, y: 25, w: 600, h: 600}, etiquetas: ['claude']}],
};

const TEXTO =
	'Hoy te enseño a usar Claude, es gratis, primero abres la aplicación de Claude instalada, después vas a la parte de Claude Code, ahí le pones precios, nombre, dónde es, y lo mandas a trabajar con calma, cuesta veinte dólares al mes, la verdad es impresionante, coméntame qué vas a construir.';

/** Estilo con ritmo alto (para que el cupo no tape lo demás) y todo lo demás como en estiloDesde({}) (lo medido, sin la decisión del 2026-10-04). */
const ESTILO: EstiloDirector = (() => {
	const e = estiloDesde({decision: false});
	return {...e, ritmo: {...e.ritmo, tarjetas_por_min: {valor: 40, n: 0, fuente: 'prueba'}, stickers_por_min: {valor: 20, n: 0, fuente: 'prueba'}}};
})();

function entradas(cambios: Partial<EntradasPlan> = {}, barbilla = 900): EntradasPlan {
	const palabras = palabrasDe(TEXTO);
	const duracion = palabras.at(-1)!.h + 0.5;
	return {
		slug: 'prueba',
		semilla: 'prueba',
		palabras,
		duracion,
		ctx: crearContexto({cara: cara(barbilla), estilo: ESTILO, semilla: 'prueba'}),
		estilo: ESTILO,
		catalogos: CATALOGOS,
		terminos: ['Claude', 'Claude Code', 'prompt'],
		notas: null,
		voz: reglasDeVoz(VOZ),
		...cambios,
	};
}

// ───────────────────────── texto ─────────────────────────

describe('texto', () => {
	it('normaliza sin acentos (la ñ se queda) y limpia la puntuación de las orillas', () => {
		expect(normalizar('Página Año ÁÉÍ')).toBe('pagina año aei');
		expect(limpiar('¿Claude,')).toBe('Claude');
		expect(capitalizar('dónde es')).toBe('Dónde es');
		expect(capitalizar('iPhone')).toBe('iPhone');
	});

	it('números escritos con palabras', () => {
		expect(numeroEnPalabras(['treinta', 'y', 'cinco'], 0)).toEqual({valor: 35, usadas: 3});
		expect(numeroEnPalabras(['doscientos', 'cincuenta', 'pesos'], 0)).toEqual({valor: 250, usadas: 2});
		expect(numeroEnPalabras(['mil', 'quinientos'], 0)).toEqual({valor: 1500, usadas: 2});
		expect(numeroEnPalabras(['dos', 'tres'], 0)).toEqual({valor: 2, usadas: 1});
		expect(numeroEnPalabras(['hola'], 0)).toBeNull();
	});

	it('cifras en dígitos: "quince" → 15, "veinte dólares" → $20, "cien por ciento" → 100%', () => {
		const c = (t: string) => detectarCifras(palabrasDe(t)).map((x) => x.texto);
		expect(c('son quince prompts listos')).toEqual(['15 prompts']);
		expect(c('cuesta veinte dólares al mes')).toEqual(['$20']);
		expect(c('es cien por ciento gratis')).toEqual(['100%']);
		expect(c('ahorras 20% hoy')).toEqual(['20%']);
		expect(c('cuesta mil quinientos pesos')).toEqual(['$1,500 pesos']);
		expect(c('es una página y un plan')).toEqual([]);
		expect(c('el modelo Opus 5.5 que salió')).toEqual([]);
	});

	it('frase nominal y texto de tarjeta (1–3 palabras, ≤ 24 caracteres, mayúscula inicial)', () => {
		const p = palabrasDe('la aplicación de Claude instalada en tu compu');
		expect(fraseNominal(p, 0)!.tokens).toEqual(['aplicación', 'de', 'Claude']);
		expect(textoDeTarjeta(['aplicación', 'de', 'Claude'])).toBe('Aplicación de Claude');
		expect(textoDeTarjeta(['herramienta', 'de', 'Claude', 'WebKit'])).toBe('Claude WebKit');
		expect(textoDeTarjeta(['página', 'web', 'de', 'Claude'])).toBe('Página web');
		expect(textoDeTarjeta(['una', 'frase', 'larguísima', 'que', 'no', 'cabe'])).toBe('Una frase larguísima');
		const q = palabrasDe('la parte de la página de Dribbble, vas a buscar');
		expect(fraseNominal(q, 3)!.tokens).toEqual(['página', 'de', 'Dribbble']);
	});
});

// ───────────────────────── momentos ─────────────────────────

describe('momentos', () => {
	const p = palabrasDe(TEXTO);
	const marcas = detectarMarcas(p, {terminos: ['Claude', 'Claude Code'], logos: CATALOGOS.logos});

	it('marcas: términos del vocabulario (el más largo primero), con su logo si está en el catálogo', () => {
		expect(marcas.map((m) => m.texto)).toEqual(['Claude', 'Claude', 'Claude Code']);
		expect(marcas[0].logo).toBe('logo-claude-tile');
		expect(marcas[2].logo).toBeNull();
		const otras = detectarMarcas(palabrasDe('usa el modelo Opus 5.5 y la página de Dribbble, luego Claude WebKit.'), {terminos: ['Claude'], logos: []});
		expect(otras.map((m) => m.texto)).toEqual(['Opus 5.5', 'Dribbble', 'Claude WebKit']);
	});

	it('tarjetas: lo que sigue a "la parte de", pasos, cifras y "es X" que cierra la cláusula, cada una con su tipo de palabra', () => {
		const c = candidatosTarjetas(p, marcas, ['prompt']);
		const t = c.map((x) => x.texto);
		expect(t).toEqual(expect.arrayContaining(['Claude Code', 'Aplicación de Claude', '$20', 'Gratis', 'Impresionante']));
		expect(c.find((x) => x.texto === '$20')!.tipo_palabra).toBe('cifra');
		expect(c.find((x) => x.texto === 'Claude Code')!.tipo_palabra).toBe('producto');
		expect(c.find((x) => x.texto === 'Gratis')!.tipo_palabra).toBe('clave');
		for (const x of c) {
			// Todas de 1–3 palabras (decisión del estilo, 2026-10-04) y ≤ 24 caracteres; una pregunta, 2 renglones de ≤ 44.
			expect(x.texto!.replace('\n', ' ').length).toBeLessThanOrEqual(x.tipo_palabra === 'pregunta' ? 44 : 24);
			expect(x.texto!.split(/\s+/).length).toBeLessThanOrEqual(3);
		}
	});

	it('tarjetas como las eliges tú: la clave de cada frase y frases verbales tal cual, nunca de más de 3 palabras', () => {
		const q = palabrasDe('te regresa un plan, lo lees, lo apruebas y lo corres, copias imágenes, no me creas, la verdad, coméntame qué página vas a construir, te mando la herramienta.');
		const c = candidatosTarjetas(q, [], []);
		const por = (texto: string) => c.find((x) => x.texto === texto);
		expect(por('Lo lees')?.tipo_palabra).toBe('frase');
		expect(por('No me creas')?.tipo_palabra).toBe('frase');
		expect(por('Copias imágenes')?.tipo_palabra).toBe('frase');
		expect(c.some((x) => x.texto === 'La verdad')).toBe(false); // relleno
		// El creador (2026-10-04): "las palabras resaltadas también son de dos a tres palabras". La pregunta del cierre
		// (5 palabras) y "Te mando la herramienta" (4) ya no se proponen.
		expect(c.some((x) => x.tipo_palabra === 'pregunta')).toBe(false);
		expect(por('Te mando la herramienta')).toBeUndefined();
		expect(c.every((x) => x.texto!.split(/\s+/).length <= 3)).toBe(true);
		// "lo apruebas y lo corres" (5 palabras) no es frase corta: va su palabra clave.
		expect(c.find((x) => x.t > q[6].d - 1e-6 && x.t <= q[10].d + 1e-6)?.tipo_palabra).toBe('clave');
		// La frase verbal pesa más que su palabra suelta ("Lo lees" > "Lees").
		expect(c.some((x) => x.texto === 'Lees')).toBe(false);
	});

	it('prefiere 2–3 palabras: la clave suelta lleva su verbo y una de 1 palabra (no marca ni cifra) pesa menos', () => {
		const q = palabrasDe('ahora te enseño cómo podemos mejorar las animaciones, lo demás es secundario, cuesta veinte dólares.');
		const c = candidatosTarjetas(q, [], []);
		const mejorar = c.find((x) => x.texto === 'Mejorar las animaciones');
		expect(mejorar?.tipo_palabra).toBe('clave');
		expect(c.some((x) => x.texto === 'Animaciones')).toBe(false);
		const veinte = c.find((x) => x.texto === '$20');
		expect(veinte?.puntaje).toBe(5); // las cifras no se castigan
		for (const x of c.filter((y) => y.texto!.split(/\s+/).length === 1 && y.tipo_palabra !== 'cifra' && y.tipo_palabra !== 'producto')) {
			expect(x.motivo).toContain('1 palabra');
		}
	});

	it('tarjetas_forzadas de más de 3 palabras que no son prompt: entran, con aviso claro', () => {
		const l = leerNotas({
			tarjetas_forzadas: [
				{texto: 'Las reglas de diseño de Apple', desde_palabra: 'reglas'},
				{texto: 'Reglas de Apple', desde_palabra: 'reglas'},
				{texto: 'Hazme una página con las reglas de diseño de Apple', variante: 'prompt', desde_palabra: 'reglas'},
			],
		});
		expect(l.notas?.tarjetas_forzadas).toHaveLength(3);
		expect(l.avisos).toHaveLength(1);
		expect(l.avisos[0]).toContain('"Las reglas de diseño de Apple": tiene 6 palabras');
		expect(l.avisos[0]).toContain('"variante": "prompt"');
	});

	it('listas: "precios, nombre, dónde es" sí; "no me creas, la verdad, no me creas" y "lo lees, lo apruebas y lo corres" no', () => {
		expect(candidatosListas(p).map((c) => c.items!.map((i) => i.texto))).toEqual([['Precios', 'Nombre', 'Dónde es']]);
		expect(candidatosListas(palabrasDe('chulísimas, no me creas, la verdad, no me creas, inténtalo tú mismo, intentarlo es gratis.'))).toEqual([]);
		expect(candidatosListas(palabrasDe('te regresa un plan, lo lees, lo apruebas y lo corres en automático.'))).toEqual([]);
		const lenta = palabrasDe('pon precios, nombre, dónde es, y listo', 1.5);
		expect(candidatosListas(lenta)).toEqual([]);
	});

	it('stickers: logo en la PRIMERA mención de la marca y mascota por concepto (el repetido pesa menos)', () => {
		const s = candidatosStickers(p, marcas);
		expect(s.find((c) => c.sticker!.logo)!.palabra).toBe('Claude,');
		const conceptos = s.filter((c) => !c.sticker!.logo).map((c) => c.sticker!.concepto);
		expect(conceptos).toEqual(expect.arrayContaining(['gratis', 'trabajar', 'impresionante', 'comenta', 'dinero']));
		const dos = candidatosStickers(palabrasDe('es gratis, sí, gratis.'), []);
		expect(dos.map((c) => c.puntaje)).toEqual([4, 3]);
	});

	it('momentos que piden demo', () => {
		const d = momentosDemo(palabrasDe('después te vas a la parte de Claude Code, copias la liga del botón, le pegas el prompt y abres la app'));
		expect(d.map((x) => x.accion)).toEqual(['ir a una sección', 'copiar la liga', 'pegar', 'abrir']);
	});
});

// ───────────────────────── titular y voz ─────────────────────────

describe('titular y voice.md', () => {
	it('borrador: 2 renglones de ≤ 24 caracteres sacados del gancho, y una versión de un renglón', () => {
		const b = borradorTitular(palabrasDe('Cómo hacer páginas web profesionales con Claude, el nuevo modelo'))!;
		expect(b.texto).toBe('Cómo hacer páginas web\nprofesionales con Claude');
		expect(b.un_renglon).toBe('Cómo hacer páginas web');
		expect(b.origen.frase).toMatch(/^Cómo hacer/);
		expect(partirTitular('una dos tres cuatro', 11)).toEqual(['una dos', 'tres cuatro']);
		expect(partirTitular('palabralarguisimaquenocabe en nada', 10)).toBeNull();
	});

	it('voice.md: sección Prohibido → reglas; revisa palabras, frases, plantillas, signos y mayúsculas', () => {
		expect(seccionProhibido(VOZ)).not.toMatch(/Hooks/);
		const reglas = reglasDeVoz(VOZ);
		const ids = (t: string) => revisarVoz(t, reglas).map((x) => x.id);
		expect(ids('Usted puede')).toEqual(['palabra:usted']);
		expect(ids('Esto es REVOLUCIONARIO')).toEqual(expect.arrayContaining(['frase:revolucionario', 'mayusculas']));
		expect(ids('No es magia, es Claude')).toEqual(['patron:no es x, es y']);
		expect(ids('Hazlo ya!!!')).toEqual(['signos-repetidos']);
		expect(ids('Claude — gratis')).toEqual(['em-dash']);
		expect(ids('Tu página web con Claude')).toEqual([]);
	});

	it('hook: pide número, "tú/tu" o tensión', () => {
		const reglas = reglasDeVoz(VOZ);
		expect(revisarTitular('Tu página web\ncon Claude', reglas).hook).toMatchObject({tu: true, cumple: true});
		expect(revisarTitular('3 trucos de Claude', reglas).hook.numero).toBe(true);
		expect(revisarTitular('Cómo hacer páginas web', reglas).hook.cumple).toBe(false);
	});
});

// ───────────────────────── estilo ─────────────────────────

describe('estilo con su fuente', () => {
	it('sin archivos: supuestos marcados (n = 0) y lo medido de MEDICIONES_CAPAS', () => {
		const e = estiloDesde({decision: false});
		expect(e.ritmo.tarjetas_por_min).toMatchObject({valor: 8, n: 0});
		expect(e.ritmo.tarjetas_por_min.fuente).toMatch(/^supuesto/);
		expect(e.tarjeta.y).toMatchObject({valor: 1274, n: 6});
		expect(e.tapa_cabeza_p90.valor).toBeNull();
		expect(e.zona_ui.arriba.valor).toBeLessThan(1920 * 0.14);
	});

	it('con el agregado de overlays toma lo medido con su n; estilo.json manda sobre todo', () => {
		const agregado = {agregado: {tarjetas_por_min: {mediana: 16.9, n: 11}, ancho_sticker_p10_px: {mediana: 281.5, n: 10}}};
		const a = estiloDesde({agregado});
		expect(a.ritmo.tarjetas_por_min).toMatchObject({valor: 16.9, n: 11});
		expect(a.sticker.ancho_p10).toMatchObject({valor: 281.5, n: 10});
		const ej = {densidades: {tarjetas_por_min: {valor: 12, n: 20, fuente: 'Fase 2'}}, franja_subtitulos: {y_p10: 1400, y_p90: 1420}, tapa_cabeza: {p90: 'N/A'}};
		const b = estiloDesde({estiloJson: ej, agregado, decision: false});
		expect(b.ritmo.tarjetas_por_min).toMatchObject({valor: 12, n: 20});
		expect(b.franja.y_p10.valor).toBe(1400);
		expect(b.tapa_cabeza_p90.valor).toBeNull();
		expect(buscarNumero({a: {valor: 'N/A'}}, ['a'], 'x')).toBe('N/A');
	});
});

// ───────────────────────── plan ─────────────────────────

describe('el plan', () => {
	it.runIf(HAY_FUENTES)('acomoda tarjetas, listas y stickers sin encimarse: una capa a la vez, ≥ 0.8 s entre inicios', () => {
		const plan = planear(entradas());
		expect(plan.tarjetas.length).toBeGreaterThan(3);
		expect(plan.stickers.length).toBeGreaterThan(1);
		// Las de una lista arrancan cada una en su palabra y se van juntas; entre bloques, nada se enciman.
		const bloques = new Map<string, {desde: number; hasta: number}>();
		for (const t of plan.tarjetas) {
			const clave = t.grupo ?? (plan.tarjetas.filter((x) => x.hasta === t.hasta && !x.grupo).length > 1 ? `fila-${t.hasta}` : t.id);
			const b = bloques.get(clave);
			bloques.set(clave, b ? {desde: Math.min(b.desde, t.desde), hasta: Math.max(b.hasta, t.hasta)} : {desde: t.desde, hasta: t.hasta});
		}
		for (const s of plan.stickers) bloques.set(s.id, {desde: s.desde, hasta: s.hasta});
		const orden = [...bloques.values()].sort((a, b) => a.desde - b.desde);
		for (let i = 1; i < orden.length; i++) {
			expect(orden[i].desde - orden[i - 1].desde).toBeGreaterThanOrEqual(0.8 - 1e-6);
			expect(orden[i].desde).toBeGreaterThanOrEqual(orden[i - 1].hasta - 1e-6);
		}
		for (const t of plan.tarjetas) expect(t.texto.length).toBeLessThanOrEqual(24);
	});

	it.runIf(HAY_FUENTES)('nunca la misma pose de mascota en dos stickers seguidos, y el titular borrador lleva tapaCabeza', () => {
		const plan = planear(entradas());
		const poses = [...plan.stickers].sort((a, b) => a.desde - b.desde).map((s) => s.mascota?.pose ?? null);
		for (let i = 1; i < poses.length; i++) if (poses[i] && poses[i - 1]) expect(poses[i]).not.toBe(poses[i - 1]);
		expect(plan.titular).toMatchObject({desde: 0, tapaCabeza: true});
		expect(plan.titularInfo.borrador).toBe(true);
	});

	it.runIf(HAY_FUENTES)('es determinista con la semilla', () => {
		const a = planear(entradas());
		const b = planear(entradas());
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it.runIf(HAY_FUENTES)('con la barbilla baja (toma de cerca) los stickers caben encima de la barba, nunca arriba de boca + 12', () => {
		const ctx = crearContexto({cara: cara(1240, 500, 40, 1100), estilo: ESTILO, semilla: 'prueba'});
		const plan = planear(entradas({ctx}));
		expect(plan.stickers.length).toBeGreaterThan(1);
		for (const s of plan.stickers) {
			const png = [...CATALOGOS.mascotas.map((c) => ({archivo: c.archivo, png: {ancho: c.ancho, alto: c.alto, tinta: c.caja_tinta}})), ...CATALOGOS.logos.map((c) => ({archivo: c.archivo, png: {ancho: c.ancho, alto: c.alto, tinta: c.caja_tinta}}))].find((x) => x.archivo === s.asset)!.png;
			expect(cajaVisibleSticker(s, png, ctx.estiloSticker).caja.y0).toBeGreaterThanOrEqual(1112 - 0.5);
		}
		// Con la boca muy baja (zona de ~100 px) los altos no caben: se quitan con aviso y quedan los bajitos.
		const apretado = planear(entradas({ctx: crearContexto({cara: cara(1420, 500, 40, 1340), estilo: ESTILO, semilla: 'prueba'})}));
		expect(apretado.descartes.some((d) => /no cabe/.test(d.motivo))).toBe(true);
		for (const s of apretado.stickers) expect(['letrero-gratis', 'letrero-comenta', 'mascota-frente-laptop', 'mascota-lado-laptop', 'mascota-frente-moneda'].map((x) => `biblioteca/stickers/mascota/${x}.png`)).toContain(s.asset);
	});

	it.runIf(HAY_FUENTES)('toma de cerca con zona libre de ~212 px: el logo de la primera mención sale achicado (piso de logos) y la tarjeta de la marca le cede su lugar', () => {
		// Boca 1229 → límite 1241; franja 1453.1 → 212 px libres (como «Claude» en un reel de prueba). El p10 (272) no cabe.
		const ctx = crearContexto({cara: cara(1330, 500, 40, 1229), estilo: ESTILO, semilla: 'prueba'});
		const plan = planear(entradas({ctx}));
		const logo = plan.stickers.find((s) => s.asset === CATALOGOS.logos[0].archivo);
		expect(logo).toBeDefined();
		const png = {ancho: 650, alto: 650, tinta: {x: 25, y: 25, w: 600, h: 600}};
		const v = cajaVisibleSticker(logo!, png, ctx.estiloSticker).caja;
		expect(v.y0).toBeGreaterThanOrEqual(1241 - 0.5);
		expect(v.y1).toBeLessThanOrEqual(ctx.franja.y0 + 0.5);
		expect(v.x1 - v.x0).toBeGreaterThanOrEqual(anchoMinimoLogo(ESTILO).valor - 0.5);
		expect(v.x1 - v.x0).toBeLessThan(ESTILO.sticker.ancho_p10.valor);
		// La tarjeta "Claude" del mismo momento no sale: el logo ganó su lugar.
		expect(plan.tarjetas.some((t) => t.texto === 'Claude' && t.desde < logo!.hasta && t.hasta > logo!.desde)).toBe(false);
		// Un mascota alto en la misma zona sigue sin achicarse por debajo del p10: el piso es solo de los logos.
		for (const s of plan.stickers.filter((x) => x.asset !== CATALOGOS.logos[0].archivo)) expect(s.caja.w).toBeGreaterThan(0);
	});

	it.runIf(HAY_FUENTES)('logo forzado en notas-director.json: entra en toma de cerca (achicado) y "Marca#2" lo pone en la 2.ª mención', () => {
		const ctx = crearContexto({cara: cara(1330, 500, 40, 1229), estilo: ESTILO, semilla: 'prueba'});
		const notas = leerNotas({stickers_forzados: [{id_catalogo: 'logo-claude-tile', desde_palabra: 'Claude#2'}]}).notas;
		const plan = planear(entradas({ctx, notas}));
		const t2 = resolverDesde(palabrasDe(TEXTO), {desde_palabra: 'Claude#2'})!;
		expect(palabrasDe(TEXTO)[t2.i0!].t).toBe('Claude');
		expect(t2.t).toBeGreaterThan(resolverDesde(palabrasDe(TEXTO), {desde_palabra: 'Claude'})!.t);
		const forzado = plan.stickers.find((s) => Math.abs(s.desde - t2.t) < 1e-6);
		expect(forzado?.asset).toBe(CATALOGOS.logos[0].archivo);
		const v = cajaVisibleSticker(forzado!, {ancho: 650, alto: 650, tinta: {x: 25, y: 25, w: 600, h: 600}}, ctx.estiloSticker).caja;
		expect(v.y0).toBeGreaterThanOrEqual(1241 - 0.5);
		// Una mención que no existe no entra y lo avisa.
		const nada = planear(entradas({ctx, notas: leerNotas({stickers_forzados: [{id_catalogo: 'logo-claude-tile', desde_palabra: 'Claude#9'}]}).notas}));
		expect(nada.avisos.join(' ')).toMatch(/no encontré su momento/);
	});

	it.runIf(HAY_FUENTES)('los stickers forzados no los quita el cupo de stickers/min: con cupo 0 entran los 3 logos forzados (y nada del borrador)', () => {
		const sinCupo: EstiloDirector = {...ESTILO, ritmo: {...ESTILO.ritmo, stickers_por_min: {valor: 0, n: 0, fuente: 'prueba'}}};
		const ctx = crearContexto({cara: cara(900), estilo: sinCupo, semilla: 'prueba'});
		const notas = leerNotas({stickers_forzados: ['Claude', 'Claude#2', 'Claude#3'].map((p) => ({id_catalogo: 'logo-claude-tile', desde_palabra: p, ancho: 290}))}).notas;
		const plan = planear(entradas({estilo: sinCupo, ctx, notas}));
		expect(plan.ritmo.objetivo_stickers).toBe(0);
		const tiempos = ['Claude', 'Claude#2', 'Claude#3'].map((p) => resolverDesde(palabrasDe(TEXTO), {desde_palabra: p})!.t);
		for (const t of tiempos) expect(plan.stickers.some((s) => Math.abs(s.desde - t) < 1e-6 && s.asset === CATALOGOS.logos[0].archivo)).toBe(true);
		expect(plan.stickers).toHaveLength(3);
		// Los 3 vienen de las notas; lo que el cupo sí frena son los candidatos del borrador.
		expect(plan.decisiones.filter((d) => d.tipo === 'sticker').every((d) => d.origen === 'notas')).toBe(true);
		expect(plan.descartes.some((d) => /ritmo objetivo/.test(d.motivo) && d.que.startsWith('sticker'))).toBe(true);
	});

	it.runIf(HAY_FUENTES)('el ritmo objetivo pone tope: con 8/min y 4/min en ~19 s entran a lo más 3 tarjetas y 1 sticker', () => {
		const estilo = estiloDesde({});
		const plan = planear(entradas({estilo, ctx: crearContexto({cara: cara(900), estilo, semilla: 'prueba'})}));
		expect(plan.tarjetas.length).toBeLessThanOrEqual(plan.ritmo.objetivo_tarjetas);
		expect(plan.stickers.length).toBeLessThanOrEqual(plan.ritmo.objetivo_stickers);
		expect(plan.descartes.some((d) => /ritmo objetivo/.test(d.motivo))).toBe(true);
	});

	it.runIf(HAY_FUENTES)('notas-director.json manda: titular, quitar, tarjeta forzada, sin stickers', () => {
		const base = planear(entradas());
		const quitar = base.tarjetas[0].id;
		const {notas, problemas} = leerNotas({titular: 'Tu página web\ncon Claude', quitar: [quitar], tarjetas_forzadas: [{texto: 'Botón verde', desde_palabra: 'cuesta'}], sin_stickers: true, _nota: 'comentario'});
		expect(problemas).toEqual([]);
		const plan = planear(entradas({notas}));
		expect(plan.titular!.texto).toBe('Tu página web\ncon Claude');
		expect(plan.titularInfo.borrador).toBe(false);
		expect(plan.tarjetas.map((t) => t.id)).not.toContain(quitar);
		expect(plan.tarjetas.find((t) => t.texto === 'Botón verde')!.desde).toBe(resolverDesde(palabrasDe(TEXTO), {desde_palabra: 'cuesta'})!.t);
		expect(plan.stickers).toEqual([]);
		expect(leerNotas({quitar: 'k1'}).problemas.length).toBeGreaterThan(0);
		expect(leerNotas({cosa: 1}).avisos[0]).toMatch(/no conozco/);
	});

	it.runIf(HAY_FUENTES)('quitar por texto es estable: sale antes de elegir (otro toma su lugar), sin acentos ni mayúsculas, y avisa si no existe', () => {
		const base = planear(entradas());
		const victima = base.tarjetas.find((t) => !t.grupo)!;
		const pedido = normalizar(victima.texto).toUpperCase();
		const {notas} = leerNotas({quitar: [pedido, 'Nada de esto existe']});
		const plan = planear(entradas({notas}));
		expect(plan.tarjetas.some((t) => normalizar(t.texto) === normalizar(victima.texto))).toBe(false);
		expect(plan.descartes.some((d) => d.que.includes(victima.texto) && /quitado por notas-director\.json/.test(d.motivo))).toBe(true);
		expect(plan.avisos.some((a) => /"Nada de esto existe".*ningún candidato/.test(a))).toBe(true);
		// Por id sigue funcionando, pero avisa que el id se puede recorrer.
		const porId = planear(entradas({notas: leerNotas({quitar: [victima.id]}).notas}));
		expect(porId.avisos.some((a) => /se recorren/.test(a))).toBe(true);
	});

	it.runIf(HAY_FUENTES)('gancho: con tu primera capa medida (p90 1.32 s), algo arranca antes de ese p90 aunque el ritmo sea bajo', () => {
		// Gancho con una clave tardía y una marca temprana: con ritmo de 1 tarjeta, sin gancho ganaría la de más puntaje.
		const texto = 'Mira este truco de Notion, después te enseño cuánto cuesta: veinte dólares al mes, impresionante.';
		const palabras = palabrasDe(texto, 0.3);
		const base = estiloDesde({});
		const medida = {valor: 0.7, n: 32, fuente: 'prueba', p10: 0.4, p90: 1.32};
		const lento = {...base, ritmo: {tarjetas_por_min: {valor: 3, n: 0, fuente: 'prueba'}, stickers_por_min: {valor: 0, n: 0, fuente: 'prueba'}}};
		const con = {...lento, ritmo: {...lento.ritmo, primera_capa_s: medida}};
		const sin = {...lento, ritmo: {...lento.ritmo, primera_capa_s: {valor: null, n: 0 as const, fuente: 'N/A' as const, nota: 'prueba'}}};
		const primeraDe = (estilo: EstiloDirector) => {
			const plan = planear(entradas({palabras, duracion: 20, estilo, ctx: crearContexto({cara: cara(900), estilo, semilla: 'prueba'})}));
			return Math.min(...plan.tarjetas.map((t) => t.desde), ...plan.stickers.map((s) => s.desde));
		};
		expect(primeraDe(con)).toBeLessThanOrEqual(1.32);
		expect(primeraDe(sin)).toBeGreaterThan(1.32);
	});

	it('quitar con la ruta de un asset quita esa demo (o su carpeta) y no la confunde con una tarjeta', async () => {
		const {assetQuitado, quitarPorTexto} = await import('../../herramientas/lib/director/plan.ts');
		expect(assetQuitado('demos/img4874-github/toma.mp4', ['demos/img4874-github/toma.mp4'])).toBe('demos/img4874-github/toma.mp4');
		expect(assetQuitado('demos/img4874-github/toma.mp4', ['demos/img4874-github/'])).toBe('demos/img4874-github/');
		expect(assetQuitado('demos/img4874-github-2/toma.mp4', ['demos/img4874-github'])).toBeNull();
		expect(assetQuitado('demos/x/toma.mp4', ['Minutos', 't3'])).toBeNull();
		// quitarPorTexto no la toma como texto de tarjeta (ni avisa que "ningún candidato dice eso").
		const avisos: string[] = [];
		quitarPorTexto([], ['demos/img4874-github/toma.mp4'], [], avisos);
		expect(avisos).toEqual([]);
	});

	it.runIf(HAY_FUENTES)('un hueco de 3 cuadros o menos entre dos tarjetas se cierra (la primera se queda hasta que entra la otra)', () => {
		const palabras = palabrasDe('uno dos tres cuatro cinco seis siete ocho nueve diez once doce', 0.3);
		const {notas} = leerNotas({
			sin_tarjetas: true,
			sin_stickers: true,
			tarjetas_forzadas: [
				{texto: 'Uno', desde: 0.3, hasta: 1.2},
				{texto: 'Dos', desde: 1.26}, // 2 cuadros después
				{texto: 'Tres', desde: 2.6}, // hueco largo: se respeta
			],
		});
		const plan = planear(entradas({palabras, duracion: 5, notas}));
		const [a, b, c] = [...plan.tarjetas].sort((x, y) => x.desde - y.desde);
		expect(a.hasta).toBeCloseTo(b.desde, 6);
		expect(c.desde - b.hasta).toBeGreaterThan(0.1);
	});

	it('quitar por texto saca un elemento de una lista y la lista sigue si le quedan 2', async () => {
		const {quitarPorTexto} = await import('../../herramientas/lib/director/plan.ts');
		const lista = {clave: 'lista:1', tipo: 'lista' as const, i0: 1, i1: 6, t: 1, palabra: 'precios, nombre, dónde es', frase: '', puntaje: 3, motivo: '', alternativas: [], items: [{texto: 'Precios', t: 1, i0: 1}, {texto: 'Nombre', t: 1.4, i0: 2}, {texto: 'Dónde es', t: 1.8, i0: 3}]};
		const sticker = {clave: 'sticker:9', tipo: 'sticker' as const, i0: 9, i1: 10, t: 4, palabra: 'precios', frase: '', puntaje: 2, motivo: '', alternativas: [], sticker: {concepto: 'dinero', etiquetas: [], marca: null, logo: false}};
		const descartes: Parameters<typeof quitarPorTexto>[2] = [];
		const avisos: string[] = [];
		const r = quitarPorTexto([lista, sticker], ['donde es', 'sticker:Dinero'], descartes, avisos);
		expect(r).toHaveLength(1);
		expect(r[0].items!.map((i) => i.texto)).toEqual(['Precios', 'Nombre']);
		expect(descartes.map((d) => d.que)).toEqual(['de la lista: "Dónde es"', 'sticker (dinero)']);
		expect(avisos).toEqual([]);
		// Con un solo elemento ya no es lista: sale entera.
		expect(quitarPorTexto([lista], ['precios', 'nombre'], [], [])).toEqual([]);
	});

	it.runIf(HAY_FUENTES)('un insert de las notas se coloca con el layout (16:9 que no cabe debajo de la barbilla → tapaCabeza) y nada se le encima', () => {
		const {notas} = leerNotas({inserts: [{asset: 'p/x/captura.png', layout: 'tarjeta', desde_palabra: 'precios,', duracion: 2.5}]});
		const plan = planear(entradas({notas, medio: () => ({ancho: 1600, alto: 900, duracion: null})}, 1240));
		const b = plan.inserts[0];
		expect(b).toMatchObject({id: 'b1', tipo: 'imagen', tapaCabeza: true, layout: 'tarjeta'});
		for (const x of [...plan.tarjetas, ...plan.stickers]) expect(x.hasta <= b.desde + 1e-6 || x.desde >= b.hasta - 1e-6).toBe(true);
	});

	it('cabeEnAgenda: respeta la duración mínima del anterior y la separación', () => {
		const agenda = [{clave: 'a', s: 1, dmin: 1.2, edes: 2, tipo: 'tarjeta' as const}];
		expect(cabeEnAgenda(agenda, {s: 2.1, dmin: 0.6}, 0.8)).toBe('a');
		expect(cabeEnAgenda(agenda, {s: 2.2, dmin: 0.6}, 0.8)).toBeNull();
		expect(cabeEnAgenda(agenda, {s: 0.3, dmin: 0.6}, 0.8)).toBe('a');
	});

	it('opciones de sticker: por etiquetas en común; mascota con prop antes que letrero; lo dicho en ±1.5 s desempata', () => {
		const o = opcionesSticker({concepto: 'gratis', etiquetas: ['gratis'], marca: null, logo: false}, CATALOGOS, 's');
		expect(o.map((x) => x.id)).toEqual(['mascota-frente-moneda', 'letrero-gratis']);
		const conLetrero = {...CATALOGOS, mascotas: [...CATALOGOS.mascotas, mascota('letrero-gratis-ya', null, ['gratis', 'letrero', 'ahora'], tinta(940, 292), {texto: 'GRATIS'})]};
		const c = opcionesSticker({concepto: 'gratis', etiquetas: ['gratis'], marca: null, logo: false}, conLetrero, 's', ['ahora', 'mismo']);
		expect(c[0].id).toBe('letrero-gratis-ya');
	});

	// Solo con el catálogo de la mascota del creador (la plantilla lo trae vacío).
	const catReal = leerCatalogosStickers();
	const conRegalo = catReal.mascotas.some((c) => c.id.endsWith('-regalo-te-lo-paso-naranja')) && catReal.mascotas.some((c) => c.id.endsWith('-regalo-te-la-paso-naranja'));
	it.runIf(conRegalo)('regalo: "te lo paso" elige el letrero TE LO PASO y "te la paso" el de TE LA PASO (catálogo real)', () => {
		for (const [dicho, fin] of [
			['y te lo paso.', '-frente-felices-regalo-te-lo-paso-naranja'],
			['comenta y te los mando', '-frente-felices-regalo-te-lo-paso-naranja'],
			['qué es tu página y te la paso.', '-frente-felices-regalo-te-la-paso-naranja'],
		] as const) {
			const k = candidatosStickers(palabrasDe(dicho), []).find((c) => c.sticker!.concepto === 'regalo')!;
			expect(k, dicho).toBeDefined();
			for (const semilla of ['a', 'b', 'c']) expect(opcionesSticker(k.sticker!, catReal, semilla)[0].id.endsWith(fin), `${dicho} (${semilla})`).toBe(true);
		}
	});

	it.runIf(HAY_FUENTES)('desenfoque: ninguno sin medida; con frecuencia medida va debajo de tarjetas (listas primero), máx. 1 cada 30 s', () => {
		expect(planear(entradas()).efectos).toEqual([]);
		const estilo = {...ESTILO, desenfoque_por_min: {valor: 2, n: 5, fuente: 'prueba'}};
		const plan = planear(entradas({estilo, ctx: crearContexto({cara: cara(900), estilo, semilla: 'prueba'})}));
		expect(plan.efectos).toHaveLength(0); // ~19 s: no alcanza para uno cada 30 s
		const largo = palabrasDe(`${TEXTO} ${TEXTO.replace('Hoy te enseño', 'Luego te enseño')}`);
		const plan2 = planear(entradas({estilo, palabras: largo, duracion: largo.at(-1)!.h + 0.5, ctx: crearContexto({cara: cara(900), estilo, semilla: 'prueba'})}));
		expect(plan2.efectos.length).toBe(1);
		const e = plan2.efectos[0];
		const lista = plan2.tarjetas.filter((t) => t.grupo || plan2.tarjetas.filter((x) => x.hasta === t.hasta).length > 1);
		expect(lista.some((t) => Math.abs(t.desde - e.desde) < 1e-6)).toBe(true);
		expect(e).toMatchObject({tipo: 'desenfoque'});
	});
});

// ───────────────────────── CLI sobre un proyecto de prueba ─────────────────────────

describe('director.ts sobre un proyecto', () => {
	const slug = '_prueba-unit-director';
	const dir = join(RAIZ, 'proyectos', slug);
	beforeAll(() => {
		rmSync(dir, {recursive: true, force: true});
		mkdirSync(dir, {recursive: true});
		symlinkSync(join('..', '..', 'pruebas', 'fixtures', 'clip-6s.mp4'), join(dir, 'base.mp4'));
		const palabras = palabrasDe(TEXTO);
		const duracion = Math.ceil(palabras.at(-1)!.h + 1);
		writeFileSync(join(dir, 'transcripcion-base.json'), JSON.stringify({fuente: 'prueba', texto: 'aprobado', duracion_base_s: duracion, palabras}));
		writeFileSync(join(dir, 'manifest.json'), JSON.stringify({version: 1, slug, creado_en: '2026-10-03T00:00:00Z', actualizado_en: '2026-10-03T00:00:00Z', etapas: {base: {verificacion: {cuadros: duracion * 30}}}}));
		const c = cara(900, 500, duracion);
		writeFileSync(join(dir, 'cara.json'), JSON.stringify({version: 1, fuente: 'prueba', fps: 30, fps_muestreo: 10, duracion_s: duracion, cortes_s: [], cuadros: c.cuadros.map((x) => ({...x, confianza: 1})), muestras: [], resumen: {cobertura: 1, barbilla_y: {p50: 900, p90: 900, max: 900}, cuadros_sin_cara: 0}}));
	});
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it.runIf(HAY_FUENTES)('escribe direccion.json (lo que lee armar-edl) y direccion.md, y la edición que armaría pasa validar', async () => {
		const r = await dirigir({slug, sinSfx: true});
		const json = JSON.parse(readFileSync(join(dir, 'direccion.json'), 'utf8'));
		for (const campo of ['titular', 'tarjetas', 'stickers', 'inserts', 'zooms', 'efectos', 'sfx_extra', 'resaltar_palabras']) expect(json).toHaveProperty(campo);
		expect(json.huella).toBe(huellaDe(json));
		const md = readFileSync(join(dir, 'direccion.md'), 'utf8');
		expect(md).toMatch(/borrador: true/);
		expect(md).toMatch(/## Momentos que piden una demo/);
		expect(r.validacion!.hallazgos).toEqual([]);
	}, 60_000);

	it.runIf(HAY_FUENTES)('no pisa un direccion.json editado a mano (código 2) salvo con --forzar; las notas inválidas dan código 2', async () => {
		const ruta = join(dir, 'direccion.json');
		const json = JSON.parse(readFileSync(ruta, 'utf8'));
		json.tarjetas = [];
		writeFileSync(ruta, JSON.stringify(json));
		expect(editadaAMano(ruta)).toBe(true);
		const error = await dirigir({slug, sinSfx: true}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(2);
		await dirigir({slug, sinSfx: true, forzar: true});
		expect(editadaAMano(ruta)).toBe(false);
		writeFileSync(join(dir, 'notas-director.json'), JSON.stringify({quitar: 'k1'}));
		const malas = await dirigir({slug, sinSfx: true}).catch((e: unknown) => e);
		expect((malas as FalloEditor).codigo).toBe(2);
		rmSync(join(dir, 'notas-director.json'));
	}, 60_000);

	it('editadaAMano: un archivo que no existe no cuenta; uno sin huella sí', () => {
		const tmp = join(tmpdir(), `director-${process.pid}.json`);
		expect(editadaAMano(tmp)).toBe(false);
		writeFileSync(tmp, '{"tarjetas": []}');
		expect(editadaAMano(tmp)).toBe(true);
		rmSync(tmp);
	});
});

// ───────────────────────── director v2: ritmo, modo de cerca, demos, listas en árbol ─────────────────────────

describe('director v2', () => {
	const CERCA: EstiloDirector = {...ESTILO, encuadre: {alto_cara: {valor: 393.4, n: 18, fuente: 'prueba', p10: 284, p90: 547.3}}};
	const ctxCerca = (estilo: EstiloDirector) => crearContexto({cara: cara(1240, 500, 40, 1100, 600), estilo, semilla: 'prueba'});

	it.runIf(HAY_FUENTES)('ritmo: con tu ritmo medido (21.79 tarjetas y 5.75 stickers por minuto) llega a su objetivo', () => {
		const estilo: EstiloDirector = {...ESTILO, ritmo: {...ESTILO.ritmo, tarjetas_por_min: {valor: 21.79, n: 28, fuente: 'prueba', p10: 0, p90: 35.64}, stickers_por_min: {valor: 5.75, n: 28, fuente: 'prueba', p10: 0, p90: 10.78}}};
		const plan = planear(entradas({estilo, ctx: crearContexto({cara: cara(1240, 500, 40, 1100), estilo, semilla: 'prueba'})}));
		expect(plan.ritmo.objetivo_tarjetas).toBeGreaterThanOrEqual(6);
		expect(plan.tarjetas.length).toBeGreaterThanOrEqual(plan.ritmo.objetivo_tarjetas - 1);
		expect(plan.tarjetas.length).toBeLessThanOrEqual(plan.ritmo.objetivo_tarjetas);
		expect(plan.stickers.length).toBeGreaterThanOrEqual(plan.ritmo.objetivo_stickers - 1);
		// Una capa a la vez y cada una entra ~1 cuadro antes de su palabra si el estilo lo mide (aquí sin medida: en su palabra).
		const tipos = Object.keys(plan.ritmo.tipos_tarjeta);
		expect(tipos.length).toBeGreaterThan(1);
		expect(ritmoContraEstilo(plan.ritmo.tarjetas_por_min, estilo.ritmo.tarjetas_por_min).cumple).toBe(true);
	});

	it('ritmoContraEstilo: [p10, p90] por reel si los hay; si no, ±25 % de la mediana', () => {
		expect(ritmoContraEstilo(20, {valor: 18.6, n: 11, fuente: 'x'}).cumple).toBe(true);
		expect(ritmoContraEstilo(12.5, {valor: 18.6, n: 11, fuente: 'x'})).toMatchObject({cumple: false});
		expect(ritmoContraEstilo(40, {valor: 21.79, n: 28, fuente: 'x', p10: 0, p90: 35.64}).cumple).toBe(false);
		expect(ritmoContraEstilo(5, {valor: null, n: 0, fuente: 'N/A', nota: 'sin medir'}).cumple).toBeNull();
	});

	it('modoDeCerca: con tu cara más grande que el p90 de tus reels se activa; con cara media o sin medida, no', () => {
		expect(modoDeCerca(cara(1240, 500, 40, 1100, 600), CERCA)).toMatchObject({activo: true, alto_cara_p50: 600, umbral: 547.3});
		expect(modoDeCerca(cara(1000, 300, 40, 880, 400), CERCA).activo).toBe(false);
		expect(modoDeCerca(cara(1240, 500, 40, 1100, 600), ESTILO).activo).toBe(false);
		expect(modoDeCerca(null, CERCA).activo).toBe(false);
	});

	const demo = (asset: string, descripcion: string, acciones: DemoDisponible['acciones'] = []): DemoDisponible => ({asset, eventos: asset.replace('toma.mp4', 'eventos.json'), duracion: 6, usable: true, motivo: 'LIMPIA', descripcion, acciones});

	it('emparejarDemos: por palabras en común (las que van con mayúscula valen 2); cada demo y cada momento una vez', () => {
		const momentos = momentosDemo(palabrasDe('vas a copiar la liga en el botón verde, luego te vas a la parte de la página de Dribbble, y vas a buscar páginas que te gusten.'));
		const github = demo('demos/a/toma.mp4', 'Repo público: clic en el botón verde "Code" para copiar la liga.', [{t: 5, tipo: 'clic'}]);
		const dribbble = demo('demos/b/toma.mp4', 'Dribbble: buscar páginas de referencia y hacer scroll.');
		const r = emparejarDemos(momentos, [dribbble, github, {...demo('demos/c/toma.mp4', 'botón verde copiar liga'), usable: false}]);
		expect(r.map((x) => [x.demo.asset, x.momento.accion])).toEqual([
			['demos/a/toma.mp4', 'copiar la liga'],
			['demos/b/toma.mp4', 'ir a una sección'],
		]);
		expect(r[0].comunes).toEqual(['boton', 'copiar', 'liga', 'verde']);
		expect([...raicesDe('Las Páginas del Botón').entries()]).toEqual([['pagina', true], ['boton', true]]);
		expect(emparejarDemos(momentos, [demo('demos/d/toma.mp4', 'Un video de cocina')])).toEqual([]);
	});

	it('trimDeDemo: alrededor del primer clic (a ~60 %); si no hay, poco antes del primer scroll; dentro de la toma', () => {
		expect(trimDeDemo({duracion: 6.87, acciones: [{t: 0.42, tipo: 'scroll'}, {t: 5.12, tipo: 'clic'}]}, 2.7)).toBeCloseTo(3.5, 2);
		expect(trimDeDemo({duracion: 8.1, acciones: [{t: 0.42, tipo: 'scroll'}]}, 2.7)).toBeCloseTo(0.12, 2);
		expect(trimDeDemo({duracion: 2, acciones: [{t: 1.9, tipo: 'clic'}]}, 2.7)).toBe(0);
	});

	it.runIf(HAY_FUENTES)('toma de cerca: el plan lo anota, reserva primero la demo que empareja (pantalla completa) y tarjetas y stickers siguen sin encimársele', () => {
		const github = demo('demos/x/toma.mp4', 'Claude Code: abrir la parte de proyectos', [{t: 3, tipo: 'clic'}]);
		const plan = planear(entradas({estilo: CERCA, ctx: ctxCerca(CERCA), demosDisponibles: [github, demo('demos/y/toma.mp4', 'Un video de cocina')]}));
		expect(plan.cerca.activo).toBe(true);
		expect(plan.inserts).toHaveLength(1);
		const b = plan.inserts[0];
		expect(b).toMatchObject({id: 'b1', tipo: 'demo', layout: 'pantalla-completa', asset: 'demos/x/toma.mp4', tapaCabeza: false});
		expect(b.hasta - b.desde).toBeCloseTo(Math.min(6, CERCA.insert.duracion_p90.valor), 2);
		expect(b.trim_desde).toBeCloseTo(Math.max(0, 3 - 0.6 * (b.hasta - b.desde)), 2);
		expect(plan.cerca.demos).toEqual([expect.objectContaining({asset: 'demos/x/toma.mp4', id: 'b1', comunes: ['claude', 'code']})]);
		expect(plan.avisos.join(' ')).toMatch(/modo de cerca/);
		for (const x of [...plan.tarjetas, ...plan.stickers]) expect(x.hasta <= b.desde + 1e-6 || x.desde >= b.hasta - 1e-6).toBe(true);
		// Tarjetas y stickers siguen, antes y después de la demo.
		expect(plan.tarjetas.some((t) => t.hasta <= b.desde) && plan.tarjetas.some((t) => t.desde >= b.hasta)).toBe(true);
		expect(plan.stickers.length).toBeGreaterThan(0);
		// Sin la toma de cerca, la misma demo (que no es del proyecto) no se propone.
		expect(planear(entradas({demosDisponibles: [github]})).inserts).toEqual([]);
	});

	it.runIf(HAY_FUENTES)('listas: si no caben en columna debajo de tu boca, van en árbol con grupo y fila (1 arriba, 2 lado a lado)', () => {
		const plan = planear(entradas({ctx: crearContexto({cara: cara(1240, 500, 40, 1140), estilo: ESTILO, semilla: 'prueba'})}));
		const lista = plan.tarjetas.filter((t) => ['Precios', 'Nombre', 'Dónde es'].includes(t.texto));
		expect(lista).toHaveLength(3);
		expect(new Set(lista.map((t) => t.grupo)).size).toBe(1);
		expect(lista.map((t) => t.fila)).toEqual([0, 1, 1]);
		expect(lista.every((t) => t.caja.x === 540)).toBe(true);
		expect(plan.decisiones.find((d) => d.tipo_palabra === 'lista')!.que).toMatch(/en árbol/);
	});

	it.runIf(HAY_FUENTES)('si un sticker solo puede repetir la pose del anterior, se cambia el anterior por otra de sus opciones', () => {
		const cat = {
			mascotas: [
				mascota('mascota-celebrando-laptop', 'celebrando', ['laptop', 'trabajo'], tinta(940, 488), {prop: 'laptop'}),
				mascota('mascota-lado-laptop', 'lado', ['laptop', 'trabajo'], tinta(940, 520), {prop: 'laptop'}),
				mascota('mascota-celebrando-wow', 'celebrando', ['impresionante', 'wow'], tinta(780, 600), {prop: 'destellos'}),
			],
			logos: [],
		};
		const q = palabrasDe('lo mandas a trabajar, es impresionante.', 0.6);
		const estilo: EstiloDirector = {...ESTILO, ritmo: {...ESTILO.ritmo, stickers_por_min: {valor: 60, n: 0, fuente: 'prueba'}}};
		const plan = planear(entradas({palabras: q, duracion: q.at(-1)!.h + 0.5, catalogos: cat, sinTarjetas: true, estilo, ctx: crearContexto({cara: cara(900), estilo, semilla: 'prueba'})}));
		expect(plan.stickers.map((x) => x.mascota?.pose)).toEqual(['lado', 'celebrando']);
		expect(plan.decisiones.find((d) => d.id === 'k1')!.avisos.join(' ')).toMatch(/cambiado/);
	});
});
