import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export function useData<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  // Solo cuenta la última petición: una respuesta vieja que llega tarde (p. ej. al buscar) no pisa a la nueva.
  const ultima = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++ultima.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n !== ultima.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (n === ultima.current) setError((e as Error).message);
    } finally {
      if (n === ultima.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Ejecuta una acción mostrando el error si falla. */
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, error, busy, setError };
}
