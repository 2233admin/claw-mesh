#!/bin/bash
# FSC Agent 单任务入口脚本
# 从 Redis 获取任务 → 克隆代码 → 执行 → 上报结果

set -euo pipefail

REDIS_CLI="redis-cli -h ${REDIS_HOST:-10.10.0.1} -p ${REDIS_PORT:-6379} -a ${REDIS_PASSWORD:-fsc-mesh-2026} --no-auth-warning"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 1. 上报 Agent 启动
log "Agent ${AGENT_ID:-$$} starting, model=${MODEL:-minimax-2.5}"
$REDIS_CLI XADD fsc:events '*' type agent_start agent_id "${AGENT_ID:-$$}" model "${MODEL:-minimax-2.5}" > /dev/null 2>&1 || true

# 2. 克隆代码库
if [ -n "${GIT_REPO:-}" ]; then
  log "Cloning ${GIT_REPO} branch=${GIT_BRANCH:-main}"
  git clone --depth 1 --branch "${GIT_BRANCH:-main}" "${GIT_REPO}" /workspace/repo 2>&1 | tail -1
  cd /workspace/repo
fi

# 3. 执行任务 (根据 AGENT_TYPE 选择工具)
TASK_FILE="/workspace/task.txt"
echo "${TASK_DESCRIPTION:-No task provided}" > "$TASK_FILE"

case "${AGENT_TYPE:-minimax}" in
  claude)
    log "Running Claude Code"
    npx -y claude-code --print < "$TASK_FILE" > /workspace/result.txt 2>&1
    ;;
  gemini)
    log "Running Gemini CLI"
    npx -y gemini-cli --prompt-file "$TASK_FILE" > /workspace/result.txt 2>&1
    ;;
  *)
    # 默认: 通过 ClawAPI Manager 调用廉价模型
    log "Running via API (${MODEL:-minimax-2.5})"
    curl -s -X POST "http://${REDIS_HOST:-10.10.0.1}:3002/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"${MODEL:-minimax-2.5}\",\"messages\":[{\"role\":\"user\",\"content\":$(cat "$TASK_FILE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '\"task\"')}],\"max_tokens\":${MAX_TOKENS:-4000}}" \
      > /workspace/result.txt 2>&1
    ;;
esac

EXIT_CODE=$?

# 4. 收集 git diff (如果有变更)
DIFF=""
if [ -d "/workspace/repo/.git" ]; then
  cd /workspace/repo
  DIFF=$(git diff 2>/dev/null || echo "")
fi

# 5. 上报结果到 Redis
STATUS="success"
[ $EXIT_CODE -ne 0 ] && STATUS="failure"

$REDIS_CLI XADD fsc:results '*' \
  task_id "${TASK_ID:-unknown}" \
  agent_id "${AGENT_ID:-$$}" \
  status "$STATUS" \
  exit_code "$EXIT_CODE" \
  model "${MODEL:-minimax-2.5}" \
  > /dev/null 2>&1 || true

log "Task complete: status=${STATUS}, exit_code=${EXIT_CODE}"
exit $EXIT_CODE
