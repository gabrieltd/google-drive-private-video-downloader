import { normalizeFormat } from "./video-model.js";
import { stableUrlPath } from "./url-utils.js";

function firstString(...values) {
    return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

export function parseDriveVideoResponse(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;

    const mediaStreamingData = data.mediaStreamingData;
    const formatStreamingData = mediaStreamingData?.formatStreamingData;
    if (!formatStreamingData || typeof formatStreamingData !== "object") return null;

    const progressive = Array.isArray(formatStreamingData.progressiveTranscodes)
        ? formatStreamingData.progressiveTranscodes
              .map((format) => normalizeFormat(format, true))
              .filter(Boolean)
        : [];
    const adaptive = Array.isArray(formatStreamingData.adaptiveTranscodes)
        ? formatStreamingData.adaptiveTranscodes
              .map((format) => normalizeFormat(format, false))
              .filter(Boolean)
        : [];
    const formats = [...progressive, ...adaptive];
    if (formats.length === 0) return null;

    const metadata = data.mediaMetadata && typeof data.mediaMetadata === "object" ? data.mediaMetadata : {};
    const title = firstString(metadata.title, metadata.name, data.title, data.name) ?? "Untitled video";
    const sourceId = firstString(
        metadata.videoId,
        metadata.driveId,
        metadata.fileId,
        metadata.id,
        mediaStreamingData.videoId,
        data.videoId,
    );
    const firstStablePath = formats.map((format) => stableUrlPath(format.url)).find(Boolean);

    return {
        title,
        formats,
        sourceMetadata: {
            videoId: sourceId,
            stableSourceKey: sourceId
                ? `source:${sourceId}`
                : `fallback:${title.toLowerCase()}|${firstStablePath ?? ""}`,
            hasAdaptiveFormats: adaptive.length > 0,
        },
    };
}
