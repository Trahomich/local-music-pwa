<script lang="ts">
	import Button from '#lib/components/Button.svelte'
	import Icon from '#lib/components/icon/Icon.svelte'
	import { getDatabase } from '#lib/db/database.ts'
	import { isServerFileEntity } from '#lib/helpers/file-system.ts'
	import { getBatchProgress } from '#lib/offline/download-status.svelte.ts'
	import {
		cancelDownloads,
		downloadPlaylist,
		OfflineStorageQuotaError,
		type PlaylistDownloadResult,
	} from '#lib/offline/downloads.ts'

	interface Props {
		playlistId: number
		/** Current playlist entries; used to detect whether anything is downloadable. */
		trackIds: readonly number[]
	}

	const { playlistId, trackIds }: Props = $props()

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
	const isThisBatch = $derived(batch !== null && batch.playlistId === playlistId)
	const isOtherBatch = $derived(batch !== null && batch.playlistId !== playlistId)

	const showResult = (result: PlaylistDownloadResult) => {
		if (result.cancelled) {
			snackbar({ id: 'playlist-download', message: m.downloadPlaylistCancelled() })
			return
		}

		snackbar({
			id: 'playlist-download',
			message: m.downloadPlaylistResult({
				downloaded: result.downloaded,
				current: result.current,
				skippedLocal: result.skippedLocal,
				failed: result.failed,
			}),
		})
	}

	const startDownload = () => {
		void downloadPlaylist(playlistId)
			.then(showResult)
			.catch((error: unknown) => {
				if (error instanceof OfflineStorageQuotaError) {
					snackbar({ id: 'playlist-download-quota', message: m.downloadQuotaError() })
					return
				}

				snackbar.unexpectedError(error)
			})
	}
</script>

{#if isThisBatch && batch}
	<span class="self-center text-onSurfaceVariant" role="status">
		{m.downloadPlaylistProgress({ done: batch.done, total: batch.total })}
	</span>

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
		{m.downloadPlaylist()}
		<Icon type="download" />
	</Button>
{/if}
