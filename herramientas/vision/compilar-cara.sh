#!/bin/bash
# Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
# SPDX-License-Identifier: MIT
# id: er-2f298797
# Compila el detector de cara y barbilla (herramientas/vision/cara.swift) → herramientas/bin/cara.
#
#   herramientas/vision/compilar-cara.sh
#
# Usa la caché de módulos en $TMPDIR (el sandbox solo deja escribir ahí y en el proyecto).
# herramientas/bin/ está en .gitignore: el binario se regenera con este script.
# (El OCR tiene su propio script, herramientas/vision/compilar.sh.)
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="${TMPDIR:-/tmp}/swift-cache"
FUENTE="$RAIZ/herramientas/vision/cara.swift"
SALIDA="$RAIZ/herramientas/bin/cara"
mkdir -p "$RAIZ/herramientas/bin" "$CACHE"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "No pude compilar cara: no encuentro swiftc. Siguiente paso: instala las Command Line Tools (xcode-select --install, lo corres tú)." >&2
	exit 2
fi
if [ ! -f "$FUENTE" ]; then
	echo "No pude compilar cara: no existe herramientas/vision/cara.swift. Siguiente paso: revisa que el archivo esté en su lugar." >&2
	exit 2
fi

inicio=$(date +%s)
# Se compila a un temporal y se mueve al final: si swiftc falla, el binario anterior sigue sirviendo.
if ! swiftc -O -parse-as-library -module-cache-path "$CACHE" "$FUENTE" -o "$SALIDA.tmp"; then
	rm -f "$SALIDA.tmp"
	echo "No pude compilar cara: swiftc terminó con error (arriba está el detalle). Siguiente paso: revisa herramientas/vision/cara.swift." >&2
	exit 1
fi
mv -f "$SALIDA.tmp" "$SALIDA"
fin=$(date +%s)
echo "Listo: herramientas/bin/cara ($(( fin - inicio )) s, $(swiftc --version 2>&1 | head -1 | sed -E 's/.*(Swift version [0-9.]+).*/\1/'))"
