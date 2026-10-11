// Caras y barbilla de cuadros crudos con Apple Vision (VNDetectFaceLandmarksRequest, revisión 3,
// constelación de 76 puntos).
//
// Uso (los cuadros llegan por stdin desde ffmpeg, sin archivos intermedios):
//   ffmpeg -v error -i base.mp4 -vf "select='not(mod(n,3))',scale=720:1280" -fps_mode passthrough \
//     -f rawvideo -pix_fmt rgba - | herramientas/bin/cara --ancho 720 --alto 1280 --fps 10
//
// Entrada: cuadros RGBA de ancho×alto×4 bytes, uno tras otro, hasta EOF.
// Salida: una línea JSON por cuadro, en el mismo orden en que llegaron:
//   {"i":0,"t":0.000000,"caras":[{"x":0.31,"y":0.22,"w":0.38,"h":0.21,"confianza":0.99,"confianza_puntos":0.83,
//     "roll":0.01,"yaw":0,"pitch":-0.1,"barbilla":{"x":0.5,"y":0.44},"boca":{"x":0.5,"y":0.39},
//     "contorno":[[x,y],…],"ojo_izq":[[x,y],…],"ojo_der":[[x,y],…],"nariz":[[x,y],…]}]}
//   - i: número de cuadro en la entrada (0, 1, 2…); t = --t0 + i / --fps.
//   - Todo va normalizado (0–1) al cuadro completo, con origen ARRIBA-izquierda (Vision usa abajo-izquierda;
//     aquí se voltea).
//   - x, y, w, h: la caja de la cara que da Vision. confianza: la de la detección; confianza_puntos: la de los
//     puntos (landmarks), null si no hay.
//   - barbilla: el punto más bajo (y mayor) del contorno de la cara; null si Vision no dio contorno.
//   - boca: el punto más bajo (y mayor) de los labios por fuera (outerLips): la orilla de abajo del labio de abajo;
//     null si Vision no dio los labios. Es la zona protegida: ninguna capa la tapa (herramientas/lib/cara.ts →
//     bocaMax; regla R1 de herramientas/validar.ts).
//   - contorno = faceContour (la quijada de oreja a oreja), ojo_izq / ojo_der = leftEye / rightEye y nariz = nose,
//     con los nombres de Vision (no se reinterpreta de qué lado de la imagen queda cada ojo).
//   - roll, yaw, pitch: en radianes, como los da Vision (null si no los da).
//   - bordes_barbilla: hasta 5 bordes oscuro→claro [[y, fuerza], …] bajando desde la barbilla del contorno (de
//     −0.03 a +0.25 × la distancia ojos–barbilla), en una franja de ±10 % del ancho de la cara: la orilla de abajo
//     de la barba (el contorno de Vision sigue la quijada y puede quedar arriba de ella). fuerza = subida de
//     luminancia (0–255) en 4 filas; se guardan los máximos locales con fuerza ≥ 6, de arriba abajo. Quién decide
//     cuál usar es herramientas/lib/cara.ts.
//   - Con --silueta, cada cara trae además "silueta":{"tope":y,"izq":x,"der":x} (o null), medida en la máscara de
//     persona de Vision (VNGeneratePersonSegmentationRequest, calidad balanced):
//       tope: el pixel de persona más alto, subiendo sin cortes desde la línea de los ojos por la franja central
//             de la cara (30–70 % del ancho de la caja): el tope de la cabeza con pelo.
//       izq / der: orillas de la persona a los lados de la cara (mediana de las filas entre los ojos y la punta de
//             la nariz, avanzando sin cortes desde el centro): orejas y pelo incluidos.
//     herramientas/lib/cara.ts la usa como coronilla y lados MEDIDOS (si son creíbles) y para medir, en cada video,
//     el factor de las fórmulas de respaldo. Ojo: una caja sólida pegada a la cabeza (no un titular de texto con
//     sombra) puede quedar dentro de la silueta y subir el tope.
//
// Opciones:
//   --ancho N --alto N --fps F     tamaño de cada cuadro y fps de la entrada (obligatorios)
//   --t0 S                         segundo del primer cuadro (por defecto 0)
//   --hilos N                      cuadros en vuelo a la vez (por defecto 4); la salida sigue en orden
//   --puntos 65|76                 constelación de puntos (por defecto 76: más puntos en la quijada)
//   --silueta                      mide también la silueta de la persona (tope y lados de la cabeza)
//   --cpu                          fuerza CPU en todas las etapas (en vez del Neural Engine)
//   --diagnostico                  imprime revisiones y dispositivos disponibles y sale
//
// Vision no carga sus modelos dentro del sandbox de macOS: esto se corre desde un comando excluido
// (npx tsx herramientas/cara.ts … o npx tsx pruebas/integracion/…).
// Códigos de salida: 0 bien · 1 fallo interno (Vision no pudo) · 2 argumentos o entrada inválidos.

