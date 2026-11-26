/// <reference lib='WebWorker' />

import { ServerLibraryRequestError } from '#lib/server-library/client.ts'
import { workerAction } from './actions.ts'
import type { TracksScanMessage, TracksScanOptions } from './types.ts'

declare const self: DedicatedWorkerGlobalScope

self.addEventListener('message', async (event: MessageEvent<TracksScanOptions>) => {
	const options = event.data

	try {
		await workerAction(options)
	} catch (err) {
		// A 401 must surface as an auth error in the UI, not as an empty library:
		// no database write happened before this point.
		const message: TracksScanMessage = {
			finished: true,
			count: {
				newlyImported: 0,
				current: 0,
				total: 0,
				error: true,
				authRequired:
					err instanceof ServerLibraryRequestError && err.code === 'AUTH_REQUIRED',
			},
		}

		self.postMessage(message)
		console.error('[scanner worker]', err)
	}
})
