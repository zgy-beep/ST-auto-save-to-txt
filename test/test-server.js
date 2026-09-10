/**
 * 自动归档服务端插件自动化模拟测试脚本
 * 运行方式: node test/test-server.js
 */

const fs = require('fs');
const path = require('path');
const plugin = require('../plugins/auto-save/index.js');

// 构造简易 Mock Express Router
class MockRouter {
    constructor() {
        this.routes = {};
    }
    post(path, handler) {
        this.routes[`POST ${path}`] = handler;
    }
    async dispatch(method, url, body) {
        const handler = this.routes[`${method} ${url}`];
        if (!handler) {
            throw new Error(`404 Not Found: ${method} ${url}`);
        }

        let statusCode = 200;
        let responseData = null;

        const req = { body };
        const res = {
            status: function (code) {
                statusCode = code;
                return this;
            },
            json: function (data) {
                responseData = data;
                return this;
            }
        };

        await handler(req, res);
        return { status: statusCode, data: responseData };
    }
}

async function runTests() {
    console.log('=== 开始执行 auto-save 服务端插件自动化单元测试 ===\n');
    let passCount = 0;
    let failCount = 0;

    const router = new MockRouter();
    await plugin.init(router);

    const logsDir = path.join(__dirname, '../plugins/auto-save/logs');

    // 辅助断言函数
    function assert(condition, testName) {
        if (condition) {
            console.log(`[PASS] ${testName}`);
            passCount++;
        } else {
            console.error(`[FAIL] ${testName}`);
            failCount++;
        }
    }

    try {
        // 测试 1: 正常消息写入测试
        const testChar = 'TestBot';
        const testPayload1 = {
            name: 'TestBot',
            mes: '你好！这是一条自动化测试消息。很高兴为你服务。',
            is_user: false,
            characterName: testChar,
            timestamp: '2026-09-10 14:00:00'
        };

        const res1 = await router.dispatch('POST', '/append', testPayload1);
        assert(res1.status === 200 && res1.data.success === true && res1.data.skipped === false, '测试 1: 正常写入消息成功');

        const filePath1 = path.join(logsDir, `${testChar}.txt`);
        assert(fs.existsSync(filePath1), '测试 1.1: 确认文件已生成在 logs 目录');
        const content1 = fs.readFileSync(filePath1, 'utf8');
        assert(content1.includes('[2026-09-10 14:00:00] TestBot:') && content1.includes('你好！这是一条自动化测试消息。'), '测试 1.2: 文件内容与格式验证无误');

        // 测试 2: Swipe / 重新生成导致相同内容提交 -> 幂等防重拦截
        const res2 = await router.dispatch('POST', '/append', testPayload1);
        assert(res2.status === 200 && res2.data.skipped === true, '测试 2: 重复提交同一时间戳与正文成功被防重机制跳过');

        // 测试 3: 超大消息 (超过 100KB) 拦截
        const largeText = 'A'.repeat(105 * 1024);
        const testPayloadLarge = {
            name: 'TestBot',
            mes: largeText,
            is_user: false,
            characterName: testChar,
            timestamp: '2026-09-10 14:01:00'
        };
        const res3 = await router.dispatch('POST', '/append', testPayloadLarge);
        assert(res3.status === 413, '测试 3: 超过 100KB 大小限制被正确拦截 (413 Payload Too Large)');

        // 测试 4: 路径穿越攻击与特殊字符防御
        const maliciousChar = '../../hacker/evil:*?"<>|test';
        const testPayloadMalicious = {
            name: 'Hacker',
            mes: '尝试路径穿越测试',
            is_user: true,
            characterName: maliciousChar,
            timestamp: '2026-09-10 14:02:00'
        };
        const res4 = await router.dispatch('POST', '/append', testPayloadMalicious);
        assert(res4.status === 200 && res4.data.success === true, '测试 4: 特殊角色名请求成功处理');

        // 检查文件名是否被清洗
        const sanitizedFiles = fs.readdirSync(logsDir).filter(f => f.includes('hacker'));
        assert(sanitizedFiles.length > 0 && !sanitizedFiles[0].includes('..') && !sanitizedFiles[0].includes('*'), '测试 4.1: 特殊字符已被安全替换为合法字符，无路径穿越漏洞');

        // 测试 5: 缺少必填字段校验
        const res5 = await router.dispatch('POST', '/append', { name: 'OnlyName' });
        assert(res5.status === 400, '测试 5: 缺少正文内容时返回 400 Bad Request');

        // 清理测试生成的文件
        console.log('\n--- 正在清理测试产生的临时文件 ---');
        if (fs.existsSync(filePath1)) fs.unlinkSync(filePath1);
        for (const file of sanitizedFiles) {
            const fullPath = path.join(logsDir, file);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
        console.log('临时测试文件清理完成。');

    } catch (err) {
        console.error('测试运行异常:', err);
        failCount++;
    } finally {
        await plugin.exit();
    }

    console.log(`\n=== 测试总结: 通过: ${passCount}, 失败: ${failCount} ===`);
    if (failCount > 0) {
        process.exit(1);
    }
}

runTests();