import CoreGraphics
import CoreML
import CoreVideo
import Foundation
import Vision

// MARK: - Errores en español (mismo formato que herramientas/lib/fallo.ts)

func salirConFallo(_ que: String, _ porque: String, _ siguiente: String, _ codigo: Int32) -> Never {
	fflush(stdout)
	FileHandle.standardError.write("No pude \(que): \(porque). Siguiente paso: \(siguiente).\n".data(using: .utf8)!)
	exit(codigo)
}

// MARK: - Opciones

struct Opciones {
	var ancho = 0
	var alto = 0
	var fps = 0.0
	var t0 = 0.0
	var hilos = 4
	var puntos = 76
	var silueta = false
	var cpu = false
	var diagnostico = false
}

func leerOpciones() -> Opciones {
	var o = Opciones()
	var args = Array(CommandLine.arguments.dropFirst())
	func valor(_ nombre: String) -> String {
		guard !args.isEmpty else {
			salirConFallo("leer los argumentos", "a \(nombre) le falta su valor", "revisa el comando (ej. --ancho 720)", 2)
		}
		return args.removeFirst()
	}
	func numero(_ nombre: String, _ texto: String) -> Double {
		guard let n = Double(texto), n.isFinite else {
			salirConFallo("leer los argumentos", "\(nombre) no es un número (\(texto))", "revisa el comando", 2)
		}
		return n
	}
	while !args.isEmpty {
		let a = args.removeFirst()
		switch a {
		case "--ancho": o.ancho = Int(numero(a, valor(a)))
		case "--alto": o.alto = Int(numero(a, valor(a)))
		case "--fps": o.fps = numero(a, valor(a))
		case "--t0": o.t0 = numero(a, valor(a))
		case "--hilos": o.hilos = max(1, Int(numero(a, valor(a))))
		case "--puntos": o.puntos = Int(numero(a, valor(a)))
		case "--silueta": o.silueta = true
		case "--cpu": o.cpu = true
		case "--diagnostico": o.diagnostico = true
		case "--ayuda", "-h", "--help":
			print("Uso: ffmpeg … -f rawvideo -pix_fmt rgba - | cara --ancho N --alto N --fps F [--t0 S] [--hilos N] [--puntos 65|76] [--silueta] [--cpu]")
			exit(0)
		default:
			salirConFallo("leer los argumentos", "no conozco la opción \(a)", "usa --ayuda para ver las opciones", 2)
		}
	}
	if o.diagnostico { return o }
	if o.ancho <= 0 || o.alto <= 0 {
		salirConFallo("leer los argumentos", "faltan --ancho y --alto (en píxeles, mayores que 0)", "pásalos igual que en el -vf de ffmpeg", 2)
	}
	if !(o.fps > 0) {
		salirConFallo("leer los argumentos", "falta --fps (mayor que 0)", "pasa los fps con los que ffmpeg entrega los cuadros", 2)
	}
	if o.puntos != 65 && o.puntos != 76 {
		salirConFallo("leer los argumentos", "--puntos debe ser 65 o 76 (llegó \(o.puntos))", "usa --puntos 76", 2)
	}
	return o
}

