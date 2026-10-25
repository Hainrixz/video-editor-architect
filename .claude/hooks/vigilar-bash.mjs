#!/usr/bin/env node
// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Hook PreToolUse (matcher Bash) del editor de video / PreToolUse hook for Bash.
 * Only watches playwright-cli (allow-list of verbs and options) so nothing can read cookies or sessions.
 * Recibe por stdin el JSON de la llamada: { tool_name, tool_input: { command }, ... }.
 *
 * Solo vigila `playwright-cli` (lista blanca de verbos y opciones), para que nadie pueda
 * leer cookies o sesiones, abrir el perfil con sesión, ni cargar configs o variables que lo vuelvan persistente.
 * - Si playwright-cli es el comando que se ejecuta: aplica la lista blanca.
 * - Si lo ejecutaría un intérprete o un subshell (bash -c, python -c, eval, $(…), sudo, xargs…): se bloquea.
 * - Si solo aparece como texto (echo, printf, grep, git, un heredoc que va a un archivo): no decide nada.
 * Si el comando no usa playwright-cli, no decide nada (exit 0 sin salida) y sigue el flujo normal de permisos.
 * Es un filtro de texto: la barrera real es el sandbox (ver .claude/settings.json). En Windows no hay sandbox:
 * ahí este hook es la única barrera para playwright-cli.
 */
import {readFileSync} from 'node:fs';

const VERBOS_PERMITIDOS = new Set(['open', 'goto', 'snapshot', 'click', 'type', 'press', 'screenshot', 'close', 'list']);
const OPCIONES_PROHIBIDAS = /^--?(profile|persistent|config|user-data-dir|extension|cdp|cdp-endpoint|storage-state|isolated)(=|$)/i;
const VARIABLES_PROHIBIDAS = /^PLAYWRIGHT_(MCP|CLI)_[A-Z0-9_]*=/;
const VARIABLE_PERMITIDA = /^PLAYWRIGHT_MCP_PROXY_SERVER=/;
/** Programas que pueden ejecutar texto como comandos: si reciben "playwright-cli", se bloquea por precaución. */
const INTERPRETES = new Set([
	'sh', 'bash', 'zsh', 'fish', 'dash', 'eval', 'exec', 'xargs', 'sudo', 'env', 'nohup', 'time', 'command', 'nice',
	'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'osascript', 'script', 'watch', 'parallel', 'tsx', 'npx',
]);

function negar(motivo) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'deny',
				permissionDecisionReason: `Bloqueado por el hook del editor: ${motivo}.`,
			},
		}),
	);
	process.exit(0);
}

/** Tokenizador sencillo estilo shell (comillas simples y dobles, escapes). */
export function tokenizar(segmento) {
	const tokens = [];
	let actual = '';
	let comilla = null;
	let hay = false;
	for (let i = 0; i < segmento.length; i++) {
		const c = segmento[i];
		if (comilla) {
			if (c === comilla) comilla = null;
			else if (c === '\\' && comilla === '"' && i + 1 < segmento.length) actual += segmento[++i];
			else actual += c;
			continue;
		}
		if (c === "'" || c === '"') {
			comilla = c;
			hay = true;
			continue;
		}
		if (c === '\\' && i + 1 < segmento.length) {
			actual += segmento[++i];
			hay = true;
			continue;
		}
		if (/\s/.test(c)) {
			if (hay || actual) tokens.push(actual);
			actual = '';
			hay = false;
			continue;
		}
		actual += c;
		hay = true;
	}
	if (hay || actual) tokens.push(actual);
	return tokens;
}

/** Divide en segmentos por ;, &&, ||, | y saltos de línea, respetando comillas. */
export function dividirSegmentos(comando) {
	const segmentos = [];
	let actual = '';
	let comilla = null;
	for (let i = 0; i < comando.length; i++) {
		const c = comando[i];
		if (comilla) {
			if (c === '\\' && comilla === '"' && i + 1 < comando.length) {
				actual += c + comando[++i];
				continue;
			}
			if (c === comilla) comilla = null;
			actual += c;
			continue;
		}
		if (c === "'" || c === '"') {
			comilla = c;
			actual += c;
			continue;
		}
		if (c === ';' || c === '\n' || c === '|' || (c === '&' && comando[i + 1] === '&')) {
			segmentos.push(actual);
			actual = '';
			if ((c === '|' || c === '&') && comando[i + 1] === c) i++;
			continue;
		}
		actual += c;
	}
	segmentos.push(actual);
	return segmentos;
}

/**
 * Quita el cuerpo de los heredocs cuyo destino NO es un intérprete (p. ej. `cat > archivo <<'EOF'`):
 * ese texto se escribe, no se ejecuta. Si el heredoc alimenta a bash/python/node…, se conserva para revisarlo.
 */
