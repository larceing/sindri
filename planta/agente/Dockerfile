# Agente de planta de Sindri: ghcr.io/larceing/sindri-planta. No lo despliega el servidor:
# se instala en la fábrica (Docker o servicio de Windows).
FROM python:3.12-slim
WORKDIR /agente
COPY requirements.txt .
# El secreto opcional "ca" sirve para redes con un proxy que intercepta HTTPS. Sin él, no hace nada.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi \
 && pip install --no-cache-dir -r requirements.txt
COPY agente.py .
RUN mkdir /datos && chown nobody /datos
USER nobody
ENV DATOS=/datos
VOLUME /datos
CMD ["python", "-u", "agente.py"]
