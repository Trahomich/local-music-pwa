# Контракты доработки Snae Player

## 1. Решения и границы цели

Решения пользователя (не допущения):
- Серверная библиотека **только для чтения**: рекурсивно показывать существующие файлы; загрузки, переименования и удаления через UI/API нет.
- Русский язык добавить через существующий механизм `messages/*.json`, а не заменять им остальные языки. Не сбрасывать уже выбранную пользователем локаль.
- Аккаунты и авторизация не нужны. Сервис рассчитан на доверенную локальную сеть; README должен предупреждать о публикации без внешней защиты.
- Плейлисты, избранное, история, очередь и настройки остаются в браузере и работают как раньше. Сервер хранит только обычные аудиофайлы.

Допущения архитектора:
- Локальные каталоги и импорт через Files API должны продолжить работать; серверный источник добавляется к ним, а не заменяет их.
- В текущем Compose-развёртывании `player` делит network namespace с Yggdrasil-sidecar и доступен по его IPv6; хостовая директория по умолчанию `/data/music` (переопределяется `MUSIC_DIR`) монтируется в `/music:ro`. Пользователь добавляет/повторно сканирует серверную библиотеку в настройках; автоматическое сканирование при каждом открытии не требуется.
- Сохраняем static adapter и текущий Netlify-вариант. Для Docker добавляется однопроцессный Node-сервер, который отдаёт уже собранный `build/` и API. Не внедряем adapter-node, отдельную СУБД или серверное пользовательское состояние.
- Для минимального изменения аудиодвижка метаданные и воспроизведение используют существующие `File`/Blob: браузер скачивает серверный файл через API. HTTP Range обязателен для корректной раздачи, но перевод аудиодвижка на потоковый URL в эту цель не входит.

## 2. Структура и владение файлами

Проект находится в корне workspace. Не редактировать `.generated/`; не коммитить тестовые музыкальные файлы и временные отчёты.

- `server/`: production HTTP server, API и Vite middleware. Точка входа `server/index.ts`; Node 26 запускает TypeScript напрямую (только erasable syntax).
- `src/lib/server-library/api.ts`: изоморфные типы API, расширения/MIME и чистые helpers без Node/DOM-зависимостей. Его создаёт задача backend; остальные импортируют, но не меняют без обсуждения.
- `src/lib/server-library/`: браузерские fetch/helpers, если нужны; их создаёт frontend-задача, кроме `api.ts`.
- `Dockerfile`, `.dockerignore`, `docker-compose.yml`: Docker-задача.
- `messages/ru.json`, регистрация локали: задача #2. Новые сообщения серверной библиотеки добавляет frontend-задача после #2 во **все** зарегистрированные локали; английский и русский тексты обязательно осмысленные, в остальных допускается английский fallback. Ключи и placeholders во всех файлах совпадают.
- Тесты backend размещаются в `server/__tests__/`, frontend — в существующих `__tests__/` рядом с клиентскими модулями. Автор реализации не берёт задачу тестов своего модуля.
- Общий `README.md` обновляет документационная задача; `.env.example` — Docker-задача.

Соблюдать `AGENTS.md`: TypeScript strict, Svelte 5 runes, i18n вместо hardcoded UI, design tokens, pnpm, Biome. Не импортировать auto-imported utilities вручную. Все записи IndexedDB должны отправлять `dispatchDatabaseChangedEvent`.

## 3. Конфигурация и запуск

Переменные:
- `MUSIC_DIR`: абсолютный или относительный путь к читаемой директории. Пустое/отсутствующее значение отключает серверную библиотеку, но не сам плеер. Внутри контейнера всегда `/music`; в Compose одноимённая хостовая переменная по умолчанию `/data/music`.
- `HOST`: адрес Node HTTP server, по умолчанию `0.0.0.0`; в Compose с Yggdrasil — `::` для IPv6.
- `PORT`: порт внутри Node server, по умолчанию `3000`.
- `SNAE_PORT`: переопределяет `PORT` плеера в общей network namespace Yggdrasil, по умолчанию `3000`; host port отдельно не публикуется.
- `PUBLIC_FALLBACK_PAGE` и `PUBLIC_GOAT_COUNTER_URL`: существующие build-time настройки; Docker build по умолчанию использует `/200.html` и пустой analytics URL.

Команды:
```sh
pnpm install --frozen-lockfile
pnpm run build
MUSIC_DIR=/absolute/path/to/music pnpm start   # server/index.ts, build уже собран
MUSIC_DIR=/absolute/path/to/music pnpm run dev # Vite + тот же API middleware
```

