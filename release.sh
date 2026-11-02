#!/usr/bin/env bash
# 一键发布 @jingmei2/dsh-session-bin 到 npm 官方源。
#
#   ./release.sh                    # patch +1 后发布（例：0.1.1 → 0.1.2）
#   ./release.sh minor              # minor +1
#   ./release.sh 0.2.0              # 发指定版本
#   ./release.sh patch --otp=123456 # 本次带上 2FA 一次性验证码
#
# 关于 2FA：
#   - 若 ~/.npmrc 里配的是「免 2FA」的 granular token，直接跑，无需任何参数。
#   - 否则 npm 会要求一次性验证码：脚本会失败并提示，重跑时加 --otp=XXXXXX。
set -euo pipefail

PKG="@jingmei2/dsh-session-bin"
REG="https://registry.npmjs.org/"
OWNER="jingmei2"
cd "$(dirname "$0")"

bold(){ printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok(){   printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die(){  printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 参数：bump 关键字或显式版本号 → BUMP；其余（--otp=… / --dry-run）→ 透传给 npm publish
BUMP="patch"; PASS=()
for a in "$@"; do
  case "$a" in
    patch|minor|major) BUMP="$a" ;;
    [0-9]*)            BUMP="$a" ;;
    *)                 PASS+=("$a") ;;
  esac
done

bold "1/7 登录与源"
WHO=$(npm whoami --registry "$REG" 2>/dev/null) || die "官方源未登录。先执行：
    npm login --auth-type=legacy --registry $REG
  legacy 登录走 registry 接口，不需要打开 npmjs.com 网页。"
[ "$WHO" = "$OWNER" ] || die "当前身份是 $WHO，不是 $OWNER"
ok "$WHO → $REG"

bold "2/7 工作区干净"
DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then printf '%s\n' "$DIRTY"; die "有未提交改动，先 commit 再把版本号交给脚本管理。"; fi
ok "git clean ($(git rev-parse --short HEAD))"

bold "3/7 单元测试"
if node --test test/ >/tmp/dsh-session-bin-test.log 2>&1; then
  ok "$(grep -E '^# (pass|fail)' /tmp/dsh-session-bin-test.log | tr '\n' ' ')"
else
  tail -25 /tmp/dsh-session-bin-test.log
  die "测试未通过，完整日志 /tmp/dsh-session-bin-test.log"
fi

bold "4/7 提升版本 → $BUMP"
OLD=$(node -p "require('./package.json').version")
npm version "$BUMP" --no-git-tag-version --allow-same-version >/dev/null
NEW=$(node -p "require('./package.json').version")
[ "$OLD" = "$NEW" ] && warn "版本号未变化（$NEW），npm 会拒绝重复发布"

bold "5/7 打包内容"
npm pack --dry-run 2>&1 | grep -E 'npm notice (name|version|total files|filename|unpacked size|package size|shasum)' || true

bold "6/7 发布"
set +e
OUT=$(npm publish --registry "$REG" "${PASS[@]+"${PASS[@]}"}" 2>&1); RC=$?
set -e
printf '%s\n' "$OUT" | sed -E 's/(npm_[A-Za-z0-9]{6})[A-Za-z0-9]+/\1…/g' | tail -15
if [ $RC -ne 0 ]; then
  npm version "$OLD" --no-git-tag-version --allow-same-version >/dev/null
  if printf '%s' "$OUT" | grep -qE 'EOTP|one-time password|auth/cli'; then
    die "需要一次性验证码（2FA）。
  重跑：./release.sh $BUMP --otp=你的6位码
  想彻底免掉：生成一个勾了 bypass 2FA 的 granular token 写进 ~/.npmrc。"
  fi
  die "发布失败，版本号已回滚到 $OLD"
fi

bold "7/7 线上校验 + git 归档"
LOCAL=$(npm pack --json --pack-destination /tmp 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].shasum))")
LIVE=$(npm view "$PKG@$NEW" dist.shasum --registry "$REG" 2>/dev/null | tail -1)
if [ "$LOCAL" = "$LIVE" ]; then ok "shasum 一致 $LIVE"; else warn "shasum 不一致（本地 $LOCAL / 线上 $LIVE）"; fi
ok "latest = $(npm view "$PKG" dist-tags.latest --registry "$REG" 2>/dev/null)"

git add -A
git commit -q -m "release: v$NEW"
git tag -a "v$NEW" -m "v$NEW"
git push -q origin HEAD
git push -q origin "v$NEW"
ok "已提交并推送 v$NEW"

printf '\n\033[32m发布完成\033[0m  %s@%s\n安装：dsh plugin add %s\n\n' "$PKG" "$NEW" "$PKG"
