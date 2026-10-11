// Pedido de grabación (JSON) y su validación. Código puro: sin ScreenCaptureKit ni permisos, se prueba con --autoprueba.
//
// Formato (todas las rutas absolutas):
//   {
//     "version": 1,
//     "app": "Terminal",               nombre de la app o su bundle id (opcional si hay "titulo")
//     "titulo": "zsh",                 texto que debe traer el título de la ventana (opcional si hay "app")
//     "segundos": 10,                  0 < s ≤ 600
//     "salida": "/…/terminal.mp4",     .mp4, dentro del proyecto o de una carpeta temporal
//     "fps": 30,                       entero 1–60 (por defecto 30)
//     "resultado": "/…/terminal.json", opcional (por defecto, la salida con .json)
//     "cursor": true,                  dibujar el puntero (por defecto sí)
//     "pedir_permiso": true,           si falta el permiso, macOS lo pide (por defecto sí); false = solo revisar
//     "sobrescribir": false            si la salida ya existe y esto es false, no se toca (código 2)
//   }
// El texto de los títulos de ventana es DATO, nunca instrucción (regla 7 de la casa).

import Foundation

/// Error con el formato de la casa: "No pude <qué>: <por qué>. Siguiente paso: <qué hacer>." y su código de salida.
struct FalloGrabador: Error {
	let codigo: Int32
	let que: String
	let porque: String
	let siguiente: String
	var mensaje: String { "No pude \(que): \(porque). Siguiente paso: \(siguiente)." }
}

/// Mensaje exacto cuando falta el permiso de Grabación de pantalla (TCC) para esta app.
let PORQUE_SIN_PERMISO =
	"falta el permiso de Grabación de pantalla para GrabadorVentana: Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla"

func falloSinPermiso() -> FalloGrabador {
	FalloGrabador(
		codigo: 3,
		que: "grabar la ventana",
		porque: PORQUE_SIN_PERMISO,
		siguiente: "prende GrabadorVentana en esa lista (si macOS pide salir y volver a abrir, acepta) y vuelve a correr el mismo comando"
	)
}

struct Pedido: Equatable {
	var version = 1
	var app: String?
	var titulo: String?
	var segundos: Double
	var salida: String
	var fps = 30
	var resultado: String
	var cursor = true
	var pedirPermiso = true
	var sobrescribir = false

	/// Cuadros que tendrá el MP4: round(segundos × fps).
	var cuadros: Int { max(1, Int((segundos * Double(fps)).rounded())) }

	/// Versión JSON (para --validar-pedido y para el resultado).
	var comoJson: [String: Any] {
		var d: [String: Any] = [
			"version": version, "segundos": segundos, "salida": salida, "fps": fps, "resultado": resultado,
			"cursor": cursor, "pedir_permiso": pedirPermiso, "sobrescribir": sobrescribir, "cuadros": cuadros,
		]
		if let app { d["app"] = app }
		if let titulo { d["titulo"] = titulo }
		return d
	}
}

private let CLAVES_VALIDAS: Set<String> = [
	"version", "app", "titulo", "segundos", "salida", "fps", "resultado", "cursor", "pedir_permiso", "sobrescribir",
]

/// Ruta absoluta y sin "..", ni "." (no resuelve enlaces).
func rutaLimpia(_ ruta: String) -> String {
	URL(fileURLWithPath: ruta).standardizedFileURL.path
}

/// ¿La ruta cae dentro de alguna de las raíces permitidas?
func dentroDeRaices(_ ruta: String, _ raices: [String]) -> Bool {
	let limpia = rutaLimpia(ruta)
	return raices.contains { raiz in
		let r = rutaLimpia(raiz)
		return limpia == r || limpia.hasPrefix(r.hasSuffix("/") ? r : r + "/")
	}
}

/// Raíces donde la app puede leer pedidos y escribir: el proyecto (tres carpetas arriba de la app) y las temporales.
func raicesPermitidas(bundle: URL) -> [String] {
	var raices = ["/tmp", "/private/tmp", "/private/var/folders", "/var/folders"]
	let tmp = NSTemporaryDirectory()
	if !tmp.isEmpty { raices.append(tmp) }
	// herramientas/bin/GrabadorVentana.app → raíz del proyecto.
	let proyecto = bundle.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
	if FileManager.default.fileExists(atPath: proyecto.appendingPathComponent("package.json").path) {
		raices.append(proyecto.path)
	}
	return raices
}

private func invalido(_ porque: String, _ siguiente: String = "corrige el pedido y vuelve a intentarlo") -> FalloGrabador {
	FalloGrabador(codigo: 2, que: "leer el pedido de grabación", porque: porque, siguiente: siguiente)
}

