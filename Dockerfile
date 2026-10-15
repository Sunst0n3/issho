# syntax=docker/dockerfile:1

# Issho in one image: the PWA (built with Vite) and the home server that serves it.
#   docker compose up -d --build

ARG NODE_IMAGE=node:24-slim

# 1. Build the web app.
# The study data in public/data/ is committed, and the image ships it as is: its sources (data-raw/)
# are git-ignored, so a fresh clone couldn't rebuild it, and the files you built and tested are the
# reproducible choice. Only a checkout without public/data/ but with data-raw/ builds it here.
# After changing content/ or data-raw/, run `npm run build:data` and commit public/data/.
# The voice clips in public/audio/ are committed the same way (`npm run build:audio` needs a local
# VOICEVOX engine, which this build doesn't have). Without them the image still works: the app then
# reads Japanese with the server's VOICEVOX service, or the phone's own voice.
FROM ${NODE_IMAGE} AS web
WORKDIR /app
# The server's packages too: `npm run build` type-checks the app's integration tests, which run the
# home server in process (src/sync/test-server.ts imports server/src), so tsc needs fastify, zod and
# the rest. The image itself still gets only the server's production packages (stage 2).
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN npm ci && npm ci --prefix server
COPY . .
RUN if [ -s public/data/curriculum.json ]; then \
      echo "Using the committed public/data/"; \
    elif [ -d data-raw ]; then \
      npm run build:data; \
    else \
      echo "public/data/ is missing and there is no data-raw/ to build it from: run 'npm run build:data' first" >&2; \
      exit 1; \
    fi \
 && for name in kana kanji radicals words curriculum strokes; do \
      test -s "public/data/$name.json" || { \
        echo "public/data/$name.json is missing: run 'npm run build:data' and commit public/data/" >&2; \
        exit 1; \
      }; \
    done \
 && if [ ! -s public/audio/manifest.json ]; then \
      echo "warning: public/audio/manifest.json is missing, so the app has no voice clips: it will use server speech or the phone's voice. Run 'npm run build:audio' and commit public/audio/." >&2; \
    fi \
 && npm run build \
 && node server/src/precompress.ts dist

# 2. The server's production dependencies.
FROM ${NODE_IMAGE} AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# 3. Runtime. Node runs the TypeScript sources directly (type stripping), so there is no server build.
# dist/ comes with brotli and gzip copies of its text files (made above), which the server sends to
# browsers that accept them: the app's first download shrinks from about 7 MB to under 2 MB.
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
