#!/bin/bash
# Ralph 主循环
# 基于 https://github.com/snarktank/ralph
# 
# 特性：
# - while 循环
# - 每次迭代 fresh context
# - passes:true 时停止

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRD_FILE="$PROJECT_ROOT/tasks/prd.json"

echo "🚀 Ralph Loop Starting..."
echo "📋 PRD: $PRD_FILE"
echo ""

# 检查 PRD 文件
if [ ! -f "$PRD_FILE" ]; then
  echo "❌ PRD file not found: $PRD_FILE"
  exit 1
fi

# 主循环
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
  
  # 这里应该调用 antfarm 或其他 agent 执行
  # 示例：antfarm workflow run fsc-mesh-integration "$STORY_TITLE"
  
  # 模拟执行（实际应该调用真实的 agent）
  echo "📝 Tasks for $NEXT_STORY:"
  jq -r ".stories[] | select(.id == \"$NEXT_STORY\") | .tasks[] | \"  - [\(.status)] \(.description)\"" "$PRD_FILE"
  echo ""
  
  # 等待用户确认（实际应该是自动执行）
  echo "⏸️  Press Enter to mark story as completed (or Ctrl+C to stop)..."
  read -r
  
  # 更新 story 状态为 completed
  jq "(.stories[] | select(.id == \"$NEXT_STORY\") | .status) = \"completed\"" "$PRD_FILE" > "$PRD_FILE.tmp"
  mv "$PRD_FILE.tmp" "$PRD_FILE"
  
  echo "✅ Story $NEXT_STORY completed"
  echo ""
  
  # 短暂延迟
  sleep 1
done
