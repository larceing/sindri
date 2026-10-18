# Sistema de diseño de Ergane

La investigación completa y las fuentes de cada valor están en la carpeta del proyecto `forja-diseno/`, en los ficheros 01 a 05. En el código, los tokens viven en `apps/web/src/tokens.css`.

## Principios

1. **El color significa algo.** La marca (índigo, tono 268) solo aparece en la acción principal, los enlaces, la selección y el foco.
   - Rojo es error, ámbar es aviso, verde es éxito y azul es información.
   - En una pantalla normal, menos del 10 % es color; el resto son grises.
2. **El color nunca va solo.** Siempre lo acompañan un icono con forma propia, un texto o un número.
3. **El color se define en OKLCH,** un espacio perceptualmente uniforme: dos tonos con la misma L se ven igual de claros.
   - Cada token tiene además su valor hex de respaldo, para los navegadores antiguos de las PDA.
4. **Contraste mínimo.** En oficina se cumple WCAG 2.2 AA: 4,5:1 para texto y 3:1 para bordes de controles. En taller el texto llega a 7:1 o más.
5. **Modo taller según ISA-101.** El fondo es gris medio y lo normal se ve gris. Solo lo anómalo lleva color, y no hay sombras ni animaciones.
   - Las alarmas tienen 4 prioridades, y cada una combina color, forma y número.
   - Hay tema de día y de noche, según el turno.
6. **Densidad sin encoger la letra.** Lo que cambia entre densidades es el espacio:

   | Densidad | Altura de fila |
   |---|---|
   | compacta | 28 px |
   | normal | 36 px |
   | cómoda | 44 px |
   | táctil | 56 px |
   | guantes | 72 px |

   Los botones principales con guantes miden 96 px. Todas estas medidas hay que validarlas en planta.
7. **Escalas matemáticas:**
   - Tipografía de oficina con razón de unos 1,2 sobre una base de 14 px.
   - Tipografía de taller con razón 1,25 sobre 18 px.
   - Espaciado en múltiplos de 4 px.
   - El espacio entre grupos es al menos el doble que dentro del grupo (principio Gestalt de proximidad).
8. **Números según la norma es-ES:**
   - Separador de miles siempre (Intl en es-ES no agrupa las cifras de 4 dígitos), cifras tabulares, alineadas a la derecha y con signo menos tipográfico.
   - Los códigos, lotes, NIF y números de documento van en fuente monoespaciada y nunca se agrupan.
9. **Tiempos de respuesta:**

   | Situación | Tiempo máximo |
   |---|---|
   | Respuesta visible a un toque o a un escaneo | 100 ms |
   | Operaciones normales | 400 ms |
   | Indicador de progreso | de 1 a 10 s |
   | A partir de 10 s | la tarea pasa a segundo plano |

10. **Gráficos:**
    - Paleta Okabe-Ito, segura para daltonismo, con un máximo de 6 series más "Otros".
    - Los colores de estado nunca se usan para series.
    - Las barras empiezan en cero.

## Tipografía e iconos

Todo se sirve desde la propia aplicación, así que funciona sin internet.

| Uso | Elección | Licencia |
|---|---|---|
| Texto | Inter Variable, con cifras tabulares | OFL |
| Códigos | JetBrains Mono | OFL |
| Iconos | Lucide | ISC |

## Preferencias por puesto

En el menú lateral se elige el modo (oficina o taller), el tema (sistema, claro/día u oscuro/noche) y la densidad. Cada equipo recuerda su elección.

## Próximas decisiones de interfaz (de la investigación)

| Necesidad | Elección | Licencia |
|---|---|---|
| Tablas | TanStack Table + TanStack Virtual, dentro de un componente `<ErganeGrid>` propio | MIT |
| Gráficos de negocio | Apache ECharts | Apache-2.0 |
| Series de sensores y PLC | uPlot | MIT |
| Grafos (trazabilidad, listas de materiales, flujos) | React Flow + ELK.js | MIT / GPL |
| PDF | Typst | Apache-2.0 |
| Documentación | Starlight + Pagefind, empaquetada sin conexión en `/ayuda` | — |
| Búsqueda universal ⌘K | `cmdk` | — |
