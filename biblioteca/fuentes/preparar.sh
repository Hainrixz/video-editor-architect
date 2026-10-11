#!/bin/sh
# Fuentes candidatas para los subtítulos (todas OFL-1.1, de github.com/google/fonts).
#
#   sh biblioteca/fuentes/preparar.sh            (desde la raíz del proyecto)
#
# Qué hace, sin gastar nada:
# 1. Baja cada fuente variable de google/fonts FIJADA a un commit y revisa su sha256.
# 2. Baja su OFL.txt (también con sha256) a biblioteca/fuentes/<familia>/.
# 3. Saca instancias estáticas con fonttools del .venv:
#    varLib.instancer --static --remove-overlaps (sin contornos encimados, así el borde no deja rayas
#    dentro de las letras), --update-name-table (el nombre interno dice el peso real) y
#    --no-recalc-timestamp (el mismo archivo da el mismo sha256 cada vez).
# 4. Revisa el sha256 de cada instancia contra el que se midió (src/estilo/fuentes.ts y biblioteca/LICENCIAS.md).
#
# Los .ttf no se versionan (.gitignore); este script los vuelve a crear idénticos.
# Si un sha256 no coincide, el script se detiene sin dejar archivos a medias.
set -eu

RAIZ=$(cd "$(dirname "$0")/../.." && pwd)
DESTINO="$RAIZ/biblioteca/fuentes"
FONTTOOLS="$RAIZ/.venv/bin/fonttools"
COMMIT=9710da1eacb3be272583c3224dcb70f9da6eadbb
URL_BASE="https://raw.githubusercontent.com/google/fonts/$COMMIT/ofl"
TEMPORAL="${TMPDIR:-/tmp}/cev-fuentes-$$"

fallo() {
	echo "No pude preparar las fuentes: $1. Siguiente paso: $2." >&2
	rm -rf "$TEMPORAL"
	exit "${3:-1}"
}

if [ ! -x "$FONTTOOLS" ]; then
	fallo "no encontré fonttools en .venv/bin" "recrea el .venv del proyecto con uv (fonttools y skia-pathops)" 2
fi

