import '../app.css'
import { browser } from '$app/env'
import { bootstrapAuth } from '#lib/auth/client.ts'
import { registerServiceWorker } from '#lib/helpers/register-sw.ts'
import type { LayoutLoad } from './$types.ts'

export const ssr = false
export const prerender = false

if (browser) {
	void registerServiceWorker({
		onNeedRefresh(update) {
			snackbar({
				id: 'app-update',
				message: m.appUpdateAvailable(),
				duration: false,
				controls: {
					label: m.reload(),
					action: update,
				},
			})
		},
	})
}

// The auth state resolves before any child loader runs, so no IndexedDB
// access can happen before the profile namespace is known (§9).
export const load: LayoutLoad = async () => {
	const authState = await bootstrapAuth()

	return { authState }
}
