import React, {useEffect, useRef, useState} from 'react';
import {Sequence, staticFile, useCurrentFrame, useDelayRender} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {aCuadro, type Edicion} from '../esquema/edicion';
import {archivoFuente, candidata, metricasCss, type IdFuente} from '../estilo/fuentes';
import {
	agruparTarjetas,
	altoCajaPrompt,
	anchoMaxDeTarjeta,
	entradaDeTarjeta,
	escalaDeTarjeta,
	escrituraDeTarjeta,
	familiaTarjeta,
	filasDeGrupo,
	geometriaPrompt,
	geometriaTarjeta,
	partirEscritura,
	pesoReal,
	radioPrompt,
	renglones,
	resolverEstiloTarjeta,
	textoTarjeta,
	cuadrosDeHorario,
	grafemas,
	visiblesPorHorario,
	xDeFila,
	yDeGrupo,
	type EstiloTarjeta,
	type GrupoTarjetas,
} from '../estilo/capas';
import {POP_MEDIDO, caracteresVisibles, cursorEncendido, escalaPop, opacidadPop} from '../estilo/animaciones';

/**
 * Tarjetas de palabra clave: caja blanca de esquinas redondeadas con texto negro en negritas, a la altura del pecho.
 * Coordenadas base 1080×1920 (van dentro del contenedor ×4/3 de Reel.tsx).
 *
 * Cómo se ven (medido en tus reels; números en src/estilo/capas.ts → MEDICIONES_CAPAS):
 * - "normal": TikTok Sans 800, mayúsculas de 51 px, caja de ~118 px de alto (30 px arriba de las mayúsculas y 36 px
 *   abajo de la línea base), ~24 px de la tinta a la orilla, radio 15 px, centro en y = 1274.
 *   Con 2 renglones o más, CADA renglón lleva su propia caja (como el texto con fondo de Instagram): se dibujan con un
 *   span en línea, `box-decoration-break: clone` y renglones de 76 px que se enciman, así la forma sigue el ancho de
 *   cada renglón. El texto va en una segunda capa idéntica encima, para que la caja de un renglón no tape las colitas
 *   (g, p, y) del de arriba. "grande" = la normal × escala_grande.
 * - "prompt" (tus prompts escritos en pantalla, 5 medidos): UNA sola caja del ancho del renglón más largo (máx. 900),
 *   texto alineado a la IZQUIERDA, mayúsculas de 33.8 px, 50 px de línea base a línea base, 29.4 px de la orilla al
 *   tope de las mayúsculas y 33.1 de la última línea base a la orilla, y radio = 0.201 × alto de la caja (crece con
 *   la caja: 35 px con 3 renglones chicos, 50 con 4). Los saltos de renglón los pones tú con "\n" (si uno no cabe, se
 *   parte solo). Para el radio hay que medir la caja ya con la fuente: frena el render (delayRender) hasta tenerla.
 * - Entrada: "corte" (211 de 213 en tus reels), "pop" (el de los stickers) o "escritura" (letra por letra, 16 de 213).
 *   La de la tarjeta manda si es "pop" o "escritura"; con "corte" (el valor por defecto) manda estilo.entrada.
 *   Escritura como en tus reels: la caja sale de una vez a su TAMAÑO FINAL (vacía 1 cuadro; 2 en los prompts) y las
 *   letras van saliendo de izquierda a derecha, cada renglón ya en su lugar final; lo que falta ocupa su lugar sin
 *   verse (visibility: hidden), así nada brinca ni se re-acomoda. Velocidad medida: 40 car/s (30.7 en los prompts);
 *   si la tarjeta dura poco, se acelera para quedar completa al 87 % de su tiempo en pantalla. Cursor: opcional
 *   (estilo.escritura.cursor; en tus reels no hay).
 *   Con tarjeta.escritura (el horario que pone el director en los prompts) las letras salen al compás de tu voz:
 *   cada palabra cuando la dices (capas.ts → visiblesPorHorario). Y el prompt no nace a su alto final: la caja crece
 *   renglón por renglón con lo ya escrito (como un editor de texto), con el borde de arriba fijo; el contenedor de
 *   afuera guarda el alto final, así el grupo se acomoda igual que antes.
 * - Salen con CORTE SECO.
 * - Las de un mismo `grupo` son una lista. Sin `fila`, cada una va en su renglón (apiladas hacia abajo, como antes);
 *   las de la misma `fila` van LADO A LADO, centradas como fila, con separacion_h_px (31.9) entre ellas: tus listas en
 *   árbol (7 de 9: 1 arriba y 2 debajo). El renglón de arriba va centrado en (promedio de sus caja.x, caja.y de su
 *   primera tarjeta) y los demás bajan con separacion_px (30) entre renglones, cada uno centrado en el promedio de sus
 *   caja.x. Cada una aparece en su `desde` (las que faltan ocupan su lugar sin verse, así nada se mueve) y se van
 *   todas juntas en el `hasta` más tardío. Sin caja.escala, las de lista usan `escala_lista`.
 *   La geometría pura (para layout y validar) está en capas.ts → disponerGrupo.
 * - caja.w (opcional) = ancho máximo de esa caja; caja.escala = tamaño; variante "grande" = ×escala_grande.
 * - Emoji: después de la fuente de la tarjeta va la de emoji de color del sistema (19 de tus 213 tarjetas llevan uno).
 *
 * La fuente se registra con ascenso = alto de mayúscula y descenso = 0 (igual que los subtítulos), así la caja no
 * depende de las métricas de la plataforma: cada renglón mide exactamente mayúscula + rellenos.
 */

