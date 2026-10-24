"""Efesto, el agente de planta de Sindri (docs/INSTRUCCIONES.md, parte C, y docs/EFESTO.md).

Corre dentro de la fábrica, lee de los sistemas de producción (OPC UA, Modbus, S7, EtherNet/IP,
MQTT, MTConnect, bases de datos, ficheros, básculas…) con un driver por protocolo, y manda los
datos al ERP por HTTPS. La conexión la abre siempre el agente, hacia fuera.

- Solo lectura: ningún driver escribe en un PLC, un SCADA ni una base de datos.
- Guarda y reenvía: lo que no se puede mandar se queda en SQLite y sale cuando vuelve la red.
- Resume en origen: estados y textos cuando cambian; contadores y valores, un resumen por minuto.
- La configuración (máquinas y tags) la descarga del ERP. Cómo llegar a cada sistema (fuentes)
  vive aquí, en fuentes.json: ni direcciones ni claves de la fábrica salen de ella.
- DEV nunca toca la planta de verdad: fuera de PRO, cada fuente tiene que ser el simulador.

Variables:
  SINDRI_URL                  p. ej. https://dev.<dominio>/sindri  (en local, http://entrada:8000/sindri)
  SINDRI_PLANTA_TOKEN_FICHERO fichero con el token del agente, legible solo por su usuario
  SINDRI_PLANTA_TOKEN         el token directamente (solo para desarrollo)
  EFESTO_FUENTES              fichero de fuentes (por defecto ./fuentes.json; ver fuentes.ejemplo.json)
  OPCUA_URL, OPCUA_USUARIO, OPCUA_CLAVE_FICHERO, OPCUA_SEGURIDAD
                              sin fuentes.json: una sola fuente OPC UA, como en la versión 0.1
  DATOS                       carpeta para la cola local (por defecto ./datos)

Uso:
  python agente.py                     lee y manda
  python agente.py drivers             qué drivers hay
  python agente.py descubrir <fuente>  qué se puede leer en una fuente (solo el simulador, salvo
                                       EFESTO_DESCUBRIR_REAL=1 en la propia fábrica)
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

import drivers
from drivers.base import Driver, Tag, transformar

VERSION = "0.2.0"
LOTE = 500

log = logging.getLogger("efesto")


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


# Fuentes ------------------------------------------------------------------------------

def cargar_fuentes() -> dict[str, dict]:
    """fuentes.json: {"nombre": {"driver": "modbus", "host": "...", ...}}. Sin él, OPC UA por variables."""
    ruta = os.environ.get("EFESTO_FUENTES", "fuentes.json")
    if os.path.isfile(ruta):
        with open(ruta, encoding="utf-8") as f:
            # ${VARIABLE} se sustituye por su valor: así una ruta o un host pueden venir del entorno.
            fuentes = json.loads(os.path.expandvars(f.read()))
        for nombre, ajustes in fuentes.items():
            if not isinstance(ajustes, dict) or "driver" not in ajustes:
                raise SystemExit(f"La fuente «{nombre}» de {ruta} no dice qué driver usa.")
            if any(k in ajustes for k in ("clave", "password", "token")):
                raise SystemExit(f"La fuente «{nombre}» lleva una clave en {ruta}: va en un fichero aparte (clave_fichero).")
        return fuentes
    if os.environ.get("OPCUA_URL"):
        return {"opcua": {
            "driver": "opcua", "url": os.environ["OPCUA_URL"], "usuario": os.environ.get("OPCUA_USUARIO"),
            "clave_fichero": os.environ.get("OPCUA_CLAVE_FICHERO"), "seguridad": os.environ.get("OPCUA_SEGURIDAD"),
        }}
    return {}


def tags_por_fuente(config: dict, fuentes: dict) -> tuple[dict[str, list[Tag]], list[str]]:
    """Reparte los tags del ERP entre las fuentes. Una máquina sin fuente usa la única que haya."""
    reparto: dict[str, list[Tag]] = {n: [] for n in fuentes}
    avisos = []
    for m in config.get("maquinas", []):
        fuente = m.get("fuente") or (next(iter(fuentes)) if len(fuentes) == 1 else "opcua")
        if fuente not in fuentes:
            avisos.append(f"La máquina {m['codigo']} usa la fuente «{fuente}», que no está en fuentes.json.")
            continue
        for t in m.get("tags", []):
            reparto[fuente].append(Tag(m["codigo"], t["clave"], t["origen"], t["tipo"], t.get("ajustes") or {}, m.get("espacio")))
    return reparto, avisos


def normalizar(tag: Tag, crudo):
    """Del valor del driver al que entiende el resumen: número para estados, contadores y medidas."""
    v = transformar(crudo, tag.ajustes)
    if tag.tipo == "text":
        return None if v is None else str(v)
    if isinstance(v, str):
        try:
            v = float(v.strip().replace(",", "."))
        except ValueError:
            raise ValueError(f"«{v[:40]}» no es un número (falta un «mapa» en los ajustes del tag)") from None
    if isinstance(v, bool):
        v = int(v)
    if not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)):
        raise ValueError(f"valor no numérico: {v!r}"[:80])
    return v


# Bucle principal ------------------------------------------------------------------

class PlantaRealEnDev(Exception):
    pass


class Agente:
    def __init__(self) -> None:
        url = os.environ.get("SINDRI_URL")
        token = leer_secreto("SINDRI_PLANTA_TOKEN")
        self.fuentes = cargar_fuentes()
        if not url or not token or not self.fuentes:
            raise SystemExit("Faltan SINDRI_URL, el token del agente (SINDRI_PLANTA_TOKEN_FICHERO) o las fuentes (fuentes.json u OPCUA_URL).")
        if url.startswith("http://") and not os.environ.get("SINDRI_PERMITIR_HTTP"):
            raise SystemExit("SINDRI_URL tiene que ir por HTTPS (en desarrollo local, SINDRI_PERMITIR_HTTP=1).")
        for ajustes in self.fuentes.values():
            drivers.cargar(ajustes["driver"])  # falla al arrancar si falta un driver o su librería
        datos = os.environ.get("DATOS", "datos")
        os.makedirs(datos, exist_ok=True)
        self.erp = Erp(url, token)
        self.cola = Cola(os.path.join(datos, "cola.sqlite"))
        self.resumen = Resumidor()
        self.config: dict | None = None
        self.reparto: dict[str, list[Tag]] = {}
        self.estado: dict[str, dict] = {n: {"driver": a["driver"], "ok": False, "error": None, "tags": 0, "fallan": 0} for n, a in self.fuentes.items()}

    @property
    def fuente_ok(self) -> bool:
        return all(e["ok"] for n, e in self.estado.items() if self.reparto.get(n))

    async def cargar_config(self) -> None:
        cfg = await self.erp.pedir("GET", "/config")
        if version_tupla(VERSION) < version_tupla(cfg.get("planta_minima", "0")):
            log.warning("Este agente (%s) es más viejo que el mínimo del ERP (%s): hay que actualizarlo.", VERSION, cfg["planta_minima"])
        if cfg.get("escritura"):
            log.warning("El ERP pide escritura, pero Efesto solo lee: se ignora.")
        if cfg != self.config:
            self.reparto, avisos = tags_por_fuente(cfg, self.fuentes)
            for a in avisos:
                log.warning("%s", a)
            log.info("Configuración: %s en %s, %d máquinas, %s", cfg.get("agente"), cfg.get("entorno"), len(cfg.get("maquinas", [])),
                     ", ".join(f"{n}: {len(t)} tags" for n, t in self.reparto.items()))
        self.config = cfg

    async def latido(self) -> None:
        errores = [f"{n}: {e['error']}" for n, e in self.estado.items() if e["error"] and self.reparto.get(n)]
        await self.erp.pedir("POST", "/latido", {
            "version": VERSION, "pendientes": self.cola.cuantas(), "fuente_ok": self.fuente_ok,
            "error": "; ".join(errores)[:500] or None, "ts": ahora_iso(),
            "fuentes": {n: {k: e[k] for k in ("driver", "ok", "tags", "fallan")} | {"error": (e["error"] or None) and e["error"][:200]}
                        for n, e in self.estado.items()},
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

    async def leer_fuente(self, nombre: str) -> None:
        """Una tarea por fuente: si una máquina se cae, las demás siguen."""
        ajustes = self.fuentes[nombre]
        clase = drivers.cargar(ajustes["driver"])
        estado = self.estado[nombre]
        espera = 5
        while self.config is None:
            await asyncio.sleep(1)
        while True:
            if not self.reparto.get(nombre):
                estado.update(ok=False, error=None, tags=0)
                await asyncio.sleep(5)
                continue
            driver: Driver = clase(nombre, ajustes)
            try:
                await asyncio.wait_for(driver.abrir(), 20)
                await self.comprobar_entorno(nombre, driver)
                espera = 5
                await self.bucle_lectura(nombre, driver)
            except PlantaRealEnDev:
                raise
            except Exception as e:  # noqa: BLE001 - la fuente se cae y vuelve; el agente sigue
                estado.update(ok=False, error=f"{ajustes['driver']}: {e}"[:300])
                log.warning("Fuente %s (%s) sin conexión: %s. Reintento en %d s.", nombre, ajustes["driver"], e, espera)
            finally:
                try:
                    await asyncio.wait_for(driver.cerrar(), 5)
                except Exception:  # noqa: BLE001
                    pass
            await asyncio.sleep(espera)
            espera = min(espera * 2, 120)

    async def comprobar_entorno(self, nombre: str, driver: Driver) -> None:
        """DEV nunca toca la planta de verdad: fuera de PRO solo vale el simulador."""
        entorno = (self.config or {}).get("entorno", "")
        if entorno != "pro" and not await driver.es_simulador():
            raise PlantaRealEnDev(f"El ERP es «{entorno}» y la fuente «{nombre}» ({driver.nombre}) no es el simulador de Sindri ({driver.marca}). Un agente de DEV nunca lee la planta real.")

    async def bucle_lectura(self, nombre: str, driver: Driver) -> None:
        estado = self.estado[nombre]
        version_cfg = None
        avisados: set = set()
        while True:
            if self.config is not version_cfg:
                tags = self.reparto.get(nombre, [])
                if not tags:
                    return
                await driver.preparar(tags)
                version_cfg = self.config
                porid = {t.id: t for t in tags}
                log.info("Fuente %s (%s): leyendo %d tags", nombre, driver.nombre, len(tags) - len(driver.errores))
            t = time.time()
            crudos = await asyncio.wait_for(driver.leer(), 30)
            lecturas: list[dict] = []
            errores = dict(driver.errores)
            for clave, crudo in crudos.items():
                tag = porid.get(clave)
                if not tag:
                    continue
                try:
                    v = normalizar(tag, crudo)
                except ValueError as e:
                    errores[clave] = str(e)
                    continue
                errores.pop(clave, None)
                lecturas += self.resumen.muestra(tag.maquina, tag.clave, tag.tipo, v, t)
            if lecturas:
                self.cola.meter(lecturas)
            for clave, error in errores.items():
                if clave not in avisados:
                    avisados.add(clave)
                    log.warning("Fuente %s, %s/%s: %s", nombre, clave[0], clave[1], error)
            estado.update(ok=True, error=(f"{len(errores)} tags sin leer, p. ej. {next(iter(errores.values()))}"[:300] if errores else None),
                          tags=len(porid), fallan=len(errores))
            await asyncio.sleep(float(self.config.get("lectura_s", 1)))

    async def correr(self) -> None:
        log.info("Efesto %s: ERP %s, fuentes %s", VERSION, self.erp.base, ", ".join(f"{n} ({a['driver']})" for n, a in self.fuentes.items()))
        await asyncio.gather(
            self.cada("config_s", 300, self.cargar_config),
            self.cada("latido_s", 30, self.latido),
            self.cada("envio_s", 5, self.enviar),
            *[self.leer_fuente(n) for n in self.fuentes],
        )


# Herramientas para dar de alta máquinas ------------------------------------------

def listar_drivers() -> None:
    for i in drivers.disponibles():
        try:
            c = drivers.cargar(i)
            print(f"{i:10} {c.nombre}\n           librería: {c.libreria}\n           dirección: {c.sintaxis}\n           simulador: {c.marca}")
        except SystemExit as e:
            print(f"{i:10} no disponible: {e}")


async def descubrir(nombre: str) -> None:
    fuentes = cargar_fuentes()
    if nombre not in fuentes:
        raise SystemExit(f"No hay fuente «{nombre}». Hay: {', '.join(fuentes) or 'ninguna'}.")
    driver = drivers.cargar(fuentes[nombre]["driver"])(nombre, fuentes[nombre])
    await driver.abrir()
    try:
        if not await driver.es_simulador() and os.environ.get("EFESTO_DESCUBRIR_REAL") != "1":
            raise SystemExit(f"«{nombre}» no es el simulador. Para explorar una máquina real, hazlo en la fábrica con EFESTO_DESCUBRIR_REAL=1 (solo lee).")
        for fila in await driver.descubrir():
            print(json.dumps(fila, ensure_ascii=False))
    finally:
        await driver.cerrar()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for ruidoso in ("asyncua", "pymodbus", "snap7", "pyads", "amqtt"):
        logging.getLogger(ruidoso).setLevel(logging.WARNING)
    orden = sys.argv[1:] or ["correr"]
    if orden[0] == "drivers":
        listar_drivers()
    elif orden[0] == "descubrir" and len(orden) == 2:
        asyncio.run(descubrir(orden[1]))
    elif orden[0] == "correr":
        try:
            asyncio.run(Agente().correr())
        except PlantaRealEnDev as e:
            log.error("%s", e)
            raise SystemExit(2)
    else:
        raise SystemExit(__doc__)
