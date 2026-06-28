# -*- coding: utf-8 -*-
"""
deno_pro.ts 本地集成测试 (指向 localhost:8000)
覆盖: 跨模型非流式 / 流式SSE / 多轮会话 / Think模式 / 图像生成
"""
import requests, json, time, sys

BASE_URL = "http://localhost:8000"

# 用例选取覆盖各系列代表模型
MODELS = ["gpt-5.5", "claude-opus-4.8", "gemini-2.5-pro", "deepseek-v4-pro", "grok-4"]

results = {}

def rec(name, ok, detail=""):
    results[name] = ok
    print(f"  {'[PASS]' if ok else '[FAIL]'} {name} {detail}")

def test_nonstream(model):
    print(f"\n[非流式] {model}")
    try:
        r = requests.post(f"{BASE_URL}/v1/chat/completions",
            json={"model": model, "stream": False, "temperature": 0.7,
                  "messages": [{"role": "user", "content": "用一句话介绍你自己"}]},
            timeout=70)
        if r.status_code == 200:
            c = r.json()["choices"][0]["message"]["content"]
            rec(f"非流式:{model}", len(c) > 0, f"({len(c)}字) {c[:50]}")
        else:
            rec(f"非流式:{model}", False, f"HTTP {r.status_code} {r.text[:80]}")
    except Exception as e:
        rec(f"非流式:{model}", False, str(e)[:80])

def test_stream():
    print("\n[流式SSE] gpt-5.5")
    try:
        r = requests.post(f"{BASE_URL}/v1/chat/completions",
            json={"model": "gpt-5.5", "stream": True,
                  "messages": [{"role": "user", "content": "从1数到5"}]},
            stream=True, timeout=70)
        chunks, content = 0, ""
        for line in r.iter_lines():
            if not line: continue
            s = line.decode("utf-8")
            if s.startswith("data:"):
                d = s[5:].strip()
                if d == "[DONE]": break
                try:
                    delta = json.loads(d)["choices"][0]["delta"].get("content", "")
                    if delta: content += delta; chunks += 1
                except Exception: pass
        rec("流式SSE", chunks > 0, f"({chunks}个chunk, {len(content)}字)")
    except Exception as e:
        rec("流式SSE", False, str(e)[:80])

def test_multiturn():
    print("\n[多轮会话] 记忆测试")
    try:
        sid = "test-multiturn-001"
        h = {"X-Session-ID": sid}
        r1 = requests.post(f"{BASE_URL}/v1/chat/completions", headers=h,
            json={"model": "gpt-5.5", "stream": False,
                  "messages": [{"role": "user", "content": "我的幸运数字是42，请记住"}]}, timeout=70)
        time.sleep(1)
        r2 = requests.post(f"{BASE_URL}/v1/chat/completions", headers=h,
            json={"model": "gpt-5.5", "stream": False,
                  "messages": [
                      {"role": "user", "content": "我的幸运数字是42，请记住"},
                      {"role": "assistant", "content": r1.json()["choices"][0]["message"]["content"]},
                      {"role": "user", "content": "我的幸运数字是多少?"}]}, timeout=70)
        ans = r2.json()["choices"][0]["message"]["content"]
        rec("多轮会话", "42" in ans, f"(回忆: {ans[:50]})")
    except Exception as e:
        rec("多轮会话", False, str(e)[:80])

def test_think():
    print("\n[Think模式] gpt-5.5-think")
    try:
        r = requests.post(f"{BASE_URL}/v1/chat/completions",
            json={"model": "gpt-5.5-think", "stream": False,
                  "messages": [{"role": "user", "content": "9.11和9.9哪个大?简短回答"}]}, timeout=90)
        if r.status_code == 200:
            c = r.json()["choices"][0]["message"]["content"]
            rec("Think模式", len(c) > 0, f"({len(c)}字) {c[:50]}")
        else:
            rec("Think模式", False, f"HTTP {r.status_code}")
    except Exception as e:
        rec("Think模式", False, str(e)[:80])

def test_image():
    print("\n[图像生成] /v1/images/generations")
    try:
        r = requests.post(f"{BASE_URL}/v1/images/generations",
            json={"prompt": "a cute cat sitting on a windowsill", "n": 1, "size": "1024x1024"},
            timeout=120)
        if r.status_code == 200:
            url = r.json()["data"][0]["url"]
            rec("图像生成", url.startswith("http"), f"({url[:60]})")
        else:
            rec("图像生成", False, f"HTTP {r.status_code} {r.text[:100]}")
    except Exception as e:
        rec("图像生成", False, str(e)[:80])

if __name__ == "__main__":
    print("=" * 60)
    print("deno_pro.ts 本地真实功能测试")
    print("=" * 60)
    for m in MODELS:
        test_nonstream(m)
        time.sleep(1)
    test_stream()
    test_multiturn()
    test_think()
    test_image()
    print("\n" + "=" * 60)
    print("测试汇总")
    print("=" * 60)
    passed = sum(1 for v in results.values() if v)
    for k, v in results.items():
        print(f"  {'[PASS]' if v else '[FAIL]'} {k}")
    print(f"\n通过: {passed}/{len(results)}")
    sys.exit(0 if passed == len(results) else 1)
