<script lang="ts">
	interface TextFieldProps {
		value?: string
		name: string
		type?: 'text' | 'password'
		label?: string
		placeholder?: string
		autocomplete?: 'username' | 'current-password' | 'new-password' | 'off'
		minLength?: number
		maxLength?: number
		required?: boolean
		/** Extra constraint checked when the field is not empty; `patternIssue` is shown on mismatch. */
		pattern?: RegExp
		patternIssue?: string
		class?: ClassValue
	}

	let {
		name,
		value = $bindable(''),
		type = 'text',
		label,
		placeholder,
		autocomplete,
		minLength,
		maxLength,
		required,
		pattern,
		patternIssue,
		class: className,
	}: TextFieldProps = $props()

	const id = $props.id()

	const validationIssue = $derived.by(() => {
		const valueLength = value.length
		if (required && valueLength < 1) {
			return m.validationRequired()
		}

		if (minLength !== undefined && valueLength < minLength) {
			return m.validationMinLength({ min: minLength })
		}

		if (maxLength !== undefined && valueLength > maxLength) {
			return m.validationMaxLength({ max: maxLength })
		}

		if (pattern !== undefined && valueLength > 0 && !pattern.test(value)) {
			return patternIssue ?? null
		}

		return null
	})
</script>

<div class={[className, 'text-field-container']}>
	{#if label}
		<label for={id} class="mb-1 block px-1 text-body-sm text-onSurfaceVariant">{label}</label>
	{/if}
	<div
		class="flex h-14 flex-col rounded-md border border-outline p-px text-onSurface focus-within:border-2 focus-within:border-primary focus-within:p-0 [&:has(input:user-invalid)]:border-error"
	>
		<input
			bind:value
			{name}
			{id}
			{type}
			{required}
			{autocomplete}
			class="w-full grow appearance-none border-none bg-transparent px-3.5 outline-none placeholder:text-onSurfaceVariant"
			{placeholder}
			{@attach (input) => {
				input.setCustomValidity(validationIssue ? ' ' : '')
			}}
		>
	</div>
	<div class="text-field-error mt-1 hidden px-4 text-body-sm text-error">
		{validationIssue ?? ''}
	</div>
</div>

<style>
	.text-field-container:has(input:user-invalid) .text-field-error {
		display: block;
	}
</style>
