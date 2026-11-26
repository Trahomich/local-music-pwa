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

## 8. Новые решения пользователя: multiuser, серверное состояние, RU default

Эти решения заменяют прежние «без авторизации» и «состояние только локальное» для self-hosted режима:
- Регистрация и вход по username/password, **раздельные аккаунты** и раздельные данные. Email не нужен. `SNAE_ALLOW_REGISTRATION=true` по умолчанию; после создания аккаунтов его можно установить в `false`.
- Плейлисты, избранное и история прослушивания хранятся на сервере **отдельно для каждого user id**. Очередь, громкость, эквалайзер, тема и остальные настройки остаются локальными.
- Данные разных аккаунтов и anonymous/legacy local profile не смешиваются и не объединяются автоматически. При переключении аккаунта нельзя показывать данные предыдущего пользователя.
- Static hosting без backend сохраняет прежний local-only режим. В self-hosted режиме auth обязателен для server-library и user-state API; локальная статическая оболочка может загружаться до входа.
- Для новых посетителей без `snae-locale` язык `ru`; сохранённый валидный выбор не перезаписывать. `baseLocale:'en'` остаётся справочной для переводов/SSR, default вынесен отдельно.

## 9. Постоянные данные и auth API

`DATA_DIR` по умолчанию `/data` в Docker и `./.data` локально. Использовать Node 26 `node:sqlite`, без новой нативной зависимости. Раздельные доменные файлы `auth.sqlite` (пользователи, сессии, пользовательское состояние) и `library.sqlite` (музыкальный индекс/artwork) исключают связанность auth и сканера. Docker Compose монтирует named volume `snae-data:/data`; MUSIC_DIR остаётся read-only. Создание схемы и миграции каждого файла транзакционны.

### Auth

- Username: 3–32 символа ASCII `[A-Za-z0-9._-]`, хранить оригинальный регистр, уникальность case-insensitive (`NFKC` + lower для ключа). Password: 8–128 символов. Ошибки не раскрывают, существует ли username при входе.
- Пароль хешировать `crypto.scrypt` с отдельной random salt и `timingSafeEqual`; plaintext не логировать. Session token — random 32 bytes, в SQLite только SHA-256 hash; срок 30 дней, истёкшие сессии периодически удаляются.
- Cookie `snae_session`: `HttpOnly`, `SameSite=Strict`, `Path=/`; `Secure` при HTTPS (`x-forwarded-proto=https` учитывать только при `SNAE_TRUST_PROXY=true`) или `SNAE_SECURE_COOKIES=true`. Для текущего HTTP Yggdrasil cookie может работать без Secure, README обязан предупредить о риске. Mutation auth/state endpoints принимают только JSON и same-origin; проверять `Origin`, если заголовок присутствует. CORS не открывать.
- Базовый rate limit неудачных login по IP+username: не более 10 за 10 минут, in-memory достаточно; не блокировать register после успешного входа. Не логировать пароли/tokens.

Endpoints, все ответы JSON UTF-8, `Cache-Control: no-store`:
- `GET /api/health` — публичный lightweight liveness endpoint, 200 `{ "status": "ok" }` и `Cache-Control: no-store`; не раскрывает users/config/paths и не проверяет авторизацию. Не использовать его как источник данных приложения.
- `POST /api/auth/register` `{username,password}` → 201 `{user:{id,username}}` + Set-Cookie; 403 `REGISTRATION_DISABLED`, 409 `USERNAME_TAKEN`, 400 `INVALID_CREDENTIALS`.
- `POST /api/auth/login` → 200 аналогично; неверная пара/пользователь — одинаковые 401 `INVALID_CREDENTIALS`; 429 `RATE_LIMITED` с `Retry-After`.
- `POST /api/auth/logout` `{}` → 204, удаляет сессию и очищает cookie; не требует валидной сессии.
- `GET /api/auth/me` → 200 `{user:{id,username}}` или 401 `AUTH_REQUIRED`.
- Любой protected API без валидной сессии → 401 `AUTH_REQUIRED`, без редиректа на HTML. Не кэшировать.

### Пользовательское состояние

Wire IDs — только стабильные UUID, не числовые IndexedDB id. Для server track UUID обязан быть одинаковым на всех устройствах (см. §10). Для local-only треков sync не выполняется: они не имеют переносимого файла; playlist сам синхронизируется, а local-only entries остаются только в соответствующем локальном профиле.

