# 自建 TVBox 接口 · 稳定长期版

一套**自维护、自体检、自托管**的 TVBox 接口管线。不是给你一个"能用的配置"，而是给你一套**源挂了会自动摘掉、地址永远不变**的系统。

---

## 一、为什么大部分接口活不过三个月

| 常见做法 | 死因 |
|---|---|
| 抄别人现成的配置文件直链 | 作者停更 / 域名到期 / 仓库删库 |
| 配置里硬编码 20 个源，一个都不检查 | 半年后一半源 404，客户端卡死在加载页 |
| 用免费图床 / 临时短链托管 | 链接失效，配置拉不到，App 直接白屏 |
| 依赖第三方 spider.jar | jar 作者不更了，所有蜘蛛源集体失效 |
| 配置塞 300 个源 | 客户端启动扫源要 30 秒，缓存炸掉 |

本方案逐条解决：**源做体检、配置做版本、托管做多路、jar 自己编译、源数量做上限**。

---

## 二、整体架构

```
sources.json  ──►  scripts/build.mjs  ──►  config/tvbox.json
（你维护的唯一文件）   （并发体检+排序+剔除）      （TVBox 读取的接口）
                            │
                            ├──► config/health.json   体检报告
                            └──► config/version.json  版本号
                            │
              GitHub Actions cron（每天 04:10 自动跑）
                            │
        ┌───────────────────┼───────────────────┐
   GitHub Raw          jsDelivr CDN      Cloudflare Worker
   （原始地址）         （国内较快）        （固定域名，永不变）
                                                │
                                          TVBox 客户端
```

---

## 三、5 分钟部署

> **最省事路径（推荐）**：仓库名、Worker 名都已替你设好默认值（仓库 `tvbox-config`、Worker `tvbox-api`），你只需在终端登录一次账号，然后跑一条命令，脚本会自动建仓库、推送、部署、并把**真实链接直接打印出来**。
>
> ```bash
> # 只做一次：登录两个账号
> gh auth login            # 登录 GitHub（会弹浏览器）
> npx wrangler login      # 登录 Cloudflare（首次会让你选一个 workers.dev 子域）
>
> # 然后在本目录运行（用户名作为参数，免交互；不带参数会交互询问）
> bash deploy.sh 你的GitHub用户名
> ```
>
> 脚本跑完，终端会输出三行可直接复制的地址（Worker / jsDelivr / GitHub Raw）。用户名、仓库名、子域这三项占位符已全部自动填好，你不用再手动改 README 里的 `<>` 占位符。

### 1. 建仓库（手动版，或用上面的 deploy.sh）

在 GitHub 新建一个 **Public** 仓库（Private 的 Raw 链接 TVBox 拉不到），把本目录全部推上去。仓库名建议用 `tvbox-config`。

```bash
cd tvbox
git init
git add .
git commit -m "init: tvbox 接口管线"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 填源

**推荐做法（也是唯一真正长期稳定的做法）：自己发内容。**

`selfhost/` 目录里是一套**苹果CMS v10 兼容的自建内容源**，把你自己的内容（自制、已授权、公开版权）发布成标准接口，TVBox 直接当 `type=1` 源用：

```bash
node selfhost/server.mjs
# http://0.0.0.0:19999/api.php/provide/vod/
```

改 `selfhost/library.json` 加片，热加载即时生效。公网部署见 [`selfhost/README.md`](selfhost/README.md)（Docker / NAS / Workers 三种方案）。

自建源的好处是**没有"站长跑路"这个死因**——服务器是你自己的，格式是你定义的。

如果你已经持有其他**有权访问**的接口（自建 Emby/Jellyfin、自有授权平台等），往下看继续填源表。

编辑 `sources.json`，把示例源的 `api` 换成你自己有权使用的接口，并把 `enabled` 改成 `true`。

字段说明：

| 字段 | 含义 | 取值 |
|---|---|---|
| `type` | 源类型 | `1` = 苹果CMS JSON 接口；`3` = 蜘蛛源（csp_）；`0` = XML/M3U |
| `api` | 接口地址 | type=1 填到 `.../api.php/provide/vod/` 为止，**结尾带斜杠** |
| `priority` | 优先级 | 数字越小越优先，同分时按实测延迟排序 |
| `tags` | 备注 | 仅用于你自己分类，不影响输出 |
| `enabled` | 开关 | `false` 直接不进体检 |

### 3. 本地验证
```bash
node scripts/build.mjs              # 完整构建（带体检）
node scripts/build.mjs --no-check   # 只验格式，不联网
node scripts/build.mjs --max=50     # 最多保留 50 个源
```
看到 `可用源 X / Y` 就说明跑通了。

### 4. 开自动更新
`.github/workflows/tvbox-update.yml` 已配好，推上去即生效：
- 每天北京时间 **04:10** 自动体检 + 重建 + 提交
- 改了 `sources.json` 也会立即触发
- 结果可在仓库 **Actions → 最新一次运行 → Summary** 看到体检报告

### 5. 拿到接口地址（**这一步决定长期稳定性**）

| 地址 | 用途 | 说明 |
|---|---|---|
| `https://raw.githubusercontent.com/<user>/<repo>/main/config/tvbox.json` | 原始 | 最稳，但国内偶尔抽风 |
| `https://cdn.jsdelivr.net/gh/<user>/<repo>@main/config/tvbox.json` | CDN | 国内速度好，有缓存（约 12h） |
| `https://你的域名/tvbox.json` | **推荐** | 见下方 Worker 部署，**地址永久固定** |

