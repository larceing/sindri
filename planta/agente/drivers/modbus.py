"""Modbus TCP y RTU: el más extendido en máquinas sencillas, variadores, contadores de energía,
controladores de temperatura, PLC baratos y pasarelas serie-Ethernet."""
from __future__ import annotations

import re
from dataclasses import dataclass

from .base import MARCA, DireccionNoValida, Driver, Tag

# hr:100 · hr:100:uint32 · hr:100:float32:cdab · 2/ir:30001:int16 · co:5 · di:7
PATRON = re.compile(r"^(?:(\d{1,3})/)?(hr|ir|co|di):(\d{1,5})(?::(int16|uint16|int32|uint32|int64|uint64|float32|float64|string(?:\d+)?))?(?::(abcd|cdab|badc|dcba))?$", re.I)
PALABRAS = {"int16": 1, "uint16": 1, "int32": 2, "uint32": 2, "float32": 2, "int64": 4, "uint64": 4, "float64": 4}


@dataclass
class Direccion:
    unidad: int
    tabla: str
    registro: int
    tipo: str
    orden: str

    @property
    def palabras(self) -> int:
        if self.tipo.startswith("string"):
            return max(1, (int(self.tipo[6:] or 16) + 1) // 2)
        return PALABRAS.get(self.tipo, 1)


def direccion(texto: str, unidad_defecto: int) -> Direccion:
    m = PATRON.match(texto.strip())
    if not m:
        raise DireccionNoValida(f"«{texto}» no es una dirección Modbus (p. ej. hr:100:uint32:abcd)")
    unidad, tabla, reg, tipo, orden = m.groups()
    tabla = tabla.lower()
    return Direccion(int(unidad) if unidad else unidad_defecto, tabla, int(reg), (tipo or ("bool" if tabla in ("co", "di") else "uint16")).lower(), (orden or "abcd").lower())


def decodificar(registros: list[int], d: Direccion):
    """Convierte registros de 16 bits al tipo pedido, con el orden de bytes y palabras de la máquina."""
    if d.tipo == "bool":
        return int(bool(registros[0]))
    regs = list(registros)
    if d.orden in ("badc", "dcba"):  # bytes cambiados dentro de cada palabra
        regs = [((r & 0xFF) << 8) | (r >> 8) for r in regs]
    if d.orden in ("cdab", "dcba"):  # palabras al revés
        regs.reverse()
    crudo = b"".join(r.to_bytes(2, "big") for r in regs)
    if d.tipo.startswith("string"):
        return crudo.split(b"\0", 1)[0].decode("latin-1").strip()
    import struct

    formato = {"int16": ">h", "uint16": ">H", "int32": ">i", "uint32": ">I", "int64": ">q", "uint64": ">Q", "float32": ">f", "float64": ">d"}[d.tipo]
    return struct.unpack(formato, crudo)[0]


class Modbus(Driver):
    id = "modbus"
    nombre = "Modbus TCP / RTU (serie o dentro de TCP)"
    libreria = "pymodbus (BSD-3-Clause)"
    sintaxis = "hr:100:uint32:abcd · ir:3 · co:5 · di:7 · 2/hr:10:float32:cdab (unidad 2)"
    marca = f"identificación del dispositivo (función 43) con fabricante «{MARCA}»"

    async def abrir(self) -> None:
        from pymodbus.client import AsyncModbusSerialClient, AsyncModbusTcpClient

        if self.ajuste("puerto_serie"):
            self.cliente = AsyncModbusSerialClient(
                self.ajuste("puerto_serie"), baudrate=int(self.ajuste("baudios", 9600)), parity=self.ajuste("paridad", "N"),
                stopbits=int(self.ajuste("bits_parada", 1)), bytesize=8, timeout=3,
            )
        else:
            from pymodbus import FramerType

            # trama "rtu": Modbus RTU dentro de TCP, lo normal en pasarelas serie-Ethernet en modo transparente.
            trama = FramerType.RTU if self.ajuste("trama") == "rtu" else FramerType.SOCKET
            self.cliente = AsyncModbusTcpClient(self.ajuste("host", obligatorio=True), port=int(self.ajuste("puerto", 502)), timeout=3, framer=trama)
        if not await self.cliente.connect():
            raise ConnectionError("no responde")
        self.unidad = int(self.ajuste("unidad", 1))

    async def es_simulador(self) -> bool:
        try:
            r = await self.cliente.read_device_information(read_code=1, object_id=0, device_id=self.unidad)
        except Exception:  # noqa: BLE001 - muchas máquinas no tienen la función 43: no es el simulador
            return False
        if r.isError():
            return False
        return r.information.get(0, b"").decode("latin-1", "replace") == MARCA

    async def preparar(self, tags: list[Tag]) -> None:
        self.tags, self.dirs, self.errores = tags, {}, {}
        for t in tags:
            try:
                self.dirs[t.id] = direccion(t.origen, self.unidad)
            except DireccionNoValida as e:
                self.errores[t.id] = str(e)
        # Agrupa direcciones cercanas de la misma tabla en una sola petición (hasta 120 registros).
        self.bloques: list[tuple[int, str, int, int, list]] = []
        porclave = sorted(self.dirs.items(), key=lambda kv: (kv[1].unidad, kv[1].tabla, kv[1].registro))
        for clave, d in porclave:
            fin = d.registro + d.palabras
            b = self.bloques[-1] if self.bloques else None
            if b and b[0] == d.unidad and b[1] == d.tabla and d.registro - b[3] <= 8 and fin - b[2] <= 120:
                self.bloques[-1] = (b[0], b[1], b[2], max(b[3], fin), b[4] + [clave])
            else:
                self.bloques.append((d.unidad, d.tabla, d.registro, fin, [clave]))

    async def leer(self) -> dict:
        salida = {}
        for unidad, tabla, inicio, fin, claves in self.bloques:
            leer = {"hr": self.cliente.read_holding_registers, "ir": self.cliente.read_input_registers,
                    "co": self.cliente.read_coils, "di": self.cliente.read_discrete_inputs}[tabla]
            r = await leer(inicio, count=fin - inicio, device_id=unidad)
            if r.isError():
                for c in claves:
                    self.errores[c] = f"{tabla}:{inicio}: {r}"
                continue
            datos = r.bits if tabla in ("co", "di") else r.registers
            for c in claves:
                d = self.dirs[c]
                trozo = datos[d.registro - inicio: d.registro - inicio + d.palabras]
                salida[c] = decodificar([int(x) for x in trozo], d)
        return salida

    async def cerrar(self) -> None:
        self.cliente.close()
