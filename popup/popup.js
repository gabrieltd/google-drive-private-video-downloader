import { MESSAGE_TYPES } from "../lib/messages.js";
import { FOLDER_SCAN_STATUSES } from "../lib/folder-scan.js";
import { formatBytes, formatIdentity, selectBestProgressiveFormat } from "../lib/video-model.js";
import { isGoogleDriveFolderUrl, isGoogleDriveUrl } from "../lib/url-utils.js";

document.addEventListener("DOMContentLoaded", () => {
    const header = document.querySelector(".header");
    const notDriveMessage = document.getElementById("only-in-drive-message");
    const downloadContainer = document.getElementById("download-container");
    const statusMessage = document.getElementById("status-message");
    const btnOn = document.getElementById("button-on");
    const btnOff = document.getElementById("button-off");
    const reloadBtn = document.querySelector(".reload-button");
    const selectionToolbar = document.getElementById("selection-toolbar");
    const selectAllCheckbox = document.getElementById("select-all");
    const selectionCount = document.getElementById("selection-count");
    const collectionActions = document.getElementById("collection-actions");
    const clearListButton = document.getElementById("clear-list");
    const downloadSelectedButton = document.getElementById("download-selected");
    const folderSection = document.getElementById("folder-section");
    const scanFolderButton = document.getElementById("scan-folder");
    const folderScanProgress = document.getElementById("folder-scan-progress");
    const folderScanMessageElement = document.getElementById("folder-scan-message");
    const cancelFolderScanButton = document.getElementById("cancel-folder-scan");
    const retryFolderScanButton = document.getElementById("retry-folder-scan");
    const folderScanHint = document.getElementById("folder-scan-hint");

    let activeTabId = null;
    let currentState = null;
    let currentVideos = [];
    let selectedVideoIds = new Set();
    let currentTabUrl = "";

    function sendMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (response) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) {
                    reject(new Error(lastError.message));
                    return;
                }
                resolve(response);
            });
        });
    }

    function setStatus(message, isError = false) {
        statusMessage.textContent = message;
        statusMessage.classList.toggle("error", isError);
    }

    function updateButtons(state) {
        const enabled = state?.enabled === true;
        const hasError = Boolean(state?.lastError);
        const scanActive = [
            FOLDER_SCAN_STATUSES.DISCOVERING,
            FOLDER_SCAN_STATUSES.COLLECTING,
            FOLDER_SCAN_STATUSES.PAUSED,
        ].includes(state?.folderScan?.status);
        btnOn.disabled = scanActive || enabled && !hasError;
        btnOn.textContent = enabled && hasError ? "RETRY" : "ON";
        btnOff.disabled = scanActive || !enabled;
        reloadBtn.classList.toggle("active", enabled);
        reloadBtn.disabled = scanActive;
    }

    function qualityLabel(format) {
        const resolution = format.height ? `${format.height}p` : "Unknown quality";
        const fps = format.fps ? ` · ${format.fps} fps` : "";
        const size = format.contentLength ? ` · ${formatBytes(format.contentLength)}` : "";
        return `${resolution}${fps}${size}`;
    }

    function compareFormatQuality(left, right) {
        for (const field of ["height", "width", "fps", "bitrate", "contentLength"]) {
            const difference = (right[field] ?? -1) - (left[field] ?? -1);
            if (difference !== 0) return difference;
        }
        return 0;
    }

    function selectionForVideos(state, videos) {
        const validIds = new Set(videos.map((video) => video.id));
        return new Set((state?.selectedVideoIds ?? []).filter((id) => validIds.has(id)));
    }

    function updateSelectionControls(videos) {
        const total = videos.length;
        const selected = selectedVideoIds.size;
        selectAllCheckbox.checked = total > 0 && selected === total;
        selectAllCheckbox.indeterminate = selected > 0 && selected < total;
        selectAllCheckbox.disabled = total === 0;
        selectionCount.textContent = `${selected} of ${total} selected`;
        downloadSelectedButton.textContent = `Download selected (${selected})`;
        downloadSelectedButton.disabled = selected === 0;
        const scanActive = [
            FOLDER_SCAN_STATUSES.DISCOVERING,
            FOLDER_SCAN_STATUSES.COLLECTING,
            FOLDER_SCAN_STATUSES.PAUSED,
        ].includes(currentState?.folderScan?.status);
        clearListButton.disabled = total === 0 || scanActive;
        selectionToolbar.classList.toggle("hidden", total === 0);
    }

    function getFolderScanMessage(scan) {
        if (!scan) return "";
        const adaptiveFailureCount = (scan.candidates ?? [])
            .filter((candidate) => candidate.error?.includes("separate video and audio streams")).length;
        const failureSummary = scan.failedCount
            ? ` ${scan.failedCount} failed${adaptiveFailureCount ? ` (${adaptiveFailureCount} require adaptive muxing)` : ""}`
            : "";
        if (scan.status === FOLDER_SCAN_STATUSES.DISCOVERING) {
            return `Scanning folder… ${scan.discoveredCount} video candidate${scan.discoveredCount === 1 ? "" : "s"} discovered`;
        }
        if (scan.status === FOLDER_SCAN_STATUSES.COLLECTING) {
            return `Collecting ${scan.capturedCount} of ${scan.total} videos…${failureSummary}`;
        }
        if (scan.status === FOLDER_SCAN_STATUSES.PAUSED) return "Folder scan paused. Return to this Drive tab to continue.";
        if (scan.status === FOLDER_SCAN_STATUSES.COMPLETED) {
            return scan.total === 0
                ? "No video files were found in this folder."
                : `Folder scan complete: ${scan.capturedCount} of ${scan.total} captured${failureSummary ? `,${failureSummary}` : ""}.`;
        }
        if (scan.status === FOLDER_SCAN_STATUSES.CANCELLED) return "Folder scan cancelled.";
        if (scan.status === FOLDER_SCAN_STATUSES.ERROR) return scan.error ?? "Unable to inspect this Drive folder.";
        return "";
    }

    function renderFolderScan(state, isFolder) {
        const scan = state?.folderScan;
        const active = [
            FOLDER_SCAN_STATUSES.DISCOVERING,
            FOLDER_SCAN_STATUSES.COLLECTING,
            FOLDER_SCAN_STATUSES.PAUSED,
        ].includes(scan?.status);
        const hasResult = scan?.status && scan.status !== FOLDER_SCAN_STATUSES.IDLE;
        scanFolderButton.disabled = !isFolder || active;
        folderScanProgress.classList.toggle("hidden", !hasResult);
        folderScanMessageElement.textContent = getFolderScanMessage(scan);
        cancelFolderScanButton.classList.toggle("hidden", !active);
        cancelFolderScanButton.disabled = !active;
        retryFolderScanButton.classList.toggle("hidden", active || !scan?.failedCount);
        retryFolderScanButton.disabled = active || !scan?.failedCount;
        folderScanHint.textContent = isFolder
            ? active ? "" : "Only videos directly inside this folder are scanned; subfolders are skipped."
            : "Open a Drive folder to scan its videos.";
    }

    async function persistSelection(nextSelection) {
        const previousState = currentState;
        const previousSelection = [...selectedVideoIds];
        selectedVideoIds = new Set(nextSelection);
        currentState = { ...(currentState ?? {}), selectedVideoIds: [...selectedVideoIds] };
        render(currentState, currentVideos);

        try {
            const response = await sendMessage({
                type: MESSAGE_TYPES.SET_SELECTION,
                tabId: activeTabId,
                selectedVideoIds: [...selectedVideoIds],
            });
            if (!response?.success) throw new Error(response?.error ?? "Unable to save selection.");
            render(response.state, response.videos ?? currentVideos);
        } catch (error) {
            selectedVideoIds = new Set(previousSelection);
            currentState = previousState;
            render(currentState, currentVideos);
            setStatus(error.message, true);
        }
    }

    function renderVideo(video) {
        const item = document.createElement("div");
        item.className = "video-item";

        const info = document.createElement("div");
        info.className = "video-info";

        const checkbox = document.createElement("input");
        checkbox.className = "video-checkbox";
        checkbox.type = "checkbox";
        checkbox.checked = selectedVideoIds.has(video.id);
        checkbox.setAttribute("aria-label", `Select ${video.title}`);
        checkbox.addEventListener("change", () => {
            const nextSelection = new Set(selectedVideoIds);
            if (checkbox.checked) nextSelection.add(video.id);
            else nextSelection.delete(video.id);
            void persistSelection([...nextSelection]);
        });

        const title = document.createElement("span");
        title.className = "video-title";
        title.title = video.title;
        title.textContent = video.title;
        info.appendChild(title);

        const progressiveFormats = (video.formats ?? [])
            .filter((format) => format.progressive === true)
            .sort(compareFormatQuality);
        const controls = document.createElement("div");
        controls.className = "video-controls";
        let selectedFormat = selectBestProgressiveFormat(progressiveFormats);

        if (progressiveFormats.length > 0) {
            const selector = document.createElement("select");
            selector.className = "quality-selector";
            const bestOption = document.createElement("option");
            bestOption.value = "best";
            bestOption.textContent = `Best — ${qualityLabel(selectedFormat)}`;
            selector.appendChild(bestOption);

            for (const format of progressiveFormats) {
                const option = document.createElement("option");
                option.value = formatIdentity(format);
                option.textContent = qualityLabel(format);
                selector.appendChild(option);
            }
            selector.addEventListener("change", () => {
                selectedFormat = selector.value === "best"
                    ? selectBestProgressiveFormat(progressiveFormats)
                    : progressiveFormats.find((format) => formatIdentity(format) === selector.value) ?? null;
            });
            controls.appendChild(selector);
        }

        const downloadButton = document.createElement("button");
        downloadButton.className = "download-button";
        const downloadStatus = video.download?.status;
        if (downloadStatus === "downloading") {
            downloadButton.textContent = "Downloading…";
            downloadButton.disabled = true;
        } else if (downloadStatus === "complete") {
            downloadButton.textContent = "Download again";
        } else if (downloadStatus === "interrupted") {
            downloadButton.textContent = "Retry";
        } else {
            downloadButton.textContent = "Download";
        }

        if (!selectedFormat) {
            downloadButton.disabled = true;
            const adaptiveNote = document.createElement("span");
            adaptiveNote.className = "format-note";
            adaptiveNote.textContent = "No direct progressive stream";
            controls.appendChild(adaptiveNote);
        } else {
            downloadButton.addEventListener("click", async () => {
                downloadButton.disabled = true;
                setStatus("Starting download…");
                try {
                    const response = await sendMessage({
                        type: MESSAGE_TYPES.DOWNLOAD_VIDEO,
                        tabId: activeTabId,
                        videoId: video.id,
                        formatKey: formatIdentity(selectedFormat),
                    });
                    if (!response?.success) setStatus(response?.error ?? "Download failed.", true);
                } catch (error) {
                    setStatus(error.message, true);
                }
            });
        }
        controls.appendChild(downloadButton);

        item.append(checkbox, info, controls);
        return item;
    }

    function render(state, videos) {
        currentState = state;
        currentVideos = videos;
        selectedVideoIds = selectionForVideos(state, videos);
        updateButtons(state);
        renderFolderScan(state, isGoogleDriveFolderUrl(currentTabUrl));
        downloadContainer.replaceChildren();

        const downloadError = videos.find((video) => video.download?.error)?.download?.error;
        const scanStatus = state?.folderScan?.status;
        if (state?.lastError) {
            setStatus(state.lastError, true);
        } else if ([
            FOLDER_SCAN_STATUSES.DISCOVERING,
            FOLDER_SCAN_STATUSES.COLLECTING,
            FOLDER_SCAN_STATUSES.PAUSED,
            FOLDER_SCAN_STATUSES.COMPLETED,
            FOLDER_SCAN_STATUSES.CANCELLED,
            FOLDER_SCAN_STATUSES.ERROR,
        ].includes(scanStatus)) {
            setStatus(getFolderScanMessage(state.folderScan), scanStatus === FOLDER_SCAN_STATUSES.ERROR);
        } else if (downloadError) {
            setStatus(downloadError, true);
        } else if (!state?.enabled) {
            setStatus(videos.length > 0 ? "Capture is off. Existing collection is available." : "Click ON to start capture.");
        } else if (videos.length === 0) {
            setStatus("Waiting for a Google Drive video… Open or play a video preview to detect available streams.");
        } else {
            setStatus(state.debuggerAttached
                ? "Capturing"
                : "Capture is enabled. Return to this Drive tab to resume detection.");
        }

        updateSelectionControls(videos);
        for (const video of videos) downloadContainer.appendChild(renderVideo(video));
    }

    function showDriveUi(isDrive) {
        header.classList.toggle("hidden", !isDrive);
        downloadContainer.classList.toggle("hidden", !isDrive);
        statusMessage.classList.toggle("hidden", !isDrive);
        notDriveMessage.classList.toggle("hidden", isDrive);
        collectionActions.classList.toggle("hidden", !isDrive);
        selectionToolbar.classList.toggle("hidden", !isDrive || currentVideos.length === 0);
        folderSection.classList.toggle("hidden", !isDrive);
        renderFolderScan(currentState, isDrive && isGoogleDriveFolderUrl(currentTabUrl));
    }

    async function refreshState() {
        if (activeTabId === null) return;
        try {
            const response = await sendMessage({ type: MESSAGE_TYPES.GET_TAB_STATE, tabId: activeTabId });
            if (!response?.success) throw new Error(response?.error ?? "Unable to read tab state.");
            render(response.state, response.videos ?? []);
        } catch (error) {
            setStatus(error.message, true);
        }
    }

    async function setEnabled(enabled) {
        btnOn.disabled = true;
        btnOff.disabled = true;
        setStatus(enabled ? "Starting capture…" : "Stopping capture…");
        try {
            const response = await sendMessage({
                type: MESSAGE_TYPES.SET_TAB_ENABLED,
                tabId: activeTabId,
                enabled,
                reload: enabled,
            });
            if (!response?.success) {
                render(response?.state ?? currentState, response?.videos ?? currentVideos);
                setStatus(response?.error ?? "Unable to change capture state.", true);
                return;
            }
            render(response.state, response.videos ?? []);
        } catch (error) {
            setStatus(error.message, true);
        }
    }

    btnOn.addEventListener("click", () => void setEnabled(true));
    btnOff.addEventListener("click", () => void setEnabled(false));
    scanFolderButton.addEventListener("click", async () => {
        scanFolderButton.disabled = true;
        setStatus("Starting folder scan…");
        try {
            const response = await sendMessage({ type: MESSAGE_TYPES.START_FOLDER_SCAN, tabId: activeTabId });
            if (!response?.success) {
                render(response?.state ?? currentState, response?.videos ?? currentVideos);
                setStatus(response?.error ?? "Unable to start the folder scan.", true);
                return;
            }
            render(response.state, response.videos ?? currentVideos);
        } catch (error) {
            setStatus(error.message, true);
        }
    });
    cancelFolderScanButton.addEventListener("click", async () => {
        cancelFolderScanButton.disabled = true;
        try {
            const response = await sendMessage({ type: MESSAGE_TYPES.CANCEL_FOLDER_SCAN, tabId: activeTabId });
            if (!response?.success) setStatus(response?.error ?? "Unable to cancel the folder scan.", true);
            else render(response.state, response.videos ?? currentVideos);
        } catch (error) {
            setStatus(error.message, true);
        }
    });
    retryFolderScanButton.addEventListener("click", async () => {
        retryFolderScanButton.disabled = true;
        try {
            const response = await sendMessage({ type: MESSAGE_TYPES.RETRY_FAILED_FOLDER_SCAN, tabId: activeTabId });
            if (!response?.success) setStatus(response?.error ?? "Unable to retry failed videos.", true);
            else render(response.state, response.videos ?? currentVideos);
        } catch (error) {
            setStatus(error.message, true);
        }
    });
    reloadBtn.addEventListener("click", () => {
        if (activeTabId !== null) chrome.tabs.reload(activeTabId);
    });
    selectAllCheckbox.addEventListener("change", () => {
        const nextSelection = selectAllCheckbox.checked
            ? currentVideos.map((video) => video.id)
            : [];
        void persistSelection(nextSelection);
    });
    clearListButton.addEventListener("click", async () => {
        clearListButton.disabled = true;
        try {
            const response = await sendMessage({ type: MESSAGE_TYPES.CLEAR_VIDEOS, tabId: activeTabId });
            if (!response?.success) throw new Error(response?.error ?? "Unable to clear the collection.");
            render(response.state, response.videos ?? []);
        } catch (error) {
            setStatus(error.message, true);
        }
    });
    downloadSelectedButton.addEventListener("click", async () => {
        if (selectedVideoIds.size === 0) return;
        downloadSelectedButton.disabled = true;
        try {
            const response = await sendMessage({
                type: MESSAGE_TYPES.DOWNLOAD_SELECTED,
                tabId: activeTabId,
                videoIds: [...selectedVideoIds],
            });
            if (!response?.success) setStatus("No selected video could be queued for download.", true);
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            updateSelectionControls(currentVideos);
        }
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (!message || message.tabId !== activeTabId) return;
        if (message.type === MESSAGE_TYPES.VIDEO_DETECTED || message.type === MESSAGE_TYPES.VIDEO_UPDATED) {
            currentState = message.state ?? currentState;
            const index = currentVideos.findIndex((video) => video.id === message.video?.id);
            if (index === -1) currentVideos = [...currentVideos, message.video];
            else currentVideos = currentVideos.map((video, videoIndex) => videoIndex === index ? message.video : video);
            render(currentState, currentVideos);
        } else if (message.type === MESSAGE_TYPES.DOWNLOAD_UPDATED) {
            currentVideos = currentVideos.map((video) => video.id === message.videoId
                ? { ...video, download: message.download }
                : video);
            render(currentState, currentVideos);
        } else if (message.type === MESSAGE_TYPES.TAB_STATE_CHANGED || message.type === MESSAGE_TYPES.FOLDER_SCAN_UPDATED) {
            currentState = message.state;
            currentVideos = message.state?.videos ?? currentVideos;
            render(currentState, currentVideos);
        }
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        const isDrive = Boolean(tab && isGoogleDriveUrl(tab.url));
        currentTabUrl = tab?.url ?? "";
        showDriveUi(isDrive);
        if (!isDrive) {
            setStatus("Open a Google Drive video or preview to use this extension.");
            return;
        }
        activeTabId = tab.id;
        void refreshState();
    });
});