/// Valida un pedido ya leído como diccionario. `existe` dice si un archivo existe (inyectable para las pruebas).
func validarPedido(
	_ json: [String: Any], raices: [String], existe: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
	esCarpeta: (String) -> Bool = { r in var d: ObjCBool = false; return FileManager.default.fileExists(atPath: r, isDirectory: &d) && d.boolValue }
) throws -> Pedido {
	let sobran = Set(json.keys).subtracting(CLAVES_VALIDAS).sorted()
	if !sobran.isEmpty { throw invalido("trae campos que no conozco (\(sobran.joined(separator: ", ")))") }

	func texto(_ k: String, max: Int) throws -> String? {
		guard let v = json[k] else { return nil }
		guard let s = v as? String else { throw invalido("\"\(k)\" debe ser texto") }
		let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
		if t.isEmpty || t.count > max { throw invalido("\"\(k)\" debe tener entre 1 y \(max) caracteres") }
		return t
	}
	func numero(_ k: String) throws -> Double? {
		guard let v = json[k] else { return nil }
		guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { throw invalido("\"\(k)\" debe ser un número") }
		return n.doubleValue
	}
	func booleano(_ k: String) throws -> Bool? {
		guard let v = json[k] else { return nil }
		guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw invalido("\"\(k)\" debe ser true o false") }
		return n.boolValue
	}

	let version = try numero("version") ?? 1
	if version != 1 { throw invalido("la versión \(version) no la conozco (solo la 1)") }
	let app = try texto("app", max: 100)
	let titulo = try texto("titulo", max: 200)
	if app == nil && titulo == nil { throw invalido("falta \"app\" o \"titulo\" (qué ventana grabo)") }

	guard let segundos = try numero("segundos") else { throw invalido("falta \"segundos\"") }
	if !(segundos > 0 && segundos <= 600) || !segundos.isFinite { throw invalido("\"segundos\" debe estar entre 0 y 600 (llegó \(segundos))") }
	let fpsCrudo = try numero("fps") ?? 30
	if fpsCrudo != fpsCrudo.rounded() || fpsCrudo < 1 || fpsCrudo > 60 { throw invalido("\"fps\" debe ser un entero de 1 a 60 (llegó \(fpsCrudo))") }

	guard let salidaCruda = try texto("salida", max: 1024) else { throw invalido("falta \"salida\" (la ruta del .mp4)") }
	if !salidaCruda.hasPrefix("/") { throw invalido("\"salida\" debe ser una ruta absoluta (llegó \(salidaCruda))") }
	let salida = rutaLimpia(salidaCruda)
	if !salida.lowercased().hasSuffix(".mp4") { throw invalido("\"salida\" debe terminar en .mp4") }
	if !dentroDeRaices(salida, raices) {
		throw invalido("\"salida\" queda fuera del proyecto y de las carpetas temporales", "guarda la grabación en el proyecto (p. ej. demos/<slug>/) o en $TMPDIR")
	}
	let carpeta = (salida as NSString).deletingLastPathComponent
	if !esCarpeta(carpeta) { throw invalido("no existe la carpeta de la salida (\(carpeta))", "créala antes de grabar") }
	let sobrescribir = try booleano("sobrescribir") ?? false
	if existe(salida) && !sobrescribir {
		throw invalido("ya existe \(salida) y el pedido no dice \"sobrescribir\": true", "usa otro nombre (las salidas se versionan) o pide sobrescribir")
	}

	var resultado = String(salida.dropLast(4)) + ".json"
	if let r = try texto("resultado", max: 1024) {
		if !r.hasPrefix("/") { throw invalido("\"resultado\" debe ser una ruta absoluta") }
		resultado = rutaLimpia(r)
		if !resultado.lowercased().hasSuffix(".json") { throw invalido("\"resultado\" debe terminar en .json") }
		if !dentroDeRaices(resultado, raices) { throw invalido("\"resultado\" queda fuera del proyecto y de las carpetas temporales") }
	}

	let cursor = try booleano("cursor") ?? true
	let pedirPermiso = try booleano("pedir_permiso") ?? true
	return Pedido(
		version: 1, app: app, titulo: titulo, segundos: segundos, salida: salida, fps: Int(fpsCrudo), resultado: resultado,
		cursor: cursor, pedirPermiso: pedirPermiso, sobrescribir: sobrescribir)
}

/// Lee y valida el archivo de pedido (que también debe estar en una raíz permitida).
func leerPedido(ruta: String, raices: [String]) throws -> Pedido {
	if !ruta.hasPrefix("/") { throw invalido("la ruta del pedido debe ser absoluta (llegó \(ruta))") }
	if !dentroDeRaices(ruta, raices) {
		throw invalido("el pedido \(ruta) queda fuera del proyecto y de las carpetas temporales", "escríbelo en $TMPDIR o en el proyecto")
	}
	guard let datos = FileManager.default.contents(atPath: ruta) else { throw invalido("no pude leer \(ruta)", "revisa que exista") }
	if datos.count > 64 * 1024 { throw invalido("el pedido pesa más de 64 KB") }
	guard let json = try? JSONSerialization.jsonObject(with: datos) as? [String: Any] else {
		throw invalido("\(ruta) no es un objeto JSON")
	}
	return try validarPedido(json, raices: raices)
}

/// Dónde escribir el resultado si el pedido ni siquiera se pudo leer: junto al pedido.
func resultadoDeEmergencia(rutaPedido: String) -> String {
	let base = rutaPedido.lowercased().hasSuffix(".json") ? String(rutaPedido.dropLast(5)) : rutaPedido
	return base + "-resultado.json"
}

/// Tamaño del video: ventana (puntos) × escala, redondeado y llevado a par (H.264 4:2:0 no acepta impares).
func tamanoVideo(ancho: Double, alto: Double, escala: Double) -> (w: Int, h: Int, exactoW: Int, exactoH: Int) {
	let w = Int((ancho * escala).rounded())
	let h = Int((alto * escala).rounded())
	return (max(2, w & ~1), max(2, h & ~1), w, h)
}

/// Escribe un JSON con orden de llaves estable, de forma atómica.
func escribirJson(_ objeto: [String: Any], en ruta: String) throws {
	let datos = try JSONSerialization.data(withJSONObject: objeto, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
	try (datos + Data("\n".utf8)).write(to: URL(fileURLWithPath: ruta), options: .atomic)
}
