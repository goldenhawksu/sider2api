"""图像生成测试: 专用端点 + 对话内关键词触发。

注:
- 上游返回的是 sider.ai CDN URL (需 CloudFront 签名才能直接打开),
  本测试只校验返回了合法的 http(s) 图片链接, 不校验图片内容可访问性。
- 上游图像生成偶发瞬时失败 (尤其背靠背连发), 故用 retry 重试以稳定回归。
"""
import pytest

from config import SINGLE_MODEL
from helpers import extract_content, retry

pytestmark = [pytest.mark.cost, pytest.mark.image]


def test_image_generations_endpoint(client):
    def call():
        return client.image("a cute orange cat sitting on a wooden table", n=1, size="1024x1024")

    def ok(r):
        return r.status_code == 200 and r.json().get("data") and \
            r.json()["data"][0].get("url", "").startswith("http")

    r = retry(call, ok)
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert data.get("data"), f"无 data 数组: {data}"
    url = data["data"][0].get("url", "")
    assert url.startswith("http"), f"返回的不是 URL: {url!r}"


def test_chat_triggered_image(client):
    """对话里用绘图关键词应触发图像生成, 响应内容应含图片链接。"""
    def call():
        return client.chat(SINGLE_MODEL, [{"role": "user", "content": "请画一只可爱的橘猫"}], stream=False)

    def ok(r):
        return r.status_code == 200 and "http" in extract_content(r.json())

    r = retry(call, ok)
    assert r.status_code == 200, r.text[:300]
    content = extract_content(r.json())
    assert "http" in content, f"对话触发图像未返回链接: {content[:200]!r}"
