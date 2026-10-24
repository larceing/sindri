package com.sindri.pda

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle

/**
 * Zebra DataWedge: el servicio de las PDA Zebra que lee el escáner y manda el resultado a las apps.
 *
 * Al arrancar en una Zebra, la app crea su perfil «SindriPDA» si no existe: escáner activo, salida
 * por Intent con nuestra acción (llega entero, con el GS y la simbología) y sin teclear. Si alguien
 * ya lo cambió a mano en la PDA, se respeta.
 *
 * Sin probar todavía en una Zebra real: el emulador de Android no tiene DataWedge.
 */
object DataWedge {
    const val PAQUETE = "com.symbol.datawedge"
    private const val API = "com.symbol.datawedge.api.ACTION"
    const val PERFIL = "SindriPDA"

    fun instalado(c: Context): Boolean =
        try {
            c.packageManager.getPackageInfo(PAQUETE, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }

    fun configurar(c: Context) {
        fun plugin(nombre: String, params: Bundle) = Bundle().apply {
            putString("PLUGIN_NAME", nombre)
            putString("RESET_CONFIG", "true")
            putBundle("PARAM_LIST", params)
        }
        val perfil = Bundle().apply {
            putString("PROFILE_NAME", PERFIL)
            putString("PROFILE_ENABLED", "true")
            putString("CONFIG_MODE", "CREATE_IF_NOT_EXIST")
            putParcelableArray(
                "APP_LIST",
                arrayOf(Bundle().apply {
                    putString("PACKAGE_NAME", c.packageName)
                    putStringArray("ACTIVITY_LIST", arrayOf("*"))
                }),
            )
            putParcelableArrayList(
                "PLUGIN_CONFIG",
                arrayListOf(
                    plugin("BARCODE", Bundle().apply {
                        putString("scanner_selection", "auto")
                        putString("scanner_input_enabled", "true")
                    }),
                    plugin("INTENT", Bundle().apply {
                        putString("intent_output_enabled", "true")
                        putString("intent_action", Escaneo.ACCION)
                        putString("intent_delivery", "2") // 2 = broadcast
                    }),
                    plugin("KEYSTROKE", Bundle().apply {
                        putString("keystroke_output_enabled", "false")
                    }),
                ),
            )
        }
        c.sendBroadcast(Intent(API).putExtra("com.symbol.datawedge.api.SET_CONFIG", perfil))
    }

    /** Gatillo por software: como pulsar el botón de escanear. */
    fun gatillo(c: Context) {
        c.sendBroadcast(Intent(API).putExtra("com.symbol.datawedge.api.SOFT_SCAN_TRIGGER", "TOGGLE_SCANNING"))
    }
}
