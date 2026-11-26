<script lang="ts">
	import { getAuthState, logout } from '#lib/auth/client.ts'
	import Button from '#lib/components/Button.svelte'
	import Icon from '#lib/components/icon/Icon.svelte'
	import Spinner from '#lib/components/Spinner.svelte'
	import SettingsListItem from './SettingsListItem.svelte'

	const authState = getAuthState()

	let isSigningOut = $state(false)

	const handleSignOut = async () => {
		if (isSigningOut) {
			return
		}

		isSigningOut = true

		try {
			await logout()
			// Success reloads the page into the unauthenticated state.
		} catch (error) {
			snackbar.unexpectedError(error)
			isSigningOut = false
		}
	}
</script>

{#if authState.status === 'authenticated' || authState.status === 'offline'}
	<!-- The offline profile (§12) keeps the account section visible; sign-out needs the network. -->
	<section class="card settings-max-width mx-auto mt-6 w-full text-body-lg">
		<div class="px-4 pt-4 text-title-sm text-onSurfaceVariant">{m.authAccount()}</div>

		<SettingsListItem title={m.authSignedInAs({ username: authState.user.username })}>
			<div class="flex items-center gap-2">
				{#if isSigningOut}
					<Spinner class="size-5" />
				{/if}
				<Button kind="toned" class="w-full sm:w-40" disabled={isSigningOut} onclick={handleSignOut}>
					<Icon type="logout" class="size-5" />
					{m.authLogout()}
				</Button>
			</div>
		</SettingsListItem>
	</section>
{/if}
