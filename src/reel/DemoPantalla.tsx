import React, {useEffect, useMemo, useState} from 'react';
import {staticFile, useCurrentFrame, useDelayRender, useVideoConfig} from 'remotion';
import {Video} from '@remotion/media';
import {ESTILO_DEMO, EventosDemo, TomaDemo, rutaTomaDeEventos, type EventoDemo} from '../estilo/demo';
import {aspectoDeEncuadre, evaluarCamara, ondasActivas, planDeZoom, posicionCursor, type Encuadre} from '../../herramientas/grabador/zoom-plan';

/**
 * Inserto de demo de pantalla (Fase 5): dibuja demos/<slug>/toma.mp4 con
 *   - zoom planificado desde eventos.json (herramientas/grabador/zoom-plan.ts: entra 0.45 s antes del clic, se
 *     mantiene 1.2 s, paneo entre clics cercanos, resorte críticamente amortiguado, nunca sale del cuadro),
 *   - cursor sintético que viaja con curva suave entre clics y se encoge al hacer clic, con una onda que crece,
 *   - marco con esquinas redondeadas (28 px por defecto, r_photo del brand kit mientras no se mida en tus reels).
 *
 * Coordenadas: va dentro del contenedor base 1080×1920 de Reel.tsx (escalado ×4/3). Ocupa `ancho × alto` px base
 * desde su esquina; quien lo usa lo coloca (p. ej. en insert.caja).
 *   - encuadre "horizontal": se ve la toma 16:10 completa (escala 1) y el zoom acerca; si la caja es más alta, la
 *     toma queda centrada sobre fondo oscuro (pantalla completa) o la tarjeta toma el alto que le toca.
 *   - encuadre "vertical": la vista tiene el aspecto de la caja (9:16 a pantalla completa, 4:5 en tarjeta) y la
 *     cámara sigue la acción por la toma horizontal.
 * Datos: lee eventos.json y, de la misma carpeta, toma.json (tamaño del cuadro). Si `eventos` es null, usa
 * toma.json junto al asset y no hay zoom ni cursor.
 *
 * Integración en Reel.tsx (no se toca aquí): un insert tipo "demo" se dibuja así, dentro del contenedor base:
 *   <Sequence from={aCuadro(i.desde)} durationInFrames={aCuadro(i.hasta) - aCuadro(i.desde)} layout="none">
 *     <div style={{position: 'absolute', left: i.caja?.x ?? 0, top: i.caja?.y ?? 0}}>
 *       <DemoPantalla asset={i.asset} eventos={i.eventos} layout={i.layout} trim_desde={i.trim_desde}
 *         encuadre={i.layout === 'pantalla-completa' ? 'vertical' : 'horizontal'}
 *         ancho={i.caja?.w} alto={i.caja?.h} />
 *     </div>
 *   </Sequence>
 * (El contrato de Insert no trae `encuadre`: mientras no exista, sale del layout como arriba.)
 */
export type PropsDemoPantalla = {
	/** demos/<slug>/toma.mp4 (relativa a public/). */
	asset: string;
	/** demos/<slug>/eventos.json (relativa a public/), o null. */
	eventos: string | null;
	layout: 'tarjeta' | 'pantalla-completa';
	encuadre: Encuadre;
	/** Segundo de la toma donde empieza el inserto. */
	trim_desde: number;
	/** Tamaño de la caja en px base (por defecto: 1080×1920 a pantalla completa; 1000×625 o 900×1125 en tarjeta). */
	ancho?: number;
	alto?: number;
	/** Radio de las esquinas de la tarjeta (px base). */
	radio?: number;
	cursor?: boolean;
	zoom?: boolean;
};

type Datos = {eventos: EventoDemo[]; ancho: number; alto: number};

/** Flecha del cursor (dibujo propio). La punta está en (0, 0) del path; el viewBox deja 1.5 de margen. */
const FLECHA = 'M0 0 L0 16.2 L4.1 12.3 L7 18.6 L9.6 17.5 L6.8 11.3 L12.1 11.3 Z';
const VIEWBOX = {x: -1.5, y: -1.5, w: 15.2, h: 22};

/** Al acercar, el cursor y la onda crecen menos que la página (escala^0.4 en vez de escala). */
const COMPENSA = 0.6;

function cajaPorDefecto(layout: PropsDemoPantalla['layout'], encuadre: Encuadre): {ancho: number; alto: number} {
	if (layout === 'pantalla-completa') return {ancho: 1080, alto: 1920};
	return encuadre === 'vertical' ? {...ESTILO_DEMO.tarjeta_vertical} : {...ESTILO_DEMO.tarjeta_horizontal};
}

