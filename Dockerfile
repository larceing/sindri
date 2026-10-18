# Imagen del servidor de Ergane (API + web). La aplicación de escritorio no entra aquí.
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
# El secreto opcional "ca" sirve para redes con un proxy que intercepta HTTPS
# (docker build --secret id=ca,src=/ruta/ca.crt). Sin él, no hace nada.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
 && pnpm install --frozen-lockfile --filter "@ergane/server..." --filter "@ergane/web..." \
 && pnpm --filter "@ergane/core" build \
 && pnpm --filter "@ergane/server" build \
 && pnpm --filter "@ergane/web" build \
 && pnpm --filter "@ergane/server" deploy --prod --legacy /app \
 && cp -r apps/server/migrations /app/migrations \
 && cp -r apps/web/dist /app/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    ERGANE_HOST=0.0.0.0 \
    PORT=3210 \
    ERGANE_WEB_DIR=/app/web \
    ERGANE_DATA_DIR=/datos
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /datos && chown node:node /datos
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
