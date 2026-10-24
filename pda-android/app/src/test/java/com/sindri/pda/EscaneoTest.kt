package com.sindri.pda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

class EscaneoTest {
    private val gs = "\u001d"

    private fun extras(vararg pares: Pair<String, String>): (String) -> String? = pares.toMap()::get

    @Test
    fun dataWedgeGs1128LlevaPrefijoAimYGs() {
        val l = Escaneo.desdeExtras(
            extras(
                Escaneo.DW_DATOS to "01020000000000151727123110L-2610${gs}3724",
                Escaneo.DW_TIPO to "LABEL-TYPE-GS1-128",
            ),
        )!!
        assertEquals(
            "window.dispatchEvent(new CustomEvent('sindri:escaneo',{detail:{datos:\"]C101020000000000151727123110L-2610\\u001d3724\",simbologia:\"]C1\"}}));",
            Escaneo.javascript(l),
        )
    }

    @Test
    fun base64PasaGsYTildes() {
        val texto = "10LOTE-Ñ${gs}3712"
        val b64 = Base64.getEncoder().encodeToString(texto.toByteArray(Charsets.UTF_8))
        val l = Escaneo.desdeExtras(extras(Escaneo.EXTRA_B64 to b64, Escaneo.EXTRA_SIMBOLOGIA to "]d2"))!!
        assertEquals(texto, l.datos)
        assertEquals("]d2", Escaneo.aim(l.simbologia))
    }

    @Test
    fun noDuplicaElPrefijoSiYaVieneDelLector() {
        val js = Escaneo.javascript(Escaneo.Lectura("]C1010200000000001510X", "LABEL-TYPE-EAN128"))
        assertEquals(true, js.contains("datos:\"]C1010200000000001510X\""))
    }

    @Test
    fun honeywellYTextoSinSimbologia() {
        val l = Escaneo.desdeExtras(extras("data" to "UBI-A-01", "aimId" to "]C0"))!!
        assertEquals("UBI-A-01", l.datos)
        assertEquals(true, Escaneo.javascript(l).contains("datos:\"]C0UBI-A-01\""))
        val t = Escaneo.javascript(Escaneo.Lectura("PED-0001", null))
        assertEquals(true, t.endsWith("simbologia:undefined}}));"))
    }

    @Test
    fun sinDatosNoHayLectura() {
        assertNull(Escaneo.desdeExtras(extras()))
        assertNull(Escaneo.desdeExtras(extras(Escaneo.DW_DATOS to "")))
    }

    @Test
    fun cadenaEscapaLoPeligroso() {
        assertEquals("\"a\\\"b\\\\c\\n\\u003c/script>\\u2028\"", Escaneo.cadena("a\"b\\c\n</script> "))
    }

    @Test
    fun tipoDesconocidoQuedaTalCual() {
        assertNull(Escaneo.aim("LABEL-TYPE-RARO"))
        assertEquals(true, Escaneo.javascript(Escaneo.Lectura("X1", "LABEL-TYPE-RARO")).contains("simbologia:\"LABEL-TYPE-RARO\""))
    }
}
