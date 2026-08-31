"""错误处理与鉴权契约测试。

缺参 400 / 缺失或错误 token 401 在上游调用之前被拦截, 属零额度 (smoke);
未知模型回退与并发图像生成会消耗上游额度 (cost)。
"""
import pytest

from config import SINGLE_MODEL
from helpers import extract_content


@pytest.mark.smoke
def test_images_missing_prompt_400(client):
    r = client.image_raw({"n": 1, "size": "1024x1024"})
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["type"] == "invalid_request_error"
    assert err.get("param") == "prompt"


@pytest.mark.smoke
def test_chat_missing_token_401(client):
    r = client.chat("sider", [{"role": "user", "content": "hi"}], auth=False)
    assert r.status_code == 401
    assert r.json()["error"]["type"] == "invalid_request_error"


@pytest.mark.smoke
def test_chat_wrong_token_401(client):
    r = client.chat("sider", [{"role": "user", "content": "hi"}], auth="totally-wrong-token")
    assert r.status_code == 401
    assert r.json()["error"]["type"] == "invalid_request_error"


@pytest.mark.cost
def test_unknown_model_fallback(client):
    """未知模型应回退到 sider 智能路由, 返回 200 而非崩溃。"""
    r = client.chat("no-such-model-xyz-123", [{"role": "user", "content": "说『收到』两个字"}], stream=False)
    assert r.status_code == 200, r.text[:200]
    assert extract_content(r.json())


@pytest.mark.cost
@pytest.mark.image
def test_concurrent_image_has_no_process_global_lock(client, request):
    """并发图像生成不应被进程内互斥锁拒绝。默认跳过, 用 --run-concurrent 开启。"""
    if not request.config.getoption("run_concurrent"):
        pytest.skip("默认跳过; 用 --run-concurrent 启用")
    import threading

    results = []

    def fire():
        try:
            resp = client.image("a red apple", n=1, size="512x512")
            results.append((resp.status_code, resp.text[:300]))
        except Exception as e:  # noqa: BLE001
            results.append(("exception", repr(e)))

    threads = [threading.Thread(target=fire) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not any("concurrent_request_rejected" in str(item) for item in results), \
        f"不应出现进程内并发锁拒绝: {results}"
