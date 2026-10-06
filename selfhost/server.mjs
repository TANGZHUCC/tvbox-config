#!/usr/bin/env node
/**
 * 自建内容源 · 苹果CMS v10 兼容接口 + 浏览器管理后台
 * ------------------------------------------------------------------
 * 把你自己有权分发的内容（自建媒体库、自有版权内容、自制视频）
 * 以标准苹果CMS v10 API 规范暴露出来，TVBox 里直接当 type=1 源用。
 *
 * 不需要采集任何第三方站点，不需要 spider.jar，内容是自己的。
 *
 * 启动：
 *   node selfhost/server.mjs              # 默认 0.0.0.0:19999
 *   PORT=8080 node selfhost/server.mjs
 *
 * 浏览器后台（新增）：http://<host>:19999/admin
 *   - 一键从文件夹扫描导入（等效 import-media.mjs）
 *   - 手动添加 / 删除内容
 *   - 实时查看库状态
 *
 * 接口（与苹果CMS v10 一致，TVBox 自动适配）：
 *   ?ac=list                        分类 + 首页列表
 *   ?ac=detail&t=1&pg=2             分类列表 + 分页
 *   ?ac=detail&ids=1,2,3            指定条目详情
 *   ?ac=detail&h=24                 最近 N 小时更新
 *   ?wd=关键词                      搜索
 *   ?ac=videolist                   老版别名，等价 detail
 *   /healthz                       服务存活探测
 *   /admin                         浏览器管理后台
 */

import http from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runImport } from './importer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.join(HERE, 'library.json');
const CONFIG_PATH = path.join(HERE, '..', 'config', 'tvbox.json');

const PORT = Number(process.env.PORT || 19999);
const HOST = process.env.HOST || '0.0.0.0';
const LIMIT = Number(process.env.PAGE_SIZE || 20);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // 公网部署建议设一个

let LIB = null;
let LIB_MTIME = 0;

/** 热加载：改动 library.json 后无需重启 */
async function loadLib() {
  const { mtimeMs } = await stat(LIB_PATH);
  if (LIB && mtimeMs === LIB_MTIME) return LIB;
  LIB = JSON.parse(await readFile(LIB_PATH, 'utf8'));
  LIB_MTIME = mtimeMs;
  console.log(`[lib] 已载入 ${LIB.videos?.length || 0} 条内容 / ${LIB.classes?.length || 0} 个分类`);
  return LIB;
}

async function saveLib(lib) {
  await writeFile(LIB_PATH, JSON.stringify(lib, null, 2) + '\n', 'utf8');
  LIB = lib;
  LIB_MTIME = (await stat(LIB_PATH)).mtimeMs;
}

function genId(seed) {
  return parseInt(createHash('md5').update(String(seed)).digest('hex').slice(0, 8), 16);
}

/* ---------------- 组装苹果CMS 响应 ---------------- */

/** 把 episodes 转成苹果CMS 的 vod_play_url 格式：名字$地址#名字$地址$$$线路2... */
function buildPlayUrl(video) {
  const sources = video.play_sources || [
    { name: video.vod_play_from || '默认线路', episodes: video.episodes || [] },
  ];
  return sources
    .map((s) => (s.episodes || []).map((e) => `${e.name || '正片'}$${e.url}`).join('#'))
    .join('$$$');
}

function buildPlayFrom(video) {
  const sources = video.play_sources || [{ name: video.vod_play_from || '默认线路' }];
  return sources.map((s) => s.name).join('$$$');
}

/** 列表页条目：字段少，不带播放地址 */
function toListItem(v, classes) {
  return {
    vod_id: v.vod_id,
    vod_name: v.vod_name,
    vod_pic: v.vod_pic || '',
    type_id: v.type_id,
    type_name: classes.get(v.type_id) || '',
    vod_year: v.vod_year || '',
    vod_area: v.vod_area || '',
    vod_lang: v.vod_lang || '',
    vod_remarks: v.vod_remarks || '',
    vod_time: v.vod_time || '',
    vod_score: v.vod_score ?? '',
    vod_duration: v.vod_duration || '',
  };
}

/** 详情页条目：带播放地址 */
function toDetailItem(v, classes) {
  return {
    ...toListItem(v, classes),
    vod_actor: v.vod_actor || '',
    vod_director: v.vod_director || '',
    vod_writer: v.vod_writer || '',
    vod_content: v.vod_content || '',
    vod_play_from: buildPlayFrom(v),
    vod_play_url: buildPlayUrl(v),
    vod_play_note: '',
  };
}

