/**
 * Pruebas de herramientas/grabador/secretos.ts:
 * - Patrones de secretos con positivos (cada familia del plan) y negativos (palabras y textos de GitHub que no lo son).
 * - Texto "sucio" de OCR (guiones raros, espacios junto a @ o _).
 * - Cadenas largas junto a key/token/secret (misma línea o la de abajo).
 * - Muestra censurada: el secreto nunca se guarda completo.
 * - Init script del blur en un DOM falso: espera a documentElement, pone el <style> y lo repone si la página lo borra.
 * - revision.json: BLOQUEADA hasta que apruebes; si el archivo cambia, se vuelve a bloquear.
 * Sin Vision (el OCR real va en pruebas/integracion/f5-secretos.ts, fuera del sandbox).
 */
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import type {CajaOcr} from '../../herramientas/lib/ocr.ts';
import {
	aprobarRevision,
	buscarJuntoAEtiqueta,
	buscarSecretos,
	censurar,
	demoUsable,
	estadoRevision,
	hallazgosEnCuadro,
	ID_ESTILO,
	leerSelectores,
	normalizarOcr,
	pareceSecreto,
	registrarEscaneo,
	revisarSelector,
	scriptOcultar,
	SELECTORES_POR_DEFECTO,
	type Hallazgo,
	type ResultadoEscaneo,
} from '../../herramientas/grabador/secretos.ts';

const tipos = (texto: string) => buscarSecretos(texto).map((c) => c.tipo);

