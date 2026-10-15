/**
 * 西瓜视频解析（纯函数模块，无 HTTP 边界）
 * 由 /api/xigua 路由与统一入口 /api/parse 直接函数调用。
 *
 * 2026-10-15 修复：
 *   西瓜网页端已改为客户端渲染——SSR 页面不再内嵌 `window._ROUTER_DATA`
 *   的 `videoInfoRes.item_list`，原「抓移动页 SSR 数据」链路整体失效。
 *   实测西瓜视频 ID 与抖音视频 ID 同源：西瓜详情页的
 *   `<meta name="mobile-agent" content="...https://m.douyin.com/share/video/{同一ID}">`
 *   直接指向抖音分享页，且该 ID 在抖音解析链路上可正常出结果。
 *   因此改为：优先复用抖音解析器（douyin.js），失败再回退原 SSR 抓取，
 *   让纯西瓜独占内容仍有兜底机会。
 */

import { logger } from "@/lib/api-utils";
import { getRedirectLocation } from "@/lib/redirect-location";
import douyinParse from "./douyin";


const PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
  Cookie:
    "MONITOR_WEB_ID=7892c49b-296e-4499-8704-e47c1b150c18; ixigua-a-s=1; ttcid=af99669b6304453480454f150701d5c226; BD_REF=1",
};

/** 判断解析结果是否含有可播放/可下载的媒体 */
function hasMedia(r) {
  if (!r || r.code !== 200 || !r.data) return false;
  const d = r.data;
  return Boolean(
    d.url ||
      d.photoUrl ||
      d.video ||
      (d.videos && d.videos.length) ||
      (d.images && d.images.length)
  );
}

/** 从任意西瓜链接中提取视频 ID（兼容 PC / 移动 / 分享页 / query 多种形态） */
export function extractXiguaId(shareUrl) {
  if (typeof shareUrl !== "string" || !shareUrl) return "";
  const patterns = [
    /ixigua\.com\/douyin\/share\/video\/(\d{6,})/i,
    /ixigua\.com\/(?:video|group|item)\/(\d{6,})/i,
    /ixigua\.com\/i(\d{6,})/i,
    /ixigua\.com\/(\d{10,})/i,
    /[?&](?:item_id|itemId|videoId|vid)=(\d{6,})/i,
    // 纯数字 ID 直传（parseVideoId("7676450021063735414")）
    /^i?(\d{10,})$/,
  ];
  for (const re of patterns) {
    const m = shareUrl.match(re);
    if (m?.[1]) return m[1];
  }
  return "";
}

/** 原 SSR 抓取链路（兜底） */
async function parseFromSsr(videoId) {
  const reqUrl = `https://m.ixigua.com/douyin/share/video/${videoId}?aweme_type=107&schema_type=1&utm_source=copy&utm_campaign=client_share&utm_medium=android&app=aweme`;
  const res = await fetch(reqUrl, { headers: PAGE_HEADERS });
  const html = await res.text();
  const re = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/is;
  const m = html.match(re);
  if (!m?.[1]) {
    return { code: 400, msg: "西瓜页面解析失败" };
  }
  let json;
  try {
    json = JSON.parse(m[1].trim());
  } catch (e) {
    logger.warn("xigua json", e.message);
    return { code: 400, msg: "西瓜数据 JSON 解析失败" };
  }
  const videoData =
    json?.loaderData?.["video_(id)/page"]?.videoInfoRes?.item_list?.[0];
  if (!videoData?.video?.play_addr?.url_list?.[0]) {
    return { code: 404, msg: "未找到播放地址" };
  }
  return {
    code: 200,
    msg: "解析成功",
    data: {
      title: videoData.desc || "",
      author: videoData.author?.nickname || "",
      avatar: videoData.author?.avatar_thumb?.url_list?.[0] || "",
      uid: String(videoData.author?.user_id || ""),
      cover: videoData.video?.cover?.url_list?.[0] || "",
      url: videoData.video.play_addr.url_list[0],
    },
  };
}

/**
 * 按视频 ID 解析。
 * 西瓜与抖音同源：先走抖音链路，命中即返回；否则回退 SSR。
 */
export async function parseVideoId(videoId) {
  const id = String(videoId || "").replace(/^i/, "").trim();
  if (!/^\d{6,}$/.test(id)) {
    return { code: 400, msg: "无法解析视频 id" };
  }

  // 1) 抖音链路（西瓜视频 ID 即抖音视频 ID）
  try {
    const r = await douyinParse(`https://www.douyin.com/video/${id}`);
    if (hasMedia(r)) {
      logger.log(`[xigua] 抖音同源链路命中: ${id}`);
      return r;
    }
    logger.log(
      `[xigua] 抖音同源链路未命中（code=${r?.code} msg=${r?.msg || ""}），回退 SSR 抓取`
    );
  } catch (e) {
    logger.warn(`[xigua] 抖音同源链路异常，回退 SSR: ${e.message}`);
  }

  // 2) 回退：原 SSR 抓取
  return parseFromSsr(id);
}

async function xiguaParse(shareUrl) {
  // 短链（如 v.ixigua.com）先取重定向，拿到真实链接再提取 ID
  let target = shareUrl;
  let id = extractXiguaId(shareUrl);
  if (!id) {
    try {
      const loc = await getRedirectLocation(shareUrl, PAGE_HEADERS);
      if (loc) {
        target = loc;
        id = extractXiguaId(loc);
      }
    } catch (e) {
      logger.warn(`[xigua] 短链重定向失败: ${e.message}`);
    }
  }
  if (!id) {
    return { code: 400, msg: "无法解析视频 id" };
  }
  logger.log(`[xigua] 解析 ${String(target).slice(0, 80)} → id=${id}`);
  return parseVideoId(id);
}

export default xiguaParse;