// MARK: - Solicitud de Vision (una por cuadro: VNRequest guarda sus resultados y no se comparte entre hilos)

func armarSolicitud(_ o: Opciones) -> VNDetectFaceLandmarksRequest {
	let s = VNDetectFaceLandmarksRequest()
	s.revision = VNDetectFaceLandmarksRequestRevision3
	s.constellation = o.puntos == 76 ? .constellation76Points : .constellation65Points
	if o.cpu, let etapas = try? s.supportedComputeStageDevices {
		for (etapa, dispositivos) in etapas {
			for d in dispositivos {
				if case .cpu = d { s.setComputeDevice(d, for: etapa) }
			}
		}
	}
	return s
}

// MARK: - JSON (a mano: rápido y con el orden de claves fijo)

func num(_ v: Double, _ decimales: Int = 5) -> String {
	guard v.isFinite else { return "null" }
	let texto = String(format: "%.\(decimales)f", v)
	return texto == "-0.\(String(repeating: "0", count: decimales))" ? String(texto.dropFirst()) : texto
}

func numOpcional(_ v: NSNumber?, _ decimales: Int = 4) -> String {
	guard let v else { return "null" }
	return num(v.doubleValue, decimales)
}

/// Puntos de una región en coordenadas de la imagen (origen abajo-izquierda) → normalizados con origen arriba.
func puntosArriba(_ region: VNFaceLandmarkRegion2D?, _ tam: CGSize) -> [CGPoint] {
	guard let region, region.pointCount > 0 else { return [] }
	return region.pointsInImage(imageSize: tam).map { p in
		CGPoint(x: Double(p.x) / Double(tam.width), y: 1.0 - Double(p.y) / Double(tam.height))
	}
}

func jsonPuntos(_ puntos: [CGPoint]) -> String {
	"[" + puntos.map { "[\(num(Double($0.x), 4)),\(num(Double($0.y), 4))]" }.joined(separator: ",") + "]"
}

// MARK: - Silueta (máscara de persona de Vision)

/// Copia de la máscara (un byte por pixel): la de Vision se libera al terminar la solicitud.
struct Mascara {
	let ancho: Int
	let alto: Int
	let filaBytes: Int
	let datos: [UInt8]
	func persona(_ x: Int, _ y: Int) -> Bool { datos[y * filaBytes + x] >= 128 }
}

func copiarMascara(_ pb: CVPixelBuffer) -> Mascara? {
	guard CVPixelBufferGetPixelFormatType(pb) == kCVPixelFormatType_OneComponent8 else { return nil }
	CVPixelBufferLockBaseAddress(pb, .readOnly)
	defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
	guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
	let ancho = CVPixelBufferGetWidth(pb)
	let alto = CVPixelBufferGetHeight(pb)
	let fila = CVPixelBufferGetBytesPerRow(pb)
	guard ancho > 2, alto > 2 else { return nil }
	let datos = [UInt8](UnsafeBufferPointer(start: base.assumingMemoryBound(to: UInt8.self), count: fila * alto))
	return Mascara(ancho: ancho, alto: alto, filaBytes: fila, datos: datos)
}

