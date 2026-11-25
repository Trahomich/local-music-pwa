<script lang="ts">
	import { ripple } from '#lib/attachments/ripple.ts'
	import { tooltip } from '#lib/attachments/tooltip.ts'
	import CommonDialog from '#lib/components/dialog/CommonDialog.svelte'
	import IconButton from '#lib/components/IconButton.svelte'
	import Icon from '#lib/components/icon/Icon.svelte'
	import WrapTranslation from '#lib/components/WrapTranslation.svelte'
	import { trackEvent } from '#lib/helpers/analytics.ts'
	import {
		getFilesFromLegacyDirectory,
		isFileSystemAccessSupported,
	} from '#lib/helpers/file-system.ts'
	import { isAndroid } from '#lib/helpers/utils/ua.ts'
	import {
		checkNewDirectoryStatus,
		importLegacyFiles,
		importNewDirectory,
		importServerDirectory,
		removeDirectory,
		replaceDirectories,
		rescanDirectory,
		rescanServerDirectory,
	} from '#lib/library/scan-actions/directories.ts'
	import { type LocalDirectory, SERVER_DIRECTORY_ID } from '#lib/library/types.ts'
	import { fetchServerLibraryStatus } from '#lib/server-library/client.ts'
	import type { DirectoryWithCount } from '../+page.ts'

	interface Props {
		disabled: boolean
		directories: DirectoryWithCount[]
	}

	const { disabled, directories }: Props = $props()

	interface ReparentDirectory {
		childDirs: LocalDirectory[]
		newDirHandle: FileSystemDirectoryHandle
	}

	const isAndroidPlatform = isAndroid()
	let reparentDirectory = $state<ReparentDirectory | null>(null)

	type ServerLibraryStatus = 'loading' | 'enabled' | 'disabled' | 'unavailable'
	let serverLibraryStatus = $state<ServerLibraryStatus>('loading')

	$effect(() => {
		fetchServerLibraryStatus()
			.then((status) => {
				serverLibraryStatus = status.enabled ? 'enabled' : 'disabled'
			})
			.catch(() => {
				serverLibraryStatus = 'unavailable'
			})
	})

	const hasServerDirectory = $derived(
		directories.some((dir) => !dir.legacy && dir.kind === 'server'),
	)
	const showAddServerLibrary = $derived(serverLibraryStatus === 'enabled' && !hasServerDirectory)

	const addServerLibraryHandler = () => {
		trackEvent('action-add-server-library')
		void importServerDirectory()
	}

	const addNewDirectoryHandler = async () => {
		const directory = await showDirectoryPicker({
			mode: 'read',
		})

		let childDirectories: LocalDirectory[] = []
		for (const existingDir of directories) {
			if (existingDir.legacy) {
				continue
			}

			if (existingDir.kind === 'server') {
				continue
			}

			const result = await checkNewDirectoryStatus(existingDir, directory)
			if (result?.status === 'existing') {
				snackbar({
					id: 'directory-already-included',
					message: `Directory '${directory.name}' is already included`,
				})

				return
			}

			if (result?.status === 'child') {
				snackbar({
					id: 'directory-added',
					message: m.directoryIsIncludedInParent({
						existingDir: existingDir.handle.name,
						newDir: directory.name,
					}),
				})

				return
			}

			if (result) {
				childDirectories.push(result.existingDir)
			}
		}

		if (childDirectories.length > 0) {
			reparentDirectory = {
				childDirs: childDirectories,
				newDirHandle: directory,
			}
		} else {
			trackEvent('action-import-directory')
			void importNewDirectory(directory)
		}
	}

	const importLegacyFilesHandler = async () => {
		const files = await getFilesFromLegacyDirectory().catch((e): File[] => {
			snackbar.unexpectedError(e)

			return []
		})

		if (files.length === 0) {
			return
		}

		trackEvent('action-import-files')
		await importLegacyFiles(files)
	}
</script>

