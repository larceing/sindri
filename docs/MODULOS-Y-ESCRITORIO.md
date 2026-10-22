# Sindri: módulos y actualización del escritorio

18-10-2026 · Luis Henry Arce Inga

Copia del documento en Claude: https://claude.ai/code/artifact/e90acaa6-1cfd-4723-8b6b-169e7366be9d

Propuesta: Sindri tiene módulos propios que valen a la vez para la web y para el .exe, y el .exe se actualiza solo. Así el equipo de personalizaciones hace cada encargo como un módulo, sin tocar el núcleo, y cada cliente lleva solo los suyos.

## Qué se pide

- **Un .exe para Windows** que se instale en cada PC.
- **Escalable:** que aguante muchos clientes y muchas personalizaciones sin que el núcleo se convierta en una mezcla de casos especiales.
- **Actualización automática** del programa y de lo que lleve dentro.
- **Módulos especiales** que pueda hacer el equipo de personalizaciones, en Java u otros lenguajes cuando haga falta.
- **Lo que ya está decidido:** el escritorio no tiene base de datos propia ni secretos, y habla solo con `https://<entorno>/sindri/` (instrucciones del servidor, parte B).

## Idea general

Los módulos son de Sindri, no del escritorio. Un módulo se instala en el servidor de un cliente y desde ese momento aparece en la web y en el .exe a la vez. Es el mismo modelo que Odoo, pero con versiones y permisos más estrictos.

- **Núcleo:** lo que hoy es Sindri (pedidos, stock, facturas, VERI\*FACTU, planta). Lo mantiene el equipo de producto y no lleva nada de un cliente concreto.
- **Módulos:** cada personalización. Pueden añadir tablas, rutas de API, pantallas, menús, informes y reacciones a lo que pasa en el núcleo («al confirmar un pedido», «al emitir una factura»).
- **Escritorio (.exe):** la ventana de Sindri más un **puente nativo**. Cuando un módulo necesita algo del PC (puerto serie, impresora, un driver), el puente arranca el programa auxiliar del módulo y le pasa las peticiones.
- **Web:** las mismas pantallas. Lo que necesite el PC le dice al usuario que use el .exe.

```
Servidor del cliente (DEV o PRO)
 ├─ Núcleo (pedidos, stock, facturas, VERI*FACTU, planta)
 ├─ Módulos (tablas, API y pantallas de cada cliente)
 └─ PostgreSQL (datos del núcleo y tablas de los módulos)
        ▲ HTTPS /api/v1            ▲ HTTPS /api/v1 y /api/m          ▲ HTTPS /api/planta/v1
   Navegador                  Sindri .exe (Electron)               Agente de planta
   (mismas pantallas)          ├─ Ventana (pantallas de la web)     (solo lectura)
                               └─ Puente del PC (solo lo que declara cada módulo)
                                     │ JSON por stdin/stdout
                                     ▼
                               Auxiliares del módulo (Java, C# o Python):
                               báscula, Zebra, drivers
```

Todo pasa por el servidor del cliente. El .exe solo añade el puente hacia el PC, y el agente de planta solo manda lecturas.

## Anatomía de un módulo

Un módulo es una carpeta con un manifiesto `sindri-modulo.json`. Sindri lee el manifiesto antes de cargar nada y se niega a cargar un módulo que no encaje.

```json
{
  "id": "conservas-norte.pesaje",
  "nombre": "Pesaje en línea de envasado",
  "version": "1.3.0",
  "sindri": ">=0.4 <0.6",
  "depende": { "sindri.planta": ">=1.0" },
  "permisos": ["pedidos:leer", "stock:escribir", "pc:puerto-serie"],
  "servidor": "servidor/index.js",
  "migraciones": "migraciones/",
  "pantallas": "web/index.js",
  "nativo": { "windows": "nativo/bascula.exe" }
}
```

| Parte | Qué aporta | Dónde corre |
| --- | --- | --- |
| `servidor` | Rutas en `/sindri/api/m/<id>/v1/...` y reacciones a eventos del núcleo | Servidor |
| `migraciones` | Tablas propias con prefijo `m_<id>_`. Nunca cambia tablas del núcleo | PostgreSQL del cliente |
| `pantallas` | Pantallas, menús y campos extra en pantallas del núcleo | Web y .exe |
| `nativo` | Programa auxiliar para el PC, en cualquier lenguaje | Solo en el .exe |

Reglas:

- **Versiones:** `sindri` dice con qué versiones del núcleo funciona. Fuera de ese rango no se carga y se avisa en Ajustes.
- **Solo por la API pública:** un módulo usa el núcleo a través de funciones y eventos documentados, nunca leyendo sus tablas por debajo. Así el núcleo puede cambiar sin romper módulos.
- **Permisos declarados:** lo que no está en `permisos` no se puede hacer. El administrador ve la lista al instalar.
- **Desinstalable:** quitar un módulo no rompe el núcleo. Sus tablas quedan hasta que alguien las borre a mano.

## Diseño de APIs

Todo lo que habla con Sindri pasa por una de cinco APIs, cada una con su versión y su forma de identificarse. Las tres primeras ya existen.