`src/lib/server-library/api.ts` дополнительно экспортирует `getServerLibraryFileUrl(path: string): string`, кодирующий relative path в query-параметр **`path`** endpoint `file`; backend и браузер не формируют этот URL самостоятельно.

`server/library/middleware.ts` экспортирует `createServerLibraryMiddleware`; `server/index.ts` и Vite plugin подключают именно его. Сигнатура:
```ts
createServerLibraryMiddleware(
  getMusicDir?: () => string | undefined,
): (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => Promise<void>
```
По умолчанию `getMusicDir` читает `process.env.MUSIC_DIR` при каждом запросе. Middleware обрабатывает только base path `/api/server-library`; для прочих URL вызывает `next()` без записи ответа. Тесты могут поднять обычный `node:http` server с этим middleware и передать путь временной директории.

`package.json` добавляет `start: node server/index.ts`. Vite dev/preview middleware и production server используют этот handler, а не две реализации. Production static files отдаются из `build/` (допустим небольшой сервер вроде `sirv`, зависимости и lockfile обновляет backend). Неизвестные `/api/*` не должны получать SPA fallback.

## 4. HTTP API серверной библиотеки

Base path: `/api/server-library`. Только same-origin GET/HEAD; mutation-методы — 405 с `Allow: GET, HEAD`. Все JSON ответы — UTF-8 и `Cache-Control: no-store`.

### `GET /api/server-library/status`

Всегда доступен для healthcheck:
```json
{ "enabled": true }
```
`enabled:false`, если `MUSIC_DIR` не задан. Сконфигурированная, но недоступная директория — 503 с ошибкой `DIRECTORY_UNAVAILABLE`.

### `GET /api/server-library/files`

Рекурсивно возвращает только поддерживаемые обычные файлы:
```json
{
  "files": [
    { "path": "Artist/Album/01 Song.mp3", "name": "01 Song.mp3", "size": 1234567, "lastModified": 1764057600000 }
  ]
}
```
- `path`: относительный POSIX-путь без ведущего `/`; уникальный ключ файла. `name`: basename. `size`: байты, `lastModified`: mtime в целых миллисекундах Unix.
- Расширения case-insensitive: `aac`, `mp3`, `ogg`, `wav`, `flac`, `m4a`, `opus`, `webm` — тот же список использует локальный импорт.
- Сортировка по `path` лексикографически, стабильно; пустая библиотека — `{ "files": [] }`.
- Не следовать symbolic links. Не отдавать частичный индекс при ошибке чтения каталога: 503; гонка с уже исчезнувшим файлом может быть пропущена.

### `GET|HEAD /api/server-library/file?path=<url-encoded-path>`

Отдаёт файл с корректным `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`; 200 для полного ответа. Поддержать одиночный HTTP Range (`bytes=start-end`, open-ended и suffix), 206 с `Content-Range`; недопустимый/неудовлетворимый Range — 416 и `Content-Range: bytes */<size>`. HEAD не возвращает тело.

MIME: `aac=audio/aac`, `mp3=audio/mpeg`, `ogg=audio/ogg`, `wav=audio/wav`, `flac=audio/flac`, `m4a=audio/mp4`, `opus=audio/ogg`, `webm=audio/webm`.

Нельзя принимать путь вместо query-параметра. Отклонять пустой путь, NUL, backslash, абсолютные пути и сегменты `.`/`..`; после resolve путь обязан оставаться внутри realpath `MUSIC_DIR`. Неподдерживаемое расширение и symlink считать not found. Никаких запросов к произвольным серверным путям и никаких записей в `MUSIC_DIR`.

### Ошибки

```json
{ "error": { "code": "INVALID_PATH", "message": "Invalid file path" } }
```
Стабильные коды: `SERVER_LIBRARY_DISABLED` (404), `INVALID_PATH` (400), `FILE_NOT_FOUND` (404), `DIRECTORY_UNAVAILABLE` (503), `INTERNAL_ERROR` (500). `message` — технический английский текст без абсолютных путей/содержимого env; UI показывает локализованное сообщение, а не сырое исключение. Ошибки логируются на сервере без секретов и абсолютного пути в клиентском ответе.

## 5. Модель клиентской библиотеки

