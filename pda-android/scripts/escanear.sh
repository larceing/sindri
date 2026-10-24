#!/usr/bin/env bash
# Simula lecturas de escáner en el emulador de Android Studio (o en una PDA conectada por USB) con adb.
#
#   ./escanear.sh bonito-caja                un código de codigos-demo.txt, por su nombre
#   ./escanear.sh '0102000000000015<GS>…'    un código cualquiera (<GS> = separador GS1)
#   ./escanear.sh -m teclado lote-bonito     como un lector en modo teclado
#   ./escanear.sh --todos                    todos los de la lista, con pausa
#   ./escanear.sh --lista                    ver la lista
#
# Modos:
#   intent   (por defecto) Como Zebra DataWedge «Intent output»: llega entero, con GS y simbología.
#            Necesita la app Sindri PDA (pda-android) abierta.
#   teclado  Como DataWedge «Keystroke», Honeywell en modo teclado o una pistola: teclea el código
#            y pulsa Intro. Sirve también con Chrome del emulador. El GS no se puede teclear con adb:
#            -g texto lo manda como «<GS>» (Sindri lo entiende) y -g quitar lo pierde, como una pistola.
#
# Con varios dispositivos: ANDROID_SERIAL=emulator-5554 ./escanear.sh …
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
CODIGOS="$DIR/codigos-demo.txt"
ACCION=com.sindri.pda.ESCANEO
PAQUETE=com.sindri.pda
MODO=intent SIMB="" GSMODO=texto PAUSA=2

uso() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
lista() { grep -v '^#' "$CODIGOS" | grep -v '^$'; }

leer() { # datos simbología
  local datos=$1 simb=$2
  if [ "$MODO" = intent ]; then
    local b64
    b64=$(printf '%s' "${datos//<GS>/$'\x1d'}" | base64 | tr -d '\n')
    adb shell am broadcast -a "$ACCION" -p "$PAQUETE" \
      --es com.sindri.pda.datos_b64 "$b64" ${simb:+--es com.sindri.pda.simbologia "$simb"} >/dev/null
  else
    local t=$datos
    [ "$GSMODO" = quitar ] && t=${t//<GS>/}
    t=${t//\'/\'\\\'\'}
    t=${t// /%s}
    adb shell "input text '$t' && input keyevent 66"
  fi
  [ "$MODO" = intent ] || simb=""   # en modo teclado no viaja la simbología
  printf '→ %-7s %-4s %s\n' "$MODO" "${simb:--}" "$datos"
}

ARGS=()
while [ $# -gt 0 ]; do
  case $1 in
    -m) MODO=$2; shift 2 ;;
    -s) SIMB=$2; shift 2 ;;
    -g) GSMODO=$2; shift 2 ;;
    -p) PAUSA=$2; shift 2 ;;
    -h|--help) uso ;;
    --lista) lista | awk -F'|' '{ printf "%-14s %s\n", $1, $4 }'; exit ;;
    --todos)
      lista | while IFS='|' read -r nombre simb datos nota; do
        echo "# $nombre: $nota"; leer "$datos" "$simb" </dev/null; sleep "$PAUSA"
      done
      exit ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[ "${MODO}" = intent ] || [ "${MODO}" = teclado ] || { echo "Modo desconocido: $MODO" >&2; uso 1; }
[ ${#ARGS[@]} -ge 1 ] || uso 1

for c in "${ARGS[@]}"; do
  fila=$(lista | awk -F'|' -v n="${c#@}" '$1 == n')   # por nombre (con o sin @) o el código tal cual
  if [ -n "$fila" ]; then
    IFS='|' read -r _ simb datos _ <<<"$fila"
    leer "$datos" "${SIMB:-$simb}"
  else
    leer "$c" "$SIMB"
  fi
done
