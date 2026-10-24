"""Lee una vez cada máquina de ejemplos/ con su driver, sin ERP: python probar.py [fuente...]

Sirve para comprobar un driver nuevo contra el simulador multiprotocolo. Solo vale contra el
simulador (comprueba la marca); para una máquina real, en la fábrica, «agente.py descubrir»."""
from __future__ import annotations

import asyncio
import json
import os
import sys

import drivers
from agente import normalizar, tags_por_fuente

AQUI = os.path.dirname(os.path.abspath(__file__))


def cargar(nombre: str):
    with open(os.path.join(AQUI, "ejemplos", nombre), encoding="utf-8") as f:
        texto = os.path.expandvars(f.read().replace("${CARPETA}", os.environ.get("CARPETA", "")))
    return json.loads(texto)


async def probar(nombre: str, ajustes: dict, tags) -> dict:
    d = drivers.cargar(ajustes["driver"])(nombre, ajustes)
    r = {"fuente": nombre, "driver": ajustes["driver"]}
    try:
        await asyncio.wait_for(d.abrir(), 15)
        r["simulador"] = await d.es_simulador()
        await d.preparar(tags)
        await asyncio.sleep(float(ajustes.get("espera_s", 1.5)))  # MQTT y serie empujan: dejar que llegue algo
        crudos = await asyncio.wait_for(d.leer(), 15)
        porid = {t.id: t for t in tags}
        r["valores"] = {}
        for clave, crudo in crudos.items():
            try:
                r["valores"][f"{clave[0]}.{clave[1]}"] = normalizar(porid[clave], crudo)
            except ValueError as e:
                d.errores[clave] = str(e)
        r["errores"] = {f"{k[0]}.{k[1]}": v for k, v in d.errores.items()}
        r["leidos"] = f"{len(r['valores'])}/{len(tags)}"
    except Exception as e:  # noqa: BLE001
        r["fallo"] = f"{type(e).__name__}: {e}"
    finally:
        try:
            await d.cerrar()
        except Exception:  # noqa: BLE001
            pass
    return r


async def main(solo: list[str]) -> list[dict]:
    fuentes = cargar("fuentes.simulador.json")
    reparto, _ = tags_por_fuente({"maquinas": cargar("maquinas.simulador.json")}, fuentes)
    nombres = [n for n in fuentes if not solo or n in solo]
    return await asyncio.gather(*[probar(n, fuentes[n], reparto[n]) for n in nombres])


if __name__ == "__main__":
    for r in asyncio.run(main(sys.argv[1:])):
        print(json.dumps(r, ensure_ascii=False, default=str))