部署 Cloudflare Worker（免费，地址永不变）：
```bash
cd worker
npx wrangler deploy
npx wrangler secret put UPSTREAM     # 粘贴上面的 raw.githubusercontent 地址
npx wrangler secret put ADMIN_KEY    # 随便设一个刷新密钥
```
> 以上三步 `deploy.sh` 已全自动完成。**子域（`<你的子域>`）是你在 `npx wrangler login` / 首次 deploy 时自己选的一个英文短名**，部署成功后终端会显示形如 `https://tvbox-api.xxxxxx.workers.dev` 的地址。TVBox 里就填：
```
https://tvbox-api.<你选的子域>.workers.dev/tvbox.json
```

### 6. TVBox 客户端配置
打开 TVBox / 影视 / FongMi 等客户端 → **设置 → 配置地址** → 粘贴上面任一地址 → 确定 → 等待加载。
建议在设置里勾选「**自动更新配置**」，并开启「**接口缓存**」。

---

## 四、长期稳定的 7 条硬规矩

1. **地址只用 Worker 的固定域名。** 后端随便换，TVBox 里填的地址一辈子不用改。
2. **源要冗余不要贪多。** 同类内容留 3–5 个备选，总数控制在 60 以内。源越多，启动越慢，失效概率越高。
3. **每天自动体检。** 靠 `build.mjs` 把挂掉的源自动摘掉，不靠人肉维护。
4. **spider.jar 必须自己编译托管。** fork 一个开源的 TVBox spider 项目（catvod 系），用 GitHub Actions 自己 build 出 jar，放进本仓库的 Release，然后在 `sources.json` 里填 `spider.url` + `spider.md5`。**永远不要依赖别人的 jar 地址。**
5. **保留回滚点。** `config/version.json` 记录版本号。配置出问题时，可以把仓库回滚到上一个 commit，TVBox 拉到的就是旧配置，10 秒恢复。
6. **别用免费短链 / 免费图床。** wallpaper、logo、jar 全部走自己的域名或 jsDelivr。
7. **域名要提前续费。** 整套系统最容易死的地方是域名到期，设好自动续费 + 至少提前 60 天提醒。

---

## 五、日常维护清单

| 频率 | 动作 | 怎么看 |
|---|---|---|
| 每天 | 看 Actions 是否绿 | 红了说明 GitHub 或上游出问题 |
| 每周 | 看 `config/health.json` | 失效源突然变多 = 上游大改，需要补新源 |
| 每月 | 检查 Worker 是否正常 | 访问 `/ping` 应返回 `pong` |
| 每月 | 更新 spider.jar | 客户端兼容性靠这个 |
| 每季 | 清理低延迟但内容少的源 | 保持配置精简 |

---

## 六、故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| TVBox 提示"配置加载失败" | 地址拉不到 / JSON 格式错 | 浏览器直接打开接口地址，看能否看到 JSON |
| 能看到分类但点进去空白 | 该源接口挂了但还没被体检摘掉 | 手动跑一次 `build.mjs`，或调高 `RETRY` |
| 搜索没结果 | `searchable` 被关或源不支持搜索 | 检查该源接口 `?wd=` 是否可用 |
| 播放一直缓冲 | 解析接口挂了 / 线路差 | 换 lines，或换一个内容源 |
| 加载特别慢 | 源太多 | 调低 `--max`，砍到 40 以内 |
| JSON 里中文乱码 | 编码问题 | 确保写入时是 UTF-8（本项目已处理） |

---

## 七、目录说明

```
tvbox/
├── sources.json                    # ★ 你唯一需要日常维护的文件
├── scripts/build.mjs               # 构建器：体检 + 排序 + 生成接口
├── config/
│   ├── tvbox.json                  # 生成的接口文件（TVBox 读这个）
│   ├── health.json                 # 体检报告
│   └── version.json                # 版本号
├── selfhost/                       # ★ 自建内容源（苹果CMS v10 兼容）
│   ├── server.mjs                  # 零依赖服务，热加载 + 浏览器管理后台(/admin)
│   ├── importer.mjs                # 扫描+组装内核（被 CLI 与后台共用）
│   ├── import-media.mjs            # 文件夹扫描 → library.json 批量导入（CLI）
│   ├── start.mjs                   # 一键启动：导入+起服务+生成主编线
│   ├── library.json                # 你的内容清单
│   ├── Dockerfile                  # 一键容器化
│   ├── docker-compose.yml
│   └── README.md                   # 部署与加片说明
├── worker/
│   ├── index.js                    # Cloudflare Worker（固定域名 + 边缘缓存）
│   └── wrangler.toml
├── deploy.sh                       # ★ 一键部署：建仓库+推送+部署 Worker+打印链接
└── .github/workflows/
    └── tvbox-update.yml            # 每日自动更新
```

---

## 八、合规提醒

本项目的技术框架是**源无关的**——它只负责把一组接口地址聚合成 TVBox 能读的 JSON，并做健康检查。请只接入**你有权访问的资源接口**（自建媒体库、自有授权内容、Emby/Jellyfin 等）。聚合未授权影视资源可能涉及侵权，风险由使用者自行承担。

---

*配置格式参考 TVBox 开源项目（FongMi / catvod 系）的公开规范。*
