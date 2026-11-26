/**
 * Polls the user-state snapshot so changes from other tabs/devices show up
 * (CONTRACTS.md §9): an initial fetch after sign-in, then on window focus /
 * tab visibility and every 30 seconds. Polls never overlap and stop after
 * logout, so no snapshot is applied into a local-only profile.
 *
 * Offline behaviour (§12): while `navigator.onLine` is false ticks are
 * skipped silently (no failed requests, no fake success) and the `online`
 * event resumes polling immediately.
 */

import { getCurrentUserId } from '#lib/auth/client.ts'
import { fetchUserStateSnapshot, UserStateRequestError } from './client.ts'
import { applyUserStateSnapshot } from './snapshot.ts'

const USER_STATE_POLL_INTERVAL_MS = 30_000

let started = false
let pollingTimer: ReturnType<typeof setInterval> | null = null
let requestInFlight = false
let lastAppliedRevision = -1

/** Called by action paths that already applied a server-returned snapshot. */
export const noteSnapshotApplied = (revision: number): void => {
	lastAppliedRevision = revision
}

export const stopUserStateSync = (): void => {
	started = false

	if (pollingTimer !== null) {
		clearInterval(pollingTimer)
		pollingTimer = null
	}

	if (typeof window !== 'undefined') {
		window.removeEventListener('focus', onWindowFocus)
		window.removeEventListener('online', onOnline)
	}
	if (typeof document !== 'undefined') {
		document.removeEventListener('visibilitychange', onVisibilityChange)
	}
}

const onVisibilityChange = (): void => {
	if (document.visibilityState === 'visible') {
		void pollUserState()
	}
}

/** Single focus handler so `stopUserStateSync` removes the very listener that was added. */
const onWindowFocus = (): void => {
	void pollUserState()
}

/** Connectivity is back: poll right away instead of waiting for the next tick. */
const onOnline = (): void => {
	void pollUserState()
}

const pollUserState = async (): Promise<void> => {
	if (requestInFlight) {
		return
	}

	if (getCurrentUserId() === null) {
		stopUserStateSync()

		return
	}

	// Without connectivity there is nothing to poll: skip the tick quietly
	// instead of producing failed requests; `online` resumes the loop (§12).
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		return
	}

	requestInFlight = true
	try {
		const snapshot = await fetchUserStateSnapshot()
		// A delayed response from an older poll (or an identical redelivery)
		// must never overwrite state already advanced by a newer server-first
		// action, so strictly newer revisions win.
		if (snapshot.revision > lastAppliedRevision) {
			await applyUserStateSnapshot(snapshot)
			noteSnapshotApplied(snapshot.revision)
		}
	} catch (error) {
		// An expired session means there is nothing to sync anymore; the
		// auth gate owns re-authentication. Transient failures just skip
		// this tick and are retried on the next one.
		if (error instanceof UserStateRequestError && error.code === 'AUTH_REQUIRED') {
			stopUserStateSync()

			return
		}

		console.error('User state poll failed:', error)
	} finally {
		requestInFlight = false
	}
}

/**
 * Starts the sync loop for the signed-in profile. Safe to call multiple
 * times; only the first call in a page lifetime has an effect. No-op in
 * SSR, tests and the local-only/static mode.
 */
export const startUserStateSync = (): void => {
	if (import.meta.env.SSR || started) {
		return
	}

	if (getCurrentUserId() === null) {
		return
	}

	started = true
	lastAppliedRevision = -1

	void pollUserState()
	pollingTimer = setInterval(() => void pollUserState(), USER_STATE_POLL_INTERVAL_MS)
	window.addEventListener('focus', onWindowFocus)
	window.addEventListener('online', onOnline)
	document.addEventListener('visibilitychange', onVisibilityChange)
}
