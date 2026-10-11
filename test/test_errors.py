"""错误处理与鉴权契约测试。

缺参 400 / 缺失或错误 token 401 / 未知模型 404 都在上游调用之前被拦截, 属零额度 (smoke);
并发图像生成会消耗上游额度 (cost)。
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


@pytest.mark.smoke
def test_unknown_model_is_rejected(client):
    """未知模型应显式报错 (404 model_not_found), 不再静默回退到 sider 白烧额度。

    未知模型在入站即被拦截, 不触达上游 —— 因此这是零额度用例。
    """
    r = client.chat("no-such-model-xyz-123", [{"role": "user", "content": "说『收到』两个字"}], stream=False)
    assert r.status_code == 404, r.text[:200]
    err = r.json()["error"]
    assert err["code"] == "model_not_found", err
    assert err["type"] == "invalid_request_error", err


@pytest.mark.cost
def test_explicit_sider_router_still_works(client):
    """显式 "sider" 智能路由不受未知模型拒绝策略影响 (会真实消耗一次上游额度)。"""
    r = client.chat("sider", [{"role": "user", "content": "只回答: OK"}], stream=False)
    assert r.status_code == 200, r.text[:200]


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