| API | Ruta | Quién la usa | Cómo se identifica | Estado |
| --- | --- | --- | --- | --- |
| Núcleo | `/sindri/api/v1/...` | Web y .exe | Cookie de sesión de Keycloak | Hecha |
| Planta | `/sindri/api/planta/v1/...` | Agente de planta | Token del agente, solo vale aquí | Hecha |
| Versión | `/sindri/version/`, `/sindri/api/v1/compat` | Servidor, .exe, agentes | Abierta | Hecha |
| Módulos | `/sindri/api/m/<id>/v1/...` | Pantallas del módulo | La misma sesión, con los permisos del módulo | Por hacer |
| Integraciones | `/sindri/api/v1/...` con `Authorization: Bearer` | Otros programas del cliente (BI, tienda online, EDI) | Clave de integración con permisos, revocable | Por hacer |

El **puente del PC** no es una API de red: la pantalla llama a `window.sindri.pc` dentro del .exe, y el .exe habla con el programa auxiliar del módulo por su entrada y salida estándar. No se abre ningún puerto en el PC.

### Versiones

- La versión va en la ruta (`v1`). Dentro de `v1` solo se añade: campos nuevos, rutas nuevas, valores nuevos en una lista.
- Quitar o renombrar un campo, o cambiar su significado, es `v2`. `v1` sigue viva mientras `compat` diga que hay clientes que la usan, y como mínimo 6 meses.
- Cada API publica su descripción OpenAPI en `.../openapi.json`, generada desde los mismos esquemas que validan las peticiones. El equipo de personalizaciones trabaja contra ese contrato.

### Convenciones

- **JSON** en todo. Nombres de campo en `snake_case` y en inglés en la API del núcleo, como ya está (`partner_id`). Planta usa nombres en español; se deja así en `v1` y se unifica en `v2`.
- **Recursos en plural** y acciones como subrutas: `POST /sales-orders/{id}/confirm`, no estados cambiados a mano.
- **Importes y cantidades como texto** (`"4.95"`), nunca como número con decimales, para no perder céntimos.
- **Fechas** en ISO 8601. Las horas, en UTC con zona.
- **Listas** con `?limite=` y `?cursor=`, y la respuesta trae `siguiente` cuando hay más.
- **Reintentos seguros:** un `POST` puede llevar `Idempotency-Key`. Si llega dos veces, se hace una. Planta ya lo hace con el id de cada lectura.

### Errores

Siempre la misma forma: `{"error": "texto para la persona", "codigo": "pedido_no_confirmable", "detalles": [...]}`. El texto va en español y se puede enseñar tal cual; `codigo` es estable y es lo que mira un programa.

| Estado | Cuándo |
| --- | --- |
| 400 | Datos mal formados |
| 401 | Sin sesión o token no válido |
| 403 | Sin permiso (no es administrador, o el módulo no lo declaró) |
| 404 | No existe |
| 409 | Choca con el estado (factura ya emitida, código repetido) |
| 422 | Regla de negocio (NIF no válido, sin stock) |

### Eventos

El núcleo publica lo que pasa en una cola dentro de su base: `pedido.confirmado`, `factura.emitida`, `stock.movido`, `planta.parada`. Los módulos se suscriben desde su parte de servidor, y más adelante se podrán mandar a otros programas por webhook firmado. Un módulo que falla al recibir un evento no deshace la operación del núcleo; se reintenta y queda anotado.

## Partes nativas en el PC

Un módulo que necesita el PC lleva un programa auxiliar en el lenguaje que mejor le venga: Java para un driver que solo existe en Java, C# para una DLL de Windows, Python para un lector o un PLC. El .exe lo arranca cuando hace falta y lo para al cerrar.

- **Cómo hablan:** mensajes JSON de una línea por la entrada y salida estándar del programa (JSON-RPC). No abre puertos, así que otro programa del PC no puede colarse.
- **Qué puede pedir la pantalla:** solo las operaciones que el módulo declara en su manifiesto (por ejemplo `bascula.leer`, `etiqueta.imprimir`). El .exe rechaza el resto.
- **Java sin instalar Java:** el auxiliar se empaqueta con su propio Java recortado (`jlink`), igual que C# con `dotnet publish` autocontenido. El cliente no instala nada aparte.
- **Firmado:** el .exe solo arranca auxiliares cuya huella coincide con la del módulo publicado. Un auxiliar cambiado a mano no arranca.
- **Si falla, no tumba nada:** si el auxiliar se cae, la pantalla lo dice y el resto de Sindri sigue funcionando.

Cosas comunes (báscula por puerto serie, impresoras Zebra en ZPL, lectores de códigos) conviene hacerlas una vez como módulos de Sindri, y que las personalizaciones los usen en vez de repetirlos.

## Actualizaciones

Se actualizan tres cosas por separado, cada una a su ritmo, y ninguna puede dejar a un cliente con piezas que no encajan.

