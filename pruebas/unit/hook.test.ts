// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
// @ts-expect-error: módulo .mjs sin tipos
import {revisar} from '../../.claude/hooks/vigilar-bash.mjs';

const HOOK = fileURLToPath(new URL('../../.claude/hooks/vigilar-bash.mjs', import.meta.url));

function correrHook(command: string, tool_name = 'Bash') {
	const r = spawnSync('node', [HOOK], {input: JSON.stringify({tool_name, tool_input: {command}}), encoding: 'utf8'});
	return {codigo: r.status, salida: r.stdout.trim()};
}

describe('hook vigilar-bash: lista blanca de playwright-cli', () => {
	const permitidos = [
		'npx playwright-cli -s=explorar open https://example.com',
		'npx playwright-cli -s=explorar goto https://example.com',
		'npx playwright-cli -s=explorar snapshot',
		'npx playwright-cli -s=explorar click e12',
		'npx playwright-cli -s=explorar type "hola mundo"',
		'npx playwright-cli -s=explorar press Enter',
		'npx playwright-cli -s=explorar screenshot --filename=out/x.png',
		'npx playwright-cli -s=explorar close',
		'npx playwright-cli -s=explorar list --json',
		'PLAYWRIGHT_MCP_PROXY_SERVER=http://localhost:1234 npx playwright-cli -s=x open https://example.com',
		'ls -la && echo listo',
		'ffmpeg -i a.mov b.mp4',
		// Solo texto: no ejecuta playwright-cli
		"printf '\\n# Snapshots de playwright-cli\\n.playwright-cli/\\n' >> .gitignore",
		'grep -n "playwright-cli" CLAUDE.md',
		'git commit -m "doc: playwright-cli en lista blanca"',
		"cat > notas.md <<'EOF'\nUsa `npx playwright-cli cookie-list` nunca\n$(npx playwright-cli state-save x)\nEOF",
	];
	for (const c of permitidos) {
		it(`permite: ${c}`, () => expect(revisar(c)).toBeNull());
	}

	const bloqueados = [
		'npx playwright-cli -s=x cookie-list',
		'npx playwright-cli cookie-get session',
		'npx playwright-cli state-save s.json',
		'npx playwright-cli localstorage-list',
		'npx playwright-cli -s=x eval "document.cookie"',
		'npx playwright-cli run-code "x"',
		'npx playwright-cli -s=x open --profile ~/perfil https://a.com',
		'npx playwright-cli -s=x open --persistent https://a.com',
		'npx playwright-cli -s=x open --config=cfg.json https://a.com',
		'npx playwright-cli attach --cdp=http://localhost:9222',
		'npx playwright-cli drop e3 --path=/etc/hosts',
		'npx playwright-cli console',
		'PLAYWRIGHT_MCP_USER_DATA_DIR=/x npx playwright-cli -s=x open https://a.com',
		'PLAYWRIGHT_CLI_CONFIG=/x npx playwright-cli open https://a.com',
		'sh -c "npx playwright-cli cookie-list"',
		'echo $(npx playwright-cli cookie-list)',
		'echo \'{"browser":{"userDataDir":"/x"}}\' > .playwright/cli.config.json',
		'mkdir -p .playwright && touch .playwright/cli.config.json',
		'npx playwright-cli --config=x open https://a.com',
		// Intérpretes o envoltorios que ejecutarían playwright-cli
		"bash <<'EOF'\nnpx playwright-cli cookie-list\nEOF",
		'python3 -c "import os; os.system(\'npx playwright-cli cookie-list\')"',
		'sudo npx playwright-cli cookie-list',
		'env PLAYWRIGHT_MCP_USER_DATA_DIR=/x npx playwright-cli open https://a.com',
		'xargs npx playwright-cli < lista.txt',
		'nohup npx playwright-cli state-save s.json',
	];
	for (const c of bloqueados) {
		it(`bloquea: ${c}`, () => expect(revisar(c)).not.toBeNull());
	}

	it('el proceso real devuelve deny en JSON para un comando prohibido', () => {
		const r = correrHook('npx playwright-cli cookie-list');
		expect(r.codigo).toBe(0);
		const json = JSON.parse(r.salida);
		expect(json.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(json.hookSpecificOutput.hookEventName).toBe('PreToolUse');
	});

	it('el proceso real no decide nada para un comando normal', () => {
		const r = correrHook('git status');
		expect(r.codigo).toBe(0);
		expect(r.salida).toBe('');
	});

	it('no decide nada si no es Bash o si el JSON está roto', () => {
		expect(correrHook('npx playwright-cli cookie-list', 'Read').salida).toBe('');
		const roto = spawnSync('node', [HOOK], {input: 'no es json', encoding: 'utf8'});
		expect(roto.status).toBe(0);
		expect(roto.stdout.trim()).toBe('');
	});
});
