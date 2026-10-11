import React from 'react';
import {Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {aCuadro, type Edicion} from '../esquema/edicion';
import {
	COLORES_VIVO,
	INTERLINEA,
	PILDORA,
	VOCES,
	entra,
	escalaTitular,
	resorte,
	sale,
	tamanoLinea,
	tamanoPildora,
	textoContador,
	tramosPersona,
	vaDetras,
	type ElementoVivo,
	type TextoVivo,
	type Voz,
} from '../estilo/texto-vivo';

/**
 * Estilo "texto vivo" (src/estilo/texto-vivo.ts). Tres capas que Reel.tsx intercala:
 *   1. CapaVivoDetras: titulares e impactos con detras = true, justo encima de tu toma.
 *   2. CapaPersona: tu silueta recortada (persona.webm, VP9 con alfa) SOLO en los tramos de esos elementos, a tamaño de
 *      lienzo como la toma: así el texto queda entre el fondo y tú (en Meg, "learn how to" pasa detrás de su cabeza).
 *   3. CapaVivo: lo demás (píldoras, notas, tarjetas de UI, collages, impactos delante), encima de los inserts.
 * Y SubtitulosVivos reemplaza a CapaSubtitulos: 1–2 palabras pegadas a tu pecho, pop por palabra y la palabra clave en
 * serif itálica amarilla. Todo en px base 1080×1920 (dentro del contenedor ×4/3), menos CapaPersona.
 */

const cargadas = new Set<string>();
function cargarVoces(): void {
	for (const v of Object.values(VOCES)) {
		if (cargadas.has(v.familia)) continue;
		cargadas.add(v.familia);
		void loadFont({family: v.familia, url: staticFile(v.ruta), weight: String(v.peso), style: v.estilo, display: 'block'});
	}
}

const fuente = (voz: Voz): React.CSSProperties => ({
	fontFamily: `"${VOCES[voz].familia}"`,
	fontWeight: VOCES[voz].peso,
	fontStyle: VOCES[voz].estilo,
	letterSpacing: voz === 'sans' ? '-0.02em' : voz === 'impacto' ? '0.01em' : 0,
	fontSynthesis: 'none',
	whiteSpace: 'pre',
});

const SOMBRA_TEXTO = '0 3px 16px rgba(0,0,0,0.42), 0 1px 3px rgba(0,0,0,0.35)';
const dur = (el: {desde: number; hasta: number}) => Math.max(1, aCuadro(el.hasta) - aCuadro(el.desde));

// ───────────────────────── elementos ─────────────────────────

const Titular: React.FC<{el: Extract<ElementoVivo, {tipo: 'titular'}>}> = ({el}) => {
	const f = useCurrentFrame();
	const k = escalaTitular(el);
	const restantes = dur(el) - f;
	const s = sale(restantes, 5);
	return (
		<div style={{position: 'absolute', left: el.x - 540, width: 1080, top: el.y, transform: `translateY(-50%) translateY(${(1 - s) * -14}px)`, opacity: s, textAlign: 'center'}}>
			{el.lineas.map((l, i) => {
				const tam = tamanoLinea(l.voz, el.tamano_px * k);
				const inicio = l.en !== undefined ? aCuadro(l.en) - aCuadro(el.desde) : i * 4;
				const color = l.color ?? (l.voz === 'serif' ? COLORES_VIVO.clave : COLORES_VIVO.texto);
				const estilo: React.CSSProperties = {...fuente(l.voz), fontSize: tam, lineHeight: `${tam * INTERLINEA[l.voz]}px`, color, textShadow: SOMBRA_TEXTO, display: 'block'};
				if (el.entrada === 'palabra') {
					const palabras = l.texto.split(' ');
					return (
						<div key={i} style={estilo}>
							{palabras.map((p, j) => {
								const g = f - inicio - j * 3;
								const a = entra(g, 5);
								return (
									<span key={j} style={{display: 'inline-block', opacity: g < 0 ? 0 : a, transform: `translateY(${(1 - a) * 26}px)`}}>
										{p}
										{j < palabras.length - 1 ? ' ' : ''}
									</span>
								);
							})}
						</div>
					);
				}
				const g = f - inicio;
				const a = el.entrada === 'pop' ? resorte(g, 7) : entra(g, 7);
				const transform = el.entrada === 'pop' ? `scale(${0.6 + 0.4 * a})` : `translateY(${(1 - a) * 38}px)`;
				return (
					<div key={i} style={{...estilo, opacity: g < 0 ? 0 : Math.min(1, entra(g, 4)), transform}}>
						{l.texto}
					</div>
				);
			})}
		</div>
	);
};

const Impacto: React.FC<{el: Extract<ElementoVivo, {tipo: 'impacto'}>}> = ({el}) => {
	const f = useCurrentFrame();
	const restantes = dur(el) - f;
	const p = resorte(f, 8);
	const fin = sale(restantes, 4);
	const escala = (0.35 + 0.65 * p) * (0.85 + 0.15 * fin);
	const tam = el.tamano_px;
	const extrusion = Array.from({length: 7}, (_, i) => `0 ${i + 1}px 0 ${COLORES_VIVO.relieve}`).join(', ');
	const texto = el.texto.toUpperCase();
	const capa: React.CSSProperties = {...fuente('impacto'), fontSize: tam, lineHeight: `${tam}px`, position: 'absolute', left: 0, right: 0, top: 0, textAlign: 'center'};
	return (
		<div style={{position: 'absolute', left: el.x - 540, width: 1080, top: el.y - tam / 2, height: tam, opacity: Math.min(1, entra(f, 3)) * fin, transform: `rotate(${el.rot}deg) scale(${escala})`, transformOrigin: `50% ${tam / 2}px`}}>
			{el.arriba ? (
				<div style={{...fuente('sans'), position: 'absolute', left: 0, right: 0, top: -tam * 0.34, textAlign: 'center', fontSize: tam * 0.22, color: '#fff', letterSpacing: '0.04em', textTransform: 'uppercase', textShadow: SOMBRA_TEXTO, opacity: entra(f - 3, 5)}}>
					{el.arriba}
				</div>
			) : null}
			<div style={{...capa, color: COLORES_VIVO.relieve, WebkitTextStroke: `${tam * 0.05}px #200800`, textShadow: `${extrusion}, 0 12px 26px rgba(0,0,0,0.45)`}}>{texto}</div>
			<div style={{...capa, backgroundImage: `linear-gradient(180deg, ${COLORES_VIVO.impacto[0]} 28%, ${COLORES_VIVO.impacto[1]} 82%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent'}}>{texto}</div>
		</div>
	);
};

const Pildora: React.FC<{el: Extract<ElementoVivo, {tipo: 'pildora'}>}> = ({el}) => {
	const f = useCurrentFrame();
	const total = dur(el);
	const restantes = total - f;
	const {w, h} = tamanoPildora(el.contenido);
	const abre = resorte(f, 10) * (restantes < 7 ? entra(restantes, 7) : 1);
	const ancho = PILDORA.nace_w + (w - PILDORA.nace_w) * abre;
	const alto = PILDORA.nace_h + (h - PILDORA.nace_h) * Math.min(1.04, abre);
	const contenido = Math.min(entra(f - 5, 5), sale(restantes - 3, 4));
	const texto: React.CSSProperties = {...fuente('sans'), fontSize: PILDORA.texto_px, color: '#fff', lineHeight: 1};
	const c = el.contenido;
	let interior: React.ReactNode = null;
	if (c.clase === 'texto') interior = <span style={texto}>{c.texto}</span>;
	else if (c.clase === 'iconos')
		interior = (
			<>
				{c.iconos.map((ic) => (
					<Img key={ic} src={staticFile(ic)} style={{width: PILDORA.icono, height: PILDORA.icono, objectFit: 'contain', marginRight: PILDORA.hueco}} />
				))}
				<span style={texto}>{c.texto}</span>
			</>
		);
	else if (c.clase === 'contador') {
		const avance = entra(f - 4, Math.max(8, Math.round(total * 0.6)));
		interior = (
			<span style={{...texto, fontVariantNumeric: 'tabular-nums'}}>
				{textoContador(c.de + (c.a - c.de) * avance, c.formato)}
				{c.texto ? ` ${c.texto}` : ''}
			</span>
		);
	} else {
		const m = entra(f - (aCuadro(c.en) - aCuadro(el.desde)), 7);
		const pista = PILDORA.bolita * 2;
		interior = (
			<>
				<span style={{...texto, opacity: 1 - 0.55 * m}}>{c.a}</span>
				<span style={{position: 'relative', width: pista, height: 10, margin: `0 ${PILDORA.hueco}px`, borderRadius: 5, background: 'rgba(255,255,255,0.22)'}}>
					<span style={{position: 'absolute', top: 5 - 20, left: m * (pista - 40), width: 40, height: 40, borderRadius: 20, background: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.5)'}} />
				</span>
				<span style={{...texto, opacity: 0.45 + 0.55 * m}}>{c.b}</span>
			</>
		);
	}
	return (
		<div
			style={{
				position: 'absolute',
				left: el.x - ancho / 2,
				top: el.y - alto / 2,
				width: ancho,
				height: alto,
				borderRadius: alto / 2,
				background: COLORES_VIVO.pildora,
				border: `2px solid ${COLORES_VIVO.borde_pildora}`,
				boxShadow: '0 14px 40px rgba(0,0,0,0.35)',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				overflow: 'hidden',
				opacity: f < 1 ? 0 : 1,
			}}
		>
			<div style={{display: 'flex', alignItems: 'center', opacity: contenido, whiteSpace: 'nowrap'}}>{interior}</div>
		</div>
	);
};

const Nota: React.FC<{el: Extract<ElementoVivo, {tipo: 'nota'}>}> = ({el}) => {
	const f = useCurrentFrame();
	const restantes = dur(el) - f;
	const s = sale(restantes, 5);
	const total = el.texto.length;
	const visibles = Math.min(total, Math.floor((Math.max(0, f) / 30) * 24) + 1);
	const lineas = el.texto.split('\n');
	const tam = el.tamano_px;
	const alto = lineas.length * tam * INTERLINEA.mano;
	let resto = visibles;
	const cuadroFinTexto = Math.ceil((total / 24) * 30);
	let flecha: React.ReactNode = null;
	if (el.flecha) {
		const x0 = el.x;
		const y0 = el.flecha.y > el.y ? el.y + alto / 2 + 8 : el.y - alto / 2 - 8;
		const {x: x1, y: y1} = el.flecha;
		const cx = (x0 + x1) / 2 + (y1 - y0) * 0.35;
		const cy = (y0 + y1) / 2 - (x1 - x0) * 0.2;
		const d = `M ${x0} ${y0} Q ${cx} ${cy} ${x1} ${y1}`;
		const largo = Math.hypot(x1 - x0, y1 - y0) * 1.25;
		const p = entra(f - cuadroFinTexto, 8);
		const ang = Math.atan2(y1 - cy, x1 - cx);
		const punta = (da: number) => `M ${x1} ${y1} L ${x1 - 26 * Math.cos(ang + da)} ${y1 - 26 * Math.sin(ang + da)}`;
		flecha = (
			<svg width={1080} height={1920} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: s, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))'}}>
				<path d={d} fill="none" stroke="#fff" strokeWidth={6} strokeLinecap="round" strokeDasharray={largo} strokeDashoffset={largo * (1 - p)} />
				{p >= 0.98 ? (
					<>
						<path d={punta(0.5)} stroke="#fff" strokeWidth={6} strokeLinecap="round" />
						<path d={punta(-0.5)} stroke="#fff" strokeWidth={6} strokeLinecap="round" />
					</>
				) : null}
			</svg>
		);
	}
	return (
		<>
			{flecha}
			<div style={{position: 'absolute', left: el.x - 540, width: 1080, top: el.y - alto / 2, textAlign: 'center', transform: `rotate(${el.rot}deg)`, opacity: s}}>
				{lineas.map((l, i) => {
					const n = Math.max(0, Math.min(l.length, resto));
					resto -= l.length;
					return (
						<div key={i} style={{...fuente('mano'), fontSize: tam, lineHeight: `${tam * INTERLINEA.mano}px`, color: '#fff', textShadow: '0 2px 8px rgba(0,0,0,0.45)'}}>
							<span>{l.slice(0, n)}</span>
							<span style={{opacity: 0}}>{l.slice(n)}</span>
						</div>
					);
				})}
			</div>
		</>
	);
};

const flotar = (f: number) => Math.sin((f / 30) * Math.PI * 2 * 0.35) * 6;

const TarjetaUi: React.FC<{el: Extract<ElementoVivo, {tipo: 'tarjeta-ui'}>}> = ({el}) => {
	const f = useCurrentFrame();
	const restantes = dur(el) - f;
	const p = resorte(f, 10);
	const s = sale(restantes, 5);
	return (
		<div style={{position: 'absolute', left: el.x - el.w / 2, top: el.y, width: el.w, transform: `translateY(-50%) translateY(${(1 - p) * 90 + flotar(f)}px) rotate(${el.rot + (1 - p) * 8}deg) scale(${(0.85 + 0.15 * p) * (0.9 + 0.1 * s)})`, opacity: Math.min(1, entra(f, 4)) * s}}>
			<Img src={staticFile(el.asset)} style={{width: el.w, display: 'block', borderRadius: 22, boxShadow: '0 22px 60px rgba(0,0,0,0.42)'}} />
		</div>
	);
};

const Collage: React.FC<{el: Extract<ElementoVivo, {tipo: 'collage'}>}> = ({el}) => {
	const f = useCurrentFrame();
	const restantes = dur(el) - f;
	const s = sale(restantes, 5);
	return (
		<>
			{el.piezas.map((pz, i) => {
				const g = f - Math.round(i * el.cada_s * 30);
				const p = resorte(g, 9);
				const x = el.desde_punto.x + (pz.x - el.desde_punto.x) * p;
				const y = el.desde_punto.y + (pz.y - el.desde_punto.y) * p;
				return (
					<div key={i} style={{position: 'absolute', left: x - pz.w / 2, top: y, width: pz.w, opacity: g < 0 ? 0 : Math.min(1, entra(g, 3)) * s, transform: `translateY(-50%) translateY(${flotar(f + i * 7) * 0.6}px) rotate(${pz.rot * p}deg) scale(${(0.3 + 0.7 * Math.max(0, p)) * (0.85 + 0.15 * s)})`}}>
						<Img src={staticFile(pz.asset)} style={{width: pz.w, display: 'block', borderRadius: 14, boxShadow: '0 12px 34px rgba(0,0,0,0.4)'}} />
					</div>
				);
			})}
		</>
	);
};

const Elemento: React.FC<{el: ElementoVivo}> = ({el}) => {
	switch (el.tipo) {
		case 'titular':
			return <Titular el={el} />;
		case 'impacto':
			return <Impacto el={el} />;
		case 'pildora':
			return <Pildora el={el} />;
		case 'nota':
			return <Nota el={el} />;
		case 'tarjeta-ui':
			return <TarjetaUi el={el} />;
		case 'collage':
			return <Collage el={el} />;
	}
};

const Elementos: React.FC<{elementos: readonly ElementoVivo[]}> = ({elementos}) => {
	cargarVoces();
	return (
		<>
			{elementos.map((el) => (
				<Sequence key={el.id} from={aCuadro(el.desde)} durationInFrames={dur(el)} layout="none" name={`vivo ${el.id}`}>
					<Elemento el={el} />
				</Sequence>
			))}
		</>
	);
};

/** Titulares e impactos que van detrás de ti (debajo de CapaPersona). */
export const CapaVivoDetras: React.FC<{vivo?: TextoVivo}> = ({vivo}) => (vivo && vivo.persona ? <Elementos elementos={vivo.elementos.filter(vaDetras)} /> : null);

/** Lo que va delante. Sin silueta (persona = null), los de "detrás" también van aquí: delante, pero sin tapar tu cara (validar.ts R13). */
export const CapaVivo: React.FC<{vivo?: TextoVivo}> = ({vivo}) => (vivo ? <Elementos elementos={vivo.persona ? vivo.elementos.filter((e) => !vaDetras(e)) : vivo.elementos} /> : null);

/** Tu silueta encima de lo de "detrás", a tamaño de lienzo (1440×2560, como la toma). */
export const CapaPersona: React.FC<{vivo?: TextoVivo}> = ({vivo}) => {
	if (!vivo?.persona) return null;
	const src = staticFile(vivo.persona);
	return (
		<>
			{tramosPersona(vivo.elementos).map((t, i) => (
				<Sequence key={i} from={aCuadro(t.desde)} durationInFrames={dur(t)} layout="none" name={`persona ${i}`}>
					<OffthreadVideo src={src} transparent muted startFrom={aCuadro(t.desde)} style={{position: 'absolute', left: 0, top: 0, width: '100%', height: '100%'}} />
				</Sequence>
			))}
		</>
	);
};

// ───────────────────────── subtítulos vivos ─────────────────────────

type SubtituloEdl = Edicion['subtitulos'][number];
type Vivos = NonNullable<TextoVivo['subtitulos']>;

const SubtituloVivo: React.FC<{sub: SubtituloEdl; clave: ReadonlySet<number>; op: Vivos}> = ({sub, clave, op}) => {
	const f = useCurrentFrame();
	const x = sub.caja?.x ?? 540;
	const y = sub.caja?.y ?? 1500;
	const t0 = aCuadro(sub.desde);
	return (
		<div style={{position: 'absolute', left: x - 540, width: 1080, top: y - op.tamano_px * 0.95, display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: op.tamano_px * 0.26}}>
			{sub.palabras.map((p) => {
				const esClave = clave.has(p.i);
				const voz: Voz = esClave ? op.voz_clave : 'sans';
				const tam = op.tamano_px * (esClave ? op.escala_clave : 1);
				const g = f - (Math.max(t0, aCuadro(p.d)) - t0);
				const a = resorte(g, 5);
				return (
					<span key={p.i} style={{...fuente(voz), fontSize: tam, lineHeight: 1, color: esClave ? op.color_clave : COLORES_VIVO.texto, textShadow: SOMBRA_TEXTO, display: 'inline-block', opacity: g < 0 ? 0 : Math.min(1, entra(g, 2)), transform: `scale(${0.72 + 0.28 * a})`, transformOrigin: '50% 80%'}}>
						{p.t.replace(/[.,;:!?¡¿…]+$/u, '').replace(/^[¡¿]+/u, '')}
					</span>
				);
			})}
		</div>
	);
};

/** Subtítulos vivos (los de `normales` y todos si no está activo: los dibuja CapaSubtitulos). */
export const SubtitulosVivos: React.FC<{subtitulos: Edicion['subtitulos']; resaltar: readonly number[]; vivo?: TextoVivo}> = ({subtitulos, resaltar, vivo}) => {
	const op = vivo?.subtitulos;
	if (!op?.activo) return null;
	cargarVoces();
	const clave = new Set(resaltar);
	const normales = new Set(op.normales);
	return (
		<>
			{subtitulos
				.filter((s) => !normales.has(s.id))
				.map((s) => (
					<Sequence key={s.id} from={aCuadro(s.desde)} durationInFrames={Math.max(1, aCuadro(s.hasta) - aCuadro(s.desde))} layout="none">
						<SubtituloVivo sub={s} clave={clave} op={op} />
					</Sequence>
				))}
		</>
	);
};

/** Los subtítulos que siguen con la apariencia normal del estilo. */
export const subtitulosNormales = (subtitulos: Edicion['subtitulos'], vivo?: TextoVivo): Edicion['subtitulos'] => {
	const op = vivo?.subtitulos;
	if (!op?.activo) return subtitulos;
	const normales = new Set(op.normales);
	return subtitulos.filter((s) => normales.has(s.id));
};
