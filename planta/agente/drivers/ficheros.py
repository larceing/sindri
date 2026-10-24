"""Ficheros CSV: máquinas que dejan un registro en una carpeta (o en una carpeta compartida por
FTP/SMB que alguien monta en el equipo del agente). Se lee la última fila del fichero más nuevo."""
from __future__ import annotations

import csv
import glob
import io
import os

from .base import Driver, Tag

FICHERO_MARCA = ".sindri-simulador"


class Ficheros(Driver):
    id = "ficheros"
    nombre = "Ficheros CSV en una carpeta"
    libreria = "ninguna (librería estándar)"
    sintaxis = "Piezas (nombre de columna) · #3 (número de columna, desde 0)"
    marca = f"fichero {FICHERO_MARCA} en la carpeta"

    async def abrir(self) -> None:
        self.carpeta = self.ajuste("carpeta", obligatorio=True)
        if not os.path.isdir(self.carpeta):
            raise FileNotFoundError(f"no existe la carpeta {self.carpeta}")

    async def es_simulador(self) -> bool:
        return os.path.isfile(os.path.join(self.carpeta, FICHERO_MARCA))

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.errores = tags, {}

    def _ultima_fila(self) -> tuple[list[str], list[str]] | None:
        ficheros = glob.glob(os.path.join(self.carpeta, self.ajuste("patron", "*.csv")))
        if not ficheros:
            return None
        ultimo = max(ficheros, key=os.path.getmtime)
        # Solo se lee: el fichero se abre en modo lectura y no se mueve ni se borra.
        with open(ultimo, encoding=self.ajuste("codificacion", "utf-8-sig"), errors="replace", newline="") as f:
            texto = f.read()
        filas = [f for f in csv.reader(io.StringIO(texto), delimiter=self.ajuste("separador", ";")) if any(c.strip() for c in f)]
        if len(filas) < 2:
            return None
        return filas[0], filas[-1]

    async def leer(self) -> dict:
        fila = await self.en_hilo(self._ultima_fila)
        if not fila:
            return {}
        cabecera, ultima = fila
        salida = {}
        for t in self.tags:
            o = t.origen.strip()
            i = int(o[1:]) if o.startswith("#") and o[1:].isdigit() else (cabecera.index(o) if o in cabecera else None)
            if i is None or i >= len(ultima):
                self.errores[t.id] = f"no hay columna «{o}»"
                continue
            v = ultima[i].strip()
            if t.tipo in ("counter", "value", "state"):
                try:
                    v = float(v.replace(",", "."))
                except ValueError:
                    if t.tipo != "state":
                        self.errores[t.id] = f"{o}: «{v}» no es un número"
                        continue
            salida[t.id] = v
        return salida

    async def descubrir(self) -> list[dict]:
        fila = await self.en_hilo(self._ultima_fila)
        return [] if not fila else [{"origen": c, "ejemplo": v} for c, v in zip(*fila)]
