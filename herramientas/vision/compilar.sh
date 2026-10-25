#!/bin/bash
# Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
# SPDX-License-Identifier: MIT
# id: er-2f298797
# Compila las herramientas de Vision en Swift → herramientas/bin/<nombre>.
#
#   herramientas/vision/compilar.sh            # compila ocr (lo único que existe en la Fase 1)
#   herramientas/vision/compilar.sh ocr cara   # compila las que le pases (herramientas/vision/<nombre>.swift)
#
# Usa la caché de módulos en $TMPDIR (el sandbox solo deja escribir ahí y en el proyecto).
# herramientas/bin/ está en .gitignore: el binario se regenera con este script.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="${TMPDIR:-/tmp}/swift-cache"
mkdir -p "$RAIZ/herramientas/bin" "$CACHE"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "No pude compilar: no encuentro swiftc. Siguiente paso: instala las Command Line Tools (xcode-select --install, lo corres tú)." >&2
	exit 2
fi

nombres=("$@")
if [ ${#nombres[@]} -eq 0 ]; then
	nombres=(ocr)
fi

for nombre in "${nombres[@]}"; do
	fuente="$RAIZ/herramientas/vision/$nombre.swift"
	salida="$RAIZ/herramientas/bin/$nombre"
	if [ ! -f "$fuente" ]; then
		echo "No pude compilar $nombre: no existe herramientas/vision/$nombre.swift. Siguiente paso: revisa el nombre." >&2
		exit 2
	fi
	inicio=$(date +%s)
	if ! swiftc -O -parse-as-library -module-cache-path "$CACHE" "$fuente" -o "$salida"; then
		echo "No pude compilar $nombre: swiftc terminó con error (arriba está el detalle). Siguiente paso: revisa herramientas/vision/$nombre.swift." >&2
		exit 1
	fi
	fin=$(date +%s)
	echo "Listo: herramientas/bin/$nombre ($(( fin - inicio )) s, $(swiftc --version 2>&1 | head -1 | sed -E 's/.*(Swift version [0-9.]+).*/\1/'))"
done