type TarjetaEdl = Edicion['tarjetas'][number];
type Variante = TarjetaEdl['variante'];

const fuentesCargadas = new Map<string, Promise<void>>();

/**
 * Registra (una vez por pestaña) un peso de una fuente de biblioteca/fuentes/ con las métricas de los subtítulos
 * (ascenso = mayúscula, descenso = 0). loadFont frena el render hasta que carga; si falla, el render falla.
 * Devuelve la promesa para quien necesite medir texto después (el titular y el prompt).
 */
export function cargarFuenteCapa(id: IdFuente, peso: number): Promise<void> {
	const real = pesoReal(id, peso);
	const llave = `${id}:${real}`;
	let promesa = fuentesCargadas.get(llave);
	if (!promesa) {
		promesa = loadFont({
			family: candidata(id).familiaCss,
			url: staticFile(archivoFuente(id, real).ruta),
			weight: String(real),
			style: 'normal',
			display: 'block',
			...metricasCss(id),
		});
		fuentesCargadas.set(llave, promesa);
	}
	return promesa;
}

export type PropsTarjetaVisual = {
	texto: string;
	estilo: EstiloTarjeta;
	/** Escala total (variante × caja.escala). */
	escala?: number;
	/** Ancho máximo de esta caja (si no, el del estilo; el del prompt en la variante prompt). */
	anchoMax?: number;
	/** "prompt" = una caja con el texto a la izquierda; "normal" y "grande" = caja por renglón, centrada. */
	variante?: Variante;
	/** Grafemas que ya se ven (escritura letra por letra). Sin valor: todos. Los demás ocupan su lugar sin verse. */
	visibles?: number;
	/** Cursor al final de lo escrito: null = sin cursor; true / false = barra encendida / apagada (parpadeo). */
	cursor?: boolean | null;
	style?: React.CSSProperties;
	'data-tarjeta'?: string;
};

/** Barra de cursor al final de lo escrito. Va en un span vacío en línea: no ocupa lugar ni cambia dónde se parte el renglón. */
const Cursor: React.FC<{alto: number; color: string; encendido: boolean}> = ({alto, color, encendido}) => (
	<span data-cursor style={{position: 'relative'}}>
		<span
			style={{
				position: 'absolute',
				left: Math.max(1, alto * 0.06),
				bottom: 0,
				width: Math.max(2, alto * 0.09),
				height: alto,
				backgroundColor: color,
				visibility: encendido ? 'visible' : 'hidden',
			}}
		/>
	</span>
);

/** El texto de una tarjeta, completo o a media escritura (lo que falta va oculto en su lugar). */
const Escrito: React.FC<{texto: string; visibles?: number; cursor: boolean | null; alto: number; color: string}> = ({texto, visibles, cursor, alto, color}) => {
	if (visibles === undefined && cursor === null) return <>{texto}</>;
	const {visible, oculto} = partirEscritura(texto, visibles ?? Number.POSITIVE_INFINITY);
	return (
		<>
			{visible}
			{cursor === null ? null : <Cursor alto={alto} color={color} encendido={cursor} />}
			{oculto ? (
				<span data-oculto style={{visibility: 'hidden'}}>
					{oculto}
				</span>
			) : null}
		</>
	);
};

