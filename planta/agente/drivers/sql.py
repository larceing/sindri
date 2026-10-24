"""Bases de datos de SCADA, MES e históricos (WinCC, Ignition, Zenon, PcVue, tablas de un MES):
una consulta SELECT por tag que devuelve un valor. Solo lectura, comprobado dos veces."""
from __future__ import annotations

import re
import sqlite3

from .base import Driver, Tag, secreto

TABLA_MARCA = "sindri_simulador"
# Una sola sentencia que empieza por SELECT o WITH y sin palabras que cambien datos.
PROHIBIDAS = re.compile(r"\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|call|into|copy|attach|pragma|vacuum|replace)\b", re.I)


def consulta_segura(texto: str) -> str:
    q = texto.strip().rstrip(";").strip()
    if ";" in q or not re.match(r"^(select|with)\b", q, re.I) or PROHIBIDAS.search(q):
        raise ValueError("solo se admite una consulta SELECT, sin ; ni sentencias que cambien datos")
    return q


class Sql(Driver):
    id = "sql"
    nombre = "Base de datos (SELECT)"
    libreria = "sqlite3 (estándar); psycopg (LGPL-3.0) para PostgreSQL; pymssql (LGPL-2.1) para SQL Server"
    sintaxis = "select valor from vista_linea1 where tag = 'Piezas' order by fecha desc limit 1"
    marca = f"existe la tabla {TABLA_MARCA}"

    async def abrir(self) -> None:
        motor = self.ajuste("motor", "sqlite")
        self.motor = motor
        if motor == "sqlite":
            # mode=ro: el propio SQLite impide escribir.
            self.conexion = sqlite3.connect(f"file:{self.ajuste('fichero', obligatorio=True)}?mode=ro", uri=True, check_same_thread=False)
        elif motor == "postgresql":
            import psycopg

            self.conexion = psycopg.connect(self.ajuste("dsn", obligatorio=True), password=secreto(self.ajustes, "clave"), autocommit=False)
            self.conexion.read_only = True  # transacción READ ONLY en el servidor
        elif motor == "mssql":
            import pymssql

            self.conexion = pymssql.connect(server=self.ajuste("host", obligatorio=True), user=self.ajuste("usuario"), password=secreto(self.ajustes, "clave"),
                                            database=self.ajuste("base", obligatorio=True), port=str(self.ajuste("puerto", 1433)), login_timeout=10)
        else:
            raise SystemExit(f"Motor «{motor}» no soportado (sqlite, postgresql, mssql).")

    def _valor(self, q: str):
        cur = self.conexion.cursor()
        try:
            cur.execute(q)
            fila = cur.fetchone()
            return None if fila is None else fila[0]
        finally:
            cur.close()
            if self.motor != "sqlite":
                self.conexion.rollback()  # nada queda abierto ni a medias

    async def es_simulador(self) -> bool:
        try:
            return await self.en_hilo(self._valor, f"select marca from {TABLA_MARCA}") == "SINDRI-SIMULADOR"
        except Exception:  # noqa: BLE001
            return False

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.consultas, self.errores = tags, {}, {}
        for t in tags:
            try:
                self.consultas[t.id] = consulta_segura(t.origen)
            except ValueError as e:
                self.errores[t.id] = str(e)

    async def leer(self) -> dict:
        salida = {}
        for c, q in self.consultas.items():
            try:
                v = await self.en_hilo(self._valor, q)
            except Exception as e:  # noqa: BLE001
                self.errores[c] = str(e)[:200]
                continue
            if v is not None:
                salida[c] = v
        return salida

    async def cerrar(self) -> None:
        self.conexion.close()
