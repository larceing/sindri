import { defineConfig } from "vitest/config";

// Cada fichero arranca su propio PostgreSQL embebido (PGlite): en paralelo se pisan y tardan.
export default defineConfig({ test: { fileParallelism: false, hookTimeout: 60_000, testTimeout: 30_000 } });
