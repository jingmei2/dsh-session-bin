#!/usr/bin/env bash
# 本地发版：bump + commit + tag + push，发布由 GitHub Actions 完成。
#
#   ./release.sh                  # patch +1（例：0.1.3 → 0.1.4）
#   ./release.sh minor            # minor +1
#   ./release.sh 0.2.0            # 发指定版本
#   ./release.sh patch --no-wait  # 推完就走，不等 CI
#
# 为什么不在本地 npm publish：
#   本地拿不到 OIDC 身份，签不出 Sigstore provenance，npm 页面不会有徽章，
#   也无法进公开透明度日志。改由 tag 触发 .github/workflows/publish.yml，
#   走 trusted publishing 自动签名。
set -euo pipefail

PKG="@jingmei2/dsh-session-bin"
REG="https://registry.npmjs.org/"
WORKFLOW="publish.yml"
cd "$(dirname "$0")"

bold(){ printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok(){   printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die(){  printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 参数：bump 关键字或显式版本号 → BUMP；--no-wait → 不等待 CI
BUMP="patch"; WAIT=1
for a in "$@"; do
  case "$a" in
    patch|minor|major) BUMP="$a" ;;
    [0-9]*)            BUMP="$a" ;;
    --no-wait)         WAIT=0 ;;
    *)                 die "未知参数：${a}（可用：patch|minor|major|<版本号>|--no-wait）" ;;
  esac
done

bold "1/6 前置检查"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "当前在 ${BRANCH}，发版必须在 main 上"
if [ -n "$(git status --porcelain)" ]; then git status --short; die "有未提交改动，先 commit 再发版"; fi
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "本地与 origin/main 不一致，先 git pull --rebase"
ok "main 干净且与远端同步 @ $(git rev-parse --short HEAD)"

bold "2/6 单元测试"
# 显式 glob：Node 24 不认 `node --test test/` 的目录参数（会当模块 require）
if node --test test/*.test.mjs >/tmp/dsh-session-bin-test.log 2>&1; then
  ok "$(grep -aoE '(pass|fail) [0-9]+' /tmp/dsh-session-bin-test.log | tail -2 | tr '\n' ' ')"
else
  tail -25 /tmp/dsh-session-bin-test.log
  die "测试未通过，完整日志 /tmp/dsh-session-bin-test.log"
fi

bold "3/6 提升版本"
OLD=$(node -p "require('./package.json').version")
npm version "$BUMP" --no-git-tag-version --allow-same-version >/dev/null
NEW=$(node -p "require('./package.json').version")
[ "$OLD" = "$NEW" ] && die "版本号未变化（${NEW}），registry 会拒绝重复发布"
ok "$OLD → $NEW"

bold "4/6 提交 + 打 tag"
git add -A
git commit -q -m "release: v$NEW"
git tag -a "v$NEW" -m "v$NEW"
ok "commit $(git rev-parse --short HEAD) / tag v$NEW"

bold "5/6 推送（CI 接管发布）"
if ! git push -q origin HEAD || ! git push -q origin "v$NEW"; then
  warn "推送失败，常见原因："
  warn "  · 凭证 scope 不足（改过 .github/workflows 需要 workflow scope）→ 执行 gh auth setup-git"
  warn "  · VPN 节点对 github.com:443 不稳定 → 换节点后重试"
  die "本地 commit 与 tag 已生成，修复后执行：
    git push origin HEAD && git push origin v$NEW"
fi
ok "已推送，CI 将走 OIDC 发布"

if [ "$WAIT" -eq 0 ]; then
  printf '\n已跳过等待。进度：gh run list --workflow %s\n\n' "$WORKFLOW"
  exit 0
fi

bold "6/6 等待 CI 并核验线上"
command -v gh >/dev/null 2>&1 || { warn "未安装 gh，跳过等待；进度见 GitHub Actions 页面"; exit 0; }

RUN=""; SHA=$(git rev-parse HEAD)
for _ in 1 2 3 4 5 6; do
  # 按 headSha 精确匹配本次提交，避免取到上一次的 run
  # 注意：sha 必须作为参数传给 python3，`SHA=… cmd | other` 的前缀只作用于 cmd 本身
  RUN=$(gh run list --workflow "$WORKFLOW" --limit 10 --json databaseId,headSha 2>/dev/null \
    | python3 -c "import sys,json;sha=sys.argv[1];rs=json.load(sys.stdin);print(next((r['databaseId'] for r in rs if r.get('headSha')==sha),''))" "$SHA" 2>/dev/null || true)
  [ -n "$RUN" ] && break
  sleep 5
done
[ -n "$RUN" ] || { warn "未取到 run id，手动查看：gh run list --workflow $WORKFLOW"; exit 0; }

if gh run watch "$RUN" --exit-status --interval 10 >/tmp/dsh-release-ci.log 2>&1; then
  ok "CI 发布成功（run ${RUN}）"
else
  tail -30 /tmp/dsh-release-ci.log
  die "CI 失败，日志：gh run view $RUN --log-failed"
fi

# registry 有数十秒索引延迟，轮询确认；校验失败只告警，不影响已达成的发布
LIVE=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  LIVE=$(npm view "$PKG@$NEW" version --registry "$REG" 2>/dev/null | tail -1 || true)
  [ "$LIVE" = "$NEW" ] && break
  [ "$i" -lt 12 ] && sleep 10
done
if [ "$LIVE" = "$NEW" ]; then
  ok "线上可见 $PKG@${NEW}（第 ${i} 次轮询）"
else
  warn "线上暂未索引到 ${NEW}，稍后自行确认：npm view $PKG@$NEW version --registry $REG"
fi

ATT=$(npm view "$PKG@$NEW" dist.attestations.provenance.predicateType --registry "$REG" 2>/dev/null | tail -1 || true)
if [ -n "$ATT" ]; then ok "provenance 已签名：$ATT"; else warn "未回读到 provenance，检查 workflow 是否带 id-token: write"; fi

ok "latest = $(npm view "$PKG" dist-tags.latest --registry "$REG" 2>/dev/null || true)"

printf '\n\033[32m发布完成\033[0m  %s@%s（带 provenance 徽章）\n安装：dsh plugin add %s\n\n' "$PKG" "$NEW" "$PKG"
