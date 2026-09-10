/**
 * 小说连载服务端插件模拟测试脚本
 * 运行方式: node test/test-server.js
 */

const fs = require('fs');
const path = require('path');
const plugin = require('../plugins/auto-save/index.js');

class MockRouter {
    constructor() {
        this.routes = {};
    }
    post(path, handler) {
        this.routes[`POST ${path}`] = handler;
    }
    get(path, handler) {
        this.routes[`GET ${path}`] = handler;
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
    console.log('=== 开始执行小说连载插件自动化单元测试 ===\n');
    let passCount = 0;
    let failCount = 0;

    const router = new MockRouter();
    await plugin.init(router);

    const logsDir = path.join(__dirname, '../plugins/auto-save/logs');

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
        // 测试 0: 服务端健康状态探针 (/status)
        const res0 = await router.dispatch('GET', '/status', {});
        assert(res0.status === 200 && res0.data.ready === true, '测试 0: 服务端状态探针正常响应');

        const testChar = '我的仙侠传奇';
        const testPayload1 = {
            name: '青云道长',
            mes: '　　山风拂面，竹林沙沙作响。老道手抚长须，微微一笑道：“徒儿，今日便传你本门至高心法。”',
            is_user: false,
            characterName: testChar,
            chapterNumber: 1,
            chapterStyle: 'numbered'
        };

        // 测试 1: 正常生成第一节
        const res1 = await router.dispatch('POST', '/append', testPayload1);
        assert(res1.status === 200 && res1.data.success === true, '测试 1: 成功连载第一节');

        const filePath1 = path.join(logsDir, `${testChar}.txt`);
        assert(fs.existsSync(filePath1), '测试 1.1: 确认小说文件已生成');
        const content1 = fs.readFileSync(filePath1, 'utf8');
        assert(content1.includes('第 1 节 · 青云道长') && content1.includes('山风拂面'), '测试 1.2: 小说章节格式规范正确');

        // 测试 2: 防重检测
        const res2 = await router.dispatch('POST', '/append', testPayload1);
        assert(res2.status === 200 && res2.data.skipped === true, '测试 2: 重复段落成功防重跳过');

        // 测试 3: 连载第二节
        const testPayload2 = {
            name: '青云道长',
            mes: '　　只见道长并指如剑，一道青光冲天而起，直贯云霄。',
            is_user: false,
            characterName: testChar,
            chapterNumber: 2,
            chapterStyle: 'numbered'
        };
        const res3 = await router.dispatch('POST', '/append', testPayload2);
        assert(res3.status === 200 && res3.data.success === true, '测试 3: 成功连载第二节');

        const content2 = fs.readFileSync(filePath1, 'utf8');
        // 测试 4: 自定义保存文件夹路径 (如外部书库/同步盘目录)
        const customDir = path.join(__dirname, '../plugins/auto-save/custom_novels');
        const testPayloadCustom = {
            name: '玄清仙子',
            mes: '　　雪花轻舞，仙子倚剑而立。',
            is_user: false,
            characterName: '极北雪境',
            chapterNumber: 1,
            chapterStyle: 'numbered',
            save_dir: customDir
        };
        const res4 = await router.dispatch('POST', '/append', testPayloadCustom);
        assert(res4.status === 200 && res4.data.success === true, '测试 4: 成功向自定义文件夹连载');
        const customFilePath = path.join(customDir, '极北雪境.txt');
        assert(fs.existsSync(customFilePath), '测试 4.1: 自定义文件夹成功自动创建并保存小说');
        if (fs.existsSync(customFilePath)) fs.unlinkSync(customFilePath);
        if (fs.existsSync(customDir)) fs.rmdirSync(customDir);

        // 清理测试文件
        if (fs.existsSync(filePath1)) fs.unlinkSync(filePath1);
        console.log('\n临时测试小说文件已清理。');
    } catch (err) {
        console.error('测试异常:', err);
        failCount++;
    } finally {
        await plugin.exit();
    }

    console.log(`\n=== 测试结果: 通过: ${passCount}, 失败: ${failCount} ===`);
    if (failCount > 0) process.exit(1);
}

runTests();
