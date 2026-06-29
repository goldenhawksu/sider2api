"""上游 Vision (视觉输入) 能力深度探针 (probe-first).

探测结论 (2026-06-29):
  上游 sider **不支持视觉输入**。multi_content type 只接受 [text, file];
  image/image_url 块报 code:1000; file 块需 FileID (须先上传); base64 不被处理;
  text 块挂 images 属性虽不报错, 但经决定性判别 (读图中文字 BANANA42/Hello7777)
  确认模型完全读不出, 仅在视觉提问下幻觉作答 => 非真视觉。

  铁律判定: 不 fake。deno_pro 收到图像输入应返回标准 not_supported。

关键教训: "什么动物"类问题模型会高频幻觉(猫/狗等), 不能作为视觉判据;
         必须用"读出图中特定文字/数字"做决定性判别。

低频直连 (--min-interval 8)。
用法: python test/probe_vision.py --min-interval 8
"""
import argparse
import base64
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import requests

from upstream_client import UpstreamClient, load_token

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

# 稳定的测试图: 一只明显的橘猫 (维基百科)
IMG_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/240px-Cat03.jpg"
Q_TEXT = "这张图里是什么动物? 只回答动物名称。"


def _fetch_base64(url):
    """下载图片转 base64 data URI (用于内联候选)。"""
    try:
        r = requests.get(url, timeout=20)
        r.raise_for_status()
        b64 = base64.b64encode(r.content).decode()
        return f"data:image/jpeg;base64,{b64}", len(b64)
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] 下载图片失败: {e}")
        return None, 0


def _understood(res):
    t = res.text.lower()
    return ("猫" in res.text) or ("cat" in t) or ("kitten" in t) or ("feline" in t)


def _run(client, label, multi_content=None, overrides=None):
    res = client.send(multi_content=multi_content, overrides=overrides,
                      model="sider", max_seconds=60)
    hit = _understood(res)
    print(f"\n{'='*60}")
    print(f">>> {label}")
    print(f"    http={res.http_status} ok={res.ok} error_code={res.error_code}")
    if res.error_msg:
        print(f"    error_msg={res.error_msg[:200]}")
    print(f"    understood={hit}")
    print(f"    text[:120]={res.text[:120]!r}")
    return {"label": label, "ok": res.ok, "error_code": res.error_code,
            "understood": hit, "text": res.text[:200]}


def main():
    ap = argparse.ArgumentParser(description="上游 Vision 深度探针")
    ap.add_argument("--min-interval", type=float, default=8.0)
    args = ap.parse_args()

    token = load_token()
    if not token:
        print("[FATAL] 未找到 SIDER_AUTH_TOKEN")
        sys.exit(2)
    print(f"[OK] token loaded; min_interval={args.min_interval}s")

    client = UpstreamClient(token, timeout=60, min_interval=args.min_interval)

    data_uri, b64len = _fetch_base64(IMG_URL)
    print(f"[OK] base64 图片就绪 (len={b64len})")

    results = []

    # 对照: 纯文本描述 (不传图, 模型应说无法看图)
    results.append(_run(client, "对照0: 纯文本无图",
        multi_content=[{"type": "text", "text": Q_TEXT, "user_input_text": Q_TEXT}]))

    # 候选1: multi_content image + url
    results.append(_run(client, "候选1: type=image, image.url",
        multi_content=[{"type": "image", "image": {"url": IMG_URL}},
                       {"type": "text", "text": Q_TEXT, "user_input_text": Q_TEXT}]))

    # 候选2: multi_content image_url + url (OpenAI 风格)
    results.append(_run(client, "候选2: type=image_url, image_url.url",
        multi_content=[{"type": "image_url", "image_url": {"url": IMG_URL}},
                       {"type": "text", "text": Q_TEXT, "user_input_text": Q_TEXT}]))

    # 候选3: multi_content file 结构 (上游响应用 file 表示图像, 输入可能对称)
    results.append(_run(client, "候选3: type=file, file.url+type=image",
        multi_content=[{"type": "file", "file": {"type": "image", "url": IMG_URL}},
                       {"type": "text", "text": Q_TEXT, "user_input_text": Q_TEXT}]))

    # 候选4: image 块用 base64 data URI
    if data_uri:
        results.append(_run(client, "候选4: type=image, image.url=base64",
            multi_content=[{"type": "image", "image": {"url": data_uri}},
                           {"type": "text", "text": Q_TEXT, "user_input_text": Q_TEXT}]))

    # 候选5: 顶层 images 字段
    results.append(_run(client, "候选5: 顶层 images=[url]",
        multi_content=[{"type": "text", "text": Q_TEXT, "user_input_text": Q_TEXT}],
        overrides={"images": [IMG_URL]}))

    # 候选6: multi_content image_url 直接字符串
    results.append(_run(client, "候选6: type=image_url, image_url=str",
        multi_content=[{"type": "image_url", "image_url": IMG_URL},
                       {"type": "text", "text": Q_TEXT, "user_input_text": Q_TEXT}]))

    # 候选7: text 块带 images 属性 (sider 可能把图挂在 text 块上)
    results.append(_run(client, "候选7: text 块 + images 属性",
        multi_content=[{"type": "text", "text": Q_TEXT, "user_input_text": Q_TEXT,
                        "images": [IMG_URL]}]))

    # 结论
    print(f"\n\n{'#'*60}")
    print("# Vision 能力结论")
    print(f"{'#'*60}")
    understood_any = False
    for r in results:
        flag = "✅理解" if r["understood"] else ("⛔错误" if not r["ok"] else "❓未理解")
        print(f"  [{flag}] {r['label']}: ok={r['ok']} code={r['error_code']}")
        if r["label"].startswith("候选") and r["understood"]:
            understood_any = True

    print(f"\n{'='*60}")
    if understood_any:
        winners = [r["label"] for r in results
                   if r["label"].startswith("候选") and r["understood"]]
        print(f"判定: 上游支持视觉输入! 有效格式: {winners}")
        print("      => deno_pro 可实现 vision: 把 OpenAI image_url 块翻译为上述有效格式。")
    else:
        print("判定: 所有候选格式均未让上游理解图像内容。")
        print("      => 上游大概率不支持视觉输入, deno_pro 应返回 not_supported (不 fake)。")


if __name__ == "__main__":
    main()
