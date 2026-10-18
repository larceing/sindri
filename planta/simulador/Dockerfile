# Simulador OPC UA de una línea de planta. Solo para desarrollo y DEV: nunca la planta de verdad.
FROM python:3.12-slim
WORKDIR /sim
COPY requirements.txt .
# El secreto opcional "ca" sirve para redes con un proxy que intercepta HTTPS. Sin él, no hace nada.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi \
 && pip install --no-cache-dir -r requirements.txt
COPY simulador.py .
USER nobody
EXPOSE 4840
CMD ["python", "-u", "simulador.py"]