/**
 * Una tarjeta dibujada en su lugar del flujo (sin posición ni tiempo). Su caja de diseño mide exactamente lo que se
 * ve: del borde de arriba de la caja del 1.er renglón al borde de abajo de la del último.
 */
export const TarjetaVisual: React.FC<PropsTarjetaVisual> = (props) => (props.variante === 'prompt' ? <TarjetaPrompt {...props} /> : <TarjetaNormal {...props} />);

const TarjetaNormal: React.FC<PropsTarjetaVisual> = ({texto, estilo, escala = 1, anchoMax, visibles, cursor = null, style, 'data-tarjeta': dataTarjeta}) => {
	const peso = pesoReal(estilo.fuente, estilo.peso);
	cargarFuenteCapa(estilo.fuente, peso);
	const g = geometriaTarjeta(estilo, escala);
	const limpio = textoTarjeta(texto);
	// La caja de diseño de cada renglón mide un interlineado; el fondo se sale por arriba (relleno − medio
	// interlineado) y por abajo. Ese sobrante se pone como relleno del contenedor para que su caja = lo visible.
	const extraArriba = Math.max(0, g.pad_arriba_px - g.medio_interlineado_px);
	const extraAbajo = Math.max(0, g.pad_abajo_px - g.medio_interlineado_px);
	const capa: React.CSSProperties = {
		gridArea: '1 / 1',
		textAlign: 'center',
		whiteSpace: 'pre-line',
		textWrap: 'balance',
		fontFamily: familiaTarjeta(estilo.fuente),
		fontWeight: peso,
		fontStyle: 'normal',
		fontSize: g.tamano_px,
		lineHeight: `${g.interlineado_px}px`,
		fontKerning: 'normal',
		fontSynthesis: 'none',
		letterSpacing: 0,
	};
	const span: React.CSSProperties = {
		padding: `${g.pad_arriba_px}px ${g.pad_lados_px}px ${g.pad_abajo_px}px`,
		borderRadius: g.radio_px,
		WebkitBoxDecorationBreak: 'clone',
		boxDecorationBreak: 'clone',
	};
	return (
		<div
			data-tarjeta={dataTarjeta}
			style={{
				display: 'grid',
				boxSizing: 'border-box',
				maxWidth: anchoMax ?? estilo.ancho_max,
				paddingTop: extraArriba,
				paddingBottom: extraAbajo,
				...style,
			}}
		>
			{/* Fondo: el texto COMPLETO (transparente) da las cajas de su tamaño final desde el primer cuadro. */}
			<div aria-hidden style={{...capa, color: 'transparent'}}>
				<span style={{...span, backgroundColor: estilo.color_fondo}}>{limpio}</span>
			</div>
			<div style={{...capa, color: estilo.color_texto}}>
				<span style={span}>
					<Escrito texto={limpio} visibles={visibles} cursor={cursor} alto={g.alto_mayuscula_px} color={estilo.color_texto} />
				</span>
			</div>
		</div>
	);
};

/**
 * Variante "prompt": una caja con el texto a la izquierda. El radio es una fracción del alto de la caja, así que
 * primero carga la fuente y mide la caja (con el texto completo, aunque se esté escribiendo); mientras, frena el render.
 */
