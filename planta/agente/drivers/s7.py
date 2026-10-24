"""Siemens S7 (S7comm): S7-300/400, S7-1200/1500 con PUT/GET permitido y bloques no optimizados,
LOGO! y muchos clones (VIPA, Inovance…). Para S7-1500 con acceso optimizado, mejor su servidor OPC UA."""
from __future__ import annotations


from .base import MARCA, Driver, Tag

DB_MARCA = 9999  # el simulador guarda la marca en DB9999, desde el byte 0


class S7(Driver):
    id = "s7"
    nombre = "Siemens S7 (S7comm)"
    libreria = "python-snap7 3.x, Python puro (MIT)"
    sintaxis = "DB10:4:REAL · DB10:0:DINT · DB10:8.1:BOOL · MW10:INT · DB5:20:STRING[16] (formato PLC4X) o DB10,REAL4 (nodeS7)"
    marca = f"DB{DB_MARCA} empieza por «{MARCA}»"

    async def abrir(self) -> None:
        import snap7

        self.cliente = snap7.client.Client()
        await self.en_hilo(self.cliente.connect, self.ajuste("host", obligatorio=True), int(self.ajuste("rack", 0)),
                           int(self.ajuste("slot", 1)), int(self.ajuste("puerto", 102)))

    async def es_simulador(self) -> bool:
        try:
            datos = await self.en_hilo(self.cliente.db_read, DB_MARCA, 0, len(MARCA))
        except Exception:  # noqa: BLE001 - en un PLC real ese DB no existe
            return False
        return bytes(datos).decode("latin-1", "replace") == MARCA

    async def preparar(self, tags: list[Tag]) -> None:
        import snap7

        self.tags, self.dirs, self.errores = tags, {}, {}
        for t in tags:
            try:
                self.dirs[t.id] = snap7.parse_tag(t.origen, strict=False)
            except ValueError as e:
                self.errores[t.id] = f"{t.origen}: {e}"

    async def leer(self) -> dict:
        if not self.dirs:
            return {}
        claves = list(self.dirs)
        # read_tags junta las lecturas en el menor número de peticiones que permite la PDU.
        valores = await self.en_hilo(self.cliente.read_tags, [self.dirs[c] for c in claves])
        return {c: (v.rstrip("\0 ") if isinstance(v, str) else v) for c, v in zip(claves, valores)}

    async def cerrar(self) -> None:
        try:
            await self.en_hilo(self.cliente.disconnect)
        except Exception:  # noqa: BLE001
            pass


