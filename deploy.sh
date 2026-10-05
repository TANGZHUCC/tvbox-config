#!/usr/bin/env bash
#
# TVBox 一键部署脚本
# ------------------------------------------------------------------
# 作用：本地 git 初始化 → 建 GitHub 公开仓库 → 推送 → 部署 Cloudflare Worker
#       → 自动设好 UPSTREAM → 打印可直接复制的接口地址。
#
# 你只需提前做两件事（都只需做一次）：
#   1) gh auth login              # 登录 GitHub（会打开浏览器）
#   2) npx wrangler login         # 登录 Cloudflare（首次会交互选子域）
#
# 然后在本目录运行：
#   bash deploy.sh                 # 会交互问你 GitHub 用户名
#   bash deploy.sh 你的用户名      # 直接带用户名，免交互
#
# 仓库名默认 tvbox-config，可用环境变量覆盖：REPO_NAME=xxx bash deploy.sh
# ------------------------------------------------------------------

set -euo pipefail

REPO_NAME="${REPO_NAME:-tvbox-config}"
WORKER_NAME="${WORKER_NAME:-tvbox-api}"
GH_USER="${1:-}"

echo "========== TVBox 一键部署 =========="

# 0. 基础命令检查
for c in git node npx gh; do
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "缺少命令：$c —— 请先安装（git/node 或 GitHub CLI）后再运行。"
    exit 1
  fi
done

# 1. 取得 GitHub 用户名（参数 > 缓存文件 > 交互）
if [ -z "$GH_USER" ] && [ -f .deploy-user ]; then GH_USER="$(cat .deploy-user)"; fi
if [ -z "$GH_USER" ]; then
  read -r -p "请输入你的 GitHub 用户名: " GH_USER
fi
if [ -z "$GH_USER" ]; then echo "用户名不能为空，已退出。"; exit 1; fi
echo "$GH_USER" > .deploy-user

# 2. 校验 gh 已登录
if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub 尚未登录。请先运行： gh auth login"
  exit 1
fi

# 3. git 初始化（本目录 = 仓库根，保证 workflow 路径正确）并提交
[ -d .git ] || git init -q
git add -A
if git diff --cached --quiet; then
  echo "（无新变更，跳过提交）"
else
  git commit -q -m "init: tvbox 自维护接口管线" || true
fi
DEFAULT_BRANCH="$(git branch --show-current 2>/dev/null || echo main)"
if [ "$DEFAULT_BRANCH" != "main" ]; then git branch -M main; DEFAULT_BRANCH="main"; fi

# 4. 创建 GitHub 公开仓库并推送
echo ""
echo "→ 创建 / 推送 GitHub 仓库 $GH_USER/$REPO_NAME ..."
if gh repo view "$GH_USER/$REPO_NAME" >/dev/null 2>&1; then
  echo "  仓库已存在，直接推送当前分支。"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"
  git push -u origin "$DEFAULT_BRANCH" 2>&1 | tail -3 || git push -u origin "$DEFAULT_BRANCH"
else
  gh repo create "$REPO_NAME" --public --source . --push \
    --description "TVBox 自维护接口管线" 2>&1 | tail -3 || {
      git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"
      git push -u origin "$DEFAULT_BRANCH"
    }
fi

# 5. 计算标准链接（分支名用实际默认分支）
RAW_URL="https://raw.githubusercontent.com/${GH_USER}/${REPO_NAME}/${DEFAULT_BRANCH}/config/tvbox.json"
JSDELIVR_URL="https://cdn.jsdelivr.net/gh/${GH_USER}/${REPO_NAME}@${DEFAULT_BRANCH}/config/tvbox.json"
echo "$RAW_URL" > .upstream-url
echo ""
echo "  GitHub Raw : $RAW_URL"
echo "  jsDelivr   : $JSDELIVR_URL"

# 6. 部署 Cloudflare Worker（wrangler.toml 在 worker/ 下）
# 关键：deploy 必须直连终端(TTY)，不能接任何管道，否则 wrangler 判定非交互、
#       无法弹出 workers.dev 子域注册提示而直接报错退出（这是上次失败的根因）。
echo ""
echo "→ 部署 Cloudflare Worker..."
echo "  首次会让你注册 workers.dev 子域：先输入 y 回车，再输入一个英文名（如 tvbox-api-tang）。"
( cd worker && npx -y wrangler deploy )

# 部署成功后 wrangler 会打印形如 https://tvbox-api.<子域>.workers.dev 的地址
SUBDOMAIN=""
while [ -z "$SUBDOMAIN" ]; do
  read -r -p "请粘贴上面部署成功后显示的 Worker 地址（到 .workers.dev，例如 https://tvbox-api.xxx.workers.dev）: " SUBDOMAIN
  SUBDOMAIN="$(printf '%s' "$SUBDOMAIN" | grep -oE 'https?://[a-z0-9-]+\.workers\.dev' | head -1 || true)"
  [ -z "$SUBDOMAIN" ] && echo "  没识别到 workers.dev 地址，请重新粘贴。"
done
SUBDOMAIN="${SUBDOMAIN%/}"
WORKER_URL="${SUBDOMAIN}/tvbox.json"

# 7. 把上游地址写入 Worker 环境变量
echo ""
echo "→ 设置 UPSTREAM = $RAW_URL"
( cd worker && printf '%s' "$RAW_URL" | npx -y wrangler secret put UPSTREAM )

# 可选：设置一个刷新密钥（用于手动刷新边缘缓存）
if [ -z "${ADMIN_KEY:-}" ]; then
  ADMIN_KEY="$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)"
  echo "  已自动生成 ADMIN_KEY=$ADMIN_KEY （请记下，用于 /refresh?key= 手动刷新缓存）"
fi
( cd worker && printf '%s' "$ADMIN_KEY" | npx -y wrangler secret put ADMIN_KEY ) || true

echo ""
echo "========== 部署完成 =========="
echo "把下面的地址填进 TVBox → 设置 → 配置地址："
echo ""
echo "  ★ 推荐（固定不变）:  $WORKER_URL"
echo "  jsDelivr 直链      :  $JSDELIVR_URL"
echo "  GitHub Raw         :  $RAW_URL"
echo ""
echo "以后只改 sources.json 推上去，TVBox 会自动更新，地址不用再动。"
echo "想手动刷新 Worker 缓存： 打开  ${SUBDOMAIN}/refresh?key=${ADMIN_KEY}"
