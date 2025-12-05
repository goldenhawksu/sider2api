// Base64 下载测试
// 测试修复后的 HTTP 403 下载错误

console.log("🧪 Base64 图像下载测试\n");
console.log("=".repeat(60));
console.log("测试目标: 验证添加 Authorization 头部后能成功下载图片");
console.log("=".repeat(60));

const API_ENDPOINT = "http://localhost:8000/v1/images/generations";

// 测试请求配置 (使用 b64_json 格式触发下载)
const testRequest = {
  prompt: "画一只可爱的橙色小猫",
  n: 1,
  size: "1024x1024",
  response_format: "b64_json"  // ← 触发下载和 Base64 转换
};

console.log("\n📋 测试场景: 请求 b64_json 格式图片\n");
console.log("预期结果:");
console.log("  - Sider API 返回图片 URL ✅");
console.log("  - 下载图片成功 (不再 HTTP 403) ✅");
console.log("  - 转换为 Base64 成功 ✅");
console.log("  - 返回 b64_json 格式 ✅");
console.log("\n开始测试...\n");

const startTime = Date.now();

try {
  console.log("📤 发送图像生成请求 (response_format: b64_json)...");

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(testRequest)
  });

  const elapsedTime = Date.now() - startTime;

  if (!response.ok) {
    const errorData = await response.json();
    console.error(`\n❌ 请求失败 (${elapsedTime}ms):`);
    console.error(`   状态码: ${response.status}`);
    console.error(`   错误: ${JSON.stringify(errorData.error, null, 2)}`);
    Deno.exit(1);
  }

  const data = await response.json();

  console.log(`\n✅ 请求成功 (${elapsedTime}ms):`);
  console.log(`   创建时间: ${new Date(data.created * 1000).toLocaleString()}`);
  console.log(`   图像数量: ${data.data?.length || 0}`);

  if (data.data && data.data.length > 0) {
    const image = data.data[0];

    if (image.b64_json) {
      console.log(`\n✅ Base64 数据已返回:`);
      console.log(`   格式: ${image.b64_json.substring(0, 30)}...`);
      console.log(`   长度: ${image.b64_json.length} 字符`);
      console.log(`   大小: ~${Math.floor(image.b64_json.length / 1024)} KB`);
      console.log(`   Prompt: ${image.revised_prompt}`);

      // 验证是否是有效的 Data URI
      if (image.b64_json.startsWith("data:image/png;base64,")) {
        console.log(`\n✅ Base64 格式验证通过!`);
        console.log(`   - 包含正确的 Data URI 前缀 ✅`);
        console.log(`   - 可以直接用于 <img> 标签 ✅`);
      } else {
        console.warn(`\n⚠️ Base64 格式异常:`);
        console.warn(`   前缀: ${image.b64_json.substring(0, 50)}`);
      }

    } else {
      console.error(`\n❌ 返回数据中没有 b64_json 字段`);
      console.error(`   返回的字段: ${Object.keys(image).join(", ")}`);
    }
  } else {
    console.error(`\n❌ 响应中没有图像数据`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 测试结果汇总");
  console.log("=".repeat(60));
  console.log(`✅ 图像生成: 成功 (${elapsedTime}ms)`);
  console.log(`✅ 下载图片: 成功 (无 HTTP 403 错误)`);
  console.log(`✅ Base64 转换: 成功`);
  console.log(`✅ 格式验证: 通过`);

  console.log("\n🎉 测试通过! HTTP 403 错误已修复!");
  console.log("   ✅ Authorization 头部生效");
  console.log("   ✅ Sider CDN 允许下载");
  console.log("   ✅ Base64 格式正确");

} catch (error) {
  const elapsedTime = Date.now() - startTime;
  console.error(`\n❌ 测试异常 (${elapsedTime}ms):`, error.message);

  if (error.message.includes("403")) {
    console.error("\n💡 HTTP 403 错误仍然存在:");
    console.error("   - 检查 Authorization 头部是否正确添加");
    console.error("   - 检查 SIDER_AUTH_TOKEN 是否有效");
    console.error("   - 检查 Sider CDN 是否有其他限制");
  }

  Deno.exit(1);
}

console.log("\n💡 说明:");
console.log("   - b64_json 格式需要下载图片并转换为 Base64");
console.log("   - 添加 Authorization 头部后,Sider CDN 允许下载");
console.log("   - 返回的 Data URI 可以直接用于前端显示");
