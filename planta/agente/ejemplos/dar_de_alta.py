"""Da de alta en un Sindri de desarrollo las máquinas de maquinas.simulador.json y crea un agente.

  python ejemplos/dar_de_alta.py http://127.0.0.1:8099 usuario fichero_token

Usa la API de administración (/api/v1/planta/...) con usuario y clave básicos, que solo existen en
local. Deja el token del agente en el fichero indicado (nunca en pantalla ni en el repositorio)."""
import base64
import json
import os
import sys
import urllib.request

AQUI = os.path.dirname(os.path.abspath(__file__))


def main(url: str, usuario: str, fichero_token: str) -> None:
    clave = os.environ.get("SINDRI_CLAVE", "")
    cab = {"authorization": "Basic " + base64.b64encode(f"{usuario}:{clave}".encode()).decode(), "content-type": "application/json"}

    def pedir(metodo, ruta, cuerpo=None):
        req = urllib.request.Request(url.rstrip("/") + ruta, data=None if cuerpo is None else json.dumps(cuerpo).encode(), headers=cab, method=metodo)
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"null")

    agente = pedir("POST", "/api/v1/planta/agentes", {"name": "efesto-simulador"})
    fd = os.open(fichero_token, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(agente["token"])
    with open(os.path.join(AQUI, "maquinas.simulador.json"), encoding="utf-8") as f:
        maquinas = json.load(f)
    for m in maquinas:
        pedir("PUT", "/api/v1/planta/maquinas", {
            "code": m["codigo"], "name": f"{m['codigo']} (simulador)", "agent_id": agente["id"], "source_name": m["fuente"],
            "namespace_uri": m.get("espacio"),
            "tags": [{"key": t["clave"], "source": t["origen"], "kind": t["tipo"], "settings": t.get("ajustes")} for t in m["tags"]],
        })
    print(f"Agente {agente['name']} con {len(maquinas)} máquinas. Token en {fichero_token}.")


if __name__ == "__main__":
    main(*sys.argv[1:4])