sha() {
	if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

bajar() { # url destino sha256
	curl -sS --fail --max-time 180 -o "$2" "$1" || fallo "no se pudo bajar $1" "revisa tu conexión (el sandbox deja raw.githubusercontent.com)" 3
	real=$(sha "$2")
	[ "$real" = "$3" ] || fallo "$(basename "$2") llegó con sha256 $real y esperaba $3" "no la uses; avísame para revisar el commit de google/fonts" 3
}

instanciar() { # variable salida sha256 ejes...
	variable=$1
	salida=$2
	esperado=$3
	shift 3
	"$FONTTOOLS" varLib.instancer -q --static --remove-overlaps --no-recalc-timestamp --update-name-table \
		-o "$TEMPORAL/$(basename "$salida")" "$variable" "$@" ||
		fallo "fonttools no pudo instanciar $(basename "$salida")" "revisa que el .venv traiga skia-pathops" 1
	real=$(sha "$TEMPORAL/$(basename "$salida")")
	if [ "$real" != "$esperado" ]; then
		fallo "$(basename "$salida") salió con sha256 $real y esperaba $esperado" \
			"si cambiaste de versión de fonttools, vuelve a medir los anchos y actualiza src/estilo/fuentes.ts y biblioteca/LICENCIAS.md" 1
	fi
	mv "$TEMPORAL/$(basename "$salida")" "$salida"
	echo "  $(basename "$salida")  $real"
}

mkdir -p "$TEMPORAL"

# ── TikTok Sans (TikTok la llama "Classic"): opsz 36, wdth 100, slnt 0 = sus instancias con nombre ──
mkdir -p "$DESTINO/tiktok-sans"
bajar "$URL_BASE/tiktoksans/TikTokSans%5Bopsz%2Cslnt%2Cwdth%2Cwght%5D.ttf" "$TEMPORAL/tiktok.ttf" \
	0e7f0a3e924c9a86478fc6fc2946de2e4ab8fc704ed72ee40434ade94bb9b0c6
bajar "$URL_BASE/tiktoksans/OFL.txt" "$TEMPORAL/OFL-tiktok.txt" \
	99e743f68f5eac487004c73aaca69c5d80d91ddb7b75c04bdf5f39331d9b7158
echo "TikTok Sans:"
instanciar "$TEMPORAL/tiktok.ttf" "$DESTINO/tiktok-sans/TikTokSans-SemiBold.ttf" \
	d4f0326ad15b1b33e12de03906f92e1ac273b7be2855d05c80446771d687550f wght=600 opsz=36 wdth=100 slnt=0
instanciar "$TEMPORAL/tiktok.ttf" "$DESTINO/tiktok-sans/TikTokSans-ExtraBold.ttf" \
	d020e2219da84f2ea17262807472e38bafe675d6493615042a5ee775b465dab6 wght=800 opsz=36 wdth=100 slnt=0
mv "$TEMPORAL/OFL-tiktok.txt" "$DESTINO/tiktok-sans/OFL.txt"

# ── Instrument Sans: wdth 100 ──
mkdir -p "$DESTINO/instrument-sans"
bajar "$URL_BASE/instrumentsans/InstrumentSans%5Bwdth%2Cwght%5D.ttf" "$TEMPORAL/instrument.ttf" \
	b24f1812584816958afcf22e22d08e44318c5e51651e25d2438efdde389b33b1
bajar "$URL_BASE/instrumentsans/OFL.txt" "$TEMPORAL/OFL-instrument.txt" \
	9e27a72ed30eb49a08678f6a5d6ed98ec7ba5368f541637ee0683ec9134ef966
echo "Instrument Sans:"
instanciar "$TEMPORAL/instrument.ttf" "$DESTINO/instrument-sans/InstrumentSans-SemiBold.ttf" \
	a63d55f34a30bac7377b13f3d66d1b1fae0c72f7ae5b364653a029a4e9f8da69 wght=600 wdth=100
instanciar "$TEMPORAL/instrument.ttf" "$DESTINO/instrument-sans/InstrumentSans-Bold.ttf" \
	b4c8e52409c0a58a238a4e7b558f3354c8e6550b8facbe9e5f3d07af7e269124 wght=700 wdth=100
mv "$TEMPORAL/OFL-instrument.txt" "$DESTINO/instrument-sans/OFL.txt"

# ── Inter: opsz 14 = sus instancias con nombre ("Inter Display" sería opsz 32) ──
mkdir -p "$DESTINO/inter"
bajar "$URL_BASE/inter/Inter%5Bopsz%2Cwght%5D.ttf" "$TEMPORAL/inter.ttf" \
	29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031
bajar "$URL_BASE/inter/OFL.txt" "$TEMPORAL/OFL-inter.txt" \
	5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57
echo "Inter:"
instanciar "$TEMPORAL/inter.ttf" "$DESTINO/inter/Inter-SemiBold.ttf" \
	4e2353ba2b6a3514acdfe5d2409ad59468bb4d0b8ee01aabf03120ecf2dae95a wght=600 opsz=14
instanciar "$TEMPORAL/inter.ttf" "$DESTINO/inter/Inter-Bold.ttf" \
	d289ec2c941d44e340fdc16adae7e82dbb3674c3ce6ed7d7c0d5d0558f5aa73e wght=700 opsz=14
instanciar "$TEMPORAL/inter.ttf" "$DESTINO/inter/Inter-ExtraBold.ttf" \
	0a63d47e990a5107e1fa64c5c904458fdebf11c86f3a56f9c0e07a42bd8f13e7 wght=800 opsz=14
mv "$TEMPORAL/OFL-inter.txt" "$DESTINO/inter/OFL.txt"

rm -rf "$TEMPORAL"
echo "Listo: 6 instancias y 3 OFL.txt en biblioteca/fuentes/ (commit $COMMIT de google/fonts)."