describe('patrones: positivos', () => {
	it.each([
		['correo', 'escríbeme a creador.prueba@ejemplo.com hoy', 'correo'],
		['sk- (Anthropic, OpenAI)', 'ANTHROPIC_API_KEY=sk-ant-TEST-1234567890abcdef', 'llave sk-'],
		['sk- de OpenAI', 'OPENAI_API_KEY sk-proj-AbCdEf0123456789xyz', 'llave sk-'],
		['sk_ (Stripe)', 'clave sk_live_51HxYzAbCdEfGh012345', 'llave sk_'],
		['AIza (Google)', 'key=AIzaSyA-1234567890abcdefghijklmnopqrs', 'llave de Google (AIza)'],
		['apify_api_', 'token apify_api_AbCdEf123456GhIjKl', 'token de Apify'],
		['ghp_', 'ghp_1234567890abcdefghijABCDEFGHIJ123456', 'token de GitHub (gh*_)'],
		['gho_', 'gho_1234567890abcdefghijABCDEF', 'token de GitHub (gh*_)'],
		['ghu_', 'ghu_1234567890abcdefghijABCDEF', 'token de GitHub (gh*_)'],
		['ghs_', 'ghs_1234567890abcdefghijABCDEF', 'token de GitHub (gh*_)'],
		['ghr_', 'ghr_1234567890abcdefghijABCDEF', 'token de GitHub (gh*_)'],
		['github_pat_', 'github_pat_11ABCDEFG0123456789_abcdefghij', 'token de GitHub (github_pat_)'],
		['hf_', 'HF_TOKEN=hf_AbCdEfGhIjKlMnOpQrStUv', 'token de Hugging Face (hf_)'],
		['AKIA', 'aws AKIAIOSFODNN7EXAMPLE', 'llave de AWS (AKIA)'],
		['xox (Slack)', 'xoxb-123456789012-abcdefABCDEF', 'token de Slack (xox)'],
		['eyJ (JWT)', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc', 'JWT (eyJ)'],
		['-----BEGIN', '-----BEGIN TEST PRIVATE KEY-----', 'llave privada (BEGIN)'],
	])('%s', (_n, texto, tipo) => {
		expect(tipos(texto)).toContain(tipo);
	});

	it('la llave sembrada de la prueba de integración', () => {
		expect(buscarSecretos('sk-ant-TEST-1234567890abcdef')[0]).toMatchObject({tipo: 'llave sk-', valor: 'sk-ant-TEST-1234567890abcdef'});
	});

	it('texto sucio de OCR: guiones raros, guion con espacio y caracteres de ancho cero', () => {
		expect(tipos('sk–ant–TEST–1234567890abcdef')).toContain('llave sk-');
		expect(tipos('sk- ant-TEST-1234567890abcdef')).toContain('llave sk-');
		expect(tipos('creador.prueba@ejem\u200Bplo.com')).toContain('correo');
		expect(normalizarOcr('a\u200Bb')).toBe('ab');
	});

	it('cadena larga junto a key/token/secret (misma línea)', () => {
		expect(buscarJuntoAEtiqueta('API token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0').map((c) => c.tipo)).toEqual(['cadena larga junto a key/token/secret']);
		expect(buscarJuntoAEtiqueta('Secret Key  Zk3pQ9wX2mN7vB4tR8yL1cF6hJ0sD5aG').length).toBe(1);
		expect(buscarJuntoAEtiqueta('contraseña: Xy7#no-cuenta-por-el-símbolo').length).toBe(0);
	});
});

describe('patrones: negativos', () => {
	it.each([
		['palabras con sk- adentro', 'task-runner desk-top risk-free whisk-ing'],
		['palabras con Sk', 'Sketch Skill skeleton'],
		['placeholder de README', 'export ANTHROPIC_API_KEY=sk-ant-...'],
		['prefijos solos', 'AKIA eyJ hf_ ghp_ xox- AIza'],
		['remoto SSH de GitHub', 'git@github.com:latent-spaces/brag.git'],
		['noreply de GitHub', '12345+creador@users.noreply.github.com'],
		['textos de la página del repo', 'gh repo clone latent-spaces/brag · https://github.com/latent-spaces/brag.git · Clone using the web URL'],
		['commit corto', 'Latest commit cb89b9f on Oct 1'],
		['separadores', '----- ---------- ———'],
		['ícono de enlace leído como @ (GitHub)', 'last week @latent-spaces.github.io/brag/'],
		['ícono de enlace pegado a una versión', 'Claude Opus 5.5 @ latent-spaces.github.io'],
		['hf_ corto', 'hf_abc'],
	])('%s no es un secreto', (_n, texto) => {
		expect(buscarSecretos(texto)).toEqual([]);
	});

	it.each([
		['valor corto', 'token: abc123'],
		['placeholder', 'API key: your-key-here'],
		['URL junto a token', 'token https://github.com/settings/tokens/new123456789abc'],
		['ruta', 'secret /usr/local/share/very/long/path/abc123456789'],
		['nombre de variable', 'secrets.GITHUB_TOKEN_FOR_THE_WORKFLOW_RUN'],
		['cadena larga sin etiqueta', 'Zk3pQ9wX2mN7vB4tR8yL1cF6hJ0sD5aG'],
	])('%s no es una cadena secreta', (_n, texto) => {
		expect(buscarJuntoAEtiqueta(texto)).toEqual([]);
	});

	it('pareceSecreto pide letras y dígitos y variedad', () => {
		expect(pareceSecreto('aaaaaaaaaaaaaaaaaaaaaaaaaaaa1')).toBe(false);
		expect(pareceSecreto('abcdefghijklmnopqrstuvwxyzab')).toBe(false);
		expect(pareceSecreto('9f8e7d6c5b4a39281706f5e4d3c2')).toBe(true);
	});
});

describe('muestra censurada', () => {
	it('nunca devuelve el valor completo', () => {
		const s = 'sk-ant-TEST-1234567890abcdef';
		expect(censurar(s)).toBe('sk-…(28)');
		expect(censurar(s)).not.toContain('TEST');
		expect(censurar('a@b.co')).toBe('a@…(6)');
	});
});

describe('hallazgos en un cuadro de OCR', () => {
	const caja = (texto: string, x: number, y: number, w = 0.2, h = 0.02): CajaOcr => ({texto, confianza: 0.9, x, y, w, h});

	it('encuentra el secreto en una caja y lo censura', () => {
		const h = hallazgosEnCuadro([caja('Tu llave: sk-ant-TEST-1234567890abcdef', 0.1, 0.1, 0.5)]);
		expect(h).toHaveLength(1);
		expect(h[0]).toMatchObject({tipo: 'llave sk-', muestra: 'sk-…(28)'});
		expect(JSON.stringify(h)).not.toContain('1234567890abcdef');
	});

	it('une cajas casi pegadas de la misma línea (Vision a veces parte un token)', () => {
		const h = hallazgosEnCuadro([caja('creador.prueba', 0.1, 0.3, 0.12), caja('@ejemplo.com', 0.2205, 0.3, 0.1)]);
		expect(h.map((x) => x.tipo)).toEqual(['correo']);
	});

	it('no pega columnas distintas de la misma fila (fila de archivos de GitHub)', () => {
		const fila = [
			caja('.claude-plugin', 0.06, 0.44, 0.09),
			caja('Add /brag-slim: a lean /brag for Claude Opus 5.5', 0.2, 0.44, 0.3),
			caja('last week', 0.63, 0.44, 0.06),
			caja('@latent-spaces.github.io/brag/', 0.8, 0.44, 0.17),
		];
		expect(hallazgosEnCuadro(fila)).toEqual([]);
	});

	it('etiqueta a la izquierda en otra columna de la misma línea', () => {
		const h = hallazgosEnCuadro([caja('Token', 0.1, 0.5, 0.05), caja('9f8e7d6c5b4a39281706f5e4d3c2b1a0', 0.25, 0.5, 0.3)]);
		expect(h.map((x) => x.tipo)).toEqual(['cadena larga junto a key/token/secret']);
	});

	it('etiqueta arriba y valor abajo', () => {
		const h = hallazgosEnCuadro([caja('API token', 0.1, 0.4, 0.1), caja('9f8e7d6c5b4a39281706f5e4d3c2b1a0', 0.1, 0.43, 0.3)]);
		expect(h.map((x) => x.tipo)).toEqual(['cadena larga junto a key/token/secret']);
	});

	it('una cadena larga lejos de la etiqueta no cuenta', () => {
		expect(hallazgosEnCuadro([caja('API token', 0.1, 0.1, 0.1), caja('9f8e7d6c5b4a39281706f5e4d3c2b1a0', 0.6, 0.8, 0.3)])).toEqual([]);
	});

	it('el mismo secreto en dos cajas cuenta una vez', () => {
		const h = hallazgosEnCuadro([caja('sk-ant-TEST-1234567890abcdef', 0.1, 0.1), caja('sk-ant-TEST-1234567890abcdef', 0.1, 0.6)]);
		expect(h).toHaveLength(1);
	});
});

describe('init script del blur', () => {
	class Elemento {
		id = '';
		textContent = '';
		hijos: Elemento[] = [];
		constructor(public tag: string) {}
		appendChild(h: Elemento) {
			this.hijos.push(h);
			return h;
		}
		buscar(id: string): Elemento | null {
			if (this.id === id) return this;
			for (const h of this.hijos) {
				const r = h.buscar(id);
				if (r) return r;
			}
			return null;
		}
	}
	function entorno() {
		const observadores: Array<() => void> = [];
		const documento = {
			documentElement: null as Elemento | null,
			head: null as Elemento | null,
			getElementById: (id: string) => documento.documentElement?.buscar(id) ?? null,
			createElement: (tag: string) => new Elemento(tag),
		};
		class Observador {
			constructor(private cb: () => void) {
				observadores.push(() => this.cb());
			}
			observe() {}
		}
		const disparar = () => observadores.forEach((o) => o());
		return {documento, Observador, disparar};
	}
	const correr = (script: string, e: ReturnType<typeof entorno>) => new Function('document', 'MutationObserver', script)(e.documento, e.Observador);
	const estilos = (e: ReturnType<typeof entorno>) => {
		const todos: Elemento[] = [];
		const visitar = (x: Elemento | null) => {
			if (!x) return;
			if (x.id === ID_ESTILO) todos.push(x);
			x.hijos.forEach(visitar);
		};
		visitar(e.documento.documentElement);
		return todos;
	};

	it('espera a que exista documentElement, pone el <style> en head con blur(12px) por selector', () => {
		const e = entorno();
		correr(scriptOcultar([...SELECTORES_POR_DEFECTO, '.llave']), e);
		expect(estilos(e)).toHaveLength(0);
		const html = new Elemento('html');
		const head = html.appendChild(new Elemento('head'));
		e.documento.documentElement = html;
		e.documento.head = head;
		e.disparar();
		const [s] = estilos(e);
		expect(head.hijos).toContain(s);
		expect(s.textContent).toContain('.llave{filter:blur(12px) !important;}');
		expect(s.textContent).toContain('input[type="password" i]{filter:blur(12px) !important;}');
		expect(s.textContent.split('\n')).toHaveLength(SELECTORES_POR_DEFECTO.length + 1);
	});

	it('si la página borra el <style>, vuelve; y nunca se duplica', () => {
		const e = entorno();
		const html = new Elemento('html');
		e.documento.documentElement = html;
		correr(scriptOcultar(['.llave']), e);
		expect(estilos(e)).toHaveLength(1); // sin head: va directo en <html>
		html.hijos = [];
		e.disparar();
		expect(estilos(e)).toHaveLength(1);
		e.disparar();
		e.disparar();
		expect(estilos(e)).toHaveLength(1);
	});

	it('un selector que intenta cerrar la regla o meter otra es código 2', () => {
		for (const malo of ['.a{color:red}', '.a;body', '</style><script>', 'a\nb', '']) {
			let codigo = 0;
			try {
				revisarSelector(malo);
			} catch (e) {
				codigo = (e as FalloEditor).codigo;
			}
			expect(codigo, malo).toBe(2);
		}
		expect(revisarSelector(' #token ')).toBe('#token');
	});
});

describe('ocultar.json y revision.json', () => {
	const dir = mkdtempSync(join(tmpdir(), 'secretos-'));
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it('ocultar.json se suma a los selectores de siempre (lista u objeto)', () => {
		writeFileSync(join(dir, 'ocultar.json'), JSON.stringify(['.llave', '#token']));
		expect(leerSelectores(dir)).toEqual([...SELECTORES_POR_DEFECTO, '.llave', '#token']);
		writeFileSync(join(dir, 'ocultar.json'), JSON.stringify({selectores: ['.otra']}));
		expect(leerSelectores(dir).at(-1)).toBe('.otra');
		writeFileSync(join(dir, 'ocultar.json'), '{malo');
		expect(() => leerSelectores(dir)).toThrow(FalloEditor);
		rmSync(join(dir, 'ocultar.json'));
		expect(leerSelectores(dir)).toEqual([...SELECTORES_POR_DEFECTO]);
	});

	const escaneo = (hallazgos: Hallazgo[]): ResultadoEscaneo => ({archivo: 'toma.mp4', leidos: 60, paso: 5, hallazgos, segundos: 1});
	const conSecreto = (): Hallazgo[] =>
		hallazgosEnCuadro([{texto: 'sk-ant-TEST-1234567890abcdef', confianza: 0.9, x: 0.1, y: 0.1, w: 0.3, h: 0.02}]).map((h) => ({
			archivo: 'toma.mp4',
			tipo: h.tipo,
			muestra: h.muestra,
			huella: h.huella,
			cuadro: 30,
			t: 1,
			lecturas: 3,
			caja: {x: 256, y: 160, w: 768, h: 32},
		}));

	it('sin revision.json la demo cuenta como BLOQUEADA (nada entra sin escanear)', () => {
		expect(estadoRevision(dir).estado).toBe('BLOQUEADA');
		expect(demoUsable(dir)).toBe(false);
	});

	it('un hallazgo la BLOQUEA, sin guardar el secreto; tu aprobación la libera; si la toma cambia, se vuelve a bloquear', () => {
		const toma = join(dir, 'toma.mp4');
		writeFileSync(toma, 'toma de prueba v1');
		const r = registrarEscaneo(dir, escaneo(conSecreto()), toma);
		expect(r.estado).toBe('BLOQUEADA');
		const texto = readFileSync(join(dir, 'revision.json'), 'utf8');
		expect(texto).not.toContain('1234567890abcdef');
		expect(texto).toContain('sk-…(28)');
		expect(demoUsable(dir)).toBe(false);

		const aprobada = aprobarRevision(dir);
		expect(aprobada.estado).toBe('APROBADA');
		expect(aprobada.revisado_por).toBe('creador');
		expect(demoUsable(dir)).toBe(true);

		writeFileSync(toma, 'toma de prueba v2');
		expect(estadoRevision(dir)).toMatchObject({estado: 'BLOQUEADA'});
		expect(estadoRevision(dir).motivo).toContain('cambió');

		// Un escaneo nuevo con hallazgos (otra toma) vuelve a bloquear aunque estaba aprobada.
		expect(registrarEscaneo(dir, escaneo(conSecreto()), toma).estado).toBe('BLOQUEADA');
	});

	it('sin hallazgos queda LIMPIA; un aviso de blur la bloquea', () => {
		const toma = join(dir, 'toma.mp4');
		writeFileSync(toma, 'toma limpia');
		expect(registrarEscaneo(dir, escaneo([]), toma).estado).toBe('LIMPIA');
		expect(demoUsable(dir)).toBe(true);
		const r = registrarEscaneo(dir, escaneo([]), toma, ['el blur no llegó a un marco de ejemplo.com']);
		expect(r.estado).toBe('BLOQUEADA');
		expect(r.motivo).toContain('el blur no llegó');
	});

	it('una captura borrada deja de contar; una captura que nunca se escaneó bloquea (las explorar-*.png no)', () => {
		const d = mkdtempSync(join(tmpdir(), 'secretos-capturas-'));
		const toma = join(d, 'toma.mp4');
		writeFileSync(toma, 'toma limpia');
		registrarEscaneo(d, escaneo([]), toma);
		mkdirSync(join(d, 'capturas'));
		const vieja = join(d, 'capturas', 'vieja.png');
		writeFileSync(vieja, 'png con secreto');
		registrarEscaneo(d, {...escaneo(conSecreto()), archivo: 'capturas/vieja.png', paso: null}, vieja);
		expect(estadoRevision(d).estado).toBe('BLOQUEADA');
		rmSync(vieja);
		expect(estadoRevision(d).estado).toBe('LIMPIA');
		writeFileSync(join(d, 'capturas', 'explorar-20261003.png'), 'solo para que Claude mire');
		expect(estadoRevision(d).estado).toBe('LIMPIA');
		writeFileSync(join(d, 'capturas', 'nueva.png'), 'sin escanear');
		expect(estadoRevision(d)).toEqual({estado: 'BLOQUEADA', motivo: 'capturas/nueva.png sin escanear'});
		// Con algo sin escanear no se puede aprobar (código 2).
		let codigo = 0;
		try {
			aprobarRevision(d);
		} catch (e) {
			codigo = (e as FalloEditor).codigo;
		}
		expect(codigo).toBe(2);
		rmSync(d, {recursive: true, force: true});
	});

	it('cada archivo se registra aparte: una captura con secreto bloquea aunque la toma esté limpia', () => {
		const toma = join(dir, 'toma.mp4');
		writeFileSync(toma, 'toma limpia 2');
		registrarEscaneo(dir, escaneo([]), toma);
		const captura = join(dir, 'captura.png');
		writeFileSync(captura, 'png');
		const r = registrarEscaneo(dir, {...escaneo(conSecreto()), archivo: 'captura.png', paso: null}, captura);
		expect(r.estado).toBe('BLOQUEADA');
		expect(r.fuentes.map((f) => f.archivo).sort()).toEqual(['captura.png', 'toma.mp4']);
	});
});
