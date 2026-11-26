/**
 * Автоматическая фоновая синхронизация серверной библиотеки при запуске
 * (CONTRACTS.md §13).
 *
 * Один раз за page lifetime после готового auth/bootstrap: `GET status` →
 * если источника ещё нет, `importServerDirectory()`, иначе
 * `rescanServerDirectory()` (server incremental rescan + catalog). Работа идёт
 * в фоне и ничего не блокирует: cached server tracks видны сразу, прогресс
 * показывает обычный scan UI. Offline browser и static hosting (local-only
 * профиль без backend) сетевой scan не запускают; отложенный из-за offline
 * запуск выполняет ровно один retry по событию `online`. Ошибки 401/503
 * показываются локализованным snackbar один раз и никогда не стирают cached
 * tracks — модуль ничего не удаляет ни из IndexedDB, ни из MUSIC_DIR.
 */

import { bootstrapAuth, getCurrentUserId } from '#lib/auth/client.ts'
import { getDatabase } from '#lib/db/database.ts'
import {
	importServerDirectory,
	rescanServerDirectory,
} from '#lib/library/scan-actions/directories.ts'
import { SERVER_DIRECTORY_ID } from '#lib/library/types.ts'
import {
	fetchServerLibraryStatus,
	ServerLibraryRequestError,
	type ServerLibraryScanStatus,
} from './client.ts'

// HMR-safe guard: при hot-reload модуля флаг переживает замену через
// `import.meta.hot.data`, поэтому в той же JS-сессии startup не повторяется.
const hotData = import.meta.hot?.data as { serverLibraryStartupStarted?: boolean } | undefined

let started = hotData?.serverLibraryStartupStarted ?? false
let onlineRetryUsed = false
let onlineListenerAttached = false

const markStarted = (): void => {
	started = true
	if (hotData) {
		hotData.serverLibraryStartupStarted = true
	}
}

const onOnlineRetry = (): void => {
	onlineListenerAttached = false
	onlineRetryUsed = true
	void runSync()
}

/**
 * Откладывает синхронизацию до `online`. Ровно один retry за page lifetime:
 * повторный offline/network-отказ после него цикл не продлевает.
 */
const deferUntilOnline = (): void => {
	if (onlineRetryUsed || onlineListenerAttached || typeof window === 'undefined') {
		return
	}

	onlineListenerAttached = true
	window.addEventListener('online', onOnlineRetry, { once: true })
}

const runSync = async (): Promise<void> => {
	// Offline browser: ни одного запроса; cached tracks уже видны, rescan
	// ждёт `online`.
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		deferUntilOnline()
		return
	}

	let status: ServerLibraryScanStatus
	try {
		status = await fetchServerLibraryStatus()
	} catch (error) {
		if (error instanceof ServerLibraryRequestError && error.code === 'NETWORK_ERROR') {
			// Сервер недоступен по сети — тот же отложенный сценарий, что и
			// offline, плюс одна локализованная ошибка вместо fake success.
			snackbar.unexpectedError(error)
			deferUntilOnline()
			return
		}

		// 401/503/прочие ответы: cached library сохраняется как есть.
		snackbar.unexpectedError(error)
		return
	}

	if (!status.enabled) {
		return
	}

	// getDatabase() открывает именно текущий per-user/anonymous namespace,
	// поэтому источник создаётся для каждого аккаунта отдельно.
	const db = await getDatabase()
	const serverDirectory = await db.get('directories', SERVER_DIRECTORY_ID)

	// Оба действия сами сериализуются с ручными add/rescan через
	// lockDatabase и показывают собственные ошибки; startup не перенаправляет
	// на Settings и не блокирует отрисовку.
	if (serverDirectory) {
		await rescanServerDirectory()
	} else {
		await importServerDirectory()
	}
}

/**
 * Запускает фоновую синхронизацию один раз за page lifetime. Синхронно
 * возвращается сразу: auth/bootstrap, status и scan идут асинхронно и не
 * задерживают initial render.
 */
export const startServerLibraryStartupSync = (): void => {
	if (import.meta.env.SSR || started) {
		return
	}
	markStarted()

	void (async () => {
		// После готового auth/bootstrap: профиль известен до решения,
		// запускать ли синхронизацию вообще.
		await bootstrapAuth()

		// Static hosting без backend (local-only) и неавторизованный режим:
		// серверной библиотеки нет — ничего не запускаем.
		if (getCurrentUserId() === null) {
			return
		}

		await runSync()
	})().catch((error: unknown) => {
		snackbar.unexpectedError(error)
	})
}

/** @internal Сброс модульного состояния для unit-тестов. */
export const resetServerLibraryStartupSyncForTests = (): void => {
	started = false
	onlineRetryUsed = false

	if (onlineListenerAttached && typeof window !== 'undefined') {
		window.removeEventListener('online', onOnlineRetry)
	}
	onlineListenerAttached = false

	if (hotData) {
		hotData.serverLibraryStartupStarted = false
	}
}
