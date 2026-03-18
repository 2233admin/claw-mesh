"""美股+Crypto哨兵 — 硅谷节点自采集版
数据从公开API直接拉，异常信号push回SUPER汇总
"""
import httpx

SENTINEL_PUSH = "http://100.80.30.139:8100/api/v1/sentinel/push"
ROUTER_URL = "http://100.80.30.139:3456/v1/chat/completions"
YF_HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}


def push_signal(signal_type, severity, title, content):
    try:
        httpx.post(SENTINEL_PUSH, json={
            "source_node": "silicon_valley", "market": "us-stock",
            "signal_type": signal_type, "severity": severity,
            "title": title, "content": content,
        }, timeout=15)
        print(f"[{severity}] {title}")
    except Exception as e:
        print(f"Push failed: {e}")


def llm_summarize(text):
    try:
        resp = httpx.post(ROUTER_URL, json={
            "model": "hub:doubao",
            "messages": [{"role": "user", "content": f"用中文一句话总结这条市场异动的含义和影响：\n{text}"}],
            "max_tokens": 200,
        }, timeout=30)
        return resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
    except:
        return ""


def yf_price(symbol):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    resp = httpx.get(url, headers=YF_HEADERS, timeout=15, follow_redirects=True)
    meta = resp.json()["chart"]["result"][0]["meta"]
    return meta.get("regularMarketPrice", 0), meta.get("previousClose", 0)


def check_vix():
    try:
        price, prev = yf_price("%5EVIX")
        change = ((price - prev) / prev * 100) if prev else 0
        if price >= 25:
            sev = "critical" if price >= 35 else "warning"
            title = f"VIX恐慌指数 {price:.1f} ({change:+.1f}%)"
            summary = llm_summarize(f"VIX恐慌指数达到{price}，较前收盘{prev}变动{change:.1f}%")
            push_signal("anomaly", sev, title, {"vix": price, "prev": prev, "change_pct": round(change, 2), "summary": summary})
        else:
            print(f"VIX正常: {price:.1f}")
    except Exception as e:
        print(f"VIX failed: {e}")


def check_sp500():
    try:
        price, prev = yf_price("%5EGSPC")
        change = ((price - prev) / prev * 100) if prev else 0
        if abs(change) >= 2:
            sev = "critical" if abs(change) >= 3 else "warning"
            d = "大涨" if change > 0 else "大跌"
            title = f"S&P500{d} {price:,.0f} ({change:+.1f}%)"
            summary = llm_summarize(f"标普500{d}{abs(change):.1f}%至{price:,.0f}点")
            push_signal("anomaly", sev, title, {"sp500": price, "prev": prev, "change_pct": round(change, 2), "summary": summary})
        else:
            print(f"S&P500正常: {price:,.0f} ({change:+.1f}%)")
    except Exception as e:
        print(f"S&P500 failed: {e}")


def check_btc():
    try:
        resp = httpx.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true", timeout=15)
        data = resp.json().get("bitcoin", {})
        price = data.get("usd", 0)
        chg = data.get("usd_24h_change", 0)
        if abs(chg) >= 5:
            sev = "critical" if abs(chg) >= 10 else "warning"
            d = "暴涨" if chg > 0 else "暴跌"
            title = f"BTC{d} ${price:,.0f} ({chg:+.1f}%)"
            summary = llm_summarize(f"比特币24小时{d}{abs(chg):.1f}%，当前${price:,.0f}")
            push_signal("anomaly", sev, title, {"btc_usd": price, "change_24h": round(chg, 2), "summary": summary})
        else:
            print(f"BTC正常: ${price:,.0f} ({chg:+.1f}%)")
    except Exception as e:
        print(f"BTC failed: {e}")


def check_fear_greed():
    try:
        resp = httpx.get("https://api.alternative.me/fng/?limit=1", timeout=15)
        data = resp.json().get("data", [{}])[0]
        val = int(data.get("value", 50))
        cls = data.get("value_classification", "")
        if val <= 20 or val >= 80:
            sev = "critical" if (val <= 10 or val >= 90) else "warning"
            title = f"Crypto情绪极端: {val} ({cls})"
            summary = llm_summarize(f"加密货币恐贪指数{val}({cls})，市场情绪极端")
            push_signal("anomaly", sev, title, {"fear_greed": val, "classification": cls, "summary": summary})
        else:
            print(f"Crypto情绪正常: {val} ({cls})")
    except Exception as e:
        print(f"Fear/greed failed: {e}")


def main():
    print("=== 硅谷 美股+Crypto哨兵巡检 ===")
    check_vix()
    check_sp500()
    check_btc()
    check_fear_greed()
    print("=== 巡检完成 ===")


if __name__ == "__main__":
    main()