Снимок v1:
```json
{
  "version": 1,
  "revision": 42,
  "playlists": [{ "uuid": "…", "name": "…", "description": "…", "createdAt": 1, "updatedAt": 2 }],
  "playlistEntries": [{ "playlistUuid": "favorites", "trackUuid": "server:sha256…", "addedAt": 3 }],
  "history": [{ "trackUuid": "server:sha256…", "playedAt": 4 }]
}
```
Favorites имеют `playlistUuid:'favorites'` и не создают обычную playlist. History содержит не более 100 последних записей, одну на trackUuid.

- `GET /api/user-state` → 200 полный snapshot. Пустой новый профиль имеет revision 0 и пустые массивы.
- `POST /api/user-state/actions` `{id: uuid, action: …}` применяет одну идемпотентную операцию в транзакции, увеличивает revision и возвращает полный snapshot. Повтор того же `id` для того же пользователя возвращает текущий snapshot без повторного изменения. Неизвестное action → 400 `INVALID_ACTION`.
- Action union: `playlist-create`, `playlist-update`, `playlist-delete`; `playlist-entry-add`, `playlist-entry-remove`; `favorite-set`; `history-record`, `history-remove`, `history-clear`. Поля соответствуют snapshot; `favorite-set` содержит `{trackUuid,favorite:boolean}`. Batch UI операцию можно разложить в несколько actions последовательно либо использовать массив `actions` в одном запросе — backend обязан применить массив атомарно; ответ всегда один snapshot.
- Операции сериализуются SQLite transaction. Нет offline optimistic writes для синхронизируемых сущностей: при сетевой ошибке UI показывает локализованную ошибку и не выдаёт операцию за успешно сохранённую. Это исключает silent overwrite с другого устройства. Последняя применённая сервером операция выигрывает.

Клиент:
- Auth frontend создаёт `src/lib/auth/client.ts` и экспортирует для sync `getCurrentUserId(): string | null` (синхронно читает уже завершённый bootstrap, без нового network request). User-state sync использует именно этот seam; `null` означает local-only/неавторизованный режим.
- До обращения дочерних loaders к IndexedDB bootstrap определяет auth. Для anonymous/legacy static используется прежняя БД `snae-app-data`; для аккаунта — отдельная `snae-app-data-user-<userId>`. Смена аккаунта/logout закрывает БД и делает reload. Не копировать anonymous/legacy данные в аккаунт автоматически.
- После login/register получить snapshot и атомарно применить к user DB, преобразуя trackUuid/playlistUuid в локальные numeric ids. Snapshot заменяет только `playlists`, `playlistEntries`, `playHistory` этого пользователя; tracks/albums/artists/images/directories не очищать. Применение dispatch DatabaseChangedEvent.
- Существующие action functions сначала вызывают server action при активном аккаунте, затем применяют возвращённый snapshot. Без backend/static режима сохраняется прежний local-only код. Poll `/api/user-state` на focus/visibility и каждые 30 секунд; изменение revision применяет snapshot, чтобы другие вкладки/устройства обновились.
- Login/Register UI на русском и английском, доступное и с loading/error состояниями. Пароль никогда не писать в localStorage/IndexedDB/log.

## 10. Быстрый серверный индекс музыки

Цель: при add/rescan клиент **не скачивает аудиофайлы для парсинга** и не вызывает browser `parseTrackMetadata` для server source. Чтение тегов выполняется на сервере один раз для всех пользователей.

SQLite index: keyed by relative POSIX `path`, хранит descriptor, `size`, `lastModified`, нормализованный `ParsedTrackData` JSON, stable track `uuid='server:'+sha256(path)`, artwork `{hash,sha256(bytes),mimeType,bytes}`. Можно хранить artwork blob в SQLite; переполнение/обрезание не допускается. Схема/index не записываются в MUSIC_DIR.

