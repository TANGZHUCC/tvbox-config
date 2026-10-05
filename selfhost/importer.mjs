#!/usr/bin/env node
/**
 * 媒体文件夹 -> library.json 导入内核
 * ------------------------------------------------------------------
 * 把「扫描 + 组装 + 写入」抽成可被 CLI 与 Web 后台共用的函数。
 * 目录结构约定见 import-media.mjs 顶部注释。
 *
 * 导出：
 *   scan(root, { baseUrl, exts })         扫描目录，返回分类+影片草稿
 *   runImport(opts)                       完整导入，返回 { lib, added, preview }
 *
 * opts:
 *   root       媒体根目录（必填）
 *   baseUrl    生成的播放地址前缀（必填，结尾不要斜杠）
 *   out        输出文件，默认 library.json
 *   merge      保留 out 已有内容，只追加新项
 *   classesFile 分类映射 json 文件（可选）
 *   ext        纳入的扩展名，逗号分隔
 *   dryRun     只预览，不写文件
 */

import { readdir, stat, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const md5int = (s) => parseInt(createHash('md5').update(s).digest('hex').slice(0, 8), 16);

/** 本地相对路径 -> 可播放 URL（逐段编码，保留斜杠） */
function toUrl(relPath, baseUrl) {
  const seg = relPath
    .split(path.sep)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `${baseUrl}/${seg}`;
}

/** 自然排序：S01E02 排在 S01E10 前面 */
function naturalSort(a, b) {
  const ax = [], bx = [];
  a.replace(/(\d+)|(\D+)/g, (_, n, s) => (n ? ax.push(+n) : ax.push(s), ''));
  b.replace(/(\d+)|(\D+)/g, (_, n, s) => (n ? bx.push(+n) : bx.push(s), ''));
  while (ax.length && bx.length) {
    const x = ax.shift(), y = bx.shift();
    if (x !== y) return x < y ? -1 : 1;
  }
  return ax.length - bx.length;
}

const isMedia = (name, exts) => exts.has(path.extname(name).toLowerCase().replace('.', ''));
const stripExt = (n) => n.replace(/\.[^.]+$/, '');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const s = await stat(full);
    out.push({ name: entry.name, full, isDir: s.isDirectory() });
  }
  return out.sort((a, b) => naturalSort(a.name, b.name));
}

/**
 * 结构约定：
 *   一级文件夹 = 分类
 *   分类下有「子文件夹（含媒体）」→ 该子文件夹 = 一部；子文件夹内文件 = 多集
 *   分类下直接有媒体文件 → 每个文件 = 一部
 */
export async function scan(root, { baseUrl, exts }) {
  const cats = [];
  const top = await walk(root);
  let unknown = null;

  for (const c of top) {
    if (!c.isDir) {
      if (isMedia(c.name, exts)) unknown ??= { type_name: '未分类', videos: [] };
      continue;
    }
    const children = await walk(c.full);
    const subDirs = children.filter((x) => x.isDir);
    const looseFiles = children.filter((x) => !x.isDir && isMedia(x.name, exts));

    const videos = [];
    for (const sd of subDirs) {
      const files = (await walk(sd.full)).filter((x) => !x.isDir && isMedia(x.name, exts));
      if (!files.length) continue;
      videos.push({
        vod_name: sd.name,
        rel: path.relative(root, sd.full),
        episodes: files.map((f) => ({
          name: stripExt(f.name),
          url: toUrl(path.relative(root, f.full), baseUrl),
        })),
      });
    }
    for (const f of looseFiles) {
      videos.push({
        vod_name: stripExt(f.name),
        rel: path.relative(root, f.full),
        episodes: [{ name: '正片', url: toUrl(path.relative(root, f.full), baseUrl) }],
      });
    }
    if (videos.length) cats.push({ type_name: c.name, videos });
  }

  if (unknown) cats.push(unknown);
  return cats;
}

/* ---------------- 组装 library.json ---------------- */

export async function runImport({
  root,
  baseUrl = '',
  out,
  merge = false,
  classesFile = null,
  ext = 'm3u8,mp4,mkv,ts,mov,webm',
  dryRun = false,
} = {}) {
  const EXTS = new Set(ext.split(',').map((s) => s.trim().toLowerCase()));
  const cats = await scan(root, { baseUrl, exts: EXTS });

  let classMap = {};
  let nextId = 1;

  if (classesFile) {
    classMap = JSON.parse(await readFile(classesFile, 'utf8'));
    nextId = Math.max(0, ...Object.values(classMap).map(Number)) + 1;
  }

  let existing = { classes: [], videos: [] };
  const existingIds = new Set();
  if (merge) {
    try {
      existing = JSON.parse(await readFile(out, 'utf8'));
      existing.classes.forEach((c) => (classMap[c.type_name] = c.type_id));
      nextId = Math.max(nextId, ...existing.classes.map((c) => c.type_id), 0) + 1;
      existing.videos.forEach((v) => existingIds.add(v.vod_id));
    } catch {
      /* out 不存在则忽略 */
    }
  }

  const classes = [...existing.classes];
  const videos = [...existing.videos];
  const beforeCount = videos.length;

  for (const cat of cats) {
    if (!(cat.type_name in classMap)) {
      classMap[cat.type_name] = nextId++;
      classes.push({ type_id: classMap[cat.type_name], type_name: cat.type_name });
    }
    const typeId = classMap[cat.type_name];

    for (const v of cat.videos) {
      const id = md5int(v.rel);
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      videos.push({
        vod_id: id,
        vod_name: v.vod_name,
        type_id: typeId,
        vod_remarks: v.episodes.length > 1 ? `共${v.episodes.length}集` : '正片',
        vod_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
        vod_play_from: '默认线路',
        episodes: v.episodes,
      });
    }
  }

  const lib = { name: '我的媒体库', classes, videos };

  if (!dryRun) {
    await writeFile(out, JSON.stringify(lib, null, 2) + '\n', 'utf8');
  }

  return {
    lib,
    added: videos.length - beforeCount,
    preview: cats.slice(0, 8).map((c) => ({
      type_name: c.type_name,
      count: c.videos.length,
    })),
  };
}
