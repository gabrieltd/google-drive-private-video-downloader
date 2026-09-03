import { stableUrlPath } from "./url-utils.js";

function nullableNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function nullableString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function normalizeFormat(rawFormat, progressive = Boolean(rawFormat?.progressive)) {
    if (!rawFormat || typeof rawFormat !== "object") return null;

    const metadata = rawFormat.transcodeMetadata && typeof rawFormat.transcodeMetadata === "object"
        ? rawFormat.transcodeMetadata
        : {};

    const url = nullableString(rawFormat.url);
    if (!url) return null;

    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return null;
    } catch {
        return null;
    }

    return {
        itag: nullableNumber(rawFormat.itag),
        url,
        width: nullableNumber(firstDefined(metadata.width, rawFormat.width)),
        height: nullableNumber(firstDefined(metadata.height, rawFormat.height)),
        fps: nullableNumber(firstDefined(
            metadata.videoFps,
            metadata.fps,
            rawFormat.videoFps,
            rawFormat.fps,
        )),
        bitrate: nullableNumber(firstDefined(
            metadata.bitrate,
            metadata.bitrateBps,
            rawFormat.bitrate,
            rawFormat.bitrateBps,
        )),
        contentLength: nullableNumber(firstDefined(metadata.contentLength, rawFormat.contentLength)),
        mimeType: nullableString(firstDefined(metadata.mimeType, rawFormat.mimeType, rawFormat.mime)),
        videoCodec: nullableString(firstDefined(
            metadata.videoCodecString,
            metadata.videoCodec,
            rawFormat.videoCodecString,
            rawFormat.videoCodec,
            rawFormat.video_codec,
        )),
        audioCodec: nullableString(firstDefined(
            metadata.audioCodecString,
            metadata.audioCodec,
            rawFormat.audioCodecString,
            rawFormat.audioCodec,
            rawFormat.audio_codec,
        )),
        progressive: Boolean(progressive),
    };
}

export function formatIdentity(format) {
    if (!format || typeof format !== "object") return null;
    if (format.itag !== null && format.itag !== undefined) return `itag:${format.itag}`;

    return [
        format.width ?? "",
        format.height ?? "",
        format.fps ?? "",
        format.mimeType ?? "",
        format.videoCodec ?? "",
        format.audioCodec ?? "",
    ].join("|");
}

export function selectBestProgressiveFormat(formats) {
    if (!Array.isArray(formats)) return null;

    const progressiveFormats = formats.filter((format) => format?.progressive !== false);
    if (progressiveFormats.length === 0) return null;

    return progressiveFormats.reduce((best, current) => {
        if (!best) return current;
        const fields = ["height", "width", "fps", "bitrate", "contentLength"];
        for (const field of fields) {
            const bestValue = best[field] ?? -1;
            const currentValue = current[field] ?? -1;
            if (currentValue !== bestValue) return currentValue > bestValue ? current : best;
        }
        return best;
    }, null);
}

export function sanitizeFilename(value, fallback = "video") {
    const original = typeof value === "string" ? value : "";
    let filename = original
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .trim();

    const extensionMatch = filename.match(/(\.[a-z0-9]{1,10})$/i);
    let extension = extensionMatch ? extensionMatch[1] : ".mp4";
    let basename = extensionMatch ? filename.slice(0, -extension.length) : filename;
    basename = basename.replace(/[. ]+$/g, "");

    if (!basename) basename = fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(basename)) basename += "-";

    const maxLength = 180;
    const maxBaseLength = maxLength - extension.length;
    basename = basename.slice(0, maxBaseLength).replace(/[. ]+$/g, "") || fallback;

    return `${basename}${extension}`;
}

