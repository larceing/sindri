"""OPC UA: SCADA modernos, PLC Siemens S7-1500/1200 (servidor OPC UA), inyectoras Euromap 77/83,
máquinas con umati, Beckhoff, B&R, KEPServerEX e Ignition como pasarela de todo lo demás."""
from __future__ import annotations

from .base import DireccionNoValida, Driver, Tag, secreto

ESPACIO_SIMULADOR = "urn:sindri:simulador"


class OpcUa(Driver):
    id = "opcua"
    nombre = "OPC UA"
    libreria = "asyncua (LGPL-3.0)"
    sintaxis = "Planta/Linea1/Estado (camino desde Objects) · ns=2;s=Linea1.Estado · nsu=urn:fabrica;i=1001"
    marca = f"espacio de nombres {ESPACIO_SIMULADOR}"

    async def abrir(self) -> None:
        from asyncua import Client

        self.cliente = Client(self.ajuste("url", obligatorio=True), timeout=10)
        usuario = self.ajuste("usuario")
        if usuario:
            self.cliente.set_user(usuario)
            self.cliente.set_password(secreto(self.ajustes, "clave") or "")
        if self.ajuste("seguridad"):
            await self.cliente.set_security_string(self.ajuste("seguridad"))
        await self.cliente.connect()

    async def es_simulador(self) -> bool:
        return ESPACIO_SIMULADOR in await self.cliente.get_namespace_array()

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.nodos, self.errores = tags, {}, {}
        for t in tags:
            try:
                if t.origen.startswith(("ns=", "nsu=", "i=", "s=", "g=", "b=")):
                    self.nodos[t.id] = self.cliente.get_node(await self._nodeid(t.origen))
                else:
                    ns = await self.cliente.get_namespace_index(t.espacio) if t.espacio else 0
                    camino = [p if ":" in p else f"{ns}:{p}" for p in t.origen.split("/") if p]
                    if not camino:
                        raise DireccionNoValida("camino vacío")
                    self.nodos[t.id] = await self.cliente.nodes.objects.get_child(camino)
            except Exception as e:  # noqa: BLE001
                self.errores[t.id] = f"{t.origen}: {e}"

    async def _nodeid(self, texto: str) -> str:
        # nsu=<uri>;... se traduce a ns=<índice>;... con el array de espacios del servidor.
        if texto.startswith("nsu="):
            uri, resto = texto[4:].split(";", 1)
            return f"ns={await self.cliente.get_namespace_index(uri)};{resto}"
        return texto

    async def leer(self) -> dict:
        if not self.nodos:
            return {}
        claves = list(self.nodos)
        # Una sola petición para todos los tags (Read con varios nodos).
        valores = await self.cliente.read_values([self.nodos[c] for c in claves])
        return dict(zip(claves, valores))

    async def cerrar(self) -> None:
        try:
            await self.cliente.disconnect()
        except Exception:  # noqa: BLE001
            pass

    async def descubrir(self) -> list[dict]:
        """Recorre Objects (hasta 6 niveles, 2000 variables) y enseña las variables con su tipo."""
        from asyncua import ua

        salida: list[dict] = []
        espacios = await self.cliente.get_namespace_array()

        async def bajar(nodo, camino: list[str], nivel: int) -> None:
            if nivel > 6 or len(salida) >= 2000:
                return
            for hijo in await nodo.get_children(refs=ua.ObjectIds.HierarchicalReferences):
                nombre = await hijo.read_browse_name()
                if nombre.NamespaceIndex == 0:
                    continue  # el modelo estándar del servidor no interesa
                clase = await hijo.read_node_class()
                paso = f"{nombre.NamespaceIndex}:{nombre.Name}"
                if clase == ua.NodeClass.Variable:
                    try:
                        tipo = (await hijo.read_data_type_as_variant_type()).name
                    except Exception:  # noqa: BLE001
                        tipo = "?"
                    salida.append({"origen": "/".join(camino + [nombre.Name]), "espacio": espacios[nombre.NamespaceIndex], "tipo_dato": tipo, "nodo": hijo.nodeid.to_string()})
                await bajar(hijo, camino + [nombre.Name], nivel + 1)

        await bajar(self.cliente.nodes.objects, [], 0)
        return salida


