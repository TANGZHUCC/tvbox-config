#!/usr/bin/env node
/**
 * 媒体文件夹 -> library.json 批量导入器（CLI 薄封装）
 * ------------------------------------------------------------------
 * 核心逻辑见 importer.mjs。本文件只负责解析参数 + 打印。
 *
 * 约定的目录结构：
 *   <root>/
 *     ├─ 电影/                      ← 一级文件夹 = 分类（type_name）
 *     │   ├─ 盗梦空间/
 *     │   │   └─ index.m3u8         ← 文件夹里有文件 = 一部影片（多文件 = 多集）
 *     │   └─ 流浪地球2/play.m3u8
 *     └─ 电视剧/
 *         └─ 权游/
 *             ├─ S01E01.mp4         ← 多个文件 = 一部多集（自动按文件名自然排序）
 *             └─ S01E02.mp4
 *
 * 用法：
 *   node selfhost/import-media.mjs \
 *     --root /path/to/media \
 *     --base-url https://你的域名/media \
 *     --out selfhost/library.json
 *
 * 选项：
 *   --root        媒体根目录（必填）
 *   --base-url    生成的播放地址前缀（必填，结尾不要斜杠）
 *   --out         输出文件，默认 selfhost/library.json
 *   --merge       保留 out 里已存在的内容，只追加新的
 *   --classes     分类映射 json 文件（可选），格式 {"电影":1,"电视剧":2}
 *   --ext         纳入的扩展名，逗号分隔，默认 m3u8,mp4,mkv,ts,mov,webm
 *   --dry-run     只预览，不写文件
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runImport } from './importer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

const ROOT = get('--root');
const BASE_URL = (get('--base-url') || '').replace(/\/$/, '');
const OUT = get('--out', path.join(HERE, 'library.json'));
const MERGE = args.includes('--merge');
const DRY = args.includes('--dry-run');
const EXTS = get('--ext', 'm3u8,mp4,mkv,ts,mov,webm');
const CLASSES_FILE = get('--classes');

if (!ROOT) {
  console.error('缺少必填参数 --root');
  process.exit(1);
}
if (!BASE_URL && !DRY) {
  console.error('缺少必填参数 --base-url（预览模式可省略）');
  process.exit(1);
}

(async () => {
  const { lib, added, preview } = await runImport({
    root: ROOT,
    baseUrl: BASE_URL,
    out: OUT,
    merge: MERGE,
    classesFile: CLASSES_FILE,
    ext: EXTS,
    dryRun: DRY,
  });

  console.log(`扫描到 ${lib.classes.length} 个分类、${lib.videos.length} 部内容（本次新增 ${added}）`);
  console.log('分类：', lib.classes.map((c) => `${c.type_name}(${c.type_id})`).join(' / '));

  if (DRY) {
    console.log('\n[预览] 前几个分类：');
    preview.forEach((p) => console.log(`  - ${p.type_name}：${p.count} 部`));
    console.log('\n[dry-run] 未写入文件。去掉 --dry-run 后执行。');
    return;
  }

  console.log(`\n已写入 ${OUT}`);
})().catch((e) => {
  console.error('导入失败：', e);
  process.exit(1);
});
