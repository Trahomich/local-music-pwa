<script lang="ts">
	import Button from '#lib/components/Button.svelte'
	import Icon from '#lib/components/icon/Icon.svelte'
	import Spinner from '#lib/components/Spinner.svelte'
	import Tabs from '#lib/components/Tabs.svelte'
	import TextField from '#lib/components/TextField.svelte'
	import {
		PASSWORD_MAX_LENGTH,
		PASSWORD_MIN_LENGTH,
		USERNAME_MAX_LENGTH,
		USERNAME_MIN_LENGTH,
		USERNAME_PATTERN,
	} from './api.ts'
	import { AuthRequestError, login, register } from './client.ts'

	type AuthMode = 'login' | 'register'

	const AUTH_MODES: readonly AuthMode[] = ['login', 'register']

	let mode = $state<AuthMode>('login')
	let username = $state('')
	let password = $state('')
	let isSubmitting = $state(false)
	let errorMessage: string | null = $state(null)

	const isRegisterMode = $derived(mode === 'register')

	const switchMode = (nextMode: AuthMode) => {
		if (nextMode === mode) {
			return
		}

		mode = nextMode
		errorMessage = null
	}

	const describeAuthError = (error: unknown): string => {
		if (error instanceof AuthRequestError) {
			switch (error.code) {
				case 'INVALID_CREDENTIALS':
					return m.authErrorInvalidCredentials()
				case 'USERNAME_TAKEN':
					return m.authErrorUsernameTaken()
				case 'REGISTRATION_DISABLED':
					return m.authErrorRegistrationDisabled()
				case 'RATE_LIMITED':
					return error.retryAfterSeconds === null
						? m.authErrorRateLimited()
						: m.authErrorRateLimitedRetry({ seconds: error.retryAfterSeconds })
				case 'NETWORK_ERROR':
					return m.authErrorNetwork()
			}
		}

		return m.authErrorUnexpected()
	}

	const handleSubmit = async (event: SubmitEvent) => {
		event.preventDefault()

		if (isSubmitting) {
			return
		}

		errorMessage = null
		isSubmitting = true

		try {
			if (isRegisterMode) {
				await register(username, password)
			} else {
				await login(username, password)
			}

			// Success reloads the page into the account profile; keep the
			// pending state so the form cannot be resubmitted meanwhile.
		} catch (error) {
			errorMessage = describeAuthError(error)
			isSubmitting = false
		}
	}
</script>

<div class="flex min-h-dvh flex-col items-center justify-center p-4">
	<div class="card w-full max-w-100 p-6">
		<h1 class="text-headline-sm">{m.appName()}</h1>
		<p class="mt-2 text-body-md text-onSurfaceVariant">
			{m.authGateDescription()}
		</p>

		<Tabs
			selectedIndex={isRegisterMode ? 1 : 0}
			items={AUTH_MODES}
			onchange={switchMode}
			class="mt-6"
		>
			{#snippet text(item: AuthMode)}
				{item === 'login' ? m.authSignIn() : m.authCreateAccount()}
			{/snippet}
		</Tabs>

		<form class="mt-6 flex flex-col gap-4" onsubmit={handleSubmit} aria-busy={isSubmitting}>
			<TextField
				bind:value={username}
				name="username"
				label={m.authUsername()}
				placeholder={m.authUsernameHint()}
				autocomplete="username"
				required
				minLength={USERNAME_MIN_LENGTH}
				maxLength={USERNAME_MAX_LENGTH}
				pattern={USERNAME_PATTERN}
				patternIssue={m.authUsernameHint()}
			/>

			<TextField
				bind:value={password}
				name="password"
				type="password"
				label={m.authPassword()}
				placeholder={isRegisterMode ? m.authPasswordHint() : undefined}
				autocomplete={isRegisterMode ? 'new-password' : 'current-password'}
				required
				minLength={isRegisterMode ? PASSWORD_MIN_LENGTH : undefined}
				maxLength={PASSWORD_MAX_LENGTH}
			/>

			{#if errorMessage !== null}
				<div role="alert" class="flex items-center gap-2 text-body-sm text-error">
					<Icon type="alertCircle" class="size-5" />
					{errorMessage}
				</div>
			{/if}

			<Button type="submit" disabled={isSubmitting} class="mt-2 w-full">
				{#if isSubmitting}
					<Spinner class="size-5" />
				{/if}
				{isRegisterMode ? m.authCreateAccount() : m.authSignIn()}
			</Button>
		</form>
	</div>
</div>