const TarjetaPrompt: React.FC<PropsTarjetaVisual> = ({texto, estilo, escala = 1, anchoMax, visibles, cursor = null, style, 'data-tarjeta': dataTarjeta}) => {
	const peso = pesoReal(estilo.fuente, estilo.peso);
	const g = geometriaPrompt(estilo, escala);
	const limpio = textoTarjeta(texto);
	const maxW = anchoMax ?? g.ancho_max;
	const clave = JSON.stringify([limpio, estilo.fuente, peso, g.tamano_px, g.interlineado_px, g.css_arriba_px, g.css_abajo_px, g.pad_lados_px, maxW]);
	const caja = useRef<HTMLDivElement>(null);
	const {delayRender, continueRender, cancelRender} = useDelayRender();
	const [espera] = useState(() => delayRender('Tarjeta prompt: cargar la fuente y medir su caja'));
	const [medida, setMedida] = useState<{clave: string; alto: number; renglonDe: number[]; renglones: number; ancho: number} | null>(null);

	useEffect(() => {
		let vivo = true;
		cargarFuenteCapa(estilo.fuente, peso)
			.then(() => {
				const el = caja.current;
				if (!vivo || !el) return;
				const renglonDe = renglonesDeGrafemas(el, limpio, g.interlineado_px);
				// Con renglones partidos, "max-content" deja la caja al ancho máximo (blanco de sobra a la derecha):
				// la caja mide el renglón más largo + sus rellenos (decisión del estilo: sin blanco de sobra).
				const ancho = Math.min(maxW, Math.ceil(anchoTinta(el, limpio)) + 2 * g.pad_lados_px + 1);
				setMedida({clave, alto: el.offsetHeight, renglonDe, renglones: Math.max(1, ...renglonDe.map((r) => r + 1)), ancho});
			})
			.catch((err) => cancelRender(err));
		return () => {
			vivo = false;
		};
		// La clave junta todo lo que cambia el alto de la caja (texto, fuente, tamaño, rellenos y ancho máximo).
	}, [clave]);
	useEffect(() => {
		if (medida?.clave === clave) continueRender(espera);
	}, [medida, clave, espera, continueRender]);
	// Si se desmonta antes de medir (por ejemplo al moverse en el Studio), suelta la espera.
	useEffect(() => () => continueRender(espera), [espera, continueRender]);

	const medidaVigente = medida?.clave === clave ? medida : null;
	const altoFinal = medidaVigente ? medidaVigente.alto : altoCajaPrompt(g, renglones(limpio).length);
	// La caja crece con lo escrito, renglón por renglón (como un editor de texto), con el borde de arriba fijo: el
	// contenedor de afuera guarda el alto final (así el grupo se acomoda igual que antes) y la caja se recorta arriba.
	let renglonesVisibles = medidaVigente?.renglones ?? 1;
	if (medidaVigente && visibles !== undefined && visibles < medidaVigente.renglonDe.length) {
		renglonesVisibles = visibles <= 0 ? 1 : medidaVigente.renglonDe[visibles - 1] + 1;
	}
	const recorta = medidaVigente !== null && renglonesVisibles < medidaVigente.renglones;
	const alto = recorta ? altoFinal - (medidaVigente!.renglones - renglonesVisibles) * g.interlineado_px : altoFinal;
	return (
		<div
			data-tarjeta={dataTarjeta}
			data-variante="prompt"
			style={{
				boxSizing: 'border-box',
				width: medidaVigente ? medidaVigente.ancho : 'max-content',
				maxWidth: maxW,
				height: medidaVigente ? altoFinal : undefined,
				...style,
			}}
		>
		<div
			ref={caja}
			data-caja-prompt
			data-renglones={medidaVigente ? `${renglonesVisibles}/${medidaVigente.renglones}` : undefined}
			style={{
				boxSizing: 'border-box',
				width: medidaVigente ? medidaVigente.ancho : 'max-content',
				maxWidth: maxW,
				height: recorta ? alto : undefined,
				overflow: recorta ? 'hidden' : undefined,
				padding: `${g.css_arriba_px}px ${g.pad_lados_px}px ${g.css_abajo_px}px`,
				borderRadius: radioPrompt(g, alto),
				backgroundColor: estilo.color_fondo,
				color: estilo.color_texto,
				textAlign: 'left',
				whiteSpace: 'pre-line',
				// Una palabra más ancha que la caja (una URL, un comando) se parte dentro de la caja y no se sale de ella
				// (decisión del estilo: ningún texto se sale de su caja).
				overflowWrap: 'anywhere',
				fontFamily: familiaTarjeta(estilo.fuente),
				fontWeight: peso,
				fontStyle: 'normal',
				fontSize: g.tamano_px,
				lineHeight: `${g.interlineado_px}px`,
				fontKerning: 'normal',
				fontSynthesis: 'none',
				letterSpacing: 0,
			}}
		>
			<Escrito texto={limpio} visibles={visibles} cursor={cursor} alto={g.alto_mayuscula_px} color={estilo.color_texto} />
		</div>
		</div>
	);
};

