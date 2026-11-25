# Multi-stage сборка Snae Player (контракт: CONTRACTS.md §6)
# Runtime: node server/index.ts — Node 26 исполняет TypeScript нативно.

FROM node:26-alpine AS base
# В Node 26 corepack из дистрибутива исключён; ставим pnpm глобально.
# Версия зафиксирована devEngines.packageManager в package.json.
RUN npm install --global pnpm@12.10.1
WORKDIR /app

# --- Production-зависимости (минимальный runtime без devDependencies) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Среди production-зависимостей нет нативных модулей и postinstall-скриптов,
# поэтому scripts отключены (lockfile не нарушается: --frozen-lockfile).
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# --- Сборка static adapter -> build/ ---
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Build-time настройки по контракту §3 (переопределяются через --build-arg)
ARG PUBLIC_FALLBACK_PAGE=/200.html
ARG PUBLIC_GOAT_COUNTER_URL=
ENV PUBLIC_FALLBACK_PAGE=${PUBLIC_FALLBACK_PAGE} \
    PUBLIC_GOAT_COUNTER_URL=${PUBLIC_GOAT_COUNTER_URL}
RUN pnpm run build

# --- Минимальный runtime ---
FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MUSIC_DIR=/music
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
# Изоморфный модуль API: server/ импортирует его через #lib (package.json#imports)
COPY src/lib/server-library ./src/lib/server-library
COPY --from=build /app/build ./build
# Непривилегированный пользователь образа node (uid 1000); запись на ФС не нужна
USER node
EXPOSE 3000
CMD ["node", "server/index.ts"]
