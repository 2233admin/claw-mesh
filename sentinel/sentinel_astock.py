"""A股盘中哨兵 — 只推异动，正常不推"""
import json
import sys
import httpx

SUPER_URL = "http://100.80.30.139:8100"
SENTINEL_PUSH = f"{SUPER_URL}/api/v1/sentinel/push"
ROUTER_URL = "http://100.80.30.139:3456/v1/chat/completions"

# 异动阈值
NORTHBOUND_THRESHOLD = 20  # 亿元
SENTIMENT_THRESHOLD = 0.3  # 情绪偏离度


def fetch_trending(platform: str) -> list:
    try:
        resp = httpx.get(f"{SUPER_URL}/trending/{platform}", timeout=30)
        data = resp.json()
        return data.get("data", [])
    except Exception as e:
        print(f"Fetch {platform} failed: {e}")
        return []


def push_signal(signal_type: str, severity: str, title: str, content: dict):
    """推送到 SUPER sentinel API"""
    try:
        httpx.post(SENTINEL_PUSH, json={
            "source_node": "central",
            "market": "a-stock",
            "signal_type": signal_type,
            "severity": severity,
            "title": title,
            "content": content,
        }, timeout=15)
        print(f"[{severity}] {title}")
    except Exception as e:
        print(f"Push failed: {e}")


def llm_summarize(text: str) -> str:
    """用免费 API 生成摘要"""
    try:
        resp = httpx.post(ROUTER_URL, json={
            "model": "hub:doubao",
            "messages": [{"role": "user", "content": f"用中文一句话总结这条市场异动的含义和影响：\n{text}"}],
            "max_tokens": 200,
        }, timeout=30)
        return resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
    except:
        return ""


def check_northbound():
    """北向资金异动"""
    data = fetch_trending("northbound")
    if not data:
        return
    for item in data[:3]:
        net = item.get("net_buy") or item.get("value") or 0
        try:
            net_val = float(str(net).replace("亿", "").replace(",", ""))
        except (ValueError, TypeError):
            continue
        if abs(net_val) >= NORTHBOUND_THRESHOLD:
            direction = "净流入" if net_val > 0 else "净流出"
            severity = "critical" if abs(net_val) >= 50 else "warning"
            title = f"北向资金{direction} {abs(net_val):.1f}亿"
            summary = llm_summarize(f"北向资金{direction}{abs(net_val):.1f}亿元")
            push_signal("anomaly", severity, title, {
                "net_value": net_val,
                "direction": direction,
                "summary": summary,
                "raw": item,
            })


def check_lhb():
    """龙虎榜新上榜"""
    data = fetch_trending("stock_lhb")
    if not data:
        return
    if len(data) > 0:
        names = [d.get("name", d.get("stock_name", "?")) for d in data[:5]]
        push_signal("alert", "info", f"龙虎榜: {', '.join(names)}", {
            "count": len(data),
            "top5": data[:5],
        })


def check_policy():
    """政策异动"""
    data = fetch_trending("policy")
    if not data:
        return
    for item in data[:3]:
        title = item.get("title", "")
        if any(kw in title for kw in ["紧急", "重大", "降准", "降息", "加息", "暂停", "IPO"]):
            summary = llm_summarize(f"政策: {title}")
            push_signal("alert", "critical", f"政策异动: {title[:30]}", {
                "title": title,
                "source": item.get("source", ""),
                "summary": summary,
            })


def main():
    print("=== A股哨兵巡检 ===")
    signals_before = 0
    check_northbound()
    check_lhb()
    check_policy()
    print("=== 巡检完成 ===")


if __name__ == "__main__":
    main()