- На старте при заданном MUSIC_DIR запускается фоновое scan; одновременно допускается один scan. `POST /api/server-library/rescan` (protected) запускает его идемпотентно и возвращает 202 `{state:'scanning'}`. Scan читает рекурсивно с той же path security, но использует `music-metadata.parseFile` и ограниченную concurrency (по умолчанию 4, env `SNAE_SCAN_CONCURRENCY`, диапазон 1–16).
- Сначала получить полный список regular supported files. Для unchanged `path+size+lastModified` парсер не вызывать. Changed/new парсить на сервере; deleted удалять из index только после успешного полного обхода. Ошибка чтения каталога сохраняет предыдущий индекс. Ошибка одного файла логируется без секретов, прежняя запись для присутствующего path сохраняется; новый битый файл пропускается.
- `GET /api/server-library/status` (protected) → `{enabled, state:'scanning'|'ready'|'error', current,total, error?}`. `enabled:false` сохраняет старое поведение без MUSIC_DIR. Не выдавать host path в error.
- `GET /api/server-library/catalog` (protected) возвращает `{revision, tracks:[{descriptor, uuid, data, artwork?:{hash,mimeType}}]}` только из последнего завершённого index. 409 `SCAN_IN_PROGRESS`, если первый catalog ещё не готов; при фоновом rescan можно отдавать последний complete catalog.
- `GET /api/server-library/artwork/<64-lowercase-hex>` (protected) отдаёт artwork bytes с правильным image MIME и `Cache-Control: public,max-age=31536000,immutable`; 404 `ARTWORK_NOT_FOUND`. Не принимать path в этом endpoint.
- Старые files/list/file/Range endpoints сохраняются для совместимости/playback и тоже protected. Playback file API продолжает отдавать обычный MUSIC_DIR, а не SQLite copy.

Клиентский server scanner:
- Add читает complete catalog; rescan сначала POST rescan и polling status до terminal state, затем catalog. Показать server progress без выдуманного «0 новых».
- Для каждого track сохранить прежнюю identity `[SERVER_DIRECTORY_ID,path]`, numeric id при rescan, stable server UUID из catalog. Metadata из `data` напрямую передаётся в существующий `dbImportTrack`; browser `parseTrackMetadata` и audio file GET запрещены на этом пути.
- Artwork скачивается только если hash отсутствует в IndexedDB images; затем существующий `createImageRecord`/image pipeline. Одинаковый hash не скачивается повторно другими track imports.
- Successful catalog удаляет только исчезнувшие paths; ошибка catalog/частичный import прежние записи сохраняет. Local/legacy scanner не менять.

Приёмка производительности: автотест/бенчмарк с минимум 1000 сгенерированными WAV доказывает, что повторный scan не вызывает `parseFile` для unchanged, а клиентский catalog import не делает file/art audio GET. Первый scan допускается долгим, но идёт с concurrency 4, виден progress и не дублируется на каждом браузере. Любые measured numbers указать честно, без выдуманной крупной библиотеки.

## 11. Границы новых задач и проверки

- Backend index владеет server index/catalog/artwork и `library.sqlite`; backend auth владеет auth/user-state endpoints и `auth.sqlite`. Не создавать общий stateful DB singleton и не редактировать чужой домен. Допустим только общий чисто технический transaction helper с явным владельцем.
- Frontend fast catalog меняет только server scanner/client types; auth frontend владеет auth bootstrap/UI и DB namespace; user-state sync владеет snapshot mapping/actions/polling. Общие auth client helpers определяет auth frontend, sync использует их по контракту, не переписывая.
- Docker добавляет DATA_DIR/snae-data и документирует auth env; не хранит SQLite в music mount.
- Каждая реализация получает отдельные независимые тесты другого участника. Финальная приёмка включает двух пользователей A/B: у B не видны плейлисты/favorites/history A ни после login/logout, ни после перезагрузки; registration off, wrong password, expired/invalid session, protected 401; server rescan без повторного parse unchanged; RU default и сохранённый EN; Docker restart сохраняет пользователей, их состояние и music index.

## 12. Офлайн-режим и скачивание треков/плейлистов

Новая цель пользователя: после скачивания плеер и его музыка работают без сети. Нужны действия «Скачать трек для офлайн» и «Скачать плейлист целиком». Это **внутреннее offline-хранилище приложения**, не ZIP и не экспорт в системную папку Downloads. Изменения серверного read-only API не требуются.

### Offline store и playback

