<script lang="ts">
	import Button from '#lib/components/Button.svelte'
	import Icon from '#lib/components/icon/Icon.svelte'
	import { getDatabase } from '#lib/db/database.ts'
	import { isServerFileEntity } from '#lib/helpers/file-system.ts'
	import { getBatchProgress } from '#lib/offline/download-status.svelte.ts'
	import {
		cancelDownloads,
		downloadAlbum,
		downloadPlaylist,
		OfflineStorageQuotaError,
		type PlaylistDownloadResult,
	} from '#lib/offline/downloads.ts'

	interface Props {
		/** The collection this control downloads: a playlist (favorites included) or an album. */
		collection: { type: 'playlist'; id: number } | { type: 'album'; id: number }
		/** Current collection tracks; used to detect whether anything is downloadable. */
		trackIds: readonly number[]
	}

	const { collection, trackIds }: Props = $props()

	// `null` while the track kinds are being loaded: the button stays disabled
	// until we know there is at least one server track to download.
	let hasServerTracks = $state<boolean | null>(null)

	$effect(() => {
		const ids = trackIds
		let cancelled = false
		hasServerTracks = null

		void (async () => {
			const db = await getDatabase()

			for (const id of ids) {
				if (cancelled) {
					return
				}

				const track = await db.get('tracks', id)
				if (track && isServerFileEntity(track.file)) {
					hasServerTracks = true
					return
				}
			}

			if (!cancelled) {
				hasServerTracks = false
			}
		})()

		return () => {
			cancelled = true
		}
	})

	const batch = $derived(getBatchProgress())
	const isThisBatch = $derived(
		batch !== null &&
			(collection.type === 'playlist'
				? batch.playlistId === collection.id
				: batch.albumId === collection.id),
	)
	const isOtherBatch = $derived(batch !== null && !isThisBatch)

	// Accessible progress text: collection label, the current track when there
	// is one, and done/total (CONTRACTS.md §12).
	const progressText = $derived.by(() => {
		if (!batch) {
			return ''
		}

		const parts = [batch.label, batch.currentTrackName].filter(
			(part): part is string => typeof part === 'string' && part.length > 0,
		)
		parts.push(m.downloadPlaylistProgress({ done: batch.done, total: batch.total }))

		return parts.join(' · ')
	})

	const showResult = (result: PlaylistDownloadResult) => {
		if (result.cancelled) {
			snackbar({ id: 'collection-download', message: m.downloadPlaylistCancelled() })
			return
		}

		snackbar({
			id: 'collection-download',
			message: m.downloadPlaylistResult({
				downloaded: result.downloaded,
				current: result.current,
				skippedLocal: result.skippedLocal,
				failed: result.failed,
			}),
		})
	}

	const startDownload = () => {
		const promise =
			collection.type === 'playlist'
				? downloadPlaylist(collection.id)
				: downloadAlbum(collection.id)

		void promise.then(showResult).catch((error: unknown) => {
			if (error instanceof OfflineStorageQuotaError) {
				snackbar({ id: 'collection-download-quota', message: m.downloadQuotaError() })
				return
			}

			snackbar.unexpectedError(error)
		})
	}
</script>

{#if isThisBatch && batch}
	<div class="flex min-w-0 flex-col justify-center gap-1 self-center">
		<progress
			class="batch-progress h-1.5 w-40 max-w-full"
			max={batch.total}
			value={batch.done}
			aria-valuetext={progressText}
		></progress>

		<span class="truncate text-body-sm text-onSurfaceVariant" role="status">
			{progressText}
		</span>
	</div>

	<Button kind="flat" class="my-1" onclick={() => cancelDownloads()}>
		{m.downloadPlaylistCancel()}
		<Icon type="close" />
	</Button>
{:else}
	<Button
		kind="flat"
		class="my-1"
		disabled={hasServerTracks !== true || isOtherBatch}
		onclick={startDownload}
	>
		{collection.type === 'album' ? m.downloadAlbum() : m.downloadPlaylist()}
		<Icon type="download" />
	</Button>
{/if}

<style lang="postcss">
	@reference '../../app.css';

	.batch-progress {
		appearance: none;
		overflow: hidden;
		border: none;
		border-radius: 9999px;
		background-color: var(--color-surfaceContainerHighest);
	}

	.batch-progress::-webkit-progress-bar {
		border-radius: 9999px;
		background-color: var(--color-surfaceContainerHighest);
	}

	.batch-progress::-webkit-progress-value {
		border-radius: 9999px;
		background-color: var(--color-primary);
		transition: width 0.2s ease;
	}

	.batch-progress::-moz-progress-bar {
		border-radius: 9999px;
		background-color: var(--color-primary);
	}
</style>
