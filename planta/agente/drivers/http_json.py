"""HTTP con JSON: equipos modernos con API REST (IO-Link masters, básculas y medidores con red,
robots colaborativos, MES y SCADA web). Solo GET."""
from __future__ import annotations

import json
import urllib.request

from .base import Driver, Tag, ruta_json, secreto


class HttpJson(Driver):
    id = "http"
    nombre = "HTTP / JSON (GET)"
    libreria = "ninguna (librería estándar)"
    sintaxis = "estado|maquina.estado · api/v1/contadores|buenas (ruta relativa a la url de la fuente|campo del JSON)"
    marca = "cabecera X-Sindri-Simulador en la respuesta de la url base"

    async def abrir(self) -> None:
        self.url = self.ajuste("url", obligatorio=True).rstrip("/") + "/"
        self.cabeceras = {"accept": "application/json", "user-agent": "sindri-efesto"}
        token = secreto(self.ajustes, "token")
        if token:
            self.cabeceras["authorization"] = f"Bearer {token}"
        self.marca_vista = (await self.en_hilo(self._get, ""))[1]

    def _get(self, ruta: str) -> tuple[object, bool]:
        req = urllib.request.Request(self.url + ruta.lstrip("/"), headers=self.cabeceras, method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            cuerpo = r.read()
            simulador = r.headers.get("X-Sindri-Simulador") == "1"
        try:
            return json.loads(cuerpo or b"null"), simulador
        except ValueError:
            return cuerpo.decode("utf-8", "replace"), simulador

    async def es_simulador(self) -> bool:
        return self.marca_vista

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.errores = tags, {}

    async def leer(self) -> dict:
        # Una petición por ruta distinta, aunque haya varios tags en ella.
        rutas: dict[str, object] = {}
        salida = {}
        for t in self.tags:
            ruta, _, campo = t.origen.partition("|")
            ruta = ruta.strip()
            if ruta not in rutas:
                try:
                    rutas[ruta] = (await self.en_hilo(self._get, ruta))[0]
                except Exception as e:  # noqa: BLE001
                    rutas[ruta] = None
                    self.errores[t.id] = f"{ruta}: {e}"
            v = ruta_json(rutas[ruta], campo.strip()) if campo.strip() else rutas[ruta]
            if v is not None:
                salida[t.id] = v
        return salida