- IndexedDB schema version 5 получает store `offlineTracks`, key `trackUuid`. Запись: `{trackUuid, fileName, size, lastModified, downloadedAt, blob}`. Blob содержит полный аудиофайл и MIME. Track.file остаётся ServerFileEntity; stable server UUID используется как ключ. Store находится в текущей per-user/anonymous DB, поэтому скачанные файлы разных аккаунтов не смешиваются.
- `src/lib/offline/store.ts` экспортирует тип `OfflineTrackRecord`, `getOfflineTrack(trackUuid)`, `listOfflineTrackUuids()`, `saveOfflineTrack(track, blob)`, `removeOfflineTrack(trackUuid)`, `isOfflineTrackCurrent(record, track)`. Current означает совпадение `size` и `lastModified` с ServerFileEntity. При rescan не удалять молча устаревшие downloads; UI может показать «требуется обновление».
- Все writes dispatch DatabaseChangedEvent для `offlineTracks`; schema meta типы обновляются. Ошибки quota/abort пропагируются, частично скачанный Blob не сохраняется. Перед серией запрашивать `navigator.storage.estimate()` при наличии и сообщать нехватку места; `navigator.storage.persist()` вызывается best-effort и отказ не блокирует скачивание.
- `resolveTrackFile` получает optional `trackUuid`; PlayerStore обязан передавать `track.uuid`. Для server track сначала проверяется current offline запись и создаётся File из неё без сети. При stale записи можно попытаться обновить из сети; если сеть недоступна, разрешено воспроизвести stale локальную копию как явно последнюю доступную. Нет offline записи → прежний server fetch; network failure при наличии записи также использует локальную копию. Local File/FileSystem sources не меняются.
- Скачивание использует существующий authenticated file endpoint. Уже current offline tracks пропускаются без повторного GET. Local File/FileSystem tracks уже офлайн и не скачиваются/не дублируются.

### Track/playlist UI

- Track menu: для server track «Скачать для офлайн»; после успеха «Удалить скачанное» с освобождением Blob. Состояния downloading/downloaded/stale/error доступны reactive через DB events; не использовать одноразовый локальный boolean вместо store.
- `src/lib/offline/downloads.ts` предоставляет `downloadTrack(track): Promise<'downloaded'|'current'>`, `downloadPlaylist(playlistId): Promise<PlaylistDownloadResult>`, `downloadAlbum(albumId): Promise<PlaylistDownloadResult>`, `cancelDownloads()`. Album использует `getAllKeysFromIndex('tracks', 'album', album.name)` (строковое значение индекса, а не числовой PK album.id) и скачивает именно треки текущего альбома; result semantics общие с playlist. Результат `{total, downloaded, current, skippedLocal, failed, cancelled:boolean}` (`cancelled` — был ли cancel, не число). Перед batch `estimate()` при наличии API обязателен, `persist()` best-effort; недостаток места по estimate отклоняет весь batch экспортируемым `OfflineStorageQuotaError` до скачивания. Если estimate недоступен/упал, загрузка продолжается. Quota-ошибка в середине увеличивает `failed` и не создаёт partial. `persist()===false` не блокирует загрузку. Blob сохраняется как получен, MIME не переписывается; size обязан совпасть с descriptor. Batch обрабатывает именно текущие entries выбранного playlist, включая favorites pseudo-playlist; не все треки библиотеки.
- Playlist detail получает явную кнопку «Скачать плейлист целиком», album detail — «Скачать альбом», disabled для пустого/только local списка, с возможностью отмены. Общий `ActiveBatchInfo` содержит `{playlistId?:number, albumId?:number, label, currentTrackName?, done,total}`. Во время batch виден determinate `<progress max=total value=done>` с доступным `aria-valuetext`: название collection, текущий track при наличии и `done/total` (не только snackbar по завершении). Между playlist и album повторно используется один UI control, без дублирования логики. Batch concurrency 2, один общий AbortController; ошибка одного трека увеличивает failed и не отменяет остальные, cancel не сохраняет текущий partial. После завершения локализованный итог. Повторный клик не запускает параллельный дубликат.
- Все новые UI strings на en/ru осмысленно и присутствуют во всех локалях. Канонические flat camelCase ключи реализации: `trackDownloadForOffline`, `trackRemoveDownload`, `trackDownloadUpdate`, `trackDownloading`, `trackDownloadFailed`, `trackDownloadRemoved`, `downloadPlaylist`, `downloadPlaylistCancel`, `downloadPlaylistProgress` ({done}/{total}), `downloadPlaylistResult` ({downloaded}/{current}/{skippedLocal}/{failed}), `downloadPlaylistCancelled`, `downloadQuotaError`, а для album — `downloadAlbum`. Точки в именах запрещены из-за generated exports. Доступность: keyboard, labels, aria-live/progress, disabled/loading; design tokens/AGENTS обязательны.