В `src/lib/server-library/api.ts`:
```ts
export interface ServerFileDescriptor {
  path: string
  name: string
  size: number
  lastModified: number
}
```
В клиентской модели:
```ts
export const SERVER_DIRECTORY_ID = -2

export interface ServerFileEntity extends ServerFileDescriptor {
  kind: 'server'
}
```
`FileEntity` расширяется `ServerFileEntity`. Для `Track.file` серверная сущность сериализуется в IndexedDB; `Track.fileName` у неё равен **полному relative `path`**, а не basename. Поэтому существующий индекс `[directory,fileName]` различает одинаковые имена в разных папках.

`Directory` становится union: прежняя локальная запись с `handle` и опциональным `kind:'local'` (старые записи без kind валидны) либо `{ id: typeof SERVER_DIRECTORY_ID, kind:'server' }`. Серверный singleton сохраняется в `directories` через `put` с явным `-2`, не через auto-increment `add`. Любые ветки UI/permission/reparent обязаны различать `kind==='server'` и наличие `handle`.

`TracksScanOptions` добавляет действия `{ action: 'server-directory-add' | 'server-directory-rescan', dirId: typeof SERVER_DIRECTORY_ID }`, чтобы сохранить форму существующих directory options; `dirId` обязан равняться `SERVER_DIRECTORY_ID`. Сканирование:
1. Полностью получить `files`; при ошибке не менять/не удалять существующие записи и показать ошибку, а не «0 новых треков».
2. Для серверных треков identity = `[SERVER_DIRECTORY_ID, path]`. При совпадающих `size`, `lastModified` и `CURRENT_METADATA_VERSION` повторный парсинг не нужен.
3. Для новых/изменённых файлов скачать через file API, создать `File` с basename/type/lastModified и пропустить через существующий metadata/artwork/import pipeline. Сохранять существующие track id и uuid при обновлении.
4. После успешного полного rescan удалить записи, чьих path больше нет. Локальные/legacy треки не затрагивать. Лимит и поддержка форматов остаются как у существующего parser.

`resolveTrackFile` получает server entity без FS permission, делает fetch file API, 404 преобразует в `not-found`, прочие сетевые/HTTP ошибки — `error`; локальное поведение не меняется. Worker и main thread используют общий URL/response helper, не дублируют кодирование path.

В настройках при `status.enabled` доступны добавление (один singleton), rescan и удаление серверного источника. «Удалить» удаляет только IndexedDB-записи/треки этого источника и никогда не вызывает запись на сервере. Нужны понятные RU/EN название, описание read-only, кнопка и ошибка сканирования; при существующем server source показывать его даже при временно недоступном status. Текст «все данные только на устройстве» не должен ложно описывать серверный источник.

## 6. Docker и Docker Compose

- Multi-stage `Dockerfile`: Node 26 + pnpm по lockfile, production build, затем минимальный runtime без devDependencies; `CMD ["node", "server/index.ts"]`, порт 3000, непривилегированный пользователь.
- `docker-compose.yml`: services `player` и `yggdrasil`. `player`: `build: .`, `network_mode: service:yggdrasil`, `depends_on: yggdrasil`, без `ports`, `MUSIC_DIR=/music`, `HOST=::`, `PORT=${SNAE_PORT:-3000}`, volume `"${MUSIC_DIR:-/data/music}:/music:ro"`, `restart: unless-stopped`, healthcheck на status endpoint через localhost. `yggdrasil` использует официальный image, `NET_ADMIN`, `/dev/net/tun` и конфигурацию из `./yggdrasil/`.
- `.dockerignore` исключает `.git`, `.scratch`, `node_modules`, `.generated`, `build`, `.env`, локальную музыку и отчёты.
- `docker compose up --build` должен поднять приложение без ручного `pnpm install` на хосте. Директория из `MUSIC_DIR` может быть создана пользователем заранее; отсутствие файлов в ней — не ошибка. Для browser UI через Yggdrasil требуется HTTPS: обычный HTTP на non-localhost не является secure context.

## 7. Проверка и готовность

Обязательные команды после соответствующих изменений:
```sh
pnpm run i18n-check
pnpm run type-check
pnpm run biome-check
pnpm run test
pnpm run build
```
Перед завершением всей цели также: `pnpm run knip`, `docker build`, `docker compose config`, запуск Compose на временной директории с тестовым аудио и curl-проверки status/list/file/Range/traversal/read-only. Коды выхода команд стандартные: 0 успех, ненулевой — ошибка; не скрывать failing checks. Изменение этих контрактов сначала обсуждается в задаче планирования #1.
