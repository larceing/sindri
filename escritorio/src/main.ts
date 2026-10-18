/**
 * Sindri de escritorio: una ventana sobre la web (docs/INSTRUCCIONES.md, parte B, forma A).
 *
 * - Es un cliente más: no tiene base de datos, no lleva secretos y solo habla con
 *   https://<entorno>/sindri/ y con su Keycloak. Los datos están en el servidor.
 * - La dirección no está en el código: viene de entorno.json, que se genera al construir
 *   el instalador (vars.URL_DEV en GitHub), o de SINDRI_URL al desarrollar.
 * - La ventana solo navega por Sindri y por Keycloak; el resto se abre en el navegador.
 * - Lo que Sindri abre aparte (los PDF de facturas, pedidos…) se descarga con la sesión de la
 *   ventana a la carpeta de Descargas y se abre con el visor del sistema: el navegador del
 *   sistema no tiene la sesión de Sindri.
 * - Al arrancar mira escritorio_minima en /version/ y, si esta versión es más vieja, pide actualizar.
 * - El instalador de DEV se llama «Sindri DEV», tiene su carpeta de datos y una franja que lo dice.
 */
import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { esMasVieja, leerEntorno, origenKeycloak, type Entorno } from "./entorno.js";

const RELEASES = "https://github.com/larceing/sindri/releases";

/** «Factura F1.pdf», y si ya existe «Factura F1 (2).pdf»… */
function rutaLibre(carpeta: string, fichero: string) {
  const limpio = basename(fichero).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "documento";
  const ext = extname(limpio);
  const base = limpio.slice(0, limpio.length - ext.length);
  let ruta = join(carpeta, limpio);
  for (let i = 2; existsSync(ruta); i++) ruta = join(carpeta, `${base} (${i})${ext}`);
  return ruta;
}

function cargarEntorno(): Entorno {
  let fichero: unknown = undefined;
  for (const ruta of [join(process.resourcesPath ?? "", "entorno.json"), join(app.getAppPath(), "entorno.json")]) {
    try {
      fichero = JSON.parse(readFileSync(ruta, "utf8"));
      break;
    } catch {
      /* sigue buscando */
    }
  }
  return leerEntorno(process.env, fichero);
}

let entorno: Entorno;
try {
  entorno = cargarEntorno();
} catch (e) {
  dialog.showErrorBox("Sindri", (e as Error).message);
  process.exit(1);
}

// DEV y PRO no se pisan: otro nombre y otra carpeta de datos (cookies incluidas).
const nombre = entorno.entorno === "pro" ? "Sindri" : `Sindri ${entorno.entorno.toUpperCase()}`;
app.setName(nombre);
app.setPath("userData", join(app.getPath("appData"), nombre));

const origenes = new Set<string>([new URL(entorno.url).origin]);
const permitido = (destino: string) => {
  try {
    return origenes.has(new URL(destino).origin);
  } catch {
    return false;
  }
};
const abrirFuera = (destino: string) => {
  if (/^https?:\/\//.test(destino)) void shell.openExternal(destino);
};

/** Franja visible en todo lo que no es PRO, para que nadie trabaje en DEV creyendo que es PRO. */
const FRANJA = (texto: string) => `
  html::before { content: "${texto}"; position: fixed; z-index: 2147483647; top: 0; left: 0; right: 0;
    height: 22px; line-height: 22px; text-align: center; font: 600 12px system-ui, sans-serif;
    letter-spacing: .08em; background: #b42318; color: #fff; pointer-events: none; }
  body { margin-top: 22px !important; }`;

function paginaSinConexion(motivo: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="es"><meta charset="utf-8"><title>${esc(nombre)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#181d24">
<h1 style="font-size:1.25rem">No hay conexión con Sindri</h1>
<p>${esc(motivo)}</p><p>Este programa no guarda datos en el equipo: hace falta red para trabajar.</p>
<p>Se vuelve a intentar solo cada 15 segundos.</p></body></html>`)}`;
}

async function comprobarVersion(win: BrowserWindow): Promise<"ok" | "vieja" | "sin-conexion"> {
  try {
    const r = await fetch(new URL("version/", entorno.url), { signal: AbortSignal.timeout(8000) });
    const v = (await r.json()) as { escritorio_minima?: string };
    if (v.escritorio_minima && esMasVieja(app.getVersion(), v.escritorio_minima)) {
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        title: nombre,
        message: "Hay que actualizar Sindri",
        detail: `Esta versión (${app.getVersion()}) es más vieja que la que necesita el servidor (${v.escritorio_minima}). Descarga la nueva y vuelve a abrir.`,
        buttons: ["Descargar", "Salir"],
        defaultId: 0,
      });
      if (response === 0) void shell.openExternal(RELEASES);
      return "vieja";
    }
    return "ok";
  } catch {
    return "sin-conexion";
  }
}

async function abrir() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: nombre,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: `persist:sindri-${entorno.entorno}`,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(nombre);
  });

  // Solo Sindri y Keycloak dentro de la ventana; lo demás, al navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (permitido(url)) win.webContents.downloadURL(url);
    else abrirFuera(url);
    return { action: "deny" };
  });
  const vigilar = (e: Electron.Event, url: string) => {
    if (url.startsWith("data:") || permitido(url)) return;
    e.preventDefault();
    abrirFuera(url);
  };
  win.webContents.on("will-navigate", vigilar);
  win.webContents.on("will-redirect", vigilar);
  if (entorno.entorno !== "pro") win.webContents.on("dom-ready", () => void win.webContents.insertCSS(FRANJA(entorno.entorno.toUpperCase())));

  // Sin permisos de cámara, micrófono, ubicación…: la web no los necesita.
  const sesion = session.fromPartition(`persist:sindri-${entorno.entorno}`);
  sesion.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  // Descargas: a Descargas sin preguntar (sin pisar otra con el mismo nombre); los PDF se abren al acabar.
  sesion.on("will-download", (_e, item) => {
    const destino = rutaLibre(app.getPath("downloads"), item.getFilename());
    item.setSavePath(destino);
    item.once("done", (_ev, estado) => {
      if (estado === "completed" && /\.pdf$/i.test(destino)) void shell.openPath(destino);
    });
  });

  const arrancar = async () => {
    const estado = await comprobarVersion(win);
    if (estado === "vieja") return app.quit();
    if (estado === "sin-conexion") {
      await win.loadURL(paginaSinConexion(`No se puede llegar a ${entorno.url}.`));
      setTimeout(() => void arrancar(), 15_000);
      return;
    }
    const kc = await origenKeycloak(entorno.url);
    if (kc) origenes.add(kc);
    await win.loadURL(entorno.url);
    await capturaDePrueba(win);
  };
  await arrancar();
}

/** Prueba de humo: SINDRI_CAPTURA=fichero.png guarda la ventana y cierra. */
async function capturaDePrueba(win: BrowserWindow) {
  const ruta = process.env.SINDRI_CAPTURA;
  if (!ruta) return;
  await new Promise((r) => setTimeout(r, 3000));
  writeFileSync(ruta, (await win.webContents.capturePage()).toPNG());
  app.quit();
}

function menu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          { label: `Servidor: ${entorno.url}`, enabled: false },
          { label: `Versión ${app.getVersion()}`, enabled: false },
          { label: "Descargas de Sindri", click: () => void shell.openExternal(RELEASES) },
        ],
      },
    ]),
  );
}

// Una sola ventana por entorno.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

app.whenReady().then(async () => {
  menu();
  await abrir();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void abrir();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
