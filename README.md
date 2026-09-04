# ![Google Drive Private Video Downloader icon](assets/icon.svg) Google Drive Private Video Downloader

A small Chromium Manifest V3 extension that downloads progressive video streams and supported files from the user's authenticated Google Drive session. It is vanilla JavaScript, local-only, and can be installed directly with **Load unpacked**.

## Features

- Capture is enabled independently per Google Drive tab.
- Detected videos accumulate for the lifetime of the Drive tab's session, including across previews and reloads.
- Detects multiple progressive qualities and lets you choose one.
- New videos are selected by default; selection is persisted per tab and can be downloaded with **Download selected**.
- Selects the best progressive format by resolution, width, frame rate, bitrate, and size.
- Deduplicates repeated Drive responses and merges newly discovered formats.
- Tracks download, completion, and interruption states.
- Limits `Download selected` to three download starts at a time.
- Limits Folder Scan to three active Chrome downloads, including regular-file preparation.
- Scans videos and regular files directly contained in the currently open Drive folder.
- Automatically downloads every supported folder item into `<Chrome Downloads>/<Drive folder name>/` when the scan finishes.
- Marks Google-native Docs, Sheets, Slides, and similar items as unsupported instead of attempting an unvalidated export.
- Shows the number of detected videos on the toolbar badge.
- Uses event-driven updates; neither the background nor the popup polls for changes.
- Keeps streaming URLs and temporary state in the current browser session only.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` (or the equivalent Chromium extensions page).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this repository folder.

No build step is required. `npm` is only needed to run the optional tests and lint checks.

## Usage

1. Open a Google Drive video page or a video preview modal.
2. Open the extension popup and click **ON** for that tab.
3. The tab is reloaded once when capture is first enabled so playback requests can be observed from the beginning.
4. Play or open the video preview. Detected videos appear in the popup and the badge count is updated.
5. Choose **Best** to automatically use the highest-quality progressive format, choose a specific quality if preferred, and click **Download**.
6. Use **Select all**, individual checkboxes, **Clear list**, and **Download selected** to manage the accumulated collection. Batch downloads choose Best independently for each selected video.

### Folder scanning

1. Open a Google Drive folder.
2. Open the extension and click **Scan current folder**.
3. Keep the Drive tab active while the extension visits video files and collects their playback streams.
4. The extension automatically downloads supported videos and regular files into `<Chrome Downloads>/<Drive folder name>/`.
5. Reopen the popup to review progress, failures, and unsupported Google-native items.

Folder scanning discovers direct videos, regular files, and unsupported Google-native items. It does not traverse subfolders or use the Drive API. Capture is enabled automatically for the scan without reloading the folder first. If playback times out or its metadata contains no directly downloadable progressive stream, the video is marked as failed and can be retried explicitly; adaptive-only playback requires stream muxing, which is outside V1. Regular files are prepared through the authenticated Drive page context, then passed to Chrome's download manager.

For a manual check, test a mixed folder with videos and a PDF, a folder with only regular files, a folder with more files than the visible viewport, a folder with no videos, a folder containing a subfolder, cancellation during discovery/collection/downloading, retrying a failed video, switching away from and back to the Drive tab, reopening the popup while a scan continues, and the existing manual video workflow.

Capture can be turned off independently in each tab without deleting its collection. The reload button reloads the current Drive tab; it does not restart the extension. The debugger is attached only while an enabled Drive tab is active, and is detached when you switch to another tab; returning to Drive reattaches it without an automatic reload.

## How it works

```text
Chrome Debugger
    ↓
Drive playback response
    ↓
parseDriveVideoResponse()
    ↓
normalized video and formats
    ↓
popup event / session state
    ↓
chrome.downloads.download()
```

The background service worker attaches `chrome.debugger` only to enabled `drive.google.com` tabs. It observes a small allowlist of known Drive playback hosts, reads a response body only long enough to parse it, then discards the raw body. The popup receives domain data (`videos`, `download`, and tab state), never raw CDP requests.

During a folder scan, the folder scanner reports direct file metadata to the service worker. Videos use the existing playback collector. Regular files use an authenticated `POST` to Drive's current `/uc` preparation endpoint from the Drive tab's `MAIN` world, validate the returned download URL, and immediately pass it to `chrome.downloads.download()`. A persisted queue keeps at most three folder transfers in `PREPARING` or `DOWNLOADING`, prioritizes pending videos, and starts the next item when a transfer completes or fails. Download URLs are never stored in the persisted folder state.

## Permissions

- `debugger`: observes network responses from the Google Drive player in the enabled tab.
- `activeTab`: works with the currently selected tab for the popup workflow.
- `tabs`: reads the URL of tracked tabs so capture can be stopped when a tab leaves Google Drive and stale session entries can be removed after a service-worker restart.
- `downloads`: saves selected streams and folder items through Chrome's download manager.
- `storage`: keeps temporary per-tab state in `chrome.storage.session` so service-worker restarts can recover enabled tabs and detected metadata during the browser session.
- `scripting`: injects the folder scanner and the regular-file preparation fetch only after the user clicks **Scan current folder**. The preparation fetch runs in the authenticated Drive tab's `MAIN` world; the extension does not request `<all_urls>` or a Drive host permission.

There is no `<all_urls>` host permission. The extension does not use the Google Drive API, OAuth, a backend, telemetry, analytics, or external uploads. It does not read, extract, store, or transmit cookie values or authorization headers. Regular Drive file downloads are prepared from the authenticated Drive page context using `credentials: "include"`, allowing the browser to attach its existing first-party session automatically.

## Limitations

- Google Drive uses internal playback APIs and their endpoints or response structures may change.
- Only progressive streams can currently be downloaded directly. Adaptive-only streams are recognized but are not muxed because this extension does not include FFmpeg or another media pipeline.
- Google-native Docs, Sheets, Slides, Forms, shortcuts, and similar items are reported as unsupported; this version does not implement Drive export.
- Regular-file preparation depends on the authenticated Drive page session, and Google may decline to provide a download URL.
- Captured signed URLs may expire. Reload the Drive video and capture a fresh URL if a download is interrupted.
- Chrome may display its debugger warning while an active debugger session exists; the extension minimizes this by detaching from inactive Drive tabs.
- The current browser session must already be authorized to view and play the video.
- The extension does not bypass access controls or download content unavailable to the active Google account.
- Folder scanning depends partly on Google Drive's UI DOM and virtualization behavior, which may change. Subfolders are not scanned, the Drive tab must remain active while video playback is being captured, signed playback URLs may expire, and some videos may have no directly downloadable progressive stream.

## Privacy and safety

All processing happens locally in the extension and browser. Video titles, streaming URLs, browsing history, cookie values, authorization headers, and response bodies are not sent externally or exported. Regular-file preparation uses the browser's existing first-party Drive session without reading or copying its credentials. The extension only observes or requests data for files the active account can already access.

Use the extension only for content you are authorized to download and in accordance with the applicable terms and laws.

## Development checks

```text
npm install
npm test
npm run lint
```

Tests cover generic filename/path sanitization, progressive format selection, parser tolerance, deterministic video identity, folder file normalization and download progress, URL/authuser parsing, matching, cancellation, retry, and per-tab session state.
