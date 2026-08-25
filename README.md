# ![Google Drive Private Video Downloader icon](assets/icon.svg) Google Drive Private Video Downloader

A small Chromium Manifest V3 extension that downloads progressive video streams already delivered to the user's authenticated Google Drive session. It is vanilla JavaScript, local-only, and can be installed directly with **Load unpacked**.

## Features

- Capture is enabled independently per Google Drive tab.
- Detects multiple progressive qualities and lets you choose one.
- Selects the best progressive format by resolution, width, frame rate, bitrate, and size.
- Deduplicates repeated Drive responses and merges newly discovered formats.
- Tracks download, completion, and interruption states.
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
5. Choose a progressive quality and click **Download**, or use **Download All**.

Capture can be turned off independently in each tab. The reload button reloads the current Drive tab; it does not restart the extension.

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

There is no `<all_urls>` host permission. The extension does not use the Google Drive API, OAuth, cookies, headers, a backend, telemetry, analytics, or external uploads.

## Limitations

- Google Drive uses internal playback APIs and their endpoints or response structures may change.
- Only progressive streams can currently be downloaded directly. Adaptive-only streams are recognized but are not muxed because this extension does not include FFmpeg or another media pipeline.
- Captured signed URLs may expire. Reload the Drive video and capture a fresh URL if a download is interrupted.
- The current browser session must already be authorized to view and play the video.
- The extension does not bypass access controls or download content unavailable to the active Google account.

## Privacy and safety

All processing happens locally in the extension and browser. Video titles, streaming URLs, browsing history, cookies, authorization headers, and response bodies are not sent externally or exported. The extension only observes playback data already delivered to the tab where the user has access.

Use the extension only for content you are authorized to download and in accordance with the applicable terms and laws.

## Development checks

```text
npm install
npm test
npm run lint
```

Tests cover filename sanitization, progressive format selection, parser tolerance, deterministic video identity, and per-tab session state.
