package com.sindri.pda

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/**
 * Sindri PDA para Android: la PDA web de Sindri a pantalla completa, más lo que una web sola no
 * puede hacer en una PDA:
 * - Recibir el escáner por Intent (Zebra DataWedge, Honeywell…), entero y con su simbología.
 * - Configurar DataWedge solo en las Zebra.
 * - Leer con la cámara en móviles sin escáner.
 *
 * Servidor: se pregunta la primera vez, o se pasa al abrir con `--es url http://…`.
 * En el emulador, el PC es 10.0.2.2.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("sindri", Context.MODE_PRIVATE) }
    private var dataWedge = false

    private val receptor = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            @Suppress("DEPRECATION")
            Escaneo.desdeExtras { k -> i.extras?.get(k) as? String }?.let(::entregar)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect desde el PC

        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // la cola sin conexión vive en localStorage
            mediaPlaybackRequiresUserGesture = false
        }
        web.webViewClient = object : WebViewClient() {
            // Solo Sindri dentro de la app; cualquier otro enlace, al navegador.
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                val actual = Uri.parse(servidor() ?: return false)
                if (r.url.host == actual.host && r.url.port == actual.port) return false
                startActivity(Intent(Intent.ACTION_VIEW, r.url))
                return true
            }

            // Sin servidor: una página propia con «Reintentar» y «Cambiar servidor» en vez de la de Android.
            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                if (!r.isForMainFrame) return
                Log.w(TAG, "No carga ${r.url}: ${e.errorCode} ${e.description}")
                v.loadDataWithBaseURL(null, paginaSinServidor(r.url.toString(), e.description.toString()), "text/html", "utf-8", null)
            }
        }
        web.addJavascriptInterface(Puente(), "SindriAndroid")

        dataWedge = DataWedge.instalado(this)
        if (dataWedge) DataWedge.configurar(this)

        val url = intent.getStringExtra("url")?.also(::guardarServidor) ?: servidor()
        if (url == null) pedirServidor() else web.loadUrl(url)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra("url")?.let {
            guardarServidor(it)
            web.loadUrl(it)
        }
    }

    override fun onResume() {
        super.onResume()
        // Con la categoría DEFAULT casan los Intent que la llevan (DataWedge) y los que no llevan
        // ninguna (adb, Honeywell). Exportado: lo manda otra app.
        val filtro = IntentFilter(Escaneo.ACCION).apply { addCategory(Intent.CATEGORY_DEFAULT) }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receptor, filtro, Context.RECEIVER_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") registerReceiver(receptor, filtro)
    }

    override fun onPause() {
        unregisterReceiver(receptor)
        super.onPause()
    }

    @Deprecated("Atrás del sistema")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else menu()
    }

    private fun entregar(l: Escaneo.Lectura) {
        Log.d(TAG, "Escaneo ${l.simbologia ?: "-"} ${l.datos.replace('\u001d', '|')}")
        runOnUiThread { web.evaluateJavascript(Escaneo.javascript(l), null) }
    }

    private fun servidor(): String? = prefs.getString("url", null)
    private fun guardarServidor(url: String) = prefs.edit().putString("url", url).apply()

    private fun pedirServidor() {
        val campo = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(servidor() ?: "http://10.0.2.2:8000/#/pda")
            setSelectAllOnFocus(true)
        }
        AlertDialog.Builder(this)
            .setTitle("Servidor de Sindri")
            .setMessage("Dirección de la PDA de Sindri. En el emulador, el PC es 10.0.2.2.")
            .setView(campo)
            .setCancelable(servidor() != null)
            .setPositiveButton("Abrir") { _, _ ->
                var url = campo.text.toString().trim()
                if (!url.contains("://")) url = "http://$url"
                if (!url.contains("#")) url = url.trimEnd('/') + "/#/pda"
                guardarServidor(url)
                web.loadUrl(url)
            }
            .show()
    }

    private fun menu() {
        AlertDialog.Builder(this)
            .setTitle("Sindri PDA ${BuildConfig.VERSION_NAME}")
            .setItems(arrayOf("Recargar", "Cambiar servidor", "Salir")) { _, i ->
                when (i) {
                    0 -> web.reload()
                    1 -> pedirServidor()
                    else -> finish()
                }
            }
            .show()
    }

    /** Lector de Google por cámara. Necesita Play Services (en el emulador, imagen «Google APIs»). */
    private fun leerConCamara() {
        val opciones = GmsBarcodeScannerOptions.Builder().enableAutoZoom().build()
        GmsBarcodeScanning.getClient(this, opciones).startScan()
            .addOnSuccessListener { b ->
                val datos = b.rawValue ?: return@addOnSuccessListener
                val aim = when (b.format) {
                    Barcode.FORMAT_EAN_13, Barcode.FORMAT_UPC_A -> "]E0"
                    Barcode.FORMAT_EAN_8 -> "]E4"
                    else -> null // GS1-128 y DataMatrix: la web lo reconoce por el contenido
                }
                entregar(Escaneo.Lectura(datos, aim))
            }
            .addOnFailureListener { e -> Toast.makeText(this, "Cámara: ${e.message}", Toast.LENGTH_LONG).show() }
    }

    /** Lo que la web puede pedir a la app: `window.SindriAndroid`. */
    inner class Puente {
        @JavascriptInterface
        fun info(): String =
            "{\"version\":${Escaneo.cadena(BuildConfig.VERSION_NAME)},\"dataWedge\":$dataWedge,\"camara\":true}"

        @JavascriptInterface
        fun gatillo() = runOnUiThread { if (dataWedge) DataWedge.gatillo(this@MainActivity) }

        @JavascriptInterface
        fun camara() = runOnUiThread { leerConCamara() }

        @JavascriptInterface
        fun servidor() = runOnUiThread { pedirServidor() }

        @JavascriptInterface
        fun recargar() = runOnUiThread { this@MainActivity.servidor()?.let { web.loadUrl(it) } }
    }

    private fun paginaSinServidor(url: String, error: String): String {
        val esc = { t: String -> t.replace("&", "&amp;").replace("<", "&lt;") }
        return """<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font:17px sans-serif;margin:0;padding:24px;background:#f4f6f8;color:#14212b">
<h2 style="margin-top:8px">Sindri no responde</h2>
<p>No se puede abrir <b style="word-break:break-all">${esc(url)}</b>.</p>
<p style="color:#5a6773">${esc(error)}. ¿Está arrancado el servidor y la PDA en su red? En el emulador, el PC es 10.0.2.2.</p>
<button onclick="SindriAndroid.recargar()" style="display:block;width:100%;min-height:56px;margin:16px 0 10px;border:0;border-radius:12px;background:#1d4e79;color:#fff;font:inherit;font-weight:700">Reintentar</button>
<button onclick="SindriAndroid.servidor()" style="display:block;width:100%;min-height:56px;border:2px solid #1d4e79;border-radius:12px;background:none;color:#1d4e79;font:inherit;font-weight:700">Cambiar servidor</button>
</body>"""
    }

    companion object {
        private const val TAG = "SindriPDA"
    }
}
