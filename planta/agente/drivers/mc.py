"""Mitsubishi MELSEC (protocolo MC / SLMP, trama 3E binaria): series Q, L, iQ-R e iQ-F,
y muchas máquinas japonesas y coreanas que lo exponen."""
from __future__ import annotations

import re
import struct

from .base import MARCA, Driver, Tag

# D100 · D100:int32 · D200:float32 · M10:bit · W1A:uint16 · D300:string16
PATRON = re.compile(r"^([A-Z]{1,2})([0-9A-F]+)(?::(int16|uint16|int32|uint32|float32|bit|string\d+))?$", re.I)
PALABRAS = {"int16": 1, "uint16": 1, "int32": 2, "uint32": 2, "float32": 2}
BITS = {"M", "X", "Y", "B", "L", "F", "SM", "S"}
D_MARCA = "D9900"  # el simulador guarda «SINDRI-SIMULADOR» en D9900..D9907


class Melsec(Driver):
    id = "mc"
    nombre = "Mitsubishi MELSEC (MC/SLMP 3E)"
    libreria = "pymcprotocol (MIT)"
    sintaxis = "D100 · D100:int32 · D200:float32 · M10:bit · D300:string16"
    marca = f"{D_MARCA}..D9907 contienen «{MARCA}»"

    async def abrir(self) -> None:
        import pymcprotocol

        self.plc = pymcprotocol.Type3E(plctype=self.ajuste("tipo_plc", "Q"))
        self.plc.soc_timeout = 5
        await self.en_hilo(self.plc.connect, self.ajuste("host", obligatorio=True), int(self.ajuste("puerto", 5007)))

    async def es_simulador(self) -> bool:
        try:
            palabras = await self.en_hilo(self.plc.batchread_wordunits, D_MARCA, len(MARCA) // 2)
        except Exception:  # noqa: BLE001
            return False
        return b"".join(int(w & 0xFFFF).to_bytes(2, "little") for w in palabras).decode("latin-1", "replace") == MARCA

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.dirs, self.errores = tags, {}, {}
        for t in tags:
            m = PATRON.match(t.origen.strip())
            if not m:
                self.errores[t.id] = f"«{t.origen}» no es una dirección MELSEC (p. ej. D100:int32)"
                continue
            dispositivo, numero, tipo = m.group(1).upper(), m.group(2).upper(), (m.group(3) or "").lower()
            if not tipo:
                tipo = "bit" if dispositivo in BITS else "int16"
            self.dirs[t.id] = (f"{dispositivo}{numero}", tipo)

    async def leer(self) -> dict:
        salida = {}
        for c, (inicio, tipo) in self.dirs.items():
            try:
                if tipo == "bit":
                    salida[c] = (await self.en_hilo(self.plc.batchread_bitunits, inicio, 1))[0]
                    continue
                n = int(tipo[6:]) // 2 if tipo.startswith("string") else PALABRAS[tipo]
                palabras = await self.en_hilo(self.plc.batchread_wordunits, inicio, n)
                crudo = b"".join(int(w & 0xFFFF).to_bytes(2, "little") for w in palabras)
                if tipo.startswith("string"):
                    salida[c] = crudo.split(b"\0", 1)[0].decode("latin-1").strip()
                else:
                    salida[c] = struct.unpack({"int16": "<h", "uint16": "<H", "int32": "<i", "uint32": "<I", "float32": "<f"}[tipo], crudo)[0]
            except Exception as e:  # noqa: BLE001
                self.errores[c] = f"{inicio}: {e}"
        return salida

    async def cerrar(self) -> None:
        try:
            await self.en_hilo(self.plc.close)
        except Exception:  # noqa: BLE001
            pass