export const DemoPantalla: React.FC<PropsDemoPantalla> = ({asset, eventos: rutaEventos, layout, encuadre, trim_desde, ancho: anchoProp, alto: altoProp, radio, cursor = true, zoom = true}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const [datos, setDatos] = useState<Datos | null>(null);
	// useDelayRender: el render espera a que lleguen eventos.json y toma.json (respeta el alcance de cada render).
	const {delayRender, continueRender, cancelRender} = useDelayRender();
	const [espera] = useState(() => delayRender(`Cargando la demo ${asset}`));

	useEffect(() => {
		let vivo = true;
		const cargar = async () => {
			const leer = async (ruta: string) => {
				const r = await fetch(staticFile(ruta));
				if (!r.ok) throw new Error(`no encontré ${ruta} (HTTP ${r.status})`);
				return r.json();
			};
			const toma = TomaDemo.parse(await leer(rutaTomaDeEventos(rutaEventos ?? asset)));
			const eventos = rutaEventos ? EventosDemo.parse(await leer(rutaEventos)) : [];
			if (vivo) setDatos({eventos, ancho: toma.cuadro.ancho, alto: toma.cuadro.alto});
			continueRender(espera);
		};
		cargar().catch((error: unknown) => {
			const motivo = error instanceof Error ? error.message : String(error);
			cancelRender(new Error(`No pude cargar la demo ${asset}: ${motivo}. Siguiente paso: vuelve a grabarla con herramientas/grabador/estudio.ts grabar.`));
		});
		return () => {
			vivo = false;
		};
	}, [asset, rutaEventos, espera, continueRender, cancelRender]);

	const caja = {...cajaPorDefecto(layout, encuadre), ...(anchoProp && altoProp ? {ancho: anchoProp, alto: altoProp} : {})};

	// Vista: dónde se dibuja la toma dentro de la caja (px base).
	const vista = useMemo(() => {
		if (!datos) return null;
		const aspecto = aspectoDeEncuadre(encuadre, datos.ancho, datos.alto, caja);
		let w = caja.ancho;
		let h = caja.ancho / aspecto;
		if (h > caja.alto) {
			h = caja.alto;
			w = caja.alto * aspecto;
		}
		return {x: (caja.ancho - w) / 2, y: (caja.alto - h) / 2, w, h, aspecto};
	}, [datos, encuadre, caja.ancho, caja.alto]);

	const plan = useMemo(() => {
		if (!datos || !vista) return null;
		return planDeZoom(zoom ? datos.eventos : [], {ancho: datos.ancho, alto: datos.alto, aspecto: vista.aspecto});
	}, [datos, vista, zoom]);

	if (!datos || !vista || !plan) return null;

	const t = trim_desde + frame / fps;
	const cam = evaluarCamara(plan, t);
	const k = vista.w / cam.w; // px base por px del cuadro
	const compensa = Math.pow(cam.escala, -COMPENSA);
	const esTarjeta = layout === 'tarjeta';
	const r = radio ?? ESTILO_DEMO.radio_px.valor;

	const altoCursor = ESTILO_DEMO.cursor.alto_rel * datos.alto * compensa;
	const unidad = altoCursor / VIEWBOX.h;
	const cur = posicionCursor(datos.eventos, t, datos);
	const ondas = ondasActivas(datos.eventos, t, datos);

	return (
		<div
			style={{
				position: 'relative',
				width: caja.ancho,
				height: caja.alto,
				backgroundColor: esTarjeta ? 'transparent' : ESTILO_DEMO.fondo_pantalla_completa,
			}}
		>
			<div
				style={{
					position: 'absolute',
					left: vista.x,
					top: vista.y,
					width: vista.w,
					height: vista.h,
					overflow: 'hidden',
					borderRadius: esTarjeta ? r : 0,
					boxShadow: esTarjeta ? ESTILO_DEMO.sombra : undefined,
					outline: esTarjeta ? ESTILO_DEMO.borde : undefined,
					outlineOffset: -1,
					backgroundColor: '#000',
				}}
			>
				<div
					style={{
						position: 'absolute',
						left: 0,
						top: 0,
						width: datos.ancho,
						height: datos.alto,
						transformOrigin: '0 0',
						transform: `translate(${-cam.x * k}px, ${-cam.y * k}px) scale(${k})`,
					}}
				>
					<Video src={staticFile(asset)} trimBefore={Math.round(trim_desde * fps)} muted style={{position: 'absolute', left: 0, top: 0, width: datos.ancho, height: datos.alto}} />
					{cursor
						? ondas.map((o, i) => (
								<div
									key={`onda-${i}`}
									style={{
										position: 'absolute',
										left: o.x - o.radio * compensa,
										top: o.y - o.radio * compensa,
										width: 2 * o.radio * compensa,
										height: 2 * o.radio * compensa,
										borderRadius: '50%',
										border: `${o.grosor * compensa}px solid ${ESTILO_DEMO.onda.color}`,
										backgroundColor: ESTILO_DEMO.onda.relleno,
										opacity: o.opacidad,
										boxSizing: 'border-box',
									}}
								/>
							))
						: null}
					{cursor && datos.eventos.some((e) => e.tipo === 'clic') ? (
						<svg
							width={VIEWBOX.w * unidad}
							height={VIEWBOX.h * unidad}
							viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}
							style={{
								position: 'absolute',
								left: cur.x - (0 - VIEWBOX.x) * unidad,
								top: cur.y - (0 - VIEWBOX.y) * unidad,
								overflow: 'visible',
								transformOrigin: `${(0 - VIEWBOX.x) * unidad}px ${(0 - VIEWBOX.y) * unidad}px`,
								transform: `scale(${cur.escala})`,
								filter: ESTILO_DEMO.cursor.sombra,
							}}
						>
							<path d={FLECHA} fill={ESTILO_DEMO.cursor.relleno} stroke={ESTILO_DEMO.cursor.contorno} strokeWidth={1.4} strokeLinejoin="round" />
						</svg>
					) : null}
				</div>
			</div>
		</div>
	);
};
