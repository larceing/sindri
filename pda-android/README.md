# Sindri PDA para Android

App Android mínima que abre la PDA web de Sindri (`#/pda`) a pantalla completa y le añade lo que una web sola no puede hacer en una PDA:

- **Recibir el escáner por Intent**, como lo manda Zebra DataWedge («Intent output») o Honeywell («Data Intent»): llega entero, con el separador GS1 y el tipo de código. La app lo pasa a la web como el evento `sindri:escaneo`, el mismo que usa el simulador.
- **Configurar DataWedge sola** en las Zebra: crea el perfil `SindriPDA` (escáner activo, salida por Intent, sin teclear) si no existe.
- **Gatillo por software**: en una Zebra, tocar el recuadro «Lee…» de cada pantalla dispara el lector.
- **Leer con la cámara** (botón de cámara arriba) en móviles sin lector, con el lector de Google (ML Kit). No pide permiso de cámara: lo pone Play Services.

Sigue funcionando el **modo teclado** (lectores que teclean el código y pulsan Intro): la web lo reconoce por la velocidad.

Más contexto: [docs/PDA.md](../docs/PDA.md).

## Probar en el emulador de Android Studio

No hace falta ninguna PDA. El emulador no tiene DataWedge, pero los scripts de `scripts/` mandan exactamente lo mismo que mandaría DataWedge.

### 1. Sindri en el PC, con datos de demostración

```powershell
pnpm install; pnpm build
$env:SINDRI_DEMO = "1"; pnpm --filter @sindri/server start      # http://127.0.0.1:8000
```

El emulador ve el PC como `10.0.2.2`, así que la PDA estará en `http://10.0.2.2:8000/#/pda`. No hace falta abrir Sindri a la red.

### 2. Un dispositivo virtual

Android Studio → **Device Manager** → **Create Virtual Device**:

- Teléfono pequeño (p. ej. Pixel 4a o «Small Phone»), que se parece a una PDA de 5-6".
- Imagen **Google APIs** o **Google Play**, API 34 o 35, x86_64. Hace falta Google para la lectura por cámara; para lo demás vale cualquiera.

### 3. Instalar y abrir la app

Abre la carpeta `pda-android` en Android Studio y pulsa **Run**. O desde una terminal:

```powershell
cd pda-android
.\gradlew installDebug
adb shell am start -n com.sindri.pda/.MainActivity --es url "http://10.0.2.2:8000/#/pda"
```

La primera vez pregunta el servidor (ya viene `http://10.0.2.2:8000/#/pda`). Para cambiarlo: botón Atrás en el menú de la PDA → «Cambiar servidor».

### 4. Escanear

Con la app abierta (por ejemplo en «Recibir»):

```powershell
cd pda-android\scripts
.\escanear.ps1 -Lista                       # códigos de prueba preparados
.\escanear.ps1 bonito-caja                  # como DataWedge por Intent: GS1-128 con lote, caducidad y 24 ud
.\escanear.ps1 -Modo teclado lote-bonito    # como un lector en modo teclado
.\escanear.ps1 -Modo teclado -Gs quitar bonito-caja   # una pistola que pierde el GS
.\escanear.ps1 -Todos -Pausa 3              # todos seguidos
.\escanear.ps1 '0102000000000015<GS>3712'   # cualquier código; <GS> es el separador GS1
```

En Linux o macOS, lo mismo con `./escanear.sh` (`-m teclado`, `-g quitar`, `--todos`, `--lista`).

Qué hace cada modo por dentro:

| Modo | Orden adb | Equivale a |
|---|---|---|
| `intent` | `adb shell am broadcast -a com.sindri.pda.ESCANEO -p com.sindri.pda --es com.sindri.pda.datos_b64 <base64> --es com.sindri.pda.simbologia ]C1` | DataWedge «Intent output» (`com.symbol.datawedge.data_string` y `label_type`), que la app también acepta tal cual |
| `teclado` | `adb shell "input text '<código>' && input keyevent 66"` | DataWedge «Keystroke», Honeywell en modo teclado, pistola USB o Bluetooth |