| Qué | De dónde sale | Cómo llega | Quién decide |
| --- | --- | --- | --- |
| Núcleo (servidor y web) | Imagen en GHCR | «Poner» en Ajustes del servidor, DEV primero y luego PRO | Luis |
| Módulos | Paquete firmado en el repositorio de módulos | Se instalan en el servidor de cada cliente. La parte de web y la nativa bajan solas al .exe | Equipo de personalizaciones, con visto bueno del cliente |
| Programa .exe | GitHub Releases, `escritorio-vX.Y.Z` | `electron-updater`: descarga en segundo plano y se aplica al reiniciar | Automático |

- **Canales:** el .exe de DEV solo mira las versiones de DEV y el de PRO solo las de PRO, así una prueba nunca llega a producción por error.
- **Firma:** las actualizaciones del .exe van firmadas, con la clave en los secretos de GitHub. Un .exe que no viene de ahí no se instala.
- **Orden:** primero el núcleo en el servidor, después los módulos y por último el .exe. El .exe mira `escritorio_minima` al arrancar y, si es viejo, se actualiza antes de abrir.
- **Vuelta atrás:** cada módulo guarda la versión anterior. Si la nueva falla al arrancar, Sindri vuelve a la anterior y lo avisa en Ajustes. Con una excepción: si la nueva ya cambió sus tablas, no se vuelve sola; por eso sus migraciones solo pueden añadir, nunca borrar.

## Cómo trabaja el equipo de personalizaciones

Cada encargo de un cliente es un módulo en su propio repositorio, con una plantilla común, y nunca un cambio en el repositorio de Sindri.

1. **Empezar:** `sindri modulo nuevo conservas-norte.pesaje` crea el repositorio desde la plantilla: manifiesto, servidor, pantallas, pruebas y el workflow de GitHub.
2. **Desarrollar:** el mismo entorno local de hoy (`docker compose up`) carga el módulo desde su carpeta y lo recarga al guardar. El simulador de planta sirve igual.
3. **Probar:** las pruebas del módulo corren en GitHub contra la versión mínima y la máxima de Sindri que declara. Si no pasan con alguna, no se publica.
4. **Publicar:** una etiqueta `vX.Y.Z` en el repositorio del módulo genera el paquete firmado.
5. **Instalar:** en Ajustes de Sindri del cliente, primero en DEV y después en PRO, como el núcleo.

Reglas:

- Un módulo no toca el código ni las tablas del núcleo. Si necesita algo que el núcleo no ofrece, se pide al equipo de producto un evento o una función nueva en la API, que luego sirve a todos.
- Ningún secreto en un módulo. Si necesita una clave (un transportista, una API externa), la configura el administrador del cliente en Ajustes y se guarda cifrada.
- Lo que sirve a varios clientes sube a un módulo general de Sindri en vez de copiarse.

## Lo que hace falta y lo que decides tú

Del servidor, nada nuevo más allá de PostgreSQL (punto D1 de las instrucciones): los módulos instalados se guardan en la base y en el volumen `/datos` que ya existe.

- [ ] **Un Sindri por cliente o uno para todos.** Recomiendo uno por cliente: sus datos y sus módulos quedan separados y una personalización no puede afectar a otro. Uno compartido es más barato de mantener, pero obliga a separar todo por empresa.
- [ ] **Dónde viven los módulos de clientes.** Recomiendo repositorios privados en `larceing`, uno por módulo, creados desde la plantilla.
- [ ] **Licencia.** Sindri es AGPL. Un módulo que corre dentro de Sindri hereda esa licencia, así que el cliente tiene derecho a su código. Si quieres módulos cerrados, hay que hablarlo antes: cambia la licencia del núcleo o la forma de cargar módulos.
- [ ] **Certificado de firma de Windows.** Sin él, Windows avisa al instalar. Para DEV no hace falta; para clientes sí.
- [ ] **Electron más auxiliares nativos**, en vez de una app entera en Java. Es lo que propone este documento: un solo juego de pantallas, y Java o C# solo donde aportan.

## Plan por fases

Cada fase deja algo que funciona y se puede probar en local antes de pasar a la siguiente.

1. **Contrato de APIs:** OpenAPI de `v1` y de planta, errores con `codigo`, listas con cursor, `Idempotency-Key`. Es la base para todo lo demás.
2. **Actualización del .exe:** `electron-updater` con canal DEV, firmado, y un `escritorio-v0.2.0` que se actualice solo desde el `0.1.0`.
3. **Cargador de módulos en el servidor:** manifiesto, comprobación de versiones y permisos, migraciones con prefijo, rutas en `/api/m/<id>/v1` y eventos del núcleo. Con un módulo de ejemplo.
4. **Pantallas de módulos** en la web y el .exe: menús, pantallas nuevas y campos extra.
5. **Puente del PC y primer auxiliar:** báscula por puerto serie (con un simulador, como el de planta) e impresión ZPL.
6. **Plantilla y herramienta** para el equipo de personalizaciones, con su workflow de pruebas y publicación.
7. **Ajustes de módulos:** instalar, actualizar, volver atrás y ver permisos desde Sindri, DEV primero.

Las fases 1 y 2 no dependen de ninguna decisión pendiente. Puedo empezar por ellas en cuanto me digas.
