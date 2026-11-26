/**
 * Main-thread-only UI notification for user-state sync failures
 * (CONTRACTS.md §9). Kept out of `actions.ts` on purpose: that module is
 * reachable from the scanner worker bundle, which must stay free of
 * snackbar/i18n UI dependencies — this file is imported only by
 * main-thread code (e.g. `play-history-actions.ts`).
 */

import { UserStateRequestError } from './client.ts'

/** Surfaces a sync failure as a localized error; unexpected errors keep the generic handler. */
export const notifyUserStateSyncError = (error: unknown): void => {
	console.error('User state sync failed:', error)

	if (error instanceof UserStateRequestError) {
		snackbar({
			id: 'user-state-sync-failed',
			message: m.userStateSyncFailed(),
		})
	} else {
		snackbar.unexpectedError(error)
	}
}
