"""中央哨兵 — 信号汇总+跨市场联动+节点健康检查
不采集原始数据，读SUPER汇聚的信号做二次分析
"""
import httpx
from datetime import datetime

SUPER_URL = "http://100.80.30.139:8100"
SENTINEL_API = f"{SUPER_URL}/api/v1/sentinel"
ROUTER_URL = "http://100.80.30.139:3456/v1/chat/completions"


def get_signals(hours=4):
    """拉最近N小时所有节点信号"""
    try:
        resp = httpx.get(f"{SENTINEL_API}/signals", params={"hours": hours, "limit": 100}, timeout=15)
        return resp.json()
    except Exception as e:
        print(f"Fetch signals failed: {e}")
        return []


def get_node_status():
    """三节点健康状态"""
    try:
        resp = httpx.get(f"{SENTINEL_API}/status", timeout=15)
        return resp.json()
    except Exception as e:
        print(f"Fetch status failed: {e}")
        return {}


def push_signal(signal_type, severity, title, content):
    try:
        httpx.post(f"{SENTINEL_API}/push", json={
            "source_node": "central",
            "market": "cross-market",
            "signal_type": signal_type,
            "severity": severity,
            "title": title,
            "content": content,
        }, timeout=15)
        print(f"[{severity}] {title}")
    except Exception as e:
        print(f"Push failed: {e}")


def llm_analyze(text):
    try:
        resp = httpx.post(ROUTER_URL, json={
            "model": "hub:doubao",
            "messages": [{"role": "user", "content": text}],
            "max_tokens": 500,
        }, timeout=30)
        return resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
    except:
        return ""


def check_node_health():
    """整风巡检 — 各节点是否正常上报"""
    status = get_node_status()
    if not status:
        return
    now = datetime.utcnow()
    for node, info in status.items():
        last = info.get("last_signal")
        count = info.get("count_24h", 0)
        if last is None and count == 0:
            push_signal("health", "warning", f"节点 {node} 24h无信号", {
                "node": node, "count_24h": 0, "last_signal": None,
            })
            print(f"[warning] {node}: 24h无信号")
        else:
            print(f"{node}: {count}条信号, 最近={last}")


def check_cross_market():
    """跨市场联动分析 — 多节点同时异动"""
    signals = get_signals(hours=4)
    if not signals:
        print("无近期信号")
        return

    # 按severity过滤
    warnings = [s for s in signals if s.get("severity") in ("warning", "critical")]
    if len(warnings) < 2:
        print(f"近4h {len(warnings)}条警告，不足以触发联动分析")
        return

    # 检查是否多市场同时异动
    markets = set(s.get("market") for s in warnings)
    if len(markets) >= 2:
        titles = [s.get("title", "") for s in warnings[:5]]
        analysis = llm_analyze(
            f"以下是最近4小时跨市场异动信号，请分析是否存在联动关系，用中文200字内回答：\n"
            + "\n".join(f"- [{s.get('market')}] {s.get('title')}" for s in warnings[:10])
        )
        push_signal("analysis", "info", f"跨市场联动: {len(markets)}个市场异动", {
            "markets": list(markets),
            "signal_count": len(warnings),
            "top_signals": titles,
            "analysis": analysis,
        })
    else:
        print(f"近4h警告集中在{markets}，无跨市场联动")


def daily_summary():
    """日报 — 汇总24h信号"""
    signals = get_signals(hours=24)
    if not signals:
        print("24h无信号，跳过日报")
        return

    by_node = {}
    for s in signals:
        node = s.get("source_node", "unknown")
        by_node.setdefault(node, []).append(s)

    summary_input = f"今日三节点哨兵汇总(共{len(signals)}条信号):\n"
    for node, sigs in by_node.items():
        warns = [s for s in sigs if s.get("severity") in ("warning", "critical")]
        summary_input += f"- {node}: {len(sigs)}条, {len(warns)}条警告\n"
        for w in warns[:3]:
            summary_input += f"  - [{w.get(severity)}] {w.get(title)}\n"

    report = llm_analyze(f"请根据以下数据生成一份简短的每日市场态势报告，中文300字内：\n{summary_input}")
    if report:
        push_signal("daily_report", "info", f"每日态势报告 ({len(signals)}条信号)", {
            "total_signals": len(signals),
            "by_node": {k: len(v) for k, v in by_node.items()},
            "report": report,
        })


def main():
    hour = datetime.utcnow().hour
    print(f"=== 中央哨兵 — 汇总+巡检 (UTC {hour}:00) ===")
    check_node_health()
    check_cross_market()
    # 每天UTC 10:00 (CST 18:00) 出日报
    if hour == 10:
        daily_summary()
    print("=== 巡检完成 ===")


if __name__ == "__main__":
    main()