### Offline auth/PWA

- Без сохранённого аккаунта offline поведение прежнее. После успешного bootstrap/login в localStorage разрешается хранить только `snae-offline-user` с `{id,username}` — никогда password/session token. При explicit online 401/logout marker удаляется; account switching перезаписывает его.
- Если `/auth/me` при reload недоступен из-за offline/network/timeout, но marker валиден, создаётся `AuthState {status:'offline', user}`. Root gate рендерит app, `getCurrentUserId()` возвращает этот же id и открывается именно его DB. Offline marker не используется, если сервер явно ответил 401, и не переключается на anonymous DB при временной сетевой ошибке.
- Offline status не даёт делать server mutations: user-state sync/remote edits остаются online-only по §9, без ложного success. При восстановлении сети bootstrap/poll возобновляет обычную синхронизацию. Local playback/download removal работают offline.
- Существующий service worker должен заранее кэшировать app shell, fallback, generated RU/EN chunks, assets/icons/artwork необходимые для открытия `/` и `/library/tracks`. Не кэшировать в service worker API/user-state/audio автоматически: аудио только через offlineTracks. Навигация offline использует cached 200.html и root redirect сохраняется.

### Проверка

- Независимые unit/integration: store writes/events/current/stale/quota/abort; resolver без сети; mixed playlist batch (current/local/failed/cancel), favorites; RU/EN; offline auth marker A/B/logout/online 401; service worker fallback. Не заменять тесты реальным воспроизведением, если Chromium доступен.
- Финальная приёмка в Chromium: login A → server scan → скачать один track и целый playlist → выключить сеть через browser context → reload `/library/tracks` → треки/плейлист/artwork видны и аудио реально начинает воспроизводиться (currentTime растёт или audio events подтверждают playback). Удалить download и проверить, что offline playback после этого не выдаётся за возможный. Аккаунт B не видит downloads A. Зафиксировать ограничения браузера честно.

## 13. Автоматическая синхронизация серверной библиотеки при запуске

Пользователь не должен вручную добавлять серверную библиотеку при каждом запуске.

- В `(app)/+layout.svelte` один раз за page lifetime запускается `startServerLibraryStartupSync()` после готового auth/bootstrap и без блокировки дочерних loaders/initial render. Static hosting без backend и offline browser не запускают network scan.
- Сначала `GET status`. Если `enabled !== true`, ничего не делать. При 401/503/network error сохранить cached tracks и показать локализованную ошибку без empty-library/fake success и без бесконечного retry loop. Один запуск допускает один новый retry по событию `online`, если он был отложен из-за offline.
- Если `SERVER_DIRECTORY_ID` отсутствует в directories — вызвать существующий `importServerDirectory()`; если уже есть — `rescanServerDirectory()` (server incremental rescan + catalog). Это автоматически создаёт источник для каждого пользователя отдельно в его IndexedDB. Для offline profile скачанные tracks/artwork видны сразу, сетевой rescan откладывается до `online`.
- Работа идёт в фоне: пользователь сразу видит cached server tracks (если есть) и обычный scan/server progress UI. Не делать `await` перед отрисовкой приложения и не перенаправлять на Settings. Кнопка ручного add/rescan остаётся; текущий `lockDatabase` сериализует startup и ручные операции. Модульный guard исключает повторный startup в том же JS-сессии, HMR-safe.
- При выборе другого аккаунта/new page lifetime поведение повторяется: каждый аккаунт получает свой локальный catalog после входа. Данные другого аккаунта не показываются. Logout удаляет только локальный источник из текущего профиля при явном действии пользователя; startup ничего не удаляет из MUSIC_DIR или user-state.

Проверка: чистый профиль после login открывает `/library/tracks` и получает server tracks БЕЗ клика Settings→Add; при следующем launch новый файл на сервере появляется в фоне. Offline reload показывает прежние tracks без network и выполняет rescan только после `online`. 401/503 не стирают cached library и не приводят к бесконечному циклу. A/B имеют независимые catalogs и startup запускается один раз за профиль.
