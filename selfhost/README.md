# 自建内容源（苹果CMS v10 兼容）

把**你自己有权分发的内容**以标准苹果CMS v10 API 暴露出来，TVBox 直接当 `type=1` 源用。

不需要采集任何第三方站点，不需要 spider.jar，内容是自己的——这是让接口长期稳定的**根治方案**：源是你自己的服务器，不存在"站长跑路"这个死因。

---

## 为什么这条路才是真的稳

| | 采集第三方站 | 自建源 |
|---|---|---|
| 源失效风险 | 高（域名到期、关站、改版） | **无**（自己控制） |
| 内容更新 | 依赖对方 | **自己决定** |
| 数据格式 | 对方随时改，规则就得重写 | **自己定义，永久不变** |
| 法律风险 | 高 | 取决于你自己的内容授权 |
| 维护成本 | 天天盯 | 加片就改一个 JSON |

---

## 快速开始

### A. 一键启动（推荐，拿来即用）

一条命令完成「导入媒体 → 起服务 → 生成 TVBox 主编线」：

```bash
cd tvbox
node selfhost/start.mjs --root /path/to/media --base-url https://你的域名/media
```

- 不传 `--root` 时跳过导入，只起服务 + 生成主编线。
- 服务以后台进程运行，PID 写入 `selfhost/server.pid`；停止用 `node selfhost/start.mjs --kill`。
- 加 `--check` 可在生成主编线时做真实体检（默认 `--no-check`，更快更稳）。

启动后你会拿到：

| 地址 | 用途 |
|---|---|
| `http://127.0.0.1:19999/api.php/provide/vod/` | TVBox 接口的源地址 |
| `http://127.0.0.1:19999/admin` | **浏览器管理后台**（见下） |
| `tvbox/config/tvbox.json` | 生成好的主编线接口文件 |

### B. 分步手动

```bash
cd tvbox
node selfhost/server.mjs
# 自建内容源已启动：http://0.0.0.0:19999/api.php/provide/vod/
```

验证：
```bash
curl "http://127.0.0.1:19999/api.php/provide/vod/?ac=list"
```

### 浏览器管理后台（新增）

打开 `http://<你的服务地址>:19999/admin`，不用碰命令行就能：

- **运行状态**：实时显示内容数、分类数、服务存活；一键刷新。
- **从文件夹批量导入**：填服务器上的媒体根目录 + 播放地址前缀，点「开始导入」即可（等效 `import-media.mjs`，支持增量合并 `--merge` 与仅预览）。
- **手动添加单条**：填名称、选分类、粘贴播放地址（每行一条，支持「名称$url」），点一下入库。
- **内容列表**：查看全部内容，逐条删除。

> 公网部署时建议加一道保护：启动服务前设环境变量 `ADMIN_TOKEN=你的密钥`，后台所有「写操作」都会要求带 `X-Admin-Token` 头；同时把 `/admin` 放到 Nginx 反代后面并加 Basic Auth 更佳。

---

## 接口说明（与苹果CMS v10 完全一致）

| 请求 | 作用 |
|---|---|
| `?ac=list` | 首页：分类 + 最新列表 |
| `?ac=detail&t=1&pg=1` | 按分类列出（`t` 是 type_id） |
| `?ac=detail&ids=1,2` | 指定条目详情（含播放地址） |
| `?ac=detail&h=24` | 最近 24 小时更新 |
| `?wd=关键词` | 搜索 |
| `?ac=videolist` | 老版别名，等价 `ac=detail` |
| `/healthz` | 服务存活探测 |
| `/admin` | 浏览器管理后台（导入 / 加片 / 删片 / 状态） |

TVBox 会自动按这个规范适配，不需要额外配置。

---

## 内容怎么加

### 方式 A：批量导入（已有本地媒体目录时推荐）

如果你的片子已经是规整的文件夹结构（一级=分类、二级=一部、三级=多集），用 `import-media.mjs` 一键转成 `library.json`：

```bash
node selfhost/import-media.mjs \
  --root /path/to/media \
  --base-url https://你的域名/media \
  --out selfhost/library.json
```

目录约定：
```
<root>/
  ├─ 电影/                    ← 一级文件夹 = 分类
  │   ├─ 盗梦空间/
  │   │   └─ index.m3u8       ← 文件夹里有文件 = 一部（多文件 = 多集）
  │   └─ 流浪地球2/play.m3u8
  └─ 电视剧/
      └─ 权游/
          ├─ S01E01.mp4       ← 多个文件 = 一部多集（自动按文件名自然排序）
          └─ S01E02.mp4
```

`--base-url` 把每个本地相对路径拼成可播放 URL（逐段编码，中文路径安全）。前提：这个本地目录能被公网以**同样的路径结构**访问到（对象存储 / NAS / CDN）。

常用参数：

| 参数 | 说明 |
|---|---|
| `--root` | 媒体根目录（必填） |
| `--base-url` | 播放地址前缀（必填，结尾不要斜杠） |
| `--out` | 输出文件，默认 `selfhost/library.json` |
| `--merge` | 保留已有内容，只追加新的（按 hash 去重，重复跑不会翻倍） |
| `--classes` | 分类映射文件 `{"电影":1,"电视剧":2}`（可选） |
| `--ext` | 纳入的扩展名，默认 `m3u8,mp4,mkv,ts,mov,webm` |
| `--dry-run` | 只预览，不写文件 |

