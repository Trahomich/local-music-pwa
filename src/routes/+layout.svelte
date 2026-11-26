<script lang="ts">
	import { afterNavigate } from '$app/navigation'
	import { page } from '$app/state'
	import AuthScreen from '#lib/auth/AuthScreen.svelte'
	import { trackPageView } from '#lib/helpers/analytics.ts'
	import { MainStore } from '#lib/stores/main/store.svelte.ts'
	import { setMainStoreContext } from '#lib/stores/main/use-store.ts'
	import { setupAppViewTransitions } from '#lib/view-transitions.svelte.ts'

	const { children, data } = $props()

	const mainStore = setMainStoreContext(new MainStore())
	setupAppViewTransitions(() => mainStore.isReducedMotion)

	afterNavigate((nav) => {
		const routeId = nav.to?.route?.id ?? 'unknown'
		trackPageView(routeId)
	})

	$effect(() => {
		if (page.data.htmlOverflow === 'auto') {
			document.documentElement.style.overflowY = 'auto'
		} else {
			document.documentElement.style.overflowY = ''
		}
	})
</script>

{#if data.authState.status === 'unauthenticated'}
	<!-- Self-hosted auth gate (§9): the static shell loads, but the app stays hidden until sign-in. -->
	<AuthScreen />
{:else}
	{#if data.authState.status === 'offline'}
		<!-- Offline profile (§12): the app runs on the local per-user database until the network is back. -->
		<div
			role="status"
			class="sticky top-0 z-50 flex items-center justify-center gap-2 border-b border-primary/10 bg-surfaceContainerHighest px-4 py-2 text-center text-body-md text-onSurface"
		>
			{m.authOfflineBanner()}
		</div>
	{/if}
	{@render children()}
{/if}
