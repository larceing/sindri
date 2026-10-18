/**
 * Aplicación de escritorio de Sindri ERP.
 *
 * Dos modos (se elige en el menú "Conexión" y se guarda en config.json):
 *  - Local: arranca dentro de la propia aplicación el servidor y una base de datos PostgreSQL
 *    embebida (PGlite) guardada en la carpeta de datos del usuario. No necesita internet ni
 *    instalar nada más. Pensado para un puesto o para probar.
 *  - Servidor de la empresa: se conecta al servidor Sindri instalado en la red local de la
 *    fábrica (http://servidor:3210). Varios puestos trabajan a la vez sobre los mismos datos.
 */
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "@sindri/server";

interface Config {
  mode: "local" | "remote";
  serverUrl?: string;
}

const configPath = () => join(app.getPath("userData"), "config.json");
const dataDir = () => join(app.getPath("userData"), "datos");

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Config;
  } catch {
    return { mode: "local" };
  }
}
const saveConfig = (c: Config) => writeFile(configPath(), JSON.stringify(c, null, 2));

/** La web compilada: dentro del instalador va en resources/web; en desarrollo, en apps/web/dist. */
function webDir(): string {
  const packaged = join(process.resourcesPath, "web");
  return existsSync(packaged) ? packaged : fileURLToPath(new URL("../../web/dist", import.meta.url));
}

let server: RunningServer | null = null;
let win: BrowserWindow | null = null;

async function resolveUrl(cfg: Config): Promise<string> {
  if (cfg.mode === "remote" && cfg.serverUrl) return cfg.serverUrl.replace(/\/$/, "");
  if (!server) server = await startServer({ dataDir: dataDir(), port: 0, webDir: webDir() });
  return server.url;
}

async function openWindow() {
  const cfg = await loadConfig();
  let url: string;
  try {
    url = await resolveUrl(cfg);
  } catch (e) {
    dialog.showErrorBox("Sindri ERP", `No se pudo arrancar: ${(e as Error).message}`);
    app.quit();
    return;
  }
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: "Sindri ERP",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Los enlaces externos (p. ej. el cotejo del QR en la AEAT) se abren en el navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  await win.loadURL(`${url}/#/pedidos`);

  // Prueba de humo automática: SINDRI_SMOKE_SHOT=captura.png guarda una captura y cierra.
  const shot = process.env.SINDRI_SMOKE_SHOT;
  if (shot) {
    await new Promise((r) => setTimeout(r, 2500));
    const image = await win.webContents.capturePage();
    await writeFile(shot, image.toPNG());
    app.quit();
  }
}

async function switchMode(cfg: Config) {
  await saveConfig(cfg);
  app.relaunch();
  app.exit(0);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      {
        label: "Conexión",
        submenu: [
          { label: "Trabajar en local (sin servidor)", click: () => void switchMode({ mode: "local" }) },
          {
            label: "Usar el servidor de la empresa en http://sindri:3210",
            click: () => void switchMode({ mode: "remote", serverUrl: "http://sindri:3210" }),
          },
          { type: "separator" },
          { label: "Abrir carpeta de datos", click: () => void shell.openPath(app.getPath("userData")) },
        ],
      },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

app.whenReady().then(async () => {
  buildMenu();
  await openWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (e) => {
  if (!server) return;
  // Cerramos la base de datos limpiamente antes de salir.
  e.preventDefault();
  const s = server;
  server = null;
  void s.close().finally(() => app.quit());
});