function classList(lib) {
  return (lib.classes || []).map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
}

function pack(list, { page = 1, pagecount = 1, total = null, classes } = {}) {
  return {
    code: 1,
    msg: '数据列表',
    page,
    pagecount,
    limit: String(LIMIT),
    total: total ?? list.length,
    list,
    class: classes || [],
  };
}

/* ---------------- 请求处理 ---------------- */

async function handle(query) {
  const lib = await loadLib();
  const classes = new Map((lib.classes || []).map((c) => [Number(c.type_id), c.type_name]));
  const all = (lib.videos || []).filter((v) => v.enabled !== false);
  const ac = (query.ac || 'list').toLowerCase();
  const pg = Math.max(1, Number(query.pg || 1));
  const cls = classList(lib);

  /* 搜索 */
  if (query.wd !== undefined && query.wd !== null && String(query.wd).trim() !== '') {
    const kw = String(query.wd).trim().toLowerCase();
    const hit = all.filter((v) =>
      [v.vod_name, v.vod_actor, v.vod_director, v.vod_content, v.vod_area]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(kw))
    );
    const start = (pg - 1) * LIMIT;
    return pack(hit.slice(start, start + LIMIT).map((v) => toListItem(v, classes)), {
      page: pg,
      pagecount: Math.max(1, Math.ceil(hit.length / LIMIT)),
      total: hit.length,
      classes: cls,
    });
  }

  /* 指定 ids 详情 */
  if (query.ids) {
    const ids = String(query.ids)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
    const hit = all.filter((v) => ids.includes(Number(v.vod_id)));
    return pack(hit.map((v) => toDetailItem(v, classes)), { total: hit.length, classes: cls });
  }

  /* 最近 N 小时更新 */
  if (query.h) {
    const hours = Number(query.h) || 24;
    const since = Date.now() - hours * 3600 * 1000;
    const hit = all
      .filter((v) => v.vod_time && new Date(v.vod_time).getTime() >= since)
      .sort((a, b) => new Date(b.vod_time) - new Date(a.vod_time));
    const start = (pg - 1) * LIMIT;
    return pack(hit.slice(start, start + LIMIT).map((v) => toListItem(v, classes)), {
      page: pg,
      pagecount: Math.max(1, Math.ceil(hit.length / LIMIT)),
      total: hit.length,
      classes: cls,
    });
  }

  /* 分类 + 分页（ac=detail / ac=videolist） */
  if (ac === 'detail' || ac === 'videolist') {
    const tid = query.t != null && String(query.t) !== '' ? Number(query.t) : null;
    const hit = tid ? all.filter((v) => Number(v.type_id) === tid) : all;
    const start = (pg - 1) * LIMIT;
    return pack(hit.slice(start, start + LIMIT).map((v) => toListItem(v, classes)), {
      page: pg,
      pagecount: Math.max(1, Math.ceil(hit.length / LIMIT)),
      total: hit.length,
      classes: cls,
    });
  }

  /* 首页（ac=list）：返回分类 + 最新列表 */
  return pack(all.slice(0, LIMIT).map((v) => toListItem(v, classes)), {
    page: 1,
    pagecount: Math.max(1, Math.ceil(all.length / LIMIT)),
    total: all.length,
    classes: cls,
  });
}

/* ---------------- 直接吐 TVBox 配置（局域网零依赖方案） ----------------
 * 电视盒直接把配置地址指向本服务：http://<Mac局域网IP>:19999/tvbox.json
 * 此处读取项目根 config/tvbox.json，并把其中写死的 127.0.0.1/localhost
 * 改写为电视实际访问到的 host，使自建源在局域网内可被电视直连。
 */
async function serveTvboxConfig(req, res) {
  let text;
  try {
    text = await readFile(CONFIG_PATH, 'utf8');
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code: 0, msg: 'config/tvbox.json 尚未生成，请先运行：node scripts/build.mjs --no-check' , list: [] }));
    return;
  }
  const hostHeader = req.headers.host || `127.0.0.1:${PORT}`;
  // 把 127.0.0.1:port / localhost:port 改写成电视看到的真实地址
  text = text.replace(/(127\.0\.0\.1|localhost)(:\d+)?/g, hostHeader);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(text);
}

/* ---------------- 浏览器管理后台 ---------------- */

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function authOk(req) {
  if (!ADMIN_TOKEN) return true;
  const t = (req.headers['x-admin-token'] || '').toString();
  return t === ADMIN_TOKEN;
}

