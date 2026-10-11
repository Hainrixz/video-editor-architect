// GrabadorVentana: graba UNA ventana de macOS (Terminal, una app nativa…) con ScreenCaptureKit a un MP4 CFR sin audio.
//
// Es una app propia (herramientas/bin/GrabadorVentana.app, firmada ad-hoc) para que el permiso de Grabación de pantalla
// quede en ELLA y no en la terminal de Claude: se abre con `open -n -W -a <ruta>/GrabadorVentana.app --args …`.
// La lanza herramientas/grabador/ventana.ts, que escribe el pedido y espera el resultado.
//
// Modos:
//   --pedido <ruta.json>           graba según el pedido y escribe el JSON de resultado (ver Pedido.swift)
//   --permiso <ruta.json>          solo revisa el permiso (sin pedirlo) y escribe {"permiso": true|false}
//   --validar-pedido <ruta.json>   lee y valida el pedido, imprime el pedido normalizado (no graba ni pide permisos)
//   --autoprueba                   pruebas internas (reloj CFR, pedido, tamaño)
//   --prueba-escritor <ruta.mp4>   MP4 sintético (cuadros grises a destiempo) con el mismo escritor CFR de la grabación
//   --version
// Códigos de salida: 0 bien · 1 fallo interno · 2 pedido inválido o falta algo del creador (ventana) · 3 permiso o
// ScreenCaptureKit. Los mensajes van en español con el formato de herramientas/lib/fallo.ts.

import AppKit
import Foundation

let VERSION_GRABADOR = "1.0.0"

func avisar(_ texto: String) {
	FileHandle.standardError.write(Data((texto + "\n").utf8))
}

func fechaIso(_ d: Date) -> String {
	let f = ISO8601DateFormatter()
	f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
	return f.string(from: d)
}

func jsonDeFallo(_ f: FalloGrabador, pedido: Pedido?) -> [String: Any] {
	var r: [String: Any] = [
		"version": 1, "ok": false, "codigo": Int(f.codigo), "mensaje": f.mensaje, "que": f.que, "porque": f.porque, "siguiente_paso": f.siguiente,
		"grabador": VERSION_GRABADOR,
	]
	if let pedido { r["pedido"] = pedido.comoJson }
	return r
}

/// Graba y escribe el resultado. Devuelve el código de salida.
func ejecutarGrabacion(rutaPedido: String) async -> Int32 {
	let raices = raicesPermitidas(bundle: Bundle.main.bundleURL)
	let inicio = Date()
	var rutaResultado: String? = dentroDeRaices(rutaPedido, raices) ? resultadoDeEmergencia(rutaPedido: rutaPedido) : nil
	var pedido: Pedido?
	do {
		let p = try leerPedido(ruta: rutaPedido, raices: raices)
		pedido = p
		rutaResultado = p.resultado
		avisar("GrabadorVentana \(VERSION_GRABADOR): pedido leído (\(descripcionVentana(p)), \(p.segundos) s a \(p.fps) fps → \(p.salida))")
		// Si algo se cuelga, la app no se queda abierta para siempre.
		let limite = p.segundos + 45
		DispatchQueue.main.asyncAfter(deadline: .now() + limite) {
			let f = FalloGrabador(codigo: 1, que: "grabar la ventana", porque: "la grabación pasó de \(Int(limite)) s sin terminar", siguiente: "vuelve a intentarlo; si se repite, avísame con el log")
			try? escribirJson(jsonDeFallo(f, pedido: p), en: p.resultado)
			avisar(f.mensaje)
			exit(1)
		}
		var r = try await grabar(p)
		r["version"] = 1
		r["ok"] = true
		r["codigo"] = 0
		r["grabador"] = VERSION_GRABADOR
		r["pedido"] = p.comoJson
		r["inicio"] = fechaIso(inicio)
		r["duracion_real_s"] = (Date().timeIntervalSince(inicio) * 1000).rounded() / 1000
		let video = r["video"] as? [String: Any] ?? [:]
		r["mensaje"] = "Listo: \(video["cuadros"] ?? "?") cuadros a \(p.fps)/1 de \(descripcionVentana(p)) en \(p.salida)"
		try escribirJson(r, en: p.resultado)
		avisar(r["mensaje"] as? String ?? "Listo")
		return 0
	} catch {
		let f = traducirError(error)
		if let ruta = rutaResultado { try? escribirJson(jsonDeFallo(f, pedido: pedido), en: ruta) }
		avisar(f.mensaje)
		return f.codigo
	}
}