/// Tope y lados de la cabeza en la máscara (ver el encabezado). Todo normalizado, origen arriba-izquierda.
func jsonSilueta(_ m: Mascara, caja: CGRect, ojosY: Double?, narizY: Double?, centroX: Double) -> String {
	let mx = { (x: Double) -> Int in min(m.ancho - 1, max(0, Int((x * Double(m.ancho)).rounded(.down)))) }
	let my = { (y: Double) -> Int in min(m.alto - 1, max(0, Int((y * Double(m.alto)).rounded(.down)))) }
	let filaOjos = my(ojosY ?? (Double(caja.minY) + 0.35 * Double(caja.height)))

	// Tope: franja central de la cara (30–70 % del ancho de la caja), subiendo desde los ojos sin cortes.
	var tope: Int? = nil
	let c0 = mx(Double(caja.minX) + 0.3 * Double(caja.width))
	let c1 = mx(Double(caja.minX) + 0.7 * Double(caja.width))
	if c1 >= c0 {
		for c in c0...c1 where m.persona(c, filaOjos) {
			var f = filaOjos
			while f > 0 && m.persona(c, f - 1) { f -= 1 }
			tope = min(tope ?? f, f)
		}
	}

	// Lados: mediana de las filas entre los ojos y la punta de la nariz, desde el centro hacia afuera sin cortes.
	let filaNariz = max(filaOjos, my(narizY ?? (Double(caja.minY) + 0.6 * Double(caja.height))))
	let centro = mx(centroX)
	var izquierdas: [Int] = []
	var derechas: [Int] = []
	for f in filaOjos...filaNariz where m.persona(centro, f) {
		var a = centro
		while a > 0 && m.persona(a - 1, f) { a -= 1 }
		var b = centro
		while b < m.ancho - 1 && m.persona(b + 1, f) { b += 1 }
		izquierdas.append(a)
		derechas.append(b + 1)
	}
	if tope == nil && izquierdas.isEmpty { return "null" }
	func medianaInt(_ v: [Int]) -> Int { v.sorted()[v.count / 2] }
	let topeTexto = tope.map { num(Double($0) / Double(m.alto)) } ?? "null"
	let izqTexto = izquierdas.isEmpty ? "null" : num(Double(medianaInt(izquierdas)) / Double(m.ancho))
	let derTexto = derechas.isEmpty ? "null" : num(Double(medianaInt(derechas)) / Double(m.ancho))
	return "{\"tope\":\(topeTexto),\"izq\":\(izqTexto),\"der\":\(derTexto)}"
}

// MARK: - Borde de abajo de la barba (luminancia del cuadro)

/// Cuadro RGBA crudo, para leer luminancias.
struct Pixeles {
	let datos: Data
	let ancho: Int
	let alto: Int
}

/// Bordes oscuro→claro bajando desde la barbilla del contorno (ver el encabezado). Coordenadas normalizadas.
func bordesBarbilla(_ p: Pixeles, barbilla: CGPoint, ojosY: Double, anchoCara: Double) -> [(y: Double, fuerza: Double)] {
	let cx = Double(barbilla.x) * Double(p.ancho)
	let cy = Double(barbilla.y) * Double(p.alto)
	let f = (Double(barbilla.y) - ojosY) * Double(p.alto)
	guard f > 8 else { return [] }
	let x0 = max(0, Int((cx - 0.1 * anchoCara * Double(p.ancho)).rounded()))
	let x1 = min(p.ancho - 1, Int((cx + 0.1 * anchoCara * Double(p.ancho)).rounded()))
	let y0 = max(0, Int((cy - 0.03 * f).rounded()) - 1)
	let y1 = min(p.alto - 1, Int((cy + 0.25 * f).rounded()) + 1)
	guard x1 > x0, y1 - y0 >= 8 else { return [] }
	// Luminancia media de cada fila de la franja, suavizada con 3 filas.
	var cruda = [Double](repeating: 0, count: y1 - y0 + 1)
	p.datos.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
		for y in y0...y1 {
			var suma = 0.0
			for x in x0...x1 {
				let i = (y * p.ancho + x) * 4
				suma += 0.299 * Double(b[i]) + 0.587 * Double(b[i + 1]) + 0.114 * Double(b[i + 2])
			}
			cruda[y - y0] = suma / Double(x1 - x0 + 1)
		}
	}
	var fila = [Double](repeating: 0, count: cruda.count)
	for i in 0..<cruda.count {
		let a = max(0, i - 1)
		let b = min(cruda.count - 1, i + 1)
		fila[i] = cruda[a...b].reduce(0, +) / Double(b - a + 1)
	}
	// Subida de luminancia en 4 filas; máximos locales con fuerza ≥ 6, de arriba abajo.
	var g = [Double](repeating: -.infinity, count: fila.count)
	for i in 2..<(fila.count - 2) { g[i] = fila[i + 2] - fila[i - 2] }
	var bordes: [(y: Double, fuerza: Double)] = []
	for i in 3..<(fila.count - 3) where g[i] >= 6 && g[i] >= g[i - 1] && g[i] >= g[i + 1] {
		bordes.append((y: (Double(y0 + i) + 0.5) / Double(p.alto), fuerza: g[i]))
		if bordes.count == 5 { break }
	}
	return bordes
}

