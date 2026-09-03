# ![Google Drive Private Video Downloader icon](assets/icon.svg) Google Drive Private Video Downloader

A small Chromium Manifest V3 extension that downloads progressive video streams already delivered to the user's authenticated Google Drive session. It is vanilla JavaScript, local-only, and can be installed directly with **Load unpacked**.

## Features

- Capture is enabled independently per Google Drive tab.
- Detected videos accumulate for the lifetime of the Drive tab's session, including across previews and reloads.
- Detects multiple progressive qualities and lets you choose one.
- New videos are selected by default; selection is persisted per tab and can be downloaded with **Download selected**.
- Selects the best progressive format by resolution, width, frame rate, bitrate, and size.
- Deduplicates repeated Drive responses and merges newly discovered formats.
- Tracks download, completion, and interruption states.
- Limits `Download selected` to three download starts at a time.
- Scans the videos directly contained in the currently open Drive folder and collects them sequentially.
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
3. Keep the Drive tab active while the extension visits each video and collects its playback streams.
4. Review the accumulated videos and their checkboxes.
5. Use **Download selected** after deselecting anything you do not want to download.

Folder scanning discovers only video files directly inside the current folder. It does not traverse subfolders, use the Drive API, or download files automatically. Capture is enabled automatically for the scan without reloading the folder first. If a video times out or Drive exposes separate audio and video streams, it is marked as failed and can be retried explicitly; the latter requires adaptive-stream muxing, which is outside V1.

For a manual V1 check, test a small mixed folder, a folder with more files than the visible viewport, a folder with no videos, cancellation during discovery or collection, retrying a failed video, switching away from and back to the Drive tab, reopening the popup while a scan continues, and downloading a manually reduced selection.

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

## Permissions

- `debugger`: observes network responses from the Google Drive player in the enabled tab.
- `activeTab`: works with the currently selected tab for the popup workflow.
- `tabs`: reads the URL of tracked tabs so capture can be stopped when a tab leaves Google Drive and stale session entries can be removed after a service-worker restart.
- `downloads`: saves a selected stream through Chrome's download manager.
- `storage`: keeps temporary per-tab state in `chrome.storage.session` so service-worker restarts can recover enabled tabs and detected metadata during the browser session.
- `scripting`: injects the folder scanner only after the user clicks **Scan current folder**. It is used with `activeTab`; the extension does not request `<all_urls>` or a Drive host permission.

There is no `<all_urls>` host permission. The extension does not use the Google Drive API, OAuth, cookies, headers, a backend, telemetry, analytics, or external uploads.

## Limitations

- Google Drive uses internal playback APIs and their endpoints or response structures may change.
- Only progressive streams can currently be downloaded directly. Adaptive-only streams are recognized but are not muxed because this extension does not include FFmpeg or another media pipeline.
- Captured signed URLs may expire. Reload the Drive video and capture a fresh URL if a download is interrupted.
- Chrome may display its debugger warning while an active debugger session exists; the extension minimizes this by detaching from inactive Drive tabs.
- The current browser session must already be authorized to view and play the video.
- The extension does not bypass access controls or download content unavailable to the active Google account.
- Folder scanning depends partly on Google Drive's UI DOM and virtualization behavior, which may change. Subfolders are not scanned, the Drive tab must remain active for playback capture, signed playback URLs may expire, and some videos may have no directly downloadable progressive stream.

## Privacy and safety

All processing happens locally in the extension and browser. Video titles, streaming URLs, browsing history, cookies, authorization headers, and response bodies are not sent externally or exported. The extension only observes playback data already delivered to the tab where the user has access.

Use the extension only for content you are authorized to download and in accordance with the applicable terms and laws.

## Development checks

```text
npm install
npm test
npm run lint
```

Tests cover filename sanitization, progressive format selection, parser tolerance, deterministic video identity, folder candidate normalization, URL parsing, matching, cancellation, retry, and per-tab session state.
