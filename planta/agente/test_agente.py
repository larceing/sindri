"""Pruebas del agente sin red ni OPC UA: python -m unittest -v"""
import os
import tempfile
import unittest

from agente import Cola, Resumidor, version_tupla


class PruebaResumidor(unittest.TestCase):
    def test_estado_solo_cuando_cambia(self):
        r = Resumidor()
        salida = [l for t, v in [(0, 1), (1, 1), (2, 0), (3, 0), (4, 1)] for l in r.muestra("L1", "Estado", "state", v, 1000 + t)]
        self.assertEqual([l["valor"] for l in salida], [1.0, 0.0, 1.0])
        self.assertTrue(all(l["tipo"] == "cambio" for l in salida))

    def test_texto(self):
        r = Resumidor()
        self.assertEqual(r.muestra("L1", "Alarma", "text", "", 0)[0]["texto"], "")
        self.assertEqual(r.muestra("L1", "Alarma", "text", "", 1), [])
        self.assertEqual(r.muestra("L1", "Alarma", "text", "Atasco", 2)[0]["texto"], "Atasco")

    def test_resumen_por_minuto(self):
        r = Resumidor()
        salida = []
        for s, v in enumerate([10, 20, 30]):
            salida += r.muestra("L1", "Velocidad", "value", v, 120 + s)
        self.assertEqual(salida, [])
        salida = r.muestra("L1", "Velocidad", "value", 99, 180)
        self.assertEqual(len(salida), 1)
        m = salida[0]
        self.assertEqual((m["min"], m["max"], m["media"], m["valor"], m["n"]), (10, 30, 20, 30, 3))
        self.assertEqual(m["ts"], "1970-01-01T00:02:00.000Z")
        self.assertEqual(m["id"], "L1:Velocidad:minuto:1970-01-01T00:02:00.000Z")

    def test_versiones(self):
        self.assertLess(version_tupla("0.1.0"), version_tupla("0.2.0"))
        self.assertLess(version_tupla("0.9.0"), version_tupla("0.10.0"))


class PruebaCola(unittest.TestCase):
    def test_guarda_y_no_duplica(self):
        with tempfile.TemporaryDirectory() as d:
            c = Cola(os.path.join(d, "c.sqlite"))
            c.meter([{"id": "a"}, {"id": "b"}])
            c.meter([{"id": "a"}])
            self.assertEqual(c.cuantas(), 2)
            # Sobrevive a un reinicio del agente.
            c2 = Cola(os.path.join(d, "c.sqlite"))
            self.assertEqual([l["id"] for l in c2.lote()], ["a", "b"])
            c2.quitar(["a"])
            self.assertEqual(c2.cuantas(), 1)


if __name__ == "__main__":
    unittest.main()