Los datos van en Base64 para que el GS (carácter 29) y las tildes lleguen sin problemas de comillas. Con `adb shell input` no se puede teclear el GS: `-Gs texto` (por defecto) lo manda como `<GS>`, que Sindri entiende, y `-Gs quitar` lo pierde, para ver el aviso de un lote pegado a la cantidad.

El modo teclado también sirve **sin la app**, con Chrome del emulador abriendo `http://10.0.2.2:8000/#/pda`.

### 5. Otras pruebas con componentes virtuales

- **Pistola USB real en el PC**: el emulador recibe el teclado del PC, así que una pistola conectada al PC «teclea» dentro del emulador como lo haría en la PDA.
- **Cámara**: en el emulador, `⋯` (Extended controls) → **Camera** → **Virtual scene images**: pon la imagen de una etiqueta en la pared o la mesa de la escena virtual y pulsa el botón de cámara de la app. También se puede usar la webcam del PC como cámara trasera (ajuste del dispositivo virtual → Camera → Back: Webcam0) y enseñarle una etiqueta impresa o en el móvil.
- **Sin red**: en el emulador, desactiva datos y wifi (o modo avión). La PDA sigue trabajando y manda lo pendiente al volver.
- **Ver qué pasa dentro de la web**: con la app de depuración abierta, `chrome://inspect` en el Chrome del PC muestra la consola de la PDA.

## Compilar sin Android Studio

Con JDK 17 o superior y el Android SDK (`ANDROID_HOME` o `local.properties` con `sdk.dir=…`):

```bash
./gradlew testDebugUnitTest assembleDebug     # pruebas y APK en app/build/outputs/apk/debug/
```

## En una PDA de verdad

- **Zebra**: instala el APK y ábrelo. Debería crear el perfil `SindriPDA` en DataWedge. Si una PDA ya tenía un perfil para Chrome o para esta app, revisa en DataWedge que «Intent output» esté activo con la acción `com.sindri.pda.ESCANEO` y entrega «Broadcast intent», y que «Keystroke output» esté apagado (o se leería dos veces).
- **Honeywell**: Ajustes → Scanning → perfil de la app → Data Processing / Data Intent: acción `com.sindri.pda.ESCANEO`. La app lee los extras `data` y `aimId`.
- **Otras marcas** (Urovo, Newland…): configura la salida por broadcast con la acción `com.sindri.pda.ESCANEO`; la app prueba los extras más comunes (`barcode_string`, `scannerdata`…).

Sin probar todavía en una Zebra ni en una Honeywell reales.

## Qué hay dentro

| Fichero | Qué hace |
|---|---|
| `app/src/main/java/com/sindri/pda/MainActivity.kt` | WebView, servidor, recepción de Intents, cámara y el puente `window.SindriAndroid` |
| `app/src/main/java/com/sindri/pda/Escaneo.kt` | Lee los extras de cada marca y arma el evento para la web (con el prefijo AIM: `]C1` = GS1-128…). Sin Android: se prueba en el PC |
| `app/src/main/java/com/sindri/pda/DataWedge.kt` | Perfil automático y gatillo de Zebra |
| `scripts/escanear.ps1`, `scripts/escanear.sh` | Lecturas simuladas por adb |
| `scripts/codigos-demo.txt` | Códigos de prueba para los datos de demostración |

El puente `window.SindriAndroid` (solo existe dentro de la app) ofrece `info()`, `gatillo()`, `camara()` y `servidor()`. La web lo usa en `apps/web/src/pda/escaner.ts` (`appAndroid()`).

Solo se cargan páginas del servidor configurado; cualquier otro enlace se abre en el navegador. El receptor de escaneos está abierto a otras apps del aparato (DataWedge es otra app): en una PDA de empresa eso es lo normal, pero conviene saberlo.
