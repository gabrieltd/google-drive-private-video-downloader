import { MESSAGE_TYPES } from "../lib/messages.js";
import { formatBytes, formatIdentity, selectBestProgressiveFormat } from "../lib/video-model.js";
import { isGoogleDriveUrl } from "../lib/url-utils.js";

document.addEventListener("DOMContentLoaded", () => {
    const header = document.querySelector(".header");
    const notDriveMessage = document.getElementById("only-in-drive-message");
    const downloadContainer = document.getElementById("download-container");
    const statusMessage = document.getElementById("status-message");
    const btnOn = document.getElementById("button-on");
    const btnOff = document.getElementById("button-off");
    const reloadBtn = document.querySelector(".reload-button");
    const downloadAllBtn = document.getElementById("download-all");

    let activeTabId = null;
    let currentState = null;
    let currentVideos = [];

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
        btnOn.disabled = enabled && !hasError;
        btnOn.textContent = enabled && hasError ? "RETRY" : "ON";
        btnOff.disabled = !enabled;
        reloadBtn.classList.toggle("active", enabled);
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

    function renderVideo(video) {
        const item = document.createElement("div");
        item.className = "video-item";

        const info = document.createElement("div");
        info.className = "video-info";

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

        item.append(info, controls);
        return item;
    }

    function render(state, videos) {
        currentState = state;
        currentVideos = videos;
        updateButtons(state);
        downloadContainer.replaceChildren();

        const downloadError = videos.find((video) => video.download?.error)?.download?.error;
        if (state?.lastError) {
            setStatus(state.lastError, true);
        } else if (downloadError) {
            setStatus(downloadError, true);
        } else if (!state?.enabled) {
            setStatus("Click ON to start capture.");
        } else if (videos.length === 0) {
            setStatus("Waiting for a Google Drive video… Open or play a video preview to detect available streams.");
        } else {
            setStatus(state.debuggerAttached ? "Capturing" : "Capture is paused.");
        }

        const hasDownloadableVideo = videos.some((video) => (video.formats ?? []).some((format) => format.progressive));
        downloadAllBtn.classList.toggle("hidden", !hasDownloadableVideo);
        for (const video of videos) downloadContainer.appendChild(renderVideo(video));
    }

    function showDriveUi(isDrive) {
        header.classList.toggle("hidden", !isDrive);
        downloadContainer.classList.toggle("hidden", !isDrive);
        statusMessage.classList.toggle("hidden", !isDrive);
        notDriveMessage.classList.toggle("hidden", isDrive);
        downloadAllBtn.classList.toggle("hidden", !isDrive);
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
    reloadBtn.addEventListener("click", () => {
        if (activeTabId !== null) chrome.tabs.reload(activeTabId);
    });
    downloadAllBtn.addEventListener("click", async () => {
        downloadAllBtn.disabled = true;
        try {
            const response = await sendMessage({ type: MESSAGE_TYPES.DOWNLOAD_ALL, tabId: activeTabId });
            if (!response?.success) setStatus("No video could be queued for download.", true);
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            downloadAllBtn.disabled = false;
        }
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (!message || message.tabId !== activeTabId) return;
        if (message.type === MESSAGE_TYPES.VIDEO_DETECTED || message.type === MESSAGE_TYPES.VIDEO_UPDATED) {
            const index = currentVideos.findIndex((video) => video.id === message.video?.id);
            if (index === -1) currentVideos = [...currentVideos, message.video];
            else currentVideos = currentVideos.map((video, videoIndex) => videoIndex === index ? message.video : video);
            render(currentState, currentVideos);
        } else if (message.type === MESSAGE_TYPES.DOWNLOAD_UPDATED) {
            currentVideos = currentVideos.map((video) => video.id === message.videoId
                ? { ...video, download: message.download }
                : video);
            render(currentState, currentVideos);
        } else if (message.type === MESSAGE_TYPES.TAB_STATE_CHANGED) {
            currentState = message.state;
            if (!currentState.enabled) currentVideos = [];
            render(currentState, currentVideos);
        }
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        const isDrive = Boolean(tab && isGoogleDriveUrl(tab.url));
        showDriveUi(isDrive);
        if (!isDrive) {
            setStatus("Open a Google Drive video or preview to use this extension.");
            return;
        }
        activeTabId = tab.id;
        void refreshState();
    });
});
