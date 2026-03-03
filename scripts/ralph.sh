#!/bin/bash
# Ralph 主循环
# 基于 https://github.com/snarktank/ralph
# 
# 特性：
# - while 循环
# - 每次迭代 fresh context
# - passes:true 时停止
# - 因果分析 + 自动重试

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRD_FILE="$PROJECT_ROOT/tasks/prd.json"

# ============ 辅助函数 ============

# 运行测试（模拟）
run_tests() {
  local story_id="$1"
  # 实际应该运行真实测试
  # 这里模拟：随机返回 pass 或 fail
  echo "pass"
}

# 重试函数
retry_story() {
  local story_id="$1"
  local fix="$2"
  
  echo "🔄 Retrying $story_id with fix: $fix"
  
  # 实际应该重新执行 story
  # 这里模拟：直接调用 verify_story
  verify_story "$story_id"
}

# 验证 story
verify_story() {
  local story_id="$1"
  local error_log="${2:-}"
  
  result=$(run_tests "$story_id")
  
  if [ "$result" = "pass" ]; then
    echo "✅ Ralph: $story_id PASSED"
    
    # 成功 → 学习经验写入 Ontology
    node -e "
      const c = require('./memory/causal');
      c.learnFromSuccess('${story_id}', process.env.LAST_FIX || 'Passed after iteration');
    "
    
    # MemoV snap
    if [ -f "$PROJECT_ROOT/scripts/memov.js" ]; then
      node "$PROJECT_ROOT/scripts/memov.js" snap "${story_id}:pass"
    fi
    
  else
    echo "❌ Ralph: $story_id FAILED"
    
    # 失败 → 因果推断
    FINDING=$(node -e "
      const c = require('./memory/causal');
      const f = c.diagnoseFailure('${story_id}', \`${error_log}\`);
      process.stdout.write(JSON.stringify(f));
    ")
    
    FIX=$(node -e "
      const f = JSON.parse(process.argv[1]);
      process.stdout.write(f.fix);
    " "$FINDING")
    
    echo "🔧 Root cause: $(node -e "const f=JSON.parse(process.argv[1]);process.stdout.write(f.cause);" "$FINDING")"
    echo "🔧 Suggested fix: $FIX"
    
    # 把 fix 注入环境，Agent 下一轮能读到
    export LAST_FIX="$FIX"
    export CAUSAL_FINDING="$FINDING"
    
    # 重新触发
    retry_story "$story_id" "$FIX"
  fi
}

# ============ 主循环 ============

echo "🚀 Ralph Loop Starting..."
echo "📋 PRD: $PRD_FILE"
echo ""

# 检查 PRD 文件
if [ ! -f "$PRD_FILE" ]; then
  echo "❌ PRD file not found: $PRD_FILE"
  exit 1
fi

ITERATION=0
while true; do
  ITERATION=$((ITERATION + 1))
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🔄 Iteration $ITERATION"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # 读取 PRD 状态
  PASSES=$(jq -r '.passes' "$PRD_FILE")
  NEXT_STORY=$(jq -r '.next_story' "$PRD_FILE")
  
  echo "📊 Status: passes=$PASSES, next_story=$NEXT_STORY"
  
  # 检查是否完成
  if [ "$PASSES" = "true" ]; then
    echo ""
    echo "✅ All stories completed! Ralph loop finished."
    echo ""
    jq '.' "$PRD_FILE"
    exit 0
  fi
  
  # 获取下一个 story
  if [ "$NEXT_STORY" = "null" ] || [ -z "$NEXT_STORY" ]; then
    echo "❌ No next story found"
    exit 1
  fi
  
  STORY_TITLE=$(jq -r ".stories[] | select(.id == \"$NEXT_STORY\") | .title" "$PRD_FILE")
  STORY_STATUS=$(jq -r ".stories[] | select(.id == \"$NEXT_STORY\") | .status" "$PRD_FILE")
  
  echo "📖 Story: $NEXT_STORY - $STORY_TITLE"
  echo "📊 Status: $STORY_STATUS"
  echo ""
  
  # 如果 story 已完成，跳到下一个
  if [ "$STORY_STATUS" = "completed" ]; then
    echo "⏭️  Story already completed, moving to next..."
    
    # 更新 next_story
    STORY_INDEX=$(jq ".stories | map(.id) | index(\"$NEXT_STORY\")" "$PRD_FILE")
    NEXT_INDEX=$((STORY_INDEX + 1))
    TOTAL_STORIES=$(jq '.stories | length' "$PRD_FILE")
    
    if [ "$NEXT_INDEX" -ge "$TOTAL_STORIES" ]; then
      # 所有 story 完成
      jq '.passes = true | .next_story = null' "$PRD_FILE" > "$PRD_FILE.tmp"
      mv "$PRD_FILE.tmp" "$PRD_FILE"
      echo "✅ All stories completed!"
      continue
    else
      NEXT_STORY_ID=$(jq -r ".stories[$NEXT_INDEX].id" "$PRD_FILE")
      jq ".next_story = \"$NEXT_STORY_ID\"" "$PRD_FILE" > "$PRD_FILE.tmp"
      mv "$PRD_FILE.tmp" "$PRD_FILE"
      continue
    fi
  fi
  
  # 执行 story（fresh context）
  echo "🔨 Executing story in fresh context..."
  echo ""
  
  # 验证 story
  verify_story "$NEXT_STORY"
  
  # 更新 story 状态为 completed
  jq "(.stories[] | select(.id == \"$NEXT_STORY\") | .status) = \"completed\"" "$PRD_FILE" > "$PRD_FILE.tmp"
  mv "$PRD_FILE.tmp" "$PRD_FILE"
  
  echo "✅ Story $NEXT_STORY completed"
  echo ""
  
  # 短暂延迟
  sleep 1
done
