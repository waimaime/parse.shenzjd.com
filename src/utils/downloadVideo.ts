/**
 * 视频/音频真实下载工具（纯前端，不经过后端函数代理）。
 *
 * 背景（2026-10-16 实测）：
 * 站点部署在 EdgeOne Pages（Cloud Functions），函数响应体有大小上限，
 * 19MB 的小红书视频经 /api/video-proxy 代理返回 **413 Payload Too Large**，
 * 表现就是「解析成功但下载失败」。
 * 而小红书 xhscdn 实测无 Referer 防盗链，且返回 `Access-Control-Allow-Origin: *`，
 * 浏览器可直接跨域读取 → 改为前端 fetch → Blob → a[download] 真实保存，
 * 不受函数响应体上限限制，且文件名正确（带 .mp4 扩展名）。
 *
 * 兼容性：图床/CDN 不支持 CORS（fetch 被拒）时，自动回退为新窗口打开直链。
 */

/** 从 URL 推断扩展名（忽略 query 与 CDN 的 `!` 处理参数） */
function getUrlExt(src: string): string {
  const clean = src.split("?")[0].split("!")[0];
  const m = clean.match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toLowerCase() : "";
}

/** 依据 Content-Type 推断扩展名 */
function extByMime(mime: string): string {
  const map: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/x-flv": "flv",
    "video/quicktime": "mov",
    "application/x-mpegurl": "m3u8",
    "application/vnd.apple.mpegurl": "m3u8",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const base = (mime || "").split(";")[0].trim().toLowerCase();
  return map[base] || "";
}

/** 清洗文件名：去掉文件系统非法字符，限制长度 */
function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "video"
  );
}

/** 补全扩展名（文件名已带扩展名则原样返回） */
function ensureExt(filename: string, mime: string, src: string): string {
  if (/\.[a-z0-9]{2,4}$/i.test(filename)) return filename;
  return `${filename}.${extByMime(mime) || getUrlExt(src) || "mp4"}`;
}

export interface DownloadVideoOptions {
  /** 进度回调（0-100），仅在上游返回 Content-Length 时可用 */
  onProgress?: (percent: number) => void;
}

/**
 * 下载视频/音频直链。
 * @returns true=真实下载成功；false=已回退为新窗口打开（CORS/防盗链导致）
 */
export async function downloadVideoFile(
  url: string,
  filename: string,
  options: DownloadVideoOptions = {}
): Promise<boolean> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const total = Number(res.headers.get("content-length") || 0);
    let blob: Blob;

    if (res.body && typeof res.body.getReader === "function" && total > 0) {
      // 流式读取：边下边更新进度，避免大文件无响应
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        options.onProgress?.(Math.min(100, Math.round((received / total) * 100)));
      }
      blob = new Blob(chunks as BlobPart[], {
        type: res.headers.get("content-type") || "video/mp4",
      });
    } else {
      blob = await res.blob();
    }

    // 上游返回 HTML 错误页（非媒体）时视为失败，避免存下一个打不开的文件
    if (blob.size < 1024 && !/^(video|audio)\//i.test(blob.type)) {
      throw new Error("not a media file");
    }

    const name = ensureExt(sanitizeFilename(filename), blob.type, url);
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    return true;
  } catch {
    // CDN 不支持 CORS / 防盗链：回退为新窗口打开直链（用户可右键另存）
    window.open(url, "_blank", "noopener,noreferrer");
    return false;
  }
}
