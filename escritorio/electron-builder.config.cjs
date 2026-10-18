// Instaladores del escritorio. Uno por entorno, para que DEV y PRO no se pisen ni se confundan:
//   SINDRI_ENTORNO=dev SINDRI_URL=https://dev.<dominio>/sindri/ pnpm dist   -> «Sindri DEV»
//   SINDRI_ENTORNO=pro SINDRI_URL=https://pro.<dominio>/sindri/ pnpm dist   -> «Sindri»
// La dirección no está en el código: en GitHub sale de vars.URL_DEV / vars.URL_PRO.
// Nada de secretos aquí: el instalador solo sabe a qué dirección ir.
const { mkdirSync, writeFileSync } = require("node:fs");

const entorno = process.env.SINDRI_ENTORNO;
const url = process.env.SINDRI_URL;
if (!["dev", "pro"].includes(entorno) || !url) throw new Error("Faltan SINDRI_ENTORNO (dev o pro) y SINDRI_URL.");
if (!url.startsWith("https://")) throw new Error("SINDRI_URL tiene que ir por HTTPS.");

mkdirSync("build", { recursive: true });
writeFileSync("build/entorno.json", JSON.stringify({ entorno, url }, null, 2));

const pro = entorno === "pro";
module.exports = {
  appId: pro ? "es.sindrierp.escritorio" : `es.sindrierp.escritorio.${entorno}`,
  productName: pro ? "Sindri" : `Sindri ${entorno.toUpperCase()}`,
  executableName: pro ? "sindri" : `sindri-${entorno}`,
  artifactName: pro ? "Sindri-${version}-${os}-${arch}.${ext}" : `Sindri-${entorno.toUpperCase()}-\${version}-\${os}-\${arch}.\${ext}`,
  directories: { output: `release/${entorno}` },
  files: ["dist/**", "package.json"],
  extraResources: [{ from: "build/entorno.json", to: "entorno.json" }],
  publish: null,
  win: { target: "nsis" },
  nsis: { oneClick: false, perMachine: false },
  mac: { target: "dmg" },
  linux: { target: ["AppImage"] },
};
