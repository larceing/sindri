import { useEffect, useState } from "react";

/** Router por hash (#/pedidos/123): funciona igual en web, en escritorio y abriendo el fichero local. */
export const navigate = (path: string) => {
  window.location.hash = path;
};

export function useRoute(): string {
  const get = () => window.location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const on = () => setRoute(get());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
