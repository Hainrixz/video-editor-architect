import {Composition} from 'remotion';
import {Reel} from './reel/Reel';
import {EdicionBase, edicionVacia, type Edicion} from './esquema/edicion';

/**
 * Una sola composición. La duración sale de la EDL (`duracion_s`) vía calculateMetadata,
 * así cada render dura lo que diga edicion-vN.json y no lo que diga este archivo.
 * Ojo: Remotion NO valida las props contra el schema al renderizar; eso lo hace herramientas/validar.ts.
 */
export const RemotionRoot: React.FC = () => (
	<Composition
		id="Reel"
		component={Reel}
		schema={EdicionBase}
		fps={30}
		width={1440}
		height={2560}
		durationInFrames={90}
		defaultProps={edicionVacia}
		calculateMetadata={({props}: {props: Edicion}) => ({
			durationInFrames: Math.max(1, Math.round(props.duracion_s * 30)),
		})}
	/>
);