export function quitarHeredocsInofensivos(comando) {
	const lineas = comando.split('\n');
	const salida = [];
	for (let i = 0; i < lineas.length; i++) {
		const linea = lineas[i];
		salida.push(linea);
		const m = linea.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		if (!m) continue;
		const fin = m[2];
		const antes = linea.slice(0, m.index);
		const primera = tokenizar(antes.split(/&&|\|\||;|\|/).pop() ?? '').find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) ?? '';
		const destino = primera.split('/').pop() ?? '';
		const esInterprete = INTERPRETES.has(destino) || /\|\s*(sh|bash|zsh|python3?|node)\b/.test(linea);
		let j = i + 1;
		while (j < lineas.length && lineas[j].replace(/^\t+/, '') !== fin) j++;
		if (!esInterprete) {
			salida.push(fin); // el cuerpo se descarta, el cierre se conserva
			i = j;
		}
	}
	return salida.join('\n');
}

/** Revisa un comando completo. Devuelve el motivo de bloqueo o null si se permite. */
export function revisar(comandoOriginal) {
	if (typeof comandoOriginal !== 'string') return null;
	const comando = quitarHeredocsInofensivos(comandoOriginal);
	const escribePlaywright = /(>|>>|\btee\b|\bcp\b|\bmv\b|\bln\b|\bmkdir\b|\btouch\b)[^;&|\n]*\.playwright(\/|\s|$)/;
	if (escribePlaywright.test(comando)) return 'no se escribe en .playwright/ (su config podría volver persistente la sesión)';
	if (!/playwright-cli/.test(comando)) return null;

	// Sustitución de comandos con playwright-cli adentro: no se puede revisar con seguridad.
	const subshells = [...comando.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '');
	if (subshells.some((s) => /playwright-cli/.test(s))) {
		return 'playwright-cli dentro de $(…) o `…` no se permite; córrelo directo con npx playwright-cli';
	}

	const segmentos = dividirSegmentos(comando);
	for (const segmento of segmentos) {
		if (!/playwright-cli/.test(segmento)) continue;
		const tokens = tokenizar(segmento.trim());
		let k = 0;
		while (k < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k])) {
			if (VARIABLES_PROHIBIDAS.test(tokens[k]) && !VARIABLE_PERMITIDA.test(tokens[k])) {
				return `la variable ${tokens[k].split('=')[0]} no se permite con playwright-cli`;
			}
			k++;
		}
		let cmd = tokens[k] ?? '';
		let idx = k;
		const base = (t) => t.split('/').pop() ?? '';
		if (base(cmd) === 'npx') {
			idx = k + 1;
			while (idx < tokens.length && /^(-y|--yes|--no-install|-q|--quiet)$/.test(tokens[idx])) idx++;
			cmd = tokens[idx] ?? '';
		}
		if (base(cmd) !== 'playwright-cli') {
			// playwright-cli aparece como argumento de otro programa.
			if (INTERPRETES.has(base(tokens[k] ?? ''))) {
				return `playwright-cli pasado a "${base(tokens[k])}" no se permite; córrelo directo con npx playwright-cli`;
			}
			continue; // solo es texto (echo, printf, grep, git…)
		}

		let i = idx + 1;
		while (i < tokens.length && tokens[i].startsWith('-')) {
			const t = tokens[i];
			if (/^(-s|--session)=.+/.test(t)) {
				i++;
				continue;
			}
			if (/^(-s|--session)$/.test(t)) {
				i += 2;
				continue;
			}
			return `la opción ${t.split('=')[0]} no se permite con playwright-cli`;
		}
		const verbo = tokens[i];
		if (!verbo) return 'falta el verbo de playwright-cli';
		if (!VERBOS_PERMITIDOS.has(verbo)) {
			return `el verbo "${verbo}" no está en la lista blanca (${[...VERBOS_PERMITIDOS].join(', ')})`;
		}
		for (const t of tokens.slice(i + 1)) {
			if (OPCIONES_PROHIBIDAS.test(t)) return `la opción ${t.split('=')[0]} no se permite (perfil, config o sesión persistente)`;
			if (/^--?(path|file)=?/i.test(t) && verbo !== 'screenshot') return `la opción ${t.split('=')[0]} solo se permite en screenshot`;
		}
	}
	return null;
}

function principal() {
	let entrada;
	try {
		entrada = JSON.parse(readFileSync(0, 'utf8'));
	} catch {
		process.exit(0);
	}
	if (entrada?.tool_name !== 'Bash') process.exit(0);
	const motivo = revisar(entrada?.tool_input?.command);
	if (motivo) negar(motivo);
	process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
	principal();
}
