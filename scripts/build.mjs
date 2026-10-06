#!/usr/bin/env node
/**
 * TVBox 接口构建器
 * ------------------------------------------------------------------
 * 流程：读取 sources.json -> 并发健康检查 -> 打分排序 -> 剔除失效源
 *       -> 生成 config/tvbox.json（TVBox 可直接读取的接口文件）
 *       -> 生成 config/health.json（体检报告，供人看）
 *
 * 用法：
 *   node scripts/build.mjs              # 完整构建（含健康检查）
 *   node scripts/build.mjs --no-check   # 跳过检查，只做格式转换
 *   node scripts/build.mjs --max 60     # 最多保留 60 个源
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG_DIR = path.join(ROOT, 'config');

const argv = process.argv.slice(2);
const NO_CHECK = argv.includes('--no-check');
const MAX_SITES = Number((argv.find((a) => a.startsWith('--max=')) || '').split('=')[1]) || 80;
const CONCURRENCY = 12;   // 并发探测数，别调太高，容易被封 IP
const TIMEOUT_MS = 8000;  // 单源超时
const RETRY = 1;          // 失败重试次数

const UA = 'okhttp/3.12.13';

/* ---------------- 工具 ---------------- */

const md5 = (s) => createHash('md5').update(s).digest('hex');

function apiBase(url) {
  const u = String(url || '').trim();
  return u.endsWith('/') ? u : u + '/';
}

function probeUrl(site) {
  const base = apiBase(site.api);
  if (site.type === 1) return base + '?ac=list&pg=1';
  if (site.type === 0) return site.api;
  return '';
}

async function fetchText(url, timeout = TIMEOUT_MS) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/* ---------------- 健康检查 ---------------- */

async function probeOnce(site) {
  if (site.type === 3) {
    // 蜘蛛源依赖 jar，无法用 HTTP 直接体检，默认视为可用
    return { ok: true, latency: 0, note: 'spider (跳过探测)' };
  }
  const url = probeUrl(site);
  if (!url) return { ok: false, latency: 0, note: '缺 api 字段' };

  const t0 = Date.now();
  try {
    const text = await fetchText(url);
    const latency = Date.now() - t0;

    if (site.type === 1) {
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        return { ok: false, latency, note: '返回非 JSON（可能被拦截）' };
      }
      const list = Array.isArray(j?.list) ? j.list : [];
      if (Number(j?.code) !== 1 && list.length === 0) {
        return { ok: false, latency, note: `code=${j?.code ?? 'null'}` };
      }
      return { ok: true, latency, note: `list=${list.length}` };
    }

    // type 0（xml / m3u）
    const ok = text.includes('<rss') || text.includes('#EXTM3U') || text.length > 200;
    return { ok, latency, note: `len=${text.length}` };
  } catch (e) {
    return {
      ok: false,
      latency: Date.now() - t0,
      note: (e?.name === 'TimeoutError' ? '超时' : String(e?.message || e)).slice(0, 40),
    };
  }
}

async function probe(site) {
  for (let i = 0; i <= RETRY; i++) {
    const r = await probeOnce(site);
    if (r.ok) return r;
    if (i === RETRY) return r;
  }
}

/* 简单的并发池 */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const raw = JSON.parse(await readFile(path.join(ROOT, 'sources.json'), 'utf8'));
  const sites = (raw.sites || []).filter((s) => s.enabled !== false);

  console.log(`[1/4] 载入 ${sites.length} 个源${NO_CHECK ? '（跳过体检）' : `，开始并发体检（并发 ${CONCURRENCY}）...`}`);

  let results = sites.map((s) =>
    s.skipCheck
      ? { ok: true, latency: 0, note: 'skipCheck（本地源不体检，始终保留）' }
      : { ok: true, latency: 0, note: '未检查' }
  );
  if (!NO_CHECK) {
    results = await pool(sites, CONCURRENCY, probe);
  }

  console.log('[2/4] 排序与筛除...');
  const scored = sites.map((s, i) => {
    const r = results[i];
    return { site: s, ...r, score: (r.ok ? 1 : 0) * 10000 - (r.latency || 0) - (s.priority || 9) * 100 };
  });

  const alive = scored.filter((x) => x.ok).sort((a, b) => b.score - a.score).slice(0, MAX_SITES);
  const dead = scored.filter((x) => !x.ok);

  /* 生成 TVBox sites 数组 */
  const outSites = alive.map(({ site, latency }) => {
    const key = md5(String(site.api)).slice(0, 16);
    const item = {
      key,
      name: site.name,
      type: site.type,
      api: site.api,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    };
    if (site.type !== 3) item.ext = site.ext ?? apiBase(site.api);
    else if (site.ext) item.ext = site.ext;
    if (latency) item._latency = latency; // 仅备注，部分客户端会忽略
    return item;
  });

  /* spider 字段：url;md5;hash */
  let spiderField = '';
  if (raw.spider?.url && !String(raw.spider.url).includes('YOUR-DOMAIN')) {
    spiderField = raw.spider.md5 ? `${raw.spider.url};md5;${raw.spider.md5}` : raw.spider.url;
  }

  const config = {
    spider: spiderField,
    wallpaper: raw.wallpaper || '',
    logo: raw.logo || '',
    sites: outSites,
    lives: (raw.lives || []).filter((l) => l.enabled !== false).map((l) => ({
      name: l.name,
      type: l.type ?? 0,
      url: l.url,
      playerType: l.playerType ?? 1,
    })),
    parses: (raw.parses || []).filter((p) => p.enabled !== false).map((p) => ({
      name: p.name,
      type: p.type ?? 1,
      url: p.url,
      ext: { flag: p.flag || [] },
    })),
    flags: ['youku', 'qq', 'iqiyi', 'qiyi', 'letv', 'sohu', 'tudou', 'pptv', 'mgtv', 'wasu', 'bilibili'],
    rules: [],
    ads: [],
  };

  await mkdir(CFG_DIR, { recursive: true });

  const ts = new Date().toISOString();
  const health = {
    generatedAt: ts,
    checked: !NO_CHECK,
    total: sites.length,
    alive: alive.length,
    dead: dead.length,
    aliveList: alive.map(({ site, latency, note }) => ({ name: site.name, latency, note })),
    deadList: dead.map(({ site, note }) => ({ name: site.name, api: site.api, reason: note })),
  };

  console.log('[3/4] 写入文件...');
  await writeFile(path.join(CFG_DIR, 'tvbox.json'), JSON.stringify(config, null, 2) + '\n');
  await writeFile(path.join(CFG_DIR, 'health.json'), JSON.stringify(health, null, 2) + '\n');
  await writeFile(
    path.join(CFG_DIR, 'version.json'),
    JSON.stringify({ version: md5(JSON.stringify(config)).slice(0, 12), generatedAt: ts, sites: outSites.length }, null, 2) + '\n'
  );

  console.log('[4/4] 完成');
  console.log(`      可用源 ${alive.length} / ${sites.length}`);
  if (dead.length) {
    console.log('      已剔除：');
    dead.slice(0, 10).forEach(({ site, note }) => console.log(`        - ${site.name}（${note}）`));
    if (dead.length > 10) console.log(`        ... 另有 ${dead.length - 10} 个`);
  }
  console.log(`      输出：config/tvbox.json (${outSites.length} 站点)`);
}

main().catch((e) => {
  console.error('构建失败：', e);
  process.exit(1);
});
