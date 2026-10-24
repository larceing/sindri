"""Keyence KV (KV-8000, KV-7500, KV-5500, KV Nano) por «KV Host Link» (enlace superior) en TCP.
Protocolo de texto: solo se mandan RD y RDS (leer). Escrito aquí, sin librería."""
from __future__ import annotations

import asyncio
import re

from .base import MARCA, Driver, Tag

PATRON = re.compile(r"^(DM|EM|FM|ZF|W|TM|R|MR|LR|CR|CM|T|C)(\d{1,5})(?:\.(U|S|D|L|H))?$", re.I)
DM_MARCA = 9900


class Keyence(Driver):
    id = "keyence"
    nombre = "Keyence KV Host Link"
    libreria = "ninguna (protocolo de texto escrito aquí)"
    sintaxis = "DM100 · DM100.S (con signo) · DM102.D (32 bits sin signo) · DM104.L (32 bits con signo) · R100 (relé)"
    marca = f"DM{DM_MARCA}..DM{DM_MARCA + 7} (en hexadecimal) contienen «{MARCA}»"

    async def abrir(self) -> None:
        self.r, self.w = await asyncio.wait_for(asyncio.open_connection(self.ajuste("host", obligatorio=True), int(self.ajuste("puerto", 8501))), 10)
        self.cerrojo = asyncio.Lock()

    async def _orden(self, texto: str) -> str:
        if not texto.startswith(("RD ", "RDS ")):  # nada que no sea leer sale de aquí
            raise ValueError("orden no permitida")
        async with self.cerrojo:
            self.w.write(texto.encode("ascii") + b"\r")
            await self.w.drain()
            linea = (await asyncio.wait_for(self.r.readuntil(b"\r\n"), 10)).decode("ascii").strip()
        if linea.startswith("E"):
            raise ValueError(f"el PLC responde {linea}")
        return linea

    async def es_simulador(self) -> bool:
        try:
            palabras = (await self._orden(f"RDS DM{DM_MARCA}.H {len(MARCA) // 2}")).split()
            return b"".join(bytes.fromhex(p.zfill(4)) for p in palabras).decode("latin-1") == MARCA
        except Exception:  # noqa: BLE001
            return False

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.dirs, self.errores = tags, {}, {}
        for t in tags:
            m = PATRON.match(t.origen.strip())
            if not m:
                self.errores[t.id] = f"«{t.origen}» no es una dirección Keyence (p. ej. DM100.S)"
                continue
            self.dirs[t.id] = f"{m.group(1).upper()}{m.group(2)}" + (f".{m.group(3).upper()}" if m.group(3) else "")

    async def leer(self) -> dict:
        salida = {}
        for c, d in self.dirs.items():
            try:
                v = await self._orden(f"RD {d}")
                salida[c] = int(v, 16) if d.endswith(".H") else int(v)
            except Exception as e:  # noqa: BLE001
                self.errores[c] = f"{d}: {e}"
        return salida

    async def cerrar(self) -> None:
        self.w.close()