> 用 `--merge` 长期维护最顺：每次往文件夹丢新片，跑一遍导入就增量更新，不会动到手改过的条目。

### 方式 B：手动编辑

编辑 `selfhost/library.json`，**改完直接生效，不用重启**（服务做了热加载）。

### 单集内容

```json
{
  "vod_id": 1,
  "vod_name": "影片名",
  "type_id": 1,
  "vod_pic": "https://你的图床/poster.jpg",
  "vod_year": "2026",
  "vod_area": "中国大陆",
  "vod_remarks": "正片",
  "vod_time": "2026-10-01 12:00:00",
  "vod_score": "8.0",
  "vod_actor": "主演",
  "vod_director": "导演",
  "vod_content": "简介文字",
  "episodes": [
    { "name": "正片", "url": "https://你的存储/media/1/index.m3u8" }
  ]
}
```

### 多集 + 多线路（推荐，单线路挂了自动切）

```json
{
  "vod_id": 2,
  "vod_name": "剧集名",
  "type_id": 2,
  "vod_remarks": "更新至02集",
  "play_sources": [
    {
      "name": "线路一",
      "episodes": [
        { "name": "第01集", "url": "https://你的主存储/2/01.m3u8" },
        { "name": "第02集", "url": "https://你的主存储/2/02.m3u8" }
      ]
    },
    {
      "name": "线路二",
      "episodes": [
        { "name": "第01集", "url": "https://你的备用存储/2/01.m3u8" },
        { "name": "第02集", "url": "https://你的备用存储/2/02.m3u8" }
      ]
    }
  ]
}
```

服务会自动把 `episodes` 拼成苹果CMS 要求的 `vod_play_url` 格式：
```
第01集$url1#第02集$url2$$$第01集$url3#第02集$url4
```

### 字段对照

| 字段 | 必填 | 说明 |
|---|---|---|
| `vod_id` | ✅ | 唯一数字 ID，不能重复 |
| `vod_name` | ✅ | 标题 |
| `type_id` | ✅ | 对应 `classes` 里的 type_id |
| `vod_pic` | | 封面图地址 |
| `vod_time` | | 更新时间，格式 `YYYY-MM-DD HH:mm:ss`，用于 `?h=` 筛选 |
| `vod_remarks` | | 角标，如"更新至02集"、"HD" |
| `episodes` / `play_sources` | ✅ | 播放地址，二选一 |
| `enabled` | | 设 `false` 可临时下架 |

---

## 部署到公网

TVBox 要能访问到，必须公网可达。三种选法：

### 方案 A：云服务器 + Docker（最省事）

```bash
cd tvbox/selfhost
docker build -t my-tvbox-source .
docker run -d --name tvbox-source \
  -p 19999:19999 \
  -v $(pwd)/library.json:/app/library.json \
  --restart unless-stopped \
  my-tvbox-source
```

`--restart unless-stopped` 保证开机自启、崩溃自拉，这是长期稳定的关键。

配合 Nginx 反代 + HTTPS：
```nginx
location /api.php/provide/vod/ {
    proxy_pass http://127.0.0.1:19999/api.php/provide/vod/;
    proxy_set_header Host $host;
}
```

### 方案 B：NAS / 家里的小主机

群晖、威联通、树莓派都行。跑起来后用**内网穿透**（Cloudflare Tunnel / frp）暴露到公网。
Cloudflare Tunnel 免费且不用公网 IP：
```bash
cloudflared tunnel --url http://localhost:19999
```

### 方案 C：Cloudflare Workers（零服务器）

内容量不大时，把 `library.json` 转成 KV 存储，用 Worker 处理 `ac` 参数返回对应结构。免费额度足够个人用，且天然全球加速。

---

## 接到主管线

部署好之后，在 `sources.json` 里加一条：

```json
{
  "name": "我的自建媒体库",
  "type": 1,
  "api": "https://你的域名/api.php/provide/vod/",
  "priority": 1,
  "tags": ["自建"],
  "enabled": true
}
```

然后 `node scripts/build.mjs` —— 体检器会去探它，通过了就进正式接口。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `19999` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PAGE_SIZE` | `20` | 每页条目数 |

---

## 排查

| 现象 | 原因 | 解决 |
|---|---|---|
| TVBox 里看不到分类 | `library.json` 的 `classes` 为空 | 至少填一个分类 |
| 点进去空白 | `type_id` 与 `classes` 对不上 | 检查两个文件里的 type_id 是否一致 |
| 有标题但播不了 | `episodes.url` 地址不可达 | 浏览器直接打开那个 m3u8 试试 |
| 改了 json 没反应 | 编辑后语法出错 | 看服务日志有没有报错；用 `node -e "require('./selfhost/library.json')"` 验语法 |
| 搜索搜不到 | 关键词没匹配到名称/简介/演员 | 搜索会匹配 `vod_name`、`vod_actor`、`vod_director`、`vod_content`、`vod_area` |

---

## 内容来源提醒

这个服务只是个"发布器"，它不关心内容从哪来。请确保你放进去的内容是你**拥有版权或已获授权**的（自制视频、已购授权、公开版权作品、你自己的拍摄素材等）。把未经授权的影视内容放进来分发，风险和采集第三方站是一样的。
