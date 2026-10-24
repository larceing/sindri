"""Lo justo de Sparkplug B para leer: decodifica y codifica el Payload (protobuf) sin librerías.

Se escribe aquí para no arrastrar dependencias (pysparkplug fija paho-mqtt 1.x) ni el .proto de
Eclipse Tahu. Solo los campos de métricas con valor simple; DataSet y Template se ignoran."""
from __future__ import annotations

import struct
from dataclasses import dataclass

# Tipos de dato de Sparkplug B 3.0
INT8, INT16, INT32, INT64, UINT8, UINT16, UINT32, UINT64, FLOAT, DOUBLE, BOOLEAN, STRING, DATETIME, TEXT = range(1, 15)


@dataclass
class Metrica:
    nombre: str | None = None
    alias: int | None = None
    tipo: int = 0
    valor: object = None
    nulo: bool = False


def _varint(b: bytes, i: int) -> tuple[int, int]:
    v = desplaza = 0
    while True:
        x = b[i]
        i += 1
        v |= (x & 0x7F) << desplaza
        if not x & 0x80:
            return v, i
        desplaza += 7


def _campos(b: bytes):
    i = 0
    while i < len(b):
        clave, i = _varint(b, i)
        num, tipo = clave >> 3, clave & 7
        if tipo == 0:
            v, i = _varint(b, i)
        elif tipo == 1:
            v, i = b[i:i + 8], i + 8
        elif tipo == 2:
            n, i = _varint(b, i)
            v, i = b[i:i + n], i + n
        elif tipo == 5:
            v, i = b[i:i + 4], i + 4
        else:
            raise ValueError("protobuf no válido")
        yield num, v


def _con_signo(v: int, bits: int) -> int:
    v &= (1 << bits) - 1
    return v - (1 << bits) if v >> (bits - 1) else v


def decodificar(payload: bytes) -> tuple[int | None, list[Metrica]]:
    """Devuelve (seq, métricas)."""
    seq, metricas = None, []
    for num, v in _campos(payload):
        if num == 3:
            seq = v
        elif num == 2:
            m = Metrica()
            for n, x in _campos(v):
                if n == 1:
                    m.nombre = x.decode("utf-8")
                elif n == 2:
                    m.alias = x
                elif n == 4:
                    m.tipo = x
                elif n == 7:
                    m.nulo = bool(x)
                elif n == 10:
                    m.valor = x
                elif n == 11:
                    m.valor = x
                elif n == 12:
                    m.valor = struct.unpack("<f", x)[0]
                elif n == 13:
                    m.valor = struct.unpack("<d", x)[0]
                elif n == 14:
                    m.valor = bool(x)
                elif n == 15:
                    m.valor = x.decode("utf-8")
            if isinstance(m.valor, int) and not isinstance(m.valor, bool):
                m.valor = {INT8: lambda v: _con_signo(v, 8), INT16: lambda v: _con_signo(v, 16), INT32: lambda v: _con_signo(v, 32),
                           INT64: lambda v: _con_signo(v, 64)}.get(m.tipo, lambda v: v)(m.valor)
            metricas.append(m)
    return seq, metricas


# Codificar: solo lo usa el simulador ---------------------------------------------------

def _v(n: int) -> bytes:
    salida = b""
    while True:
        x = n & 0x7F
        n >>= 7
        if n:
            salida += bytes([x | 0x80])
        else:
            return salida + bytes([x])


def _c(num: int, tipo: int, dato) -> bytes:
    clave = _v((num << 3) | tipo)
    if tipo == 0:
        return clave + _v(dato)
    if tipo == 2:
        return clave + _v(len(dato)) + dato
    return clave + dato


def codificar(timestamp: int, seq: int, metricas: list[Metrica]) -> bytes:
    cuerpo = _c(1, 0, timestamp)
    for m in metricas:
        b = b""
        if m.nombre:
            b += _c(1, 2, m.nombre.encode())
        if m.alias is not None:
            b += _c(2, 0, m.alias)
        b += _c(3, 0, timestamp) + _c(4, 0, m.tipo)
        if m.tipo in (INT8, INT16, INT32, UINT8, UINT16, UINT32):
            b += _c(10, 0, int(m.valor) & 0xFFFFFFFF)
        elif m.tipo in (INT64, UINT64, DATETIME):
            b += _c(11, 0, int(m.valor) & 0xFFFFFFFFFFFFFFFF)
        elif m.tipo == FLOAT:
            b += _c(12, 5, struct.pack("<f", m.valor))
        elif m.tipo == DOUBLE:
            b += _c(13, 1, struct.pack("<d", m.valor))
        elif m.tipo == BOOLEAN:
            b += _c(14, 0, int(bool(m.valor)))
        elif m.tipo in (STRING, TEXT):
            b += _c(15, 2, str(m.valor).encode())
        cuerpo += _c(2, 2, b)
    return cuerpo + _c(3, 0, seq)
