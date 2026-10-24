"""Puerto serie (RS-232/RS-485) con tramas de texto: básculas (Mettler Toledo, Dibal, Baxtran,
Gram…), lectores de código de barras y equipos que solo «escupen» líneas. Se escucha, no se pide."""
from __future__ import annotations

import asyncio
import re
import threading
import time

from .base import MARCA, Driver, Tag


class Serie(Driver):
    id = "serie"
    nombre = "Puerto serie (tramas de texto)"
    libreria = "pyserial (BSD-3-Clause)"
    sintaxis = r"([-+]?\d+[.,]\d+)\s*kg (expresión regular: el primer grupo es el valor) · ^(ST|US) (estable o no)"
    marca = f"la primera línea es «{MARCA}» (solo el simulador por socket://)"

    async def abrir(self) -> None:
        import serial

        self.puerto = serial.serial_for_url(self.ajuste("url", obligatorio=True), baudrate=int(self.ajuste("baudios", 9600)),
                                            bytesize=int(self.ajuste("bits", 8)), parity=self.ajuste("paridad", "N"),
                                            stopbits=float(self.ajuste("bits_parada", 1)), timeout=1)
        self.lineas: list[tuple[float, str]] = []
        self.primera: str | None = None
        self.cerrojo = threading.Lock()
        self.parar = threading.Event()
        self.hilo = threading.Thread(target=self._escuchar, daemon=True)
        self.hilo.start()

    def _escuchar(self) -> None:
        resto = b""
        while not self.parar.is_set():
            try:
                trozo = self.puerto.read(256)
            except Exception:  # noqa: BLE001
                break
            resto += trozo
            *lineas, resto = re.split(rb"\r\n|\r|\n", resto)
            with self.cerrojo:
                for l in lineas:
                    texto = l.decode("latin-1").strip()
                    if not texto:
                        continue
                    if self.primera is None:
                        self.primera = texto
                    self.lineas = (self.lineas + [(time.time(), texto)])[-50:]

    async def es_simulador(self) -> bool:
        for _ in range(30):
            if self.primera is not None:
                return self.primera == MARCA
            await asyncio.sleep(0.1)
        return False

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.patrones, self.errores = tags, {}, {}
        for t in tags:
            try:
                self.patrones[t.id] = re.compile(t.origen)
            except re.error as e:
                self.errores[t.id] = f"expresión no válida: {e}"

    async def leer(self) -> dict:
        if not self.hilo.is_alive():
            raise ConnectionError("el puerto serie se ha cerrado")
        with self.cerrojo:
            lineas = list(self.lineas)
        caducidad = float(self.ajuste("caducidad_s", 30))
        salida = {}
        for c, p in self.patrones.items():
            # La última línea reciente que encaja.
            for t, texto in reversed(lineas):
                if time.time() - t > caducidad:
                    break
                m = p.search(texto)
                if m:
                    v = m.group(1) if m.groups() else m.group(0)
                    salida[c] = v.replace(",", ".")
                    break
        return salida

    async def cerrar(self) -> None:
        self.parar.set()
        self.puerto.close()
