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
    MUSIC_DIR=/music \
    DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
# Изоморфные модули API: server/ импортирует их через относительные пути
# (src/lib/server-library — file API; src/lib/auth — username/сессии;
# src/lib/library — типы и нормализация тегов для серверного сканера).
# Их runtime-импортов за пределы этих каталогов нет (только type-only, стрипятся).
COPY src/lib/server-library ./src/lib/server-library
COPY src/lib/auth ./src/lib/auth
COPY src/lib/library ./src/lib/library
COPY --from=build /app/build ./build
# Каталог постоянных данных (CONTRACTS.md §9): сюда монтируется named volume
# snae-data. Свежий named volume наследует владельца каталога из образа, поэтому
# создаём /data и отдаём его uid 1000 до USER node: приложение сможет писать
# auth.sqlite/library.sqlite. Музыка (/music) остаётся read-only mount'ом.
RUN mkdir -p /data && chown node:node /data
# Непривилегированный пользователь образа node (uid 1000); запись только в /data
USER node
EXPOSE 3000
CMD ["node", "server/index.ts"]
