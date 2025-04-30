
import requests
import json
import time

# Deno Deploy API 地址
BASE_URL = "https://deno-sider2api.spdt.work"
AUTH_TOKEN = "sk-deno-free-key-123456"

# 模型列表
MODELS = [
    "gpt-4o", 
    "claude-3.5-sonnet", 
    "claude-3.7-sonnet", 
    "deepseek-reasoner", 
    "o3-mini", 
    "o1", 
    "llama-3.1-405b", 
    "gemini-2.0-pro",
    "gemini-2.5-pro"
]

def test_models_list():
    """测试模型列表获取"""
    print("\n===== 测试模型列表获取 =====")
    url = f"{BASE_URL}/v1/models"
    
    response = requests.get(
        url, 
        headers={
            "Authorization": f"Bearer {AUTH_TOKEN}",
            "Content-Type": "application/json"
        }
    )
    
    print(f"响应状态码: {response.status_code}")
    
    try:
        models_data = response.json()
        print("模型列表:")
        for model in models_data.get('data', []):
            print(f"- {model['id']}")
    except json.JSONDecodeError:
        print("响应解析失败")
        print(response.text)

def test_chat_completion(model, message="介绍一下你自己"):
    """测试单个模型的对话接口"""
    print(f"\n===== 测试模型: {model} =====")
    url = f"{BASE_URL}/v1/chat/completions"
    
    payload = {
        "messages": [
            {"role": "user", "content": message}
        ],
        "model": model,
        "stream": False,
        "temperature": 0.7
    }
    
    try:
        response = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {AUTH_TOKEN}",
                "Content-Type": "application/json"
            },
            json=payload,
            timeout=30
        )
        
        print(f"响应状态码: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print(f"模型: {result.get('model')}")
            print(f"响应长度: {len(result['choices'][0]['message']['content'])} 字符")
            print("响应预览:")
            print(result['choices'][0]['message']['content'][:200] + "...")
        else:
            print("请求失败")
            print(response.text)
        
        return response.status_code == 200
    
    except requests.exceptions.RequestException as e:
        print(f"请求发生错误: {e}")
        return False

def run_comprehensive_test():
    """运行全面的模型测试"""
    print("🚀 Sider API 模型全面测试")
    
    # 测试模型列表获取
    test_models_list()
    
    # 测试结果追踪
    test_results = {}
    
    # 依次测试每个模型
    for model in MODELS:
        success = test_chat_completion(model)
        test_results[model] = success
        
        # 模型间添加延迟，避免可能的频率限制
        time.sleep(2)
    
    # 生成测试报告
    print("\n🏁 测试报告:")
    for model, result in test_results.items():
        status = "✅ 成功" if result else "❌ 失败"
        print(f"{model}: {status}")

if __name__ == "__main__":
    run_comprehensive_test()
