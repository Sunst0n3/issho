# syntax=docker/dockerfile:1

# Issho in one image: the PWA (built with Vite) and the home server that serves it.
#   docker compose up -d --build

ARG NODE_IMAGE=node:24-slim

# 1. Build the web app.
# The static data in public/data/ is not rebuilt here. Its sources (data-raw/) are git-ignored, so a
# fresh clone on the home server couldn't rebuild it, and shipping the files you already built and
# tested is reproducible. Run `npm run build:data` on your computer (and commit public/data/)
# whenever content/ or data-raw/ changes, then rebuild the image.
FROM ${NODE_IMAGE} AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN for name in kana kanji radicals words curriculum strokes; do \
      test -s "public/data/$name.json" || { \
        echo "public/data/$name.json is missing: run 'npm run build:data' before building the image" >&2; \
        exit 1; \
      }; \
    done \
 && npm run build

# 2. The server's production dependencies.
FROM ${NODE_IMAGE} AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# 3. Runtime. Node runs the TypeScript sources directly (type stripping), so there is no server build.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist
WORKDIR /app
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src
COPY shared ./shared
COPY --from=web /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/src/index.ts"]