async function adminApi(req, res, u) {
  const seg = u.pathname.replace(/\/$/, '');
  const send = (obj, code = 200) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && seg.endsWith('/api/health')) {
    const lib = await loadLib();
    return send({ ok: true, ts: new Date().toISOString(), count: lib.videos?.length || 0, classes: lib.classes?.length || 0 });
  }

  if (req.method === 'GET' && seg.endsWith('/api/library')) {
    const lib = await loadLib();
    return send({
      name: lib.name || '我的媒体库',
      classes: lib.classes || [],
      count: lib.videos?.length || 0,
      videos: (lib.videos || []).map((v) => ({
        vod_id: v.vod_id,
        vod_name: v.vod_name,
        type_id: v.type_id,
        vod_remarks: v.vod_remarks || '',
        episodes: (v.play_sources?.[0]?.episodes || v.episodes || []).length,
        enabled: v.enabled !== false,
      })),
    });
  }

  /* 写操作统一校验 token */
  if (!authOk(req)) return send({ ok: false, msg: 'token 错误' }, 401);

  if (req.method === 'POST' && seg.endsWith('/api/import')) {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.root) return send({ ok: false, msg: '缺少 root' }, 400);
    const { added, lib, preview } = await runImport({
      root: body.root,
      baseUrl: (body.baseUrl || '').replace(/\/$/, ''),
      out: LIB_PATH,
      merge: !!body.merge,
      dryRun: !!body.dryRun,
    });
    if (!body.dryRun) LIB = null; // 强制下次重新载入
    return send({ ok: true, added, total: lib.videos.length, classes: lib.classes, preview });
  }

  if (req.method === 'POST' && seg.endsWith('/api/video')) {
    const body = JSON.parse(await readBody(req) || '{}');
    const v = body.video;
    if (!v || !v.vod_name || v.type_id === undefined) return send({ ok: false, msg: '缺少 vod_name 或 type_id' }, 400);
    const lib = await loadLib();
    const episodes = Array.isArray(v.episodes) ? v.episodes : [];
    const play_sources = Array.isArray(v.play_sources) ? v.play_sources : undefined;
    const item = {
      vod_id: v.vod_id ?? genId(v.vod_name + '|' + v.type_id),
      vod_name: v.vod_name,
      type_id: Number(v.type_id),
      vod_pic: v.vod_pic || '',
      vod_remarks: v.vod_remarks || (episodes.length > 1 ? `共${episodes.length}集` : '正片'),
      vod_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
      vod_play_from: '默认线路',
      ...(play_sources ? { play_sources } : { episodes }),
    };
    if (v.vod_content) item.vod_content = v.vod_content;
    if (v.vod_year) item.vod_year = v.vod_year;
    if (v.vod_actor) item.vod_actor = v.vod_actor;
    lib.videos = lib.videos || [];
    lib.videos.push(item);
    await saveLib(lib);
    return send({ ok: true, added: 1, total: lib.videos.length });
  }

  if (req.method === 'POST' && seg.endsWith('/api/video/delete')) {
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.id === undefined) return send({ ok: false, msg: '缺少 id' }, 400);
    const lib = await loadLib();
    const before = lib.videos.length;
    lib.videos = lib.videos.filter((x) => Number(x.vod_id) !== Number(body.id));
    await saveLib(lib);
    return send({ ok: true, removed: before - lib.videos.length, total: lib.videos.length });
  }

  if (req.method === 'POST' && seg.endsWith('/api/reload')) {
    LIB = null;
    await loadLib();
    return send({ ok: true });
  }

  return send({ ok: false, msg: '未知接口' }, 404);
}

/* ---------------- 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  /* 浏览后台 */
  if (u.pathname === '/admin' || u.pathname === '/admin/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(adminHtml());
    return;
  }

  /* 管理 API */
  if (u.pathname.startsWith('/admin/api/')) {
    try {
      await adminApi(req, res, u);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, msg: String(e.message || e) }));
    }
    return;
  }

  if (u.pathname === '/healthz') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  /* TVBox 配置接口（局域网直连，改写 127.0.0.1 → 真实 host） */
  if (u.pathname === '/tvbox.json' || u.pathname === '/config/tvbox.json') {
    try {
      await serveTvboxConfig(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ code: 0, msg: String(e.message || e), list: [] }));
    }
    return;
  }

  const query = Object.fromEntries(u.searchParams.entries());

  try {
    const data = await handle(query);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code: 0, msg: String(e.message || e), list: [] }));
  }
});

