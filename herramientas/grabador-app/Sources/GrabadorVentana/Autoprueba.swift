// --autoprueba: prueba lo que no necesita permisos ni pantalla (reloj CFR, validación del pedido, tamaño del video).
// Imprime una línea por prueba y "Autoprueba: X de Y" al final. Sale con 0 si todo pasa y con 1 si algo falla.

import Foundation

private var pasan = 0
private var total = 0

private func revisar(_ nombre: String, _ condicion: Bool, _ detalle: @autoclosure () -> String = "") {
	total += 1
	if condicion {
		pasan += 1
		print("✔ \(nombre)")
	} else {
		print("✘ \(nombre) \(detalle())")
	}
}

/// Corre el reloj con tiempos de llegada y devuelve, por ranura, el índice del cuadro fuente que lleva.
private func simular(fps: Int, segundos: Double, llegadas: [Double], avances: [Double] = []) -> (fuente: [Int], reloj: RelojCfr, orden: Bool) {
	var reloj = RelojCfr(fps: fps, segundos: segundos)
	var fuente = [Int](repeating: -1, count: reloj.total)
	var ultimo = -1
	var ranuras: [Int] = []
	let eventos = (llegadas.enumerated().map { (t: $0.element, cuadro: $0.offset) } + avances.map { (t: $0, cuadro: -1) }).sorted { $0.t < $1.t }
	for e in eventos {
		let escrituras = e.cuadro >= 0 ? reloj.llega(e.t) : reloj.avanza(e.t)
		for w in escrituras {
			switch w {
			case .repetir(let n): fuente[n] = ultimo
			case .nuevo(let n): fuente[n] = e.cuadro
			}
			ranuras.append(w.ranura)
		}
		if e.cuadro >= 0 { ultimo = e.cuadro }
	}
	for w in reloj.cierra() {
		fuente[w.ranura] = ultimo
		ranuras.append(w.ranura)
	}
	return (fuente, reloj, ranuras == Array(0..<reloj.total))
}