func jsonCara(_ cara: VNFaceObservation, _ tam: CGSize, _ mascara: Mascara?, conSilueta: Bool, pixeles: Pixeles?) -> String {
	let r = cara.boundingBox
	let y = 1.0 - Double(r.origin.y) - Double(r.size.height)
	let contorno = puntosArriba(cara.landmarks?.faceContour, tam)
	let ojoIzq = puntosArriba(cara.landmarks?.leftEye, tam)
	let ojoDer = puntosArriba(cara.landmarks?.rightEye, tam)
	let nariz = puntosArriba(cara.landmarks?.nose, tam)
	// La barbilla es el punto más bajo del contorno (y mayor con origen arriba).
	let barbilla = contorno.max(by: { $0.y < $1.y })
	// La boca es el punto más bajo de los labios por fuera (outerLips): la orilla de abajo del labio de abajo.
	let boca = puntosArriba(cara.landmarks?.outerLips, tam).max(by: { $0.y < $1.y })
	var campos = [
		"\"x\":\(num(Double(r.origin.x)))",
		"\"y\":\(num(y))",
		"\"w\":\(num(Double(r.size.width)))",
		"\"h\":\(num(Double(r.size.height)))",
		"\"confianza\":\(num(Double(cara.confidence), 4))",
		"\"confianza_puntos\":\(cara.landmarks.map { num(Double($0.confidence), 4) } ?? "null")",
		"\"roll\":\(numOpcional(cara.roll))",
		"\"yaw\":\(numOpcional(cara.yaw))",
		"\"pitch\":\(numOpcional(cara.pitch))",
	]
	campos.append("\"barbilla\":" + (barbilla.map { "{\"x\":\(num(Double($0.x))),\"y\":\(num(Double($0.y)))}" } ?? "null"))
	campos.append("\"boca\":" + (boca.map { "{\"x\":\(num(Double($0.x))),\"y\":\(num(Double($0.y)))}" } ?? "null"))
	campos.append("\"contorno\":\(jsonPuntos(contorno))")
	campos.append("\"ojo_izq\":\(jsonPuntos(ojoIzq))")
	campos.append("\"ojo_der\":\(jsonPuntos(ojoDer))")
	campos.append("\"nariz\":\(jsonPuntos(nariz))")
	let ojosTodos = ojoIzq + ojoDer
	if let b = barbilla, let p = pixeles, !ojosTodos.isEmpty {
		let ojosY = ojosTodos.map { Double($0.y) }.reduce(0, +) / Double(ojosTodos.count)
		let bordes = bordesBarbilla(p, barbilla: b, ojosY: ojosY, anchoCara: Double(r.size.width))
		campos.append("\"bordes_barbilla\":[" + bordes.map { "[\(num($0.y)),\(num($0.fuerza, 2))]" }.joined(separator: ",") + "]")
	} else {
		campos.append("\"bordes_barbilla\":[]")
	}
	if conSilueta {
		var silueta = "null"
		if let m = mascara {
			let ojos = ojoIzq + ojoDer
			let ojosY = ojos.isEmpty ? nil : ojos.map { Double($0.y) }.reduce(0, +) / Double(ojos.count)
			let centroX = ojos.isEmpty ? Double(r.midX) : ojos.map { Double($0.x) }.reduce(0, +) / Double(ojos.count)
			let narizY = nariz.map { Double($0.y) }.max()
			let caja = CGRect(x: Double(r.origin.x), y: y, width: Double(r.size.width), height: Double(r.size.height))
			silueta = jsonSilueta(m, caja: caja, ojosY: ojosY, narizY: narizY, centroX: centroX)
		}
		campos.append("\"silueta\":\(silueta)")
	}
	return "{" + campos.joined(separator: ",") + "}"
}

