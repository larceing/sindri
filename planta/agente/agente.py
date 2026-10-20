"""Agente de planta de Sindri (docs/INSTRUCCIONES.md, parte C).

Corre dentro de la fábrica, lee del SCADA por OPC UA y manda los datos al ERP por HTTPS.
La conexión la abre siempre el agente, hacia fuera: el ERP nunca entra en la planta.

- Solo lectura: este programa no escribe nunca en el SCADA ni en un PLC.
- Guarda y reenvía: lo que no se puede mandar se queda en SQLite y sale cuando vuelve la red.
- Resume en origen: estados y textos cuando cambian; contadores y valores, un resumen por minuto.
- La configuración (máquinas y tags) la descarga del ERP; aquí solo va cómo llegar a cada sitio.
- DEV nunca toca la planta de verdad: fuera de PRO solo arranca contra el simulador.

Variables:
  SINDRI_URL                 p. ej. https://dev.<dominio>/sindri  (en local, http://entrada:8000/sindri)
  SINDRI_PLANTA_TOKEN_FICHERO fichero con el token del agente, legible solo por su usuario
  SINDRI_PLANTA_TOKEN        el token directamente (solo para desarrollo)
  OPCUA_URL                  p. ej. opc.tcp://scada:4840/
  OPCUA_USUARIO, OPCUA_CLAVE_FICHERO   usuario de solo lectura del SCADA (opcional)
  OPCUA_SEGURIDAD            p. ej. Basic256Sha256,SignAndEncrypt,cert.der,clave.pem (opcional)
  DATOS                      carpeta para la cola local (por defecto ./datos)
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

VERSION = "0.1.0"
ESPACIO_SIMULADOR = "urn:sindri:simulador"
LOTE = 500

log = logging.getLogger("sindri-planta")


def ahora_iso(t: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if t is None else t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def leer_secreto(var: str) -> str | None:
    """Lee un secreto de un fichero (lo normal) o de la variable sin _FICHERO (solo desarrollo)."""
    ruta = os.environ.get(f"{var}_FICHERO")
    if ruta:
        try:
            with open(ruta, encoding="utf-8") as f:
                return f.read().strip()
        except OSError as e:
            raise SystemExit(f"No puedo leer {ruta} ({e.strerror}). Tiene que ser legible por el usuario del agente.")
    return os.environ.get(var) or None


# Cola local ---------------------------------------------------------------------------

class Cola:
    """Lecturas pendientes de mandar. El id de cada lectura evita duplicados en el ERP."""

    def __init__(self, ruta: str):
        self.db = sqlite3.connect(ruta)
        self.db.execute("create table if not exists pendiente (id text primary key, cuerpo text not null, creado real not null)")
        self.db.commit()

    def meter(self, lecturas: list[dict]) -> None:
        self.db.executemany(
            "insert or ignore into pendiente (id, cuerpo, creado) values (?, ?, ?)",
            [(l["id"], json.dumps(l), time.time()) for l in lecturas],
        )
        self.db.commit()

    def lote(self, n: int = LOTE) -> list[dict]:
        return [json.loads(c) for (c,) in self.db.execute("select cuerpo from pendiente order by creado, id limit ?", (n,))]

    def quitar(self, ids: list[str]) -> None:
        self.db.executemany("delete from pendiente where id = ?", [(i,) for i in ids])
        self.db.commit()

    def cuantas(self) -> int:
        return self.db.execute("select count(*) from pendiente").fetchone()[0]


# Resumen en origen ------------------------------------------------------------------

@dataclass
class Acumulado:
    minuto: int
    n: int = 0
    suma: float = 0.0
    minimo: float = float("inf")
    maximo: float = float("-inf")
    ultimo: float = 0.0


def es_numero(valor) -> bool:
    """Si el valor se puede mandar como número: NaN e infinito no son JSON válido."""
    try:
        return math.isfinite(float(valor))
    except (TypeError, ValueError):
        return False


@dataclass
class Resumidor:
    """Convierte muestras de cada segundo en lo que se manda al ERP."""

    previo: dict[tuple[str, str], object] = field(default_factory=dict)
    acum: dict[tuple[str, str], Acumulado] = field(default_factory=dict)

    def muestra(self, maquina: str, tag: str, tipo: str, valor, t: float) -> list[dict]:
        clave = (maquina, tag)
        salida: list[dict] = []
        if tipo in ("state", "text"):
            if tipo == "state" and not es_numero(valor):
                # Un estado sin número (None, NaN, infinito) no se manda: el ERP rechazaría el lote entero.
                return salida
            if clave not in self.previo or self.previo[clave] != valor:
                self.previo[clave] = valor
                ts = ahora_iso(t)
                l = {"id": f"{maquina}:{tag}:cambio:{ts}", "maquina": maquina, "tag": tag, "tipo": "cambio", "ts": ts}
                if tipo == "text":
                    l["texto"] = None if valor is None else str(valor)[:500]
                else:
                    l["valor"] = float(valor)
                salida.append(l)
            return salida
        # counter y value: un resumen por minuto (con la hora de inicio del minuto).
        if not es_numero(valor):
            return salida
        v = float(valor)
        minuto = int(t // 60)
        a = self.acum.get(clave)
        if a and a.minuto != minuto:
            salida.append(self._cerrar(maquina, tag, a))
            a = None
        if a is None:
            a = self.acum[clave] = Acumulado(minuto)
        a.n += 1
        a.suma += v
        a.minimo = min(a.minimo, v)
        a.maximo = max(a.maximo, v)
        a.ultimo = v
        return salida

    def _cerrar(self, maquina: str, tag: str, a: Acumulado) -> dict:
        ts = ahora_iso(a.minuto * 60)
        return {
            "id": f"{maquina}:{tag}:minuto:{ts}", "maquina": maquina, "tag": tag, "tipo": "minuto", "ts": ts,
            "valor": a.ultimo, "min": a.minimo, "max": a.maximo, "media": round(a.suma / a.n, 4), "n": a.n,
        }


# ERP ----------------------------------------------------------------------------------

class Erp:
    def __init__(self, url: str, token: str):
        self.base = url.rstrip("/") + "/api/planta/v1"
        self.token = token

    def _pedir(self, metodo: str, ruta: str, cuerpo: dict | None = None) -> dict:
        datos = None if cuerpo is None else json.dumps(cuerpo).encode()
        req = urllib.request.Request(self.base + ruta, data=datos, method=metodo, headers={
            "authorization": f"Bearer {self.token}",
            "content-type": "application/json",
            "user-agent": f"sindri-planta/{VERSION}",
        })
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read() or b"{}")

    async def pedir(self, metodo: str, ruta: str, cuerpo: dict | None = None) -> dict:
        return await asyncio.to_thread(self._pedir, metodo, ruta, cuerpo)


def version_tupla(v: str) -> tuple[int, ...]:
    try:
        return tuple(int(x) for x in v.split(".")[:3])
    except ValueError:
        return (0,)


# Bucle principal ------------------------------------------------------------------

class Agente:
    def __init__(self) -> None:
        url = os.environ.get("SINDRI_URL")
        token = leer_secreto("SINDRI_PLANTA_TOKEN")
        self.opc_url = os.environ.get("OPCUA_URL")
        if not url or not token or not self.opc_url:
            raise SystemExit("Faltan SINDRI_URL, el token del agente (SINDRI_PLANTA_TOKEN_FICHERO) u OPCUA_URL.")
        if url.startswith("http://") and not os.environ.get("SINDRI_PERMITIR_HTTP"):
            raise SystemExit("SINDRI_URL tiene que ir por HTTPS (en desarrollo local, SINDRI_PERMITIR_HTTP=1).")
        datos = os.environ.get("DATOS", "datos")
        os.makedirs(datos, exist_ok=True)
        self.erp = Erp(url, token)
        self.cola = Cola(os.path.join(datos, "cola.sqlite"))
        self.resumen = Resumidor()
        self.config: dict | None = None
        self.fuente_ok = False
        self.ultimo_error: str | None = None

    async def cargar_config(self) -> None:
        cfg = await self.erp.pedir("GET", "/config")
        if version_tupla(VERSION) < version_tupla(cfg.get("planta_minima", "0")):
            log.warning("Este agente (%s) es más viejo que el mínimo del ERP (%s): hay que actualizarlo.", VERSION, cfg["planta_minima"])
        if cfg.get("escritura"):
            log.warning("El ERP pide escritura, pero este agente solo lee: se ignora.")
        if cfg != self.config:
            log.info("Configuración: %s en %s, %d máquinas", cfg.get("agente"), cfg.get("entorno"), len(cfg.get("maquinas", [])))
        self.config = cfg

    async def latido(self) -> None:
        await self.erp.pedir("POST", "/latido", {
            "version": VERSION, "pendientes": self.cola.cuantas(), "fuente_ok": self.fuente_ok,
            "error": self.ultimo_error, "ts": ahora_iso(),
        })

    async def enviar(self) -> None:
        while lote := self.cola.lote():
            r = await self.erp.pedir("POST", "/lecturas", {"lecturas": lote})
            # Lo rechazado (hora imposible) tampoco se reintenta: se queda en el registro.
            for i in r.get("rechazadas", []):
                log.warning("El ERP rechaza la lectura %s", i)
            self.cola.quitar([l["id"] for l in lote])
            if len(lote) < LOTE:
                break

    async def cada(self, segundos_clave: str, defecto: float, tarea) -> None:
        while True:
            try:
                await tarea()
            except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
                log.warning("Sin conexión con el ERP (%s): %s", tarea.__name__, e)
            await asyncio.sleep(float((self.config or {}).get(segundos_clave, defecto)))

    async def leer_planta(self) -> None:
        from asyncua import Client

        while self.config is None:
            await asyncio.sleep(1)
        while True:
            try:
                cliente = Client(self.opc_url, timeout=10)
                usuario = os.environ.get("OPCUA_USUARIO")
                if usuario:
                    cliente.set_user(usuario)
                    cliente.set_password(leer_secreto("OPCUA_CLAVE") or "")
                if os.environ.get("OPCUA_SEGURIDAD"):
                    await cliente.set_security_string(os.environ["OPCUA_SEGURIDAD"])
                async with cliente:
                    await self.comprobar_entorno(cliente)
                    await self.bucle_lectura(cliente)
            except PlantaRealEnDev:
                raise
            except Exception as e:  # noqa: BLE001 - la fuente se cae y vuelve; el agente sigue
                self.fuente_ok = False
                self.ultimo_error = f"OPC UA: {e}"[:500]
                log.warning("Sin conexión con OPC UA: %s. Reintento en 10 s.", e)
                await asyncio.sleep(10)

    async def comprobar_entorno(self, cliente) -> None:
        """DEV nunca toca la planta de verdad: fuera de PRO solo vale el simulador."""
        entorno = (self.config or {}).get("entorno", "")
        espacios = await cliente.get_namespace_array()
        if entorno != "pro" and ESPACIO_SIMULADOR not in espacios:
            raise PlantaRealEnDev(f"El ERP es «{entorno}» y {self.opc_url} no es el simulador. Un agente de DEV nunca lee la planta real.")

    async def bucle_lectura(self, cliente) -> None:
        nodos: dict[tuple[str, str], tuple[str, object]] = {}
        version_cfg = None
        while True:
            if self.config is not version_cfg:
                nodos = await self.resolver(cliente)
                version_cfg = self.config
            t = time.time()
            lecturas: list[dict] = []
            for (maquina, tag), (tipo, nodo) in nodos.items():
                valor = await nodo.read_value()
                lecturas += self.resumen.muestra(maquina, tag, tipo, valor, t)
            if lecturas:
                self.cola.meter(lecturas)
            self.fuente_ok, self.ultimo_error = True, None
            await asyncio.sleep(float(self.config.get("lectura_s", 1)))

    async def resolver(self, cliente) -> dict:
        nodos = {}
        for m in self.config.get("maquinas", []):
            ns = await cliente.get_namespace_index(m["espacio"]) if m.get("espacio") else 0
            for t in m["tags"]:
                camino = [f"{ns}:{p}" for p in t["origen"].split("/") if p]
                try:
                    nodos[(m["codigo"], t["clave"])] = (t["tipo"], await cliente.nodes.objects.get_child(camino))
                except Exception as e:  # noqa: BLE001
                    log.warning("No encuentro %s/%s en OPC UA (%s): %s", m["codigo"], t["clave"], t["origen"], e)
        log.info("Leyendo %d tags", len(nodos))
        return nodos

    async def correr(self) -> None:
        log.info("Agente de planta %s: ERP %s, OPC UA %s", VERSION, self.erp.base, self.opc_url)
        await asyncio.gather(
            self.cada("config_s", 300, self.cargar_config),
            self.cada("latido_s", 30, self.latido),
            self.cada("envio_s", 5, self.enviar),
            self.leer_planta(),
        )


class PlantaRealEnDev(Exception):
    pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("asyncua").setLevel(logging.WARNING)
    try:
        asyncio.run(Agente().correr())
    except PlantaRealEnDev as e:
        log.error("%s", e)
        raise SystemExit(2)
