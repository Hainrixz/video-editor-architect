/**
 * Regla única para el nombre de la carpeta de un proyecto (proyectos/<slug>/).
 * Formato recomendado: AAAA-MM-DD-tema. Se permite "_" al inicio para proyectos de prueba.
 */
const PATRON_SLUG = /^[a-z0-9_][a-z0-9_-]{0,79}$/;
const SLUGS_RESERVADOS = new Set(['_logs']);

export function esSlugValido(slug: string): boolean {
	return PATRON_SLUG.test(slug) && !SLUGS_RESERVADOS.has(slug);
}

export const REGLA_SLUG = 'solo minúsculas, números, "_" y "-" (máximo 80; p. ej. 2026-10-03-tema)';
