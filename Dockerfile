# Imagen del servidor de Sindri (API + web). La aplicación de escritorio no entra aquí.
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
 && pnpm install --frozen-lockfile --filter "@sindri/server..." --filter "@sindri/web..." \
 && pnpm --filter "@sindri/core" build \
 && pnpm --filter "@sindri/server" build \
 && pnpm --filter "@sindri/web" build \
 && pnpm --filter "@sindri/server" deploy --prod --legacy /app \
 && cp -r apps/server/migrations /app/migrations \
 && cp -r apps/server/plantillas /app/plantillas \
 && cp -r apps/web/dist /app/web

FROM node:22-bookworm-slim
# Etiqueta de la imagen (sha-xxxxxxx o vX.Y.Z): se publica en /version/.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    SINDRI_HOST=0.0.0.0 \
    PORT=8000 \
    SINDRI_WEB_DIR=/app/web \
    SINDRI_DATA_DIR=/datos
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /datos && chown node:node /datos
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
