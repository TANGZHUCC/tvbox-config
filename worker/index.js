/**
 * TVBox 动态接口 Worker（Cloudflare Workers）
 * ------------------------------------------------------------------
 * 作用：给 TVBox 一个「永远不会变」的固定地址，后端随便换。
 *
 * 路由：
 *   GET /tvbox.json        主接口（缓存 10 分钟）
 *   GET /tvbox.json?n=30   只返回前 30 个源（弱设备 / 省流量）
 *   GET /health            体检报告
 *   GET /version           当前版本号（客户端可据此判断是否更新）
 *   GET /ping              存活探测
 *
 * 环境变量（wrangler secret / vars）：
 *   UPSTREAM   上游原始配置地址，例如
 *              https://raw.githubusercontent.com/<user>/<repo>/main/config/tvbox.json
 *   ADMIN_KEY  刷新缓存的密钥（可选）
 */

const CACHE_TTL = 600; // 秒

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      ...CORS,
      ...extraHeaders,
    },
  });
}

/** 带边缘缓存的上游拉取 */
async function fetchUpstream(url, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });

  let res = await cache.match(cacheKey);
  if (res) return { res, hit: true };

  res = await fetch(url, {
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    headers: { 'User-Agent': 'tvbox-worker/1.0' },
  });
  if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);

  const body = await res.text();
  res = new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_TTL}` },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return { res, hit: false };
}

/** 可选：简单的地理/线路分流，把源按 tag 打散给不同地区 */
function sliceSites(config, n) {
  if (!n || n <= 0 || !Array.isArray(config.sites)) return config;
  return { ...config, sites: config.sites.slice(0, n) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/ping') {
      return new Response('pong', { headers: { 'Content-Type': 'text/plain', ...CORS } });
    }

    if (url.pathname === '/tvbox.json' || url.pathname === '/') {
      try {
        const { res, hit } = await fetchUpstream(env.UPSTREAM, ctx);
        const config = await res.json();
        const n = Number(url.searchParams.get('n') || 0);
        return json(sliceSites(config, n), {
          'X-Cache': hit ? 'HIT' : 'MISS',
          'X-Sites': String((config.sites || []).length),
        });
      } catch (e) {
        return json({ error: String(e.message || e) }, { 'Cache-Control': 'no-store' });
      }
    }

    if (url.pathname === '/health' || url.pathname === '/version') {
      const target = env.UPSTREAM.replace(/tvbox\.json$/, url.pathname === '/health' ? 'health.json' : 'version.json');
      try {
        const { res } = await fetchUpstream(target, ctx);
        const data = await res.json();
        return json(data, { 'Cache-Control': 'public, max-age=60' });
      } catch (e) {
        return json({ error: String(e.message || e) }, { 'Cache-Control': 'no-store' });
      }
    }

    // 手动刷新边缘缓存（部署时调用一次）
    if (url.pathname === '/refresh') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
        return new Response('forbidden', { status: 403, headers: CORS });
      }
      await caches.default.delete(new Request(env.UPSTREAM, { method: 'GET' }));
      return json({ ok: true, refreshedAt: new Date().toISOString() }, { 'Cache-Control': 'no-store' });
    }

    return new Response('Not Found', { status: 404, headers: CORS });
  },
};
