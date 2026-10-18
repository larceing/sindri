"""Simulador OPC UA de una línea de envasado, para desarrollo y DEV.

Nunca se conecta a nada real: solo publica tags que cambian solos, como haría el SCADA.
Espacio de nombres "urn:sindri:simulador", carpeta Planta/Linea1:

  Estado            Int32   0 = parada, 1 = en marcha, 2 = avería
  PiezasBuenas      UInt32  contador que solo sube (se reinicia al cambiar de orden)
  PiezasMalas       UInt32  ídem, rechazos
  Velocidad         Double  piezas por minuto
  TemperaturaHorno  Double  grados C
  OrdenActual       String  número de la orden de fabricación en curso
  Alarma            String  texto de la última alarma ("" si no hay)

Lectura anónima y sin cifrar: SOLO para el simulador. El SCADA real se lee con usuario de
solo lectura y cifrado (ver docs/INSTRUCCIONES.md, parte C).
"""
import asyncio
import logging
import math
import os
import random

from asyncua import Server, ua

PUERTO = int(os.environ.get("PUERTO", "4840"))
PASO_S = float(os.environ.get("PASO_S", "1"))


async def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    servidor = Server()
    await servidor.init()
    servidor.set_endpoint(f"opc.tcp://0.0.0.0:{PUERTO}/")
    servidor.set_server_name("Sindri - simulador de planta")
    servidor.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    ns = await servidor.register_namespace("urn:sindri:simulador")

    planta = await servidor.nodes.objects.add_folder(ns, "Planta")
    linea = await planta.add_object(ns, "Linea1")
    estado = await linea.add_variable(ns, "Estado", 1, ua.VariantType.Int32)
    buenas = await linea.add_variable(ns, "PiezasBuenas", 0, ua.VariantType.UInt32)
    malas = await linea.add_variable(ns, "PiezasMalas", 0, ua.VariantType.UInt32)
    velocidad = await linea.add_variable(ns, "Velocidad", 0.0, ua.VariantType.Double)
    horno = await linea.add_variable(ns, "TemperaturaHorno", 120.0, ua.VariantType.Double)
    orden = await linea.add_variable(ns, "OrdenActual", "OF2026-00001", ua.VariantType.String)
    alarma = await linea.add_variable(ns, "Alarma", "", ua.VariantType.String)

    async with servidor:
        print(f"Simulador OPC UA en opc.tcp://0.0.0.0:{PUERTO}/ (ns={ns})", flush=True)
        t = 0.0
        n_orden = 1
        total = [0, 0]
        e = 1
        while True:
            await asyncio.sleep(PASO_S)
            t += PASO_S
            # Cambios de estado raros: una parada o una avería de vez en cuando.
            r = random.random()
            if e == 1 and r < 0.01:
                e = 2
                await alarma.write_value("Atasco en la etiquetadora")
            elif e == 1 and r < 0.02:
                e = 0
            elif e != 1 and r < 0.15:
                e = 1
                await alarma.write_value("")
            await estado.write_value(e, ua.VariantType.Int32)

            v = 0.0 if e != 1 else 60 + 8 * math.sin(t / 30) + random.uniform(-2, 2)
            await velocidad.write_value(round(v, 2), ua.VariantType.Double)
            piezas = v * PASO_S / 60
            nuevas_malas = 1 if e == 1 and random.random() < 0.02 else 0
            total[0] += int(piezas + random.random())
            total[1] += nuevas_malas
            await buenas.write_value(total[0], ua.VariantType.UInt32)
            await malas.write_value(total[1], ua.VariantType.UInt32)
            await horno.write_value(round(120 + 5 * math.sin(t / 90) + random.uniform(-0.5, 0.5), 2), ua.VariantType.Double)

            # Cada 1000 piezas, orden nueva y contadores a cero.
            if total[0] >= 1000:
                n_orden += 1
                total = [0, 0]
                await orden.write_value(f"OF2026-{n_orden:05d}")


if __name__ == "__main__":
    asyncio.run(main())
