// Reloj CFR: ScreenCaptureKit manda cuadros solo cuando la ventana cambia (cuadros por segundo variables).
// Este reloj decide qué va en cada ranura n/fps del MP4 para que salga a cuadros por segundo CONSTANTES:
// - cada cuadro nuevo cae en la ranura round((t − t0) × fps), con t su tiempo de presentación;
// - las ranuras que quedan vacías entre dos cuadros llevan otra vez el último cuadro (repetir);
// - un cuadro que llega tarde para una ranura ya escrita no se escribe, pero pasa a ser "el último";
// - al cerrar, se repite el último cuadro hasta completar round(segundos × fps) ranuras.
// Código puro (sin ScreenCaptureKit): se prueba con --autoprueba.

import Foundation

enum Escritura: Equatable {
	/// La ranura lleva otra vez el último cuadro que llegó.
	case repetir(Int)
	/// La ranura lleva el cuadro que acaba de llegar.
	case nuevo(Int)

	var ranura: Int {
		switch self {
		case .repetir(let n), .nuevo(let n): return n
		}
	}
}

struct RelojCfr {
	let fps: Double
	/// Ranuras del MP4 (cuadros que tendrá).
	let total: Int
	private(set) var t0: Double?
	/// Ranuras ya escritas: 0..<escritas.
	private(set) var escritas = 0
	private(set) var hayCuadro = false
	private(set) var nuevos = 0
	private(set) var repetidos = 0
	/// Cuadros que llegaron tarde (su ranura ya estaba escrita) o después del final.
	private(set) var descartados = 0

	init(fps: Int, segundos: Double) {
		self.fps = Double(fps)
		self.total = max(1, Int((segundos * Double(fps)).rounded()))
	}

	/// Ranura más cercana al tiempo t.
	func ranura(_ t: Double) -> Int {
		guard let t0 else { return 0 }
		return Int(((t - t0) * fps).rounded())
	}

	/// Llega un cuadro nuevo con tiempo t (s). Devuelve qué escribir, en orden.
	mutating func llega(_ t: Double) -> [Escritura] {
		if t0 == nil { t0 = t }
		let r = ranura(t)
		defer { hayCuadro = true }
		guard r >= escritas, r < total else {
			descartados += 1
			return []
		}
		var salida: [Escritura] = []
		if hayCuadro {
			for k in escritas..<r {
				salida.append(.repetir(k))
				repetidos += 1
			}
		}
		salida.append(.nuevo(r))
		nuevos += 1
		escritas = r + 1
		return salida
	}

	/// El tiempo avanza a t sin cuadro nuevo: rellena con el último cuadro hasta `margen` ranuras antes de t
	/// (el margen deja llegar a un cuadro que viene un poco atrasado).
	mutating func avanza(_ t: Double, margen: Int = 3) -> [Escritura] {
		guard let t0, hayCuadro else { return [] }
		let hasta = min(total, Int(((t - t0) * fps).rounded(.down)) - margen)
		var salida: [Escritura] = []
		while escritas < hasta {
			salida.append(.repetir(escritas))
			escritas += 1
			repetidos += 1
		}
		return salida
	}

	/// Cierra: repite el último cuadro hasta completar `total` ranuras.
	mutating func cierra() -> [Escritura] {
		guard hayCuadro else { return [] }
		var salida: [Escritura] = []
		while escritas < total {
			salida.append(.repetir(escritas))
			escritas += 1
			repetidos += 1
		}
		return salida
	}

	var completo: Bool { escritas >= total }

	/// ¿Ya pasaron los segundos pedidos desde el primer cuadro?
	func termino(_ t: Double) -> Bool {
		guard let t0 else { return false }
		return t - t0 >= Double(total) / fps
	}
}
