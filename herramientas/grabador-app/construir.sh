#!/bin/sh
# Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
# SPDX-License-Identifier: MIT
# id: er-2f298797
# Arma herramientas/bin/GrabadorVentana.app (Swift + ScreenCaptureKit) y la firma ad-hoc con codesign.
#
#   sh herramientas/grabador-app/construir.sh            # compila solo si algo cambió
#   sh herramientas/grabador-app/construir.sh --forzar   # compila aunque esté al día
#
# Por qué una app y no un binario suelto: macOS guarda el permiso de Grabación de pantalla (TCC) para la app que
# lo pide. Abierta con `open -a`, la responsable es GrabadorVentana y no la terminal de Claude.
#
# Ojo: la firma ad-hoc cambia con cada binario nuevo, y macOS ata el permiso a la firma. Después de recompilar,
# macOS vuelve a pedir el permiso. Por eso este script NO recompila si las fuentes, el Info.plist, el script y la
# versión de swiftc no cambiaron (huella en Contents/Resources/huella.txt).
#
# Corre dentro del sandbox (swiftc y codesign solo escriben en el proyecto y en $TMPDIR).
# herramientas/bin/ está en .gitignore: la app se regenera con este script.
set -eu

RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
DIR="$RAIZ/herramientas/grabador-app"
FUENTES="$DIR/Sources/GrabadorVentana"
PLIST="$DIR/Info.plist"
APP="$RAIZ/herramientas/bin/GrabadorVentana.app"
CACHE="${TMPDIR:-/tmp}/swift-cache"
TEMPORAL="${TMPDIR:-/tmp}/cev-grabador-app-$$"
ID=local.claude-editor.grabador-ventana

fallo() {
	echo "No pude armar GrabadorVentana: $1. Siguiente paso: $2." >&2
	rm -rf "$TEMPORAL"
	exit "${3:-1}"
}

command -v swiftc >/dev/null 2>&1 || fallo "no encuentro swiftc" "instala las Command Line Tools (xcode-select --install, lo corres tú)" 2
command -v codesign >/dev/null 2>&1 || fallo "no encuentro codesign" "instala las Command Line Tools (xcode-select --install, lo corres tú)" 2

VERSION_SWIFT=$(swiftc --version 2>&1 | head -1)
HUELLA=$({
	cat "$FUENTES"/*.swift "$PLIST" "$DIR/construir.sh"
	echo "$VERSION_SWIFT"
} | shasum -a 256 | cut -d' ' -f1)

if [ "${1:-}" != "--forzar" ] && [ -f "$APP/Contents/Resources/huella.txt" ] &&
	[ "$(cat "$APP/Contents/Resources/huella.txt")" = "$HUELLA" ] && codesign --verify --strict "$APP" 2>/dev/null; then
	echo "GrabadorVentana ya está al día (huella ${HUELLA%"${HUELLA#????????????}"}…): no la recompilo para no perder el permiso de Grabación de pantalla."
	exit 0
fi

mkdir -p "$CACHE" "$RAIZ/herramientas/bin" "$TEMPORAL/GrabadorVentana.app/Contents/MacOS" "$TEMPORAL/GrabadorVentana.app/Contents/Resources"
inicio=$(date +%s)
swiftc -O -swift-version 5 -module-cache-path "$CACHE" -target arm64-apple-macos15.0 -module-name GrabadorVentana \
	"$FUENTES"/*.swift -o "$TEMPORAL/GrabadorVentana.app/Contents/MacOS/GrabadorVentana" ||
	fallo "swiftc terminó con error (arriba está el detalle)" "revisa herramientas/grabador-app/Sources" 1
cp "$PLIST" "$TEMPORAL/GrabadorVentana.app/Contents/Info.plist"
plutil -lint "$TEMPORAL/GrabadorVentana.app/Contents/Info.plist" >/dev/null || fallo "el Info.plist no es válido" "revisa herramientas/grabador-app/Info.plist" 1
printf '%s\n' "$HUELLA" >"$TEMPORAL/GrabadorVentana.app/Contents/Resources/huella.txt"

# Firma ad-hoc ("-"): no usa llavero ni certificados.
codesign --force --sign - --identifier "$ID" --timestamp=none "$TEMPORAL/GrabadorVentana.app" ||
	fallo "codesign no pudo firmar la app" "revisa el detalle de arriba" 1
codesign --verify --strict "$TEMPORAL/GrabadorVentana.app" || fallo "la firma no se verificó" "vuelve a correr con --forzar" 1

# Antes de instalarla: sus pruebas internas (no necesitan permisos).
if ! "$TEMPORAL/GrabadorVentana.app/Contents/MacOS/GrabadorVentana" --autoprueba >"$TEMPORAL/autoprueba.txt" 2>&1; then
	cat "$TEMPORAL/autoprueba.txt" >&2
	fallo "la autoprueba falló" "revisa las pruebas marcadas con ✘ arriba" 1
fi
resumen=$(tail -1 "$TEMPORAL/autoprueba.txt")

rm -rf "$APP"
mv "$TEMPORAL/GrabadorVentana.app" "$APP"
rm -rf "$TEMPORAL"
fin=$(date +%s)
echo "Listo: herramientas/bin/GrabadorVentana.app ($((fin - inicio)) s, $VERSION_SWIFT)"
echo "  Firma ad-hoc, identificador $ID. $resumen"
echo "  Primera grabación: macOS te pedirá el permiso de Grabación de pantalla para GrabadorVentana."