/**
 * Renglón (0, 1, 2…) en que el navegador dibuja cada grafema del texto de `el` (el texto completo: lo escrito y lo
 * oculto ocupan su lugar). Los que no tienen caja propia (un salto de renglón, un espacio donde se parte) van con el
 * anterior. Se mide una vez, con la fuente ya cargada.
 */
/**
 * Ancho (px CSS, sin la escala del lienzo) del renglón más largo del texto COMPLETO, aunque se esté escribiendo: lo mide
 * una copia invisible con los mismos estilos y el mismo ancho máximo que la caja.
 */
function anchoTinta(el: HTMLElement, texto: string): number {
	const copia = el.cloneNode(false) as HTMLElement;
	copia.removeAttribute('data-caja-prompt');
	copia.style.position = 'absolute';
	copia.style.visibility = 'hidden';
	copia.style.height = 'auto';
	copia.style.overflow = 'visible';
	copia.style.width = 'max-content';
	copia.style.left = '0';
	copia.style.top = '0';
	copia.textContent = texto;
	(el.parentElement ?? el).appendChild(copia);
	try {
		const escalaX = copia.offsetWidth > 0 ? copia.getBoundingClientRect().width / copia.offsetWidth : 1;
		const rango = document.createRange();
		rango.selectNodeContents(copia);
		const cajas = Array.from(rango.getClientRects()).filter((c) => c.width > 0 && c.height > 0);
		if (!cajas.length || !(escalaX > 0)) return el.offsetWidth;
		return (Math.max(...cajas.map((c) => c.right)) - Math.min(...cajas.map((c) => c.left))) / escalaX;
	} finally {
		copia.remove();
	}
}

function renglonesDeGrafemas(el: HTMLElement, texto: string, interlineado: number): number[] {
	const nodos: Text[] = [];
	const caminante = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	for (let n = caminante.nextNode(); n; n = caminante.nextNode()) nodos.push(n as Text);
	const escalaY = el.offsetHeight > 0 ? el.getBoundingClientRect().height / el.offsetHeight : 1;
	const renglon = interlineado * escalaY;
	const res: number[] = [];
	let nodo = 0;
	let dentro = 0;
	let tope0: number | null = null;
	const rango = document.createRange();
	for (const gr of grafemas(texto)) {
		while (nodo < nodos.length && dentro >= nodos[nodo].length) {
			nodo++;
			dentro = 0;
		}
		let r = res.length ? res[res.length - 1] : 0;
		if (nodo < nodos.length) {
			const fin = Math.min(nodos[nodo].length, dentro + gr.length);
			rango.setStart(nodos[nodo], dentro);
			rango.setEnd(nodos[nodo], fin);
			const caja = Array.from(rango.getClientRects()).find((c) => c.height > 0 && c.width > 0);
			if (caja && gr.trim() !== '') {
				if (tope0 === null) tope0 = caja.top;
				r = Math.max(0, Math.round((caja.top - tope0) / renglon));
			}
			dentro = fin;
		}
		res.push(r);
	}
	return res;
}

export type PropsGrupoTarjetas = {
	grupo: GrupoTarjetas;
	estilo: EstiloTarjeta;
};