{#snippet addButton(title: string, onclick: () => void)}
	<button
		{@attach ripple()}
		type="button"
		class={[
			disabled ? 'bg-surfaceContainer/10 text-onSurface/54' : 'interactable',
			'flex h-16 items-center gap-2 rounded-sm px-4 ring-1 ring-outlineVariant ring-inset',
		]}
		{disabled}
		{onclick}
	>
		<Icon type="plus" />
		{title}
	</button>
{/snippet}

<ul class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
	{#each directories as dir}
		<li
			class={[
				'flex h-16 items-center gap-2 rounded-sm pr-1 pl-4 text-onTertiaryContainer',
				dir.legacy ? 'bg-tertiaryContainer/40' : 'bg-tertiaryContainer/56',
			]}
		>
			{#if dir.legacy}
				<div {@attach tooltip(m.settingsTracksInAppStorageTooltip())}>
					<Icon type="information" class="size-4 text-onTertiaryContainer/54" />
				</div>
			{/if}

			<div class="flex flex-col overflow-hidden">
				<div class="truncate">
					{#if dir.legacy}
						{m.settingsTracksInsideAppMemory()}
					{:else if dir.kind === 'server'}
						{m.settingsServerLibraryTitle()}
					{:else}
						{dir.handle.name}
					{/if}
				</div>
				<div class="text-body-sm">
					{m.settingsDirectoriesTracksCount({ count: dir.count })}
				</div>
			</div>

			<div class="ml-auto flex items-center gap-1">
				{#if dir.legacy}
					<IconButton
						{disabled}
						icon="trashOutline"
						tooltip={m.settingsDirRemove()}
						onclick={() => {
							void removeDirectory(dir.id)
						}}
					/>
				{:else if dir.kind === 'server'}
					<IconButton
						{disabled}
						icon="cached"
						tooltip={m.settingsDirRescan()}
						onclick={() => {
							trackEvent('action-rescan-server-library')
							void rescanServerDirectory()
						}}
					/>
					<IconButton
						{disabled}
						icon="trashOutline"
						tooltip={m.settingsDirRemove()}
						onclick={() => {
							void removeDirectory(SERVER_DIRECTORY_ID)
						}}
					/>
				{:else}
					<!-- Chromium on Android broke persisted handles https://issues.chromium.org/issues/499064852 -->
					{#if !isAndroidPlatform}
						<IconButton
							{disabled}
							icon="cached"
							tooltip={m.settingsDirRescan()}
							onclick={() => {
								trackEvent('action-rescan-directory')
								void rescanDirectory(dir.id, dir.handle)
							}}
						/>
					{/if}
					<IconButton
						{disabled}
						icon="trashOutline"
						tooltip={m.settingsDirRemove()}
						onclick={() => {
							void removeDirectory(dir.id)
						}}
					/>
				{/if}
			</div>
		</li>
	{/each}
	<li class="contents">
		{#if isFileSystemAccessSupported}
			{@render addButton(m.settingsAddDirectory(), addNewDirectoryHandler)}
		{:else}
			{@render addButton(m.settingsImportDirectory(), importLegacyFilesHandler)}
		{/if}
		{#if showAddServerLibrary}
			{@render addButton(m.settingsServerLibraryAdd(), addServerLibraryHandler)}
		{/if}
	</li>
</ul>

{#if hasServerDirectory || showAddServerLibrary}
	<p class="mt-3 text-body-sm text-onSurfaceVariant">
		{m.settingsServerLibraryDescription()}
	</p>
{/if}

{#snippet directoryName(name: string | undefined)}
	<span class="inline-flex h-[--spacing(4.125)] w-fit items-center gap-1 text-tertiary">
		<Icon type="folder" class="mt-0.5 size-3" />

		<span class="inline h-full w-fit max-w-25 truncate">{name}</span>
	</span>
{/snippet}

<CommonDialog
	open={{
		get: () => reparentDirectory,
		close: () => {
			reparentDirectory = null
		},
	}}
	class="[--dialog-width:--spacing(85)]"
	icon="folderHidden"
	title={m.replaceDirectoryQ()}
	buttons={(data) => [
		{
			title: m.cancel(),
		},
		{
			title: m.replace(),
			action: () => {
				const ids = data.childDirs.map((dir) => dir.id)
				void replaceDirectories(data.newDirHandle, ids)
			},
		},
	]}
>
	{#snippet children({ data })}
		<WrapTranslation messageFn={m.replaceDirectoryExplanation}>
			{#snippet existingDirs()}
				{#each data.childDirs as dir}
					{@render directoryName(dir.handle.name)}
				{/each}
			{/snippet}
			{#snippet newDir()}
				{@render directoryName(data.newDirHandle.name)}
			{/snippet}
		</WrapTranslation>
	{/snippet}
</CommonDialog>
