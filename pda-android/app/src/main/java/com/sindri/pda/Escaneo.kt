package com.sindri.pda

import java.util.Base64

/**
 * Lo que llega de un escáner y cómo se le pasa a la web de Sindri.
 *
 * La web escucha el evento `sindri:escaneo` con `{ datos, simbologia }` (ver
 * `apps/web/src/pda/escaner.ts`). Aquí se arma ese evento a partir del Intent del lector.
 * No usa nada de Android para poder probarlo en el ordenador.
 */
object Escaneo {
    /** Acción del Intent que manda el lector. En DataWedge es «Intent action» del perfil. */
    const val ACCION = "com.sindri.pda.ESCANEO"

    /** Datos en Base64 (UTF-8). Lo usan los scripts de adb: así pasan el GS y las tildes sin líos de comillas. */
    const val EXTRA_B64 = "com.sindri.pda.datos_b64"
    const val EXTRA_DATOS = "com.sindri.pda.datos"
    const val EXTRA_SIMBOLOGIA = "com.sindri.pda.simbologia"

    /** Zebra DataWedge, salida por Intent. */
    const val DW_DATOS = "com.symbol.datawedge.data_string"
    const val DW_TIPO = "com.symbol.datawedge.label_type"

    /** Honeywell («Data Intent» en los ajustes del escáner). */
    const val HW_DATOS = "data"
    const val HW_AIM = "aimId"

    /** Otras marcas de PDA Android (Urovo, Newland…) suelen usar alguno de estos. */
    private val OTROS_DATOS = listOf("barcode_string", "scannerdata", "barcodeData")

    data class Lectura(val datos: String, val simbologia: String?)

    /**
     * Tipo de etiqueta de DataWedge a identificador AIM, el prefijo estándar que dice qué código es
     * (]C1 = GS1-128, ]d2 = GS1 DataMatrix…). La web lo usa para saber que es GS1.
     */
    private val AIM = mapOf(
        "LABEL-TYPE-EAN128" to "]C1",
        "LABEL-TYPE-GS1-128" to "]C1",
        "LABEL-TYPE-CODE128" to "]C0",
        "LABEL-TYPE-GS1-DATAMATRIX" to "]d2",
        "LABEL-TYPE-DATAMATRIX" to "]d1",
        "LABEL-TYPE-GS1-QRCODE" to "]Q3",
        "LABEL-TYPE-QRCODE" to "]Q1",
        "LABEL-TYPE-EAN13" to "]E0",
        "LABEL-TYPE-UPCA" to "]E0",
        "LABEL-TYPE-EAN8" to "]E4",
        "LABEL-TYPE-GS1-DATABAR" to "]e0",
        "LABEL-TYPE-GS1-DATABAR-EXP" to "]e0",
        "LABEL-TYPE-CODE39" to "]A0",
        "LABEL-TYPE-I2OF5" to "]I0",
    )

    /** Identificador AIM de una simbología: ya lo es (]C1) o es un tipo de DataWedge. */
    fun aim(simbologia: String?): String? = when {
        simbologia.isNullOrBlank() -> null
        simbologia.startsWith("]") && simbologia.length == 3 -> simbologia
        else -> AIM[simbologia.trim().uppercase()]
    }

    /** Lee un Intent del lector. `extra` devuelve el texto de cada extra (o null). */
    fun desdeExtras(extra: (String) -> String?): Lectura? {
        val datos = extra(EXTRA_B64)?.let(::deBase64)
            ?: extra(EXTRA_DATOS)
            ?: extra(DW_DATOS)
            ?: extra(HW_DATOS)
            ?: OTROS_DATOS.firstNotNullOfOrNull(extra)
            ?: return null
        if (datos.isEmpty()) return null
        val simbologia = extra(EXTRA_SIMBOLOGIA) ?: extra(DW_TIPO) ?: extra(HW_AIM)
        return Lectura(datos, simbologia)
    }

    private fun deBase64(s: String): String? =
        try {
            String(Base64.getDecoder().decode(s.trim()), Charsets.UTF_8)
        } catch (e: IllegalArgumentException) {
            null
        }

    /** El JavaScript que entrega la lectura a la web. El prefijo AIM va delante si el lector no lo puso. */
    fun javascript(l: Lectura): String {
        val aim = aim(l.simbologia)
        val datos = if (aim != null && !l.datos.startsWith("]")) aim + l.datos else l.datos
        val simb = aim ?: l.simbologia
        return "window.dispatchEvent(new CustomEvent('sindri:escaneo',{detail:{datos:${cadena(datos)}," +
            "simbologia:${if (simb == null) "undefined" else cadena(simb)}}}));"
    }

    /** Literal de cadena de JavaScript (JSON) seguro para cualquier texto, incluido el GS (\u001d). */
    fun cadena(s: String): String {
        val b = StringBuilder(s.length + 2).append('"')
        for (c in s) {
            when {
                c == '"' -> b.append("\\\"")
                c == '\\' -> b.append("\\\\")
                c == '\n' -> b.append("\\n")
                c == '\r' -> b.append("\\r")
                c == '\t' -> b.append("\\t")
                c < ' ' || c == ' ' || c == ' ' || c == '<' ->
                    b.append("\\u").append(String.format("%04x", c.code))
                else -> b.append(c)
            }
        }
        return b.append('"').toString()
    }
}
