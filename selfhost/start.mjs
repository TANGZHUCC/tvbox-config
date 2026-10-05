#!/usr/bin/env node
/**
 * 一键启动脚本：导入媒体 → 起自建源服务 → 生成 TVBox 主编线
 * ------------------------------------------------------------------
 * 用法：
 *   node selfhost/start.mjs --root /path/to/media --base-url https://你的域名/media
 *
 * 不传 --root 时跳过导入，只起服务 + 生成主编线。
 *
 * 选项：
 *   --root        媒体根目录（传给 import-media.mjs）
 *   --base-url    播放地址前缀（传给 import-media.mjs）
 *   --merge       增量合并已有 library.json
 *   --port        自建源监听端口，默认 19999
 *   --check       生成主编线时做真实体检（默认 --no-check，更快更稳）
 *   --kill        只停止已在运行的自建源服务
 *
 * 服务以后台进程方式运行，PID 写入 selfhost/server.pid。
 * 停止：node selfhost/start.mjs --kill  （或 kill $(cat selfhost/server.pid)）
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // tvbox/
const NODE = process.execPath;
const PID_FILE = path.join(HERE, 'server.pid');

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const has = (k) => args.includes(k);

const ROOT_DIR = get('--root');
const BASE = (get('--base-url') || '').replace(/\/$/, '');
const MERGE = has('--merge');
const PORT = Number(get('--port', 19999));
const DO_CHECK = has('--check');

/* ---------------- 停止已有服务 ---------------- */

function killServer() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 'SIGTERM');
    console.log(`已发送停止信号给服务（PID ${pid}）`);
  } catch {
    console.log('没有找到运行中的服务（或已停止）。');
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
}

if (has('--kill')) {
  killServer();
  process.exit(0);
}

/* ---------------- 工具 ---------------- */

function waitHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 1500 },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              JSON.parse(d).ok ? resolve() : reject(new Error('服务返回非 ok'));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy('timeout'));
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('服务启动超时'));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

/* ---------------- 主流程 ---------------- */

console.log('=== 自建 TVBox 接口 · 一键启动 ===\n');

/* 1. 导入（可选） */
if (ROOT_DIR) {
  console.log('[1/4] 导入媒体目录…');
  const r = spawnSync(
    NODE,
    [
      path.join(HERE, 'import-media.mjs'),
      '--root', ROOT_DIR,
      '--base-url', BASE || 'http://localhost',
      '--out', path.join(HERE, 'library.json'),
      ...(MERGE ? ['--merge'] : []),
    ],
    { stdio: 'inherit', cwd: ROOT }
  );
  if (r.status !== 0) {
    console.error('导入失败，中止。');
    process.exit(1);
  }
  console.log('');
} else {
  console.log('[1/4] 跳过导入（未传 --root）\n');
}

/* 2. 起服务（后台） */
console.log('[2/4] 启动自建源服务（后台）…');
const logPath = path.join(HERE, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(
  NODE,
  [path.join(HERE, 'server.mjs')],
  {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  }
);
child.unref();
fs.writeFileSync(PID_FILE, String(child.pid));
console.log(`      服务 PID ${child.pid}，日志 ${logPath}`);

/* 3. 等存活 */
console.log('[3/4] 等待服务就绪…');
try {
  await waitHealth();
  console.log('      ✓ 服务已就绪');
} catch (e) {
  console.error('      ✗ 服务启动失败：', e.message);
  console.error('      查看日志：', logPath);
  killServer();
  process.exit(1);
}

/* 4. 生成主编线 */
console.log(`[4/4] 生成 TVBox 主编线（${DO_CHECK ? '真实体检' : '跳过体检 --no-check'}）…`);
const buildArgs = [path.join(ROOT, 'scripts/build.mjs')];
if (!DO_CHECK) buildArgs.push('--no-check');
const b = spawnSync(NODE, buildArgs, { stdio: 'inherit', cwd: ROOT });
if (b.status !== 0) {
  console.error('      主编线生成失败，但服务本身已启动。可稍后手动运行 scripts/build.mjs。');
}

/* 汇总 */
console.log('\n=== 完成 ===');
console.log(`自建源接口  : http://127.0.0.1:${PORT}/api.php/provide/vod/`);
console.log(`管理后台    : http://127.0.0.1:${PORT}/admin`);
console.log(`生成接口文件: ${path.join(ROOT, 'config/tvbox.json')}`);
console.log(`停止服务    : node selfhost/start.mjs --kill`);
console.log('\n提示：把 --base-url 指向你部署后的公网域名，TVBox 才能从外网访问。');
