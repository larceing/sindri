import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/start.js";

/** El servidor de la fábrica puede servir HTTPS él mismo (lo necesitan las PDA sin conexión). */
describe("HTTPS propio", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sindri-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", join(dir, "clave.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    srv = await startServer({ dataDir: join(dir, "datos"), port: 0, https: { key: readFileSync(join(dir, "clave.pem")), cert: readFileSync(join(dir, "cert.pem")) } });
  });
  afterAll(async () => srv?.close());

  it("responde por HTTPS", async () => {
    expect(srv.url.startsWith("https://")).toBe(true);
    const body = await new Promise<string>((resolve, reject) => {
      request(`${srv.url}/api/health`, { rejectUnauthorized: false }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      }).on("error", reject).end();
    });
    expect(JSON.parse(body)).toBeTruthy();
  });
});