export function formatBytes(value) {
    const bytes = nullableNumber(value);
    if (bytes === null || bytes < 0) return "Unknown size";
    if (bytes < 1024) return `${bytes} B`;

    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes;
    let unitIndex = -1;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function compactTitle(video) {
    return typeof video?.title === "string" ? video.title.trim().toLowerCase() : "";
}

function explicitSourceId(video) {
    const sourceMetadata = video?.sourceMetadata;
    // Drive can expose a playback/session ID alongside the stable file ID.
    // Prefer the stable identifiers so refreshed playback responses merge
    // into the same collected video.
    return sourceMetadata?.fileId ?? sourceMetadata?.driveId ?? sourceMetadata?.videoId ?? null;
}

function fallbackSourceKey(video) {
    const firstStablePath = Array.isArray(video?.formats)
        ? video.formats.map((format) => stableUrlPath(format?.url)).find(Boolean)
        : null;
    return `fallback:${compactTitle(video)}|${firstStablePath ?? ""}`;
}

export function videoIdentityKey(video) {
    const sourceId = explicitSourceId(video);
    if (sourceId !== null && sourceId !== undefined && String(sourceId).length > 0) {
        return `source:${sourceId}`;
    }
    if (video?.sourceMetadata?.stableSourceKey) return video.sourceMetadata.stableSourceKey;
    if (video?.identityKey) return video.identityKey;
    return fallbackSourceKey(video);
}

function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function createVideoRecord(parsedVideo, tabId, capturedAt = Date.now()) {
    const identityKey = videoIdentityKey(parsedVideo);
    const formats = dedupeFormats(parsedVideo?.formats);

    return {
        id: `video-${stableHash(identityKey)}`,
        tabId,
        title: typeof parsedVideo?.title === "string" && parsedVideo.title.trim() ? parsedVideo.title.trim() : "Untitled video",
        capturedAt,
        formats,
        sourceMetadata: parsedVideo?.sourceMetadata ?? { stableSourceKey: identityKey },
        identityKey,
        download: null,
    };
}

export function dedupeFormats(formats) {
    if (!Array.isArray(formats)) return [];
    const result = [];
    const identities = new Set();
    for (const format of formats) {
        const normalized = normalizeFormat(format, format?.progressive === true);
        const identity = formatIdentity(normalized);
        if (!normalized || !identity || identities.has(identity)) continue;
        identities.add(identity);
        result.push(normalized);
    }
    return result;
}

function mergeFormat(existing, incoming) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
        if (key === "progressive") {
            merged.progressive = Boolean(existing.progressive || value);
        } else if (value !== null && value !== undefined && value !== "") {
            merged[key] = value;
        }
    }
    return merged;
}

export function mergeFormatLists(existingFormats, incomingFormats) {
    const formatsByIdentity = new Map();
    for (const format of dedupeFormats(existingFormats)) {
        formatsByIdentity.set(formatIdentity(format), format);
    }
    for (const format of dedupeFormats(incomingFormats)) {
        const identity = formatIdentity(format);
        const previous = formatsByIdentity.get(identity);
        formatsByIdentity.set(identity, previous ? mergeFormat(previous, format) : format);
    }
    return [...formatsByIdentity.values()];
}

export function areVideosSame(first, second) {
    if (!first || !second) return false;
    if (first.id && second.id && first.id === second.id) return true;

    const firstSourceId = explicitSourceId(first);
    const secondSourceId = explicitSourceId(second);
    if (firstSourceId && secondSourceId && String(firstSourceId) === String(secondSourceId)) return true;

    const firstIdentity = videoIdentityKey(first);
    const secondIdentity = videoIdentityKey(second);
    if (firstIdentity && firstIdentity === secondIdentity) return true;

    const firstPaths = new Set(
        (first.formats ?? []).map((format) => stableUrlPath(format?.url)).filter(Boolean),
    );
    const sharesStableFormatPath = (second.formats ?? [])
        .map((format) => stableUrlPath(format?.url))
        .some((path) => path && firstPaths.has(path));

    return Boolean(sharesStableFormatPath && compactTitle(first) === compactTitle(second));
}

export function mergeVideo(existing, incoming) {
    const formats = mergeFormatLists(existing?.formats ?? [], incoming?.formats ?? []);
    return {
        ...existing,
        ...incoming,
        id: existing.id,
        tabId: existing.tabId,
        title: incoming.title && incoming.title !== "Untitled video" ? incoming.title : existing.title,
        capturedAt: existing.capturedAt ?? incoming.capturedAt,
        formats,
        sourceMetadata: { ...(existing.sourceMetadata ?? {}), ...(incoming.sourceMetadata ?? {}) },
        identityKey: existing.identityKey ?? incoming.identityKey,
        download: incoming.download ?? existing.download ?? null,
    };
}
