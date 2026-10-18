import { describe, expect, it } from "vitest";
import { esMasVieja, leerEntorno, origenKeycloak } from "../src/entorno.js";

describe("entorno del escritorio", () => {
  it("entorno.json manda sobre las variables", () => {
    const e = leerEntorno({ SINDRI_URL: "http://localhost:8000/sindri" }, { entorno: "dev", url: "https://dev.ejemplo.test/sindri" });
    expect(e).toEqual({ entorno: "dev", url: "https://dev.ejemplo.test/sindri/" });
  });
  it("al desarrollar usa SINDRI_URL", () => {
    expect(leerEntorno({ SINDRI_URL: "http://localhost:8000/sindri/" }).url).toBe("http://localhost:8000/sindri/");
  });
  it("sin dirección, o sin HTTPS fuera de este PC, no arranca", () => {
    expect(() => leerEntorno({})).toThrow(/entorno.json/);
    expect(() => leerEntorno({ SINDRI_URL: "http://dev.ejemplo.test/sindri/" })).toThrow(/HTTPS/);
    expect(() => leerEntorno({}, { entorno: "pro", url: "http://localhost/sindri/" })).toThrow(/PRO/);
    expect(() => leerEntorno({}, { entorno: "qa", url: "https://x.test/" })).toThrow(/desconocido/);
  });
  it("compara versiones", () => {
    expect(esMasVieja("0.1.0", "0.2.0")).toBe(true);
    expect(esMasVieja("0.10.0", "0.9.9")).toBe(false);
    expect(esMasVieja("1.2.0", "1.2.0")).toBe(false);
  });
  it("saca Keycloak de la redirección de /login", async () => {
    const f = (async () => new Response(null, { status: 302, headers: { location: "https://sso.ejemplo.test/realms/general/protocol/openid-connect/auth?x=1" } })) as typeof fetch;
    expect(await origenKeycloak("https://dev.ejemplo.test/sindri/", f)).toBe("https://sso.ejemplo.test");
    const g = (async () => new Response(null, { status: 302, headers: { location: "http://malo.test/" } })) as typeof fetch;
    expect(await origenKeycloak("https://dev.ejemplo.test/sindri/", g)).toBeNull();
  });
});