func lineaDeCuadro(_ i: Int, _ t: Double, _ caras: [VNFaceObservation], _ tam: CGSize, _ mascara: Mascara?, conSilueta: Bool, pixeles: Pixeles?) -> String {
	// Orden estable: de la cara más grande a la más chica.
	let orden = caras.sorted { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }
	return "{\"i\":\(i),\"t\":\(num(t, 6)),\"caras\":[\(orden.map { jsonCara($0, tam, mascara, conSilueta: conSilueta, pixeles: pixeles) }.joined(separator: ","))]}"
}

// MARK: - Cuadros por stdin

/// Lee exactamente `n` bytes de stdin. nil = EOF limpio; si llega un cuadro a medias, sale con 2.
func leerCuadro(_ n: Int, indice: Int) -> Data? {
	var datos = Data(count: n)
	let leidos = datos.withUnsafeMutableBytes { (p: UnsafeMutableRawBufferPointer) -> Int in
		var total = 0
		while total < n {
			let r = fread(p.baseAddress! + total, 1, n - total, stdin)
			if r == 0 { break }
			total += r
		}
		return total
	}
	if leidos == 0 { return nil }
	if leidos < n {
		salirConFallo(
			"leer el cuadro \(indice)",
			"llegaron \(leidos) de \(n) bytes (el tamaño no cuadra con --ancho/--alto o ffmpeg se cortó)",
			"revisa que --ancho/--alto sean los del -vf de ffmpeg y que use -pix_fmt rgba",
			2
		)
	}
	return datos
}

func imagenRGBA(_ datos: Data, ancho: Int, alto: Int) -> CGImage? {
	guard let proveedor = CGDataProvider(data: datos as CFData),
		let espacio = CGColorSpace(name: CGColorSpace.sRGB)
	else { return nil }
	return CGImage(
		width: ancho,
		height: alto,
		bitsPerComponent: 8,
		bitsPerPixel: 32,
		bytesPerRow: ancho * 4,
		space: espacio,
		bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
		provider: proveedor,
		decode: nil,
		shouldInterpolate: false,
		intent: .defaultIntent
	)
}

// MARK: - Salida en orden (los cuadros terminan en desorden; se imprimen en el orden en que llegaron)

final class Salida: @unchecked Sendable {
	private let candado = NSLock()
	private var listos: [Int: String] = [:]
	private var siguiente = 0
	private var fallo = false

	func guardar(_ i: Int, _ linea: String) {
		candado.lock()
		defer { candado.unlock() }
		listos[i] = linea
		while let l = listos.removeValue(forKey: siguiente) {
			print(l)
			siguiente += 1
		}
	}

	/// Varios cuadros en vuelo pueden fallar a la vez: solo el primero explica y sale; los demás esperan.
	func reclamarFallo() -> Bool {
		candado.lock()
		defer { candado.unlock() }
		if fallo { return false }
		fallo = true
		return true
	}
}

