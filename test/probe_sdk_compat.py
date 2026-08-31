"""官方 SDK 兼容性探针: 用 openai / anthropic / google-genai 官方 SDK 直连被测实例。

回答的是"真实用户能否把 base_url 一改就接入"这个问题, 而非 raw HTTP 层的协议契约。
运行: python test/probe_sdk_compat.py  (读 .env 的 BASE_URL / AUTH_TOKEN)
每个 SDK 用不同模型, 避开实例每模型 60s/6 次的限速。
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

BASE = config.DEFAULT_BASE_URL.rstrip("/")
TOKEN = config.DEFAULT_TOKEN
RESULTS = []


def check(name, fn):
    t0 = time.time()
    try:
        detail = fn()
        RESULTS.append((name, "PASS", round(time.time() - t0, 2), detail))
    except Exception as e:  # noqa: BLE001
        RESULTS.append((name, "FAIL", round(time.time() - t0, 2), f"{type(e).__name__}: {e}"[:220]))


# ---------------- openai SDK ----------------
def openai_suite():
    from openai import OpenAI
    cli = OpenAI(base_url=f"{BASE}/v1", api_key=TOKEN)

    def models():
        ids = [m.id for m in cli.models.list().data]
        return f"{len(ids)} models, e.g. {ids[:3]}"

    def chat():
        r = cli.chat.completions.create(
            model="gpt-4.1", messages=[{"role": "user", "content": "只回答: OK"}], max_tokens=20)
        c = r.choices[0]
        return f"finish={c.finish_reason} text={c.message.content!r} usage={bool(r.usage)}"

    def chat_stream():
        s = cli.chat.completions.create(
            model="gpt-4.1", messages=[{"role": "user", "content": "数到三"}], stream=True)
        n, txt = 0, ""
        for ck in s:
            n += 1
            if ck.choices and ck.choices[0].delta.content:
                txt += ck.choices[0].delta.content
        return f"{n} chunks, {len(txt)} chars"

    def responses():
        r = cli.responses.create(model="gpt-4.1", input="只回答: OK")
        return f"status={r.status} output_text={r.output_text!r}"

    check("openai.models.list", models)
    check("openai.chat.completions (non-stream)", chat)
    check("openai.chat.completions (stream)", chat_stream)
    check("openai.responses.create", responses)


# ---------------- anthropic SDK ----------------
def anthropic_suite(inject_auth=False):
    import anthropic
    # inject_auth: 手动补 Authorization 头, 用于区分"鉴权门不认 x-api-key"与"协议本身有问题"
    extra = {"Authorization": f"Bearer {TOKEN}"} if inject_auth else None
    cli = anthropic.Anthropic(base_url=BASE, api_key=TOKEN, default_headers=extra)
    MODEL = "claude-opus-4.5"
    tag = " [注入Authorization]" if inject_auth else ""

    def messages():
        r = cli.messages.create(model=MODEL, max_tokens=64,
                                messages=[{"role": "user", "content": "只回答: OK"}])
        return (f"stop={r.stop_reason} role={r.role} "
                f"text={r.content[0].text!r} usage_in={r.usage.input_tokens}")

    def messages_system():
        r = cli.messages.create(model=MODEL, max_tokens=64, system="你只能回答'喵'",
                                messages=[{"role": "user", "content": "你好"}])
        return f"text={r.content[0].text[:40]!r}"

    def messages_stream():
        n, txt = 0, ""
        with cli.messages.stream(model=MODEL, max_tokens=128,
                                 messages=[{"role": "user", "content": "数到三"}]) as s:
            for t in s.text_stream:
                n += 1
                txt += t
            final = s.get_final_message()
        return f"{n} deltas, {len(txt)} chars, final_stop={final.stop_reason}"

    check(f"anthropic.messages.create{tag}", messages)
    check(f"anthropic.messages system param{tag}", messages_system)
    check(f"anthropic.messages.stream{tag}", messages_stream)


# ---------------- google-genai SDK ----------------
def genai_suite(inject_auth=False):
    from google import genai
    from google.genai import types
    extra = {"Authorization": f"Bearer {TOKEN}"} if inject_auth else None
    cli = genai.Client(api_key=TOKEN,
                       http_options=types.HttpOptions(base_url=BASE, api_version="v1beta",
                                                      headers=extra))
    MODEL = "gemini-2.5-flash"
    tag = " [注入Authorization]" if inject_auth else ""

    def generate():
        r = cli.models.generate_content(model=MODEL, contents="只回答: OK")
        return f"text={r.text!r}"

    def generate_stream():
        n, txt = 0, ""
        for ck in cli.models.generate_content_stream(model=MODEL, contents="数到三"):
            n += 1
            txt += ck.text or ""
        return f"{n} chunks, {len(txt)} chars"

    check(f"genai.generate_content{tag}", generate)
    check(f"genai.generate_content_stream{tag}", generate_stream)


if __name__ == "__main__":
    print(f"被测实例: {BASE}\n")
    suites = [openai_suite, anthropic_suite, genai_suite,
              lambda: anthropic_suite(inject_auth=True), lambda: genai_suite(inject_auth=True)]
    for suite in suites:
        try:
            suite()
        except Exception as e:  # noqa: BLE001
            RESULTS.append((getattr(suite, "__name__", "suite"), "SUITE-ERROR", 0,
                            f"{type(e).__name__}: {e}"[:200]))
        time.sleep(2)

    print(f"{'用例':<48} {'结果':<6} {'秒':>6}  详情")
    print("-" * 130)
    for name, status, sec, detail in RESULTS:
        print(f"{name:<48} {status:<6} {sec:>6}  {detail}")
    npass = sum(1 for r in RESULTS if r[1] == "PASS")
    print(f"\nPASS {npass}/{len(RESULTS)}")