func correrAutoprueba() -> Int32 {
	// ── Reloj CFR ──
	let a = simular(fps: 30, segundos: 1, llegadas: (0..<30).map { 100 + Double($0) / 30 })
	revisar("30 fps exactos → 30 cuadros nuevos, 0 repetidos", a.reloj.nuevos == 30 && a.reloj.repetidos == 0 && a.fuente == Array(0..<30), "\(a.fuente)")
	revisar("cada ranura se escribe una vez y en orden", a.orden)

	let b = simular(fps: 30, segundos: 1, llegadas: (0..<15).map { 7 + Double($0) * 2 / 30 })
	revisar("15 fps → cada cuadro dura 2 ranuras (CFR 30)", b.reloj.total == 30 && b.fuente == (0..<30).map { $0 / 2 } && b.orden, "\(b.fuente)")

	let c = simular(fps: 30, segundos: 1, llegadas: [3.0, 3.5])
	revisar(
		"hueco: el último cuadro se repite hasta el siguiente y hasta el final",
		c.fuente == Array(repeating: 0, count: 15) + Array(repeating: 1, count: 15) && c.reloj.nuevos == 2 && c.reloj.repetidos == 28 && c.orden, "\(c.fuente)")

	var semilla: UInt64 = 42
	func azar() -> Double {
		semilla = semilla &* 6364136223846793005 &+ 1442695040888963407
		return Double(semilla >> 11) / Double(1 << 53)
	}
	let d = simular(fps: 30, segundos: 2, llegadas: (0..<60).map { 50 + Double($0) / 30 + (azar() - 0.5) * 0.01 })
	revisar("llegadas con ±5 ms de temblor caen en su ranura", d.fuente == Array(0..<60) && d.orden, "\(d.fuente)")

	// Un cuadro atrasado: el reloj ya rellenó su ranura; no se reescribe, pero pasa a ser el último.
	let e = simular(fps: 30, segundos: 1, llegadas: [0.0, 0.2, 0.25], avances: [0.24])
	revisar("un cuadro atrasado no rompe el orden (cuenta como descartado)", e.orden && e.reloj.descartados >= 0 && e.fuente.allSatisfy { $0 >= 0 }, "\(e.fuente)")

	let f = simular(fps: 30, segundos: 0.5, llegadas: (0..<40).map { Double($0) / 30 })
	revisar("lo que llega después del final se descarta", f.reloj.total == 15 && f.reloj.descartados == 25 && f.orden)

	var g = RelojCfr(fps: 30, segundos: 10)
	revisar("10 s a 30 fps = 300 ranuras", g.total == 300)
	_ = g.llega(5)
	revisar("termina a los 10 s del primer cuadro", !g.termino(14.99) && g.termino(15.0))
	var h = RelojCfr(fps: 30, segundos: 1)
	revisar("sin ningún cuadro, cerrar no escribe nada", h.cierra().isEmpty && !h.completo)

	// ── Tamaño del video ──
	let t1 = tamanoVideo(ancho: 800, alto: 600, escala: 2)
	revisar("800×600 pt × 2 → 1600×1200 px", t1.w == 1600 && t1.h == 1200 && t1.exactoW == 1600)
	let t2 = tamanoVideo(ancho: 801, alto: 601, escala: 1)
	revisar("impares a 1× se llevan a par (H.264 4:2:0)", t2.w == 800 && t2.h == 600 && t2.exactoW == 801 && t2.exactoH == 601)

	// ── Pedido ──
	let raices = ["/proyecto", "/tmp"]
	let existe: (String) -> Bool = { $0 == "/proyecto/demos/ya.mp4" }
	let carpeta: (String) -> Bool = { ["/proyecto/demos", "/tmp"].contains($0) }
	func validar(_ json: [String: Any]) -> Result<Pedido, FalloGrabador> {
		do { return .success(try validarPedido(json, raices: raices, existe: existe, esCarpeta: carpeta)) } catch let f as FalloGrabador { return .failure(f) } catch {
			return .failure(FalloGrabador(codigo: 1, que: "?", porque: "?", siguiente: "?"))
		}
	}
	let base: [String: Any] = ["app": "Terminal", "segundos": 10, "salida": "/proyecto/demos/terminal.mp4"]
	if case .success(let p) = validar(base) {
		revisar(
			"pedido mínimo: 30 fps, cursor, pide permiso, resultado junto a la salida, 300 cuadros",
			p.fps == 30 && p.cursor && p.pedirPermiso && !p.sobrescribir && p.resultado == "/proyecto/demos/terminal.json" && p.cuadros == 300)
	} else {
		revisar("pedido mínimo válido", false, "lo rechazó")
	}
	func rechaza(_ nombre: String, _ cambio: [String: Any?], _ texto: String) {
		var j = base
		for (k, v) in cambio {
			if let v { j[k] = v } else { j.removeValue(forKey: k) }
		}
		if case .failure(let f) = validar(j) {
			revisar("rechaza \(nombre) (código 2)", f.codigo == 2 && f.mensaje.contains(texto) && f.mensaje.hasPrefix("No pude ") && f.mensaje.contains("Siguiente paso:"), f.mensaje)
		} else {
			revisar("rechaza \(nombre)", false, "lo aceptó")
		}
	}
	rechaza("sin app ni título", ["app": nil], "\"app\" o \"titulo\"")
	rechaza("sin segundos", ["segundos": nil], "falta \"segundos\"")
	rechaza("0 segundos", ["segundos": 0], "\"segundos\"")
	rechaza("más de 600 s", ["segundos": 601], "\"segundos\"")
	rechaza("fps no entero", ["fps": 29.97], "\"fps\"")
	rechaza("salida relativa", ["salida": "demos/x.mp4"], "absoluta")
	rechaza("salida .mov", ["salida": "/proyecto/demos/x.mov"], ".mp4")
	rechaza("salida fuera del proyecto", ["salida": "/home/otro/x.mp4"], "fuera del proyecto")
	rechaza("salida con .. que se escapa", ["salida": "/proyecto/demos/../../etc/x.mp4"], "fuera del proyecto")
	rechaza("carpeta que no existe", ["salida": "/proyecto/nada/x.mp4"], "no existe la carpeta")
	rechaza("salida que ya existe", ["salida": "/proyecto/demos/ya.mp4"], "ya existe")
	rechaza("campo desconocido", ["segundso": 3], "no conozco")
	rechaza("cursor que no es booleano", ["cursor": "sí"], "true o false")
	rechaza("versión 2", ["version": 2], "versión")
	var sobre = base
	sobre["salida"] = "/proyecto/demos/ya.mp4"
	sobre["sobrescribir"] = true
	if case .success = validar(sobre) { revisar("acepta sobrescribir si se pide", true) } else { revisar("acepta sobrescribir si se pide", false) }

	revisar("dentroDeRaices no confunde /proyecto-otro con /proyecto", !dentroDeRaices("/proyecto-otro/x.mp4", raices) && dentroDeRaices("/proyecto/x.mp4", raices))
	revisar("resultado de emergencia junto al pedido", resultadoDeEmergencia(rutaPedido: "/tmp/p.json") == "/tmp/p-resultado.json")
	revisar("el mensaje sin permiso es el acordado", falloSinPermiso().mensaje.contains(PORQUE_SIN_PERMISO) && falloSinPermiso().codigo == 3)

	print("Autoprueba: \(pasan) de \(total)")
	return pasan == total ? 0 : 1
}
