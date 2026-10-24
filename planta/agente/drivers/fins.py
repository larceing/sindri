"""Omron FINS sobre TCP: PLC Omron CJ, CP, CS y NX/NJ (que además tienen EtherNet/IP y OPC UA).
Escrito aquí, sin librería: solo se manda la orden 0101 (leer área de memoria)."""
from __future__ import annotations

import asyncio
import re
import struct

from .base import MARCA, Driver, Tag

# Código de área por palabras y por bits (manual W342 de Omron).
AREAS = {"DM": (0x82, 0x02), "D": (0x82, 0x02), "CIO": (0xB0, 0x30), "W": (0xB1, 0x31), "WR": (0xB1, 0x31), "H": (0xB2, 0x32), "HR": (0xB2, 0x32), "A": (0xB3, 0x33)}
PATRON = re.compile(r"^(DM|D|CIO|WR|W|HR|H|A)(\d{1,5})(?:\.(\d{1,2}))?(?::(int16|uint16|int32|uint32|float32|string\d+))?$", re.I)
DM_MARCA = 9900


class Fins(Driver):
    id = "fins"
    nombre = "Omron FINS/TCP"
    libreria = "ninguna (protocolo escrito aquí; alternativa: fins-driver, MIT)"
    sintaxis = "DM100 · DM100:int32 · DM200:float32 · CIO0.03 (bit) · DM300:string16"
    marca = f"DM{DM_MARCA}..DM{DM_MARCA + 7} contienen «{MARCA}»"

    async def abrir(self) -> None:
        self.r, self.w = await asyncio.wait_for(asyncio.open_connection(self.ajuste("host", obligatorio=True), int(self.ajuste("puerto", 9600))), 10)
        self.w.write(b"FINS" + struct.pack(">IIII", 12, 0, 0, 0))  # pide nodo
        await self.w.drain()
        cab = await asyncio.wait_for(self.r.readexactly(24), 10)
        if cab[:4] != b"FINS" or struct.unpack(">I", cab[12:16])[0] != 0:
            raise ConnectionError("el PLC no acepta la conexión FINS")
        self.nodo_cliente, self.nodo_plc = struct.unpack(">II", cab[16:24])
        self.sid = 0
        self.cerrojo = asyncio.Lock()

    async def _leer_area(self, area: int, direccion: int, bit: int, n: int) -> bytes:
        async with self.cerrojo:
            self.sid = (self.sid + 1) & 0xFF
            fins = bytes([0x80, 0, 2, 0, self.nodo_plc & 0xFF, 0, 0, self.nodo_cliente & 0xFF, 0, self.sid, 0x01, 0x01, area]) + struct.pack(">HBH", direccion, bit, n)
            self.w.write(b"FINS" + struct.pack(">III", 8 + len(fins), 2, 0) + fins)
            await self.w.drain()
            cab = await asyncio.wait_for(self.r.readexactly(16), 10)
            cuerpo = await asyncio.wait_for(self.r.readexactly(struct.unpack(">I", cab[4:8])[0] - 8), 10)
        fin = struct.unpack(">H", cuerpo[12:14])[0]
        if fin & 0x7F7F:
            raise ValueError(f"código de fin FINS {fin:04X}")
        return cuerpo[14:]

    async def es_simulador(self) -> bool:
        try:
            return (await self._leer_area(0x82, DM_MARCA, 0, len(MARCA) // 2)).decode("latin-1") == MARCA
        except Exception:  # noqa: BLE001
            return False

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.dirs, self.errores = tags, {}, {}
        for t in tags:
            m = PATRON.match(t.origen.strip())
            if not m:
                self.errores[t.id] = f"«{t.origen}» no es una dirección Omron (p. ej. DM100:int32 o CIO0.03)"
                continue
            area, num, bit, tipo = m.group(1).upper(), int(m.group(2)), m.group(3), (m.group(4) or "").lower()
            self.dirs[t.id] = (AREAS[area], num, None if bit is None else int(bit), tipo or ("bit" if bit is not None else "uint16"))

    async def leer(self) -> dict:
        salida = {}
        for c, ((palabra, porbit), num, bit, tipo) in self.dirs.items():
            try:
                if tipo == "bit":
                    salida[c] = (await self._leer_area(porbit, num, bit, 1))[0]
                    continue
                n = int(tipo[6:]) // 2 if tipo.startswith("string") else (2 if tipo in ("int32", "uint32", "float32") else 1)
                crudo = await self._leer_area(palabra, num, 0, n)
                if tipo.startswith("string"):
                    salida[c] = crudo.split(b"\0", 1)[0].decode("latin-1").strip()
                else:
                    # Omron guarda 32 bits con la palabra baja primero (CDAB).
                    if n == 2:
                        crudo = crudo[2:4] + crudo[0:2]
                    salida[c] = struct.unpack({"int16": ">h", "uint16": ">H", "int32": ">i", "uint32": ">I", "float32": ">f"}[tipo], crudo)[0]
            except Exception as e:  # noqa: BLE001
                self.errores[c] = f"{num}: {e}"
        return salida

    async def cerrar(self) -> None:
        self.w.close()