func explicarFalloVision(_ error: Error, indice: Int, salida: Salida) -> Never {
	if !salida.reclamarFallo() {
		while true { sleep(1) }
	}
	let texto = String(describing: error)
	// Dentro del sandbox, Vision falla al cargar su modelo: "e5rt…" o VNErrorInternalError (código 9,
	// "encountered an unexpected condition"). Con --cpu ni siquiera falla: devuelve 0 caras.
	let nsError = error as NSError
	let internoDeVision = nsError.domain == VNErrorDomain && nsError.code == VNErrorCode.internalError.rawValue
	if texto.contains("e5rt") || texto.contains("nilError") || texto.contains("espresso") || internoDeVision {
		salirConFallo(
			"buscar la cara en el cuadro \(indice) con Vision",
			"Vision no pudo cargar su modelo (\(texto.prefix(120))); casi siempre pasa dentro del sandbox, que no deja usar el Neural Engine ni su caché de modelos",
			"corre npx tsx herramientas/cara.ts … (está en excludedCommands) o una prueba de pruebas/integracion/",
			1
		)
	}
	salirConFallo("buscar la cara en el cuadro \(indice) con Vision", String(texto.prefix(300)), "revisa proyectos/_logs/fallos.log y avísame", 1)
}

// MARK: - Principal

@main
struct Cara {
	static func main() {
		setvbuf(stdout, nil, _IOFBF, 1 << 16)
		let o = leerOpciones()

		if o.diagnostico {
			let s = armarSolicitud(o)
			let revisiones = VNDetectFaceLandmarksRequest.supportedRevisions.map { String($0) }.joined(separator: ",")
			let con76 = VNDetectFaceLandmarksRequest.revision(VNDetectFaceLandmarksRequestRevision3, supportsConstellation: .constellation76Points)
			var etapas = "{}"
			if let e = try? s.supportedComputeStageDevices {
				etapas = "{" + e.map { (etapa, ds) in
					"\"\(etapa.rawValue)\":[\(ds.map { "\"\(String(describing: $0).replacingOccurrences(of: "\"", with: "'"))\"" }.joined(separator: ","))]"
				}.joined(separator: ",") + "}"
			}
			print("{\"revisiones\":[\(revisiones)],\"revision_3_76_puntos\":\(con76),\"dispositivos\":\(etapas)}")
			fflush(stdout)
			exit(0)
		}

		let bytesPorCuadro = o.ancho * o.alto * 4
		let tam = CGSize(width: o.ancho, height: o.alto)
		let cola = DispatchQueue(label: "cara.vision", qos: .userInitiated, attributes: .concurrent)
		let cupo = DispatchSemaphore(value: o.hilos)
		let grupo = DispatchGroup()
		let salida = Salida()
		var leidos = 0

		while let datos = leerCuadro(bytesPorCuadro, indice: leidos) {
			let i = leidos
			leidos += 1
			guard let imagen = imagenRGBA(datos, ancho: o.ancho, alto: o.alto) else {
				salirConFallo("armar la imagen del cuadro \(i)", "CoreGraphics no aceptó los bytes", "revisa --ancho/--alto y -pix_fmt rgba", 2)
			}
			let t = o.t0 + Double(i) / o.fps
			cupo.wait()
			grupo.enter()
			cola.async {
				defer {
					cupo.signal()
					grupo.leave()
				}
				let solicitud = armarSolicitud(o)
				var solicitudes: [VNRequest] = [solicitud]
				var segmentacion: VNGeneratePersonSegmentationRequest? = nil
				if o.silueta {
					let s = VNGeneratePersonSegmentationRequest()
					s.qualityLevel = .balanced
					s.outputPixelFormat = kCVPixelFormatType_OneComponent8
					segmentacion = s
					solicitudes.append(s)
				}
				let manejador = VNImageRequestHandler(cgImage: imagen, orientation: .up, options: [:])
				do {
					try manejador.perform(solicitudes)
				} catch {
					explicarFalloVision(error, indice: i, salida: salida)
				}
				let mascara = segmentacion?.results?.first.flatMap { copiarMascara($0.pixelBuffer) }
				let pixeles = Pixeles(datos: datos, ancho: o.ancho, alto: o.alto)
				salida.guardar(i, lineaDeCuadro(i, t, solicitud.results ?? [], tam, mascara, conSilueta: o.silueta, pixeles: pixeles))
			}
		}
		grupo.wait()
		fflush(stdout)
	}
}