final class Delegado: NSObject, NSApplicationDelegate {
	let rutaPedido: String
	init(rutaPedido: String) { self.rutaPedido = rutaPedido }
	func applicationDidFinishLaunching(_ notification: Notification) {
		let ruta = rutaPedido
		Task {
			let codigo = await ejecutarGrabacion(rutaPedido: ruta)
			exit(codigo)
		}
	}
}

// ───────────────────────────── entrada ─────────────────────────────

// `open` en macOS viejos agrega -psn_…; se ignora.
let argumentos = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }

func valorDe(_ opcion: String) -> String? {
	guard let i = argumentos.firstIndex(of: opcion), argumentos.index(after: i) < argumentos.endIndex else { return nil }
	return argumentos[argumentos.index(after: i)]
}

if argumentos.contains("--version") {
	print("GrabadorVentana \(VERSION_GRABADOR)")
	exit(0)
}

if argumentos.contains("--autoprueba") {
	exit(correrAutoprueba())
}

if let ruta = valorDe("--prueba-escritor") {
	// Sin pantalla ni permisos: cuadros sintéticos a destiempo → el mismo EscritorCfr de la grabación real.
	let raices = raicesPermitidas(bundle: Bundle.main.bundleURL)
	guard ruta.hasPrefix("/"), ruta.lowercased().hasSuffix(".mp4"), dentroDeRaices(ruta, raices) else {
		avisar("No pude probar el escritor: \(ruta) debe ser un .mp4 absoluto dentro del proyecto o de una carpeta temporal. Siguiente paso: corrige la ruta.")
		exit(2)
	}
	exit(correrPruebaEscritor(ruta: ruta))
}

if let ruta = valorDe("--validar-pedido") {
	do {
		let p = try leerPedido(ruta: ruta, raices: raicesPermitidas(bundle: Bundle.main.bundleURL))
		let datos = try JSONSerialization.data(withJSONObject: p.comoJson, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
		print(String(decoding: datos, as: UTF8.self))
		exit(0)
	} catch {
		let f = traducirError(error)
		avisar(f.mensaje)
		exit(f.codigo)
	}
}

if let ruta = valorDe("--permiso") {
	// Solo revisa (CGPreflight no muestra ningún diálogo). Sirve abierta con `open` (el permiso es de la app).
	let tiene = CGPreflightScreenCaptureAccess()
	let raices = raicesPermitidas(bundle: Bundle.main.bundleURL)
	guard ruta.hasPrefix("/"), ruta.lowercased().hasSuffix(".json"), dentroDeRaices(ruta, raices) else {
		avisar("No pude revisar el permiso: la ruta \(ruta) debe ser un .json absoluto dentro del proyecto o de una carpeta temporal. Siguiente paso: corrige la ruta.")
		exit(2)
	}
	var r: [String: Any] = ["version": 1, "permiso": tiene, "grabador": VERSION_GRABADOR]
	if !tiene { r["mensaje"] = falloSinPermiso().mensaje }
	do { try escribirJson(r, en: ruta) } catch {
		avisar("No pude escribir \(ruta). Siguiente paso: revisa que la carpeta exista.")
		exit(1)
	}
	exit(tiene ? 0 : 3)
}

guard let rutaPedido = valorDe("--pedido") else {
	avisar(
		"No pude arrancar: falta --pedido <ruta.json> (o --permiso, --validar-pedido, --autoprueba, --version). Siguiente paso: lánzala con herramientas/grabador/ventana.ts.")
	exit(2)
}

let aplicacion = NSApplication.shared
// Sin ícono en el Dock ni menú: solo graba y sale.
aplicacion.setActivationPolicy(.accessory)
let delegado = Delegado(rutaPedido: rutaPedido)
aplicacion.delegate = delegado
aplicacion.run()