/** Un grupo (o una tarjeta sola) dentro de su Sequence: useCurrentFrame() = cuadros desde que aparece la primera. */
export const GrupoDeTarjetas: React.FC<PropsGrupoTarjetas> = ({grupo, estilo}) => {
	const f = useCurrentFrame();
	const [arriba, ...abajo] = filasDeGrupo(grupo.tarjetas);
	const x0 = xDeFila(arriba, estilo);
	const y0 = yDeGrupo(arriba[0], estilo);

	const dibujar = (t: TarjetaEdl) => {
		const aparece = aCuadro(t.desde) - grupo.desde;
		const local = f - aparece;
		const entrada = entradaDeTarjeta(t, estilo);
		let anim: React.CSSProperties = {};
		let visibles: number | undefined;
		let cursor: boolean | null = null;
		if (local < 0) anim = {visibility: 'hidden'};
		else if (entrada === 'pop') anim = {transform: `scale(${escalaPop(local, POP_MEDIDO)})`, opacity: opacidadPop(local, POP_MEDIDO)};
		else if (entrada === 'escritura') {
			// Su tiempo en pantalla: de su aparición a que se va el grupo entero.
			const {total, params} = escrituraDeTarjeta(t, estilo, grupo.hasta - aCuadro(t.desde));
			if (t.escritura && t.escritura.length >= 2) {
				// Al compás de tu voz: el horario del director (segundos del video; f cuenta desde grupo.desde).
				visibles = visiblesPorHorario((grupo.desde + f) / 30, t.escritura, total);
				if (estilo.escritura.cursor) {
					const c = cuadrosDeHorario(t.escritura, total, aCuadro(t.desde), grupo.hasta);
					const fin = c ? c.completo - aCuadro(t.desde) : 0;
					const parpadeo = estilo.escritura.cursor_parpadeo_cuadros;
					cursor = local < fin || parpadeo <= 0 ? true : Math.floor((local - fin) / parpadeo) % 2 === 0;
				}
			} else {
				visibles = caracteresVisibles(local, total, params);
				if (estilo.escritura.cursor) cursor = cursorEncendido(local, total, params, estilo.escritura.cursor_parpadeo_cuadros);
			}
		}
		return (
			<TarjetaVisual
				key={t.id}
				data-tarjeta={t.id}
				texto={t.texto}
				estilo={estilo}
				variante={t.variante}
				escala={escalaDeTarjeta(t, estilo)}
				anchoMax={anchoMaxDeTarjeta(t, estilo)}
				visibles={visibles}
				cursor={cursor}
				style={{flexShrink: 0, ...anim}}
			/>
		);
	};

	/** Un renglón del grupo: sus tarjetas lado a lado, centradas en vertical. */
	const fila = (ts: TarjetaEdl[], i: number, style?: React.CSSProperties) => (
		<div
			key={`fila-${i}`}
			data-fila={i}
			style={{display: 'flex', flexDirection: 'row', alignItems: 'center', gap: estilo.separacion_h_px, width: 'max-content', ...style}}
		>
			{ts.map(dibujar)}
		</div>
	);

	// El renglón de arriba se centra en (x0, y0) con un contenedor flex de 0 × 0 y no con translate(-50%, -50%):
	// con un translate fraccionario, Chrome dibuja el texto ~1.5 px más arriba que su caja de bloque (medido en el
	// prompt: la mayúscula quedaba a 28.1 px de la orilla en vez de 30).
	return (
		<div data-grupo-tarjetas={grupo.id} style={{position: 'absolute', left: x0, top: y0, width: 0, height: 0, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
			<div style={{position: 'relative', flexShrink: 0, width: 'max-content'}}>
				{fila(arriba, 0)}
				{abajo.length > 0 ? (
					<div
						style={{
							position: 'absolute',
							top: `calc(100% + ${estilo.separacion_px}px)`,
							left: '50%',
							marginLeft: -540,
							width: 1080,
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'center',
							gap: estilo.separacion_px,
						}}
					>
						{abajo.map((ts, i) => {
							const dx = xDeFila(ts, estilo) - x0;
							return fila(ts, i + 1, dx === 0 ? undefined : {position: 'relative', left: dx});
						})}
					</div>
				) : null}
			</div>
		</div>
	);
};

export type PropsCapaTarjetas = {
	tarjetas: Edicion['tarjetas'];
	/** edicion.estilos.tarjetas (objeto libre): lo que traiga pisa los valores por defecto campo por campo. */
	estilo?: unknown;
};

/** Todas las tarjetas con su tiempo (mismo redondeo a cuadro que Reel.tsx). Los SFX los pone Reel.tsx. */
export const CapaTarjetas: React.FC<PropsCapaTarjetas> = ({tarjetas, estilo}) => {
	const e = resolverEstiloTarjeta(estilo);
	const grupos = agruparTarjetas(tarjetas);
	return (
		<>
			{grupos.map((g) => (
				<Sequence key={g.id} from={g.desde} durationInFrames={g.hasta - g.desde} layout="none" name={`tarjeta ${g.id}`}>
					<GrupoDeTarjetas grupo={g} estilo={e} />
				</Sequence>
			))}
		</>
	);
};
