"""smoke 级测试: 零上游成本的结构与契约校验 (主页 / 模型清单 / CORS / 404)。"""
import pytest

from config import REPRESENTATIVE_MODELS

pytestmark = pytest.mark.smoke

EXPECTED_ITEM_KEYS = {"id", "object", "created", "owned_by", "permission", "root", "parent"}


def test_homepage_ok(client):
    r = client.get("/", auth=False)
    assert r.status_code == 200


def test_models_list_contract(client):
    r = client.get("/v1/models", auth=False)
    assert r.status_code == 200
    data = r.json()
    assert data.get("object") == "list"
    items = data.get("data")
    assert isinstance(items, list) and len(items) >= 10

    for m in items:
        missing = EXPECTED_ITEM_KEYS - set(m.keys())
        assert not missing, f"模型 {m.get('id')} 缺字段: {missing}"
        assert m["object"] == "model"

    ids = {m["id"] for m in items}
    present = [m for m in REPRESENTATIVE_MODELS if m in ids]
    assert present, f"代表模型均不在线: {REPRESENTATIVE_MODELS}"


def test_cors_preflight(client):
    r = client.options("/v1/chat/completions")
    assert r.status_code in (200, 204)
    assert r.headers.get("access-control-allow-origin") == "*"
    methods = r.headers.get("access-control-allow-methods", "")
    assert "POST" in methods and "GET" in methods


def test_unknown_route_404(client):
    r = client.get("/__no_such_route__", auth=False)
    assert r.status_code == 404