/* ---------------- 后台页面（自包含，无外部依赖） ---------------- */

function adminHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>自建内容源 · 管理后台</title>
<style>
  :root{--bg:#f5f7fa;--card:#fff;--bd:#e6e9ef;--pri:#2f6fed;--ok:#2bb673;--bad:#e05656;--mut:#8a93a6}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:var(--bg);color:#1f2430;font-size:14px}
  .wrap{max-width:960px;margin:0 auto;padding:20px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--mut);margin-bottom:16px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:16px}
  .card h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
  .stat{display:flex;gap:24px;flex-wrap:wrap}
  .stat .n{font-size:26px;font-weight:700}
  .stat .l{color:var(--mut);font-size:12px}
  label{display:block;font-size:12px;color:var(--mut);margin:8px 0 4px}
  input[type=text],input[type=url],textarea,select{width:100%;padding:8px 10px;border:1px solid var(--bd);border-radius:8px;font-size:13px;background:#fff;color:#1f2430}
  textarea{font-family:monospace;min-height:70px;resize:vertical}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .row>*{flex:1;min-width:200px}
  .chk{display:flex;align-items:center;gap:6px;margin-top:12px;font-size:13px;color:#1f2430}
  .chk input{width:auto}
  button{background:var(--pri);color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;margin-top:12px}
  button.ghost{background:#fff;color:var(--pri);border:1px solid var(--pri)}
  button.sm{padding:4px 10px;font-size:12px;margin:0}
  button.bad{background:var(--bad)}
  .out{background:#0f1220;color:#d6e1ff;font-size:12px;padding:10px;border-radius:8px;white-space:pre-wrap;max-height:200px;overflow:auto;margin-top:10px;font-family:monospace}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px;border-bottom:1px solid var(--bd)}
  th{color:var(--mut);font-weight:600;font-size:12px}
  .tag{display:inline-block;background:#eef3ff;color:var(--pri);border-radius:6px;padding:1px 7px;font-size:11px}
  .ok{color:var(--ok)}.bad{color:var(--bad)}
  a{color:var(--pri)}
</style>
</head>
<body>
<div class="wrap">
  <h1>自建内容源 · 管理后台</h1>
  <div class="sub">苹果CMS v10 兼容接口 · 把你自己有权分发的内容发布给 TVBox</div>

  <div class="card">
    <h2>📊 运行状态</h2>
    <div class="stat">
      <div><div class="n" id="sCount">–</div><div class="l">内容总数</div></div>
      <div><div class="n" id="sClass">–</div><div class="l">分类数量</div></div>
      <div><div class="n ok">✓</div><div class="l">服务存活</div></div>
    </div>
    <button class="ghost sm" onclick="refreshLib()">刷新</button>
  </div>

  <div class="card">
    <h2>🗂️ 从文件夹批量导入</h2>
    <div class="row">
      <div><label>媒体根目录（服务器上的路径）</label>
        <input type="text" id="impRoot" placeholder="/volume1/media"></div>
      <div><label>播放地址前缀 base-url（结尾不带 /）</label>
        <input type="url" id="impBase" placeholder="https://你的域名/media"></div>
    </div>
    <div class="chk"><input type="checkbox" id="impMerge"><label for="impMerge" style="margin:0">增量合并（保留已存在内容，只追加新的）</label></div>
    <div class="chk"><input type="checkbox" id="impDry"><label for="impDry" style="margin:0">仅预览（不写入文件）</label></div>
    <button onclick="doImport()">开始导入</button>
    <div class="out" id="impOut" style="display:none"></div>
  </div>

  <div class="card">
    <h2>➕ 手动添加单条</h2>
    <div class="row">
      <div><label>名称</label><input type="text" id="vName" placeholder="影片名"></div>
      <div><label>分类</label><select id="vType"></select></div>
    </div>
    <div class="row">
      <div><label>封面图地址（可选）</label><input type="url" id="vPic" placeholder="https://..."></div>
      <div><label>角标（可选）</label><input type="text" id="vRemarks" placeholder="更新至02集"></div>
    </div>
    <label>播放地址（每行一条，格式「名称$url」，只填 url 也行）</label>
    <textarea id="vEps" placeholder="第01集$https://你的存储/1/01.m3u8&#10;第02集$https://你的存储/1/02.m3u8"></textarea>
    <button onclick="addVideo()">添加内容</button>
    <div class="out" id="vOut" style="display:none"></div>
  </div>

  <div class="card">
    <h2>📚 内容列表 <span class="tag" id="listCount"></span></h2>
    <table>
      <thead><tr><th>ID</th><th>名称</th><th>分类</th><th>集数</th><th>角标</th><th></th></tr></thead>
      <tbody id="listBody"><tr><td colspan="6" style="color:var(--mut)">加载中…</td></tr></tbody>
    </table>
  </div>
</div>

<script>
const api = (p,opt)=>fetch('/admin/api/'+p,opt).then(r=>r.json());
const show=(id,obj)=>{const e=document.getElementById(id);e.style.display='block';e.textContent=typeof obj==='string'?obj:JSON.stringify(obj,null,2);};

async function refreshLib(){
  const r=await api('library');
  document.getElementById('sCount').textContent=r.count;
  document.getElementById('sClass').textContent=r.classes.length;
  document.getElementById('listCount').textContent=r.count+' 条';
  const sel=document.getElementById('vType');sel.innerHTML='';
  r.classes.forEach(c=>{const o=document.createElement('option');o.value=c.type_id;o.textContent=c.type_name;sel.appendChild(o);});
  const tb=document.getElementById('listBody');tb.innerHTML='';
  r.videos.forEach(v=>{
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+v.vod_id+'</td><td>'+v.vod_name+'</td><td><span class="tag">'+(v.type_id)+'</span></td><td>'+v.episodes+'</td><td>'+(v.vod_remarks||'')+'</td>';
    const td=document.createElement('td');
    const b=document.createElement('button');b.className='sm bad';b.textContent='删除';
    b.onclick=()=>delVideo(v.vod_id);td.appendChild(b);tr.appendChild(td);tb.appendChild(tr);
  });
  if(!r.videos.length)tb.innerHTML='<tr><td colspan="6" style="color:var(--mut)">暂无内容，先在上方导入或添加。</td></tr>';
}
async function doImport(){
  const body={root:impRoot.value.trim(),baseUrl:impBase.value.trim(),merge:impMerge.checked,dryRun:impDry.checked};
  if(!body.root){show('impOut','请填写媒体根目录');return;}
  show('impOut','导入中…');
  const r=await api('import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.ok){
    let s='成功：新增 '+r.added+' 条，当前共 '+r.total+' 条\\n分类：'+(r.classes||[]).map(c=>c.type_name+'('+c.type_id+')').join(' / ');
    if(r.preview&&r.preview.length){s+='\\n扫描到：'+r.preview.map(p=>p.type_name+' '+p.count+'部').join('，');}
    show('impOut',s);refreshLib();
  }else show('impOut','失败：'+(r.msg||'未知错误'));
}
async function addVideo(){
  const lines=(vEps.value||'').trim().split(/\\n|\\r/).filter(Boolean);
  const episodes=lines.map(l=>{const i=l.indexOf('$');return i<0?{name:'正片',url:l.trim()}:{name:l.slice(0,i).trim(),url:l.slice(i+1).trim()};});
  const body={video:{vod_name:vName.value.trim(),type_id:Number(vType.value),episodes,vod_pic:vPic.value.trim(),vod_remarks:vRemarks.value.trim()}};
  if(!body.video.vod_name||!episodes.length){show('vOut','请填写名称与至少一条播放地址');return;}
  show('vOut','添加中…');
  const r=await api('video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  show('vOut',r.ok?'已添加，当前共 '+r.total+' 条':'失败：'+(r.msg||''));
  if(r.ok){vName.value='';vEps.value='';vPic.value='';vRemarks.value='';refreshLib();}
}
async function delVideo(id){
  if(!confirm('确认删除 ID '+id+' ？'))return;
  const r=await api('video/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
  show('vOut',r.ok?'已删除，剩余 '+r.total+' 条':'失败：'+(r.msg||''));refreshLib();
}
refreshLib();
</script>
</body>
</html>`;
}

server.listen(PORT, HOST, () => {
  console.log(`自建内容源已启动：http://${HOST}:${PORT}/api.php/provide/vod/`);
  console.log(`TVBox 配置地址（局域网填这个）：http://<本机局域网IP>:${PORT}/tvbox.json`);
  console.log(`健康检查：http://127.0.0.1:${PORT}/healthz`);
  console.log(`管理后台：http://127.0.0.1:${PORT}/admin`);
  console.log(`内容文件：${LIB_PATH}`);
});
