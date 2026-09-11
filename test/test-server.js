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
        assert(res0.status === 200 && res0.data.ready === true && res0.data.version === '1.5.1', '测试 0: 服务端状态探针正常响应且版本为 1.5.1');

        const testChar = '我的仙侠传奇';
        const testPayload1 = {
            name: '青云道长',
            mes: '　　山风拂面，竹林沙沙作响。老道手抚长须，微微一笑道：“徒儿，今日便传你本门至高心法。”',
            is_user: false,
            characterName: testChar,
            chapterNumber: 1,
            chapterStyle: 'numbered_floor',
            floor: 1
        };

        // 测试 1: 首次创建小说文件，默认生成带原始楼层排版格式与 UTF-8 BOM 与《书名》扉页
        const res1 = await router.dispatch('POST', '/append', testPayload1);
        assert(res1.status === 200 && res1.data.success === true, '测试 1: 成功连载第一节');

        const filePath1 = path.join(logsDir, `${testChar}.txt`);
        assert(fs.existsSync(filePath1), '测试 1.1: 确认小说文件已生成');
        const content1 = fs.readFileSync(filePath1, 'utf8');
        assert(content1.startsWith('\uFEFF《我的仙侠传奇》'), '测试 1.2: 小说文件首部正确写入 UTF-8 BOM 与《书名》扉页');
        assert(content1.includes('第 1 章 · 青云道长 (原楼层: 1)') && content1.includes('山风拂面'), '测试 1.3: 默认排版格式正确显示“第 1 章 · 角色名 (原楼层: 1)”');

        // 测试 2: 精准防重检测（相同内容直接跳过）
        const res2 = await router.dispatch('POST', '/append', testPayload1);
        assert(res2.status === 200 && res2.data.skipped === true, '测试 2: 完全相同内容成功防重跳过');

        // 测试 2.1: 消除误杀测试（即使新章节开头与前文有相同语句，只要是新内容绝不能被误判跳过），同时验证原楼层跳号 (原楼层: 3)
        const testPayload2 = {
            name: '青云道长',
            mes: '　　山风拂面，竹林沙沙作响。但这一次，远方却传来了惊雷般的兽吼！',
            is_user: false,
            characterName: testChar,
            chapterNumber: 2,
            chapterStyle: 'numbered_floor',
            floor: 3
        };
        const res2_1 = await router.dispatch('POST', '/append', testPayload2);
        assert(res2_1.status === 200 && res2_1.data.skipped === false, '测试 2.1: 前置同名短句的新章节正常写入，未被误判跳过');
        const content2 = fs.readFileSync(filePath1, 'utf8');
        assert(content2.includes('第 2 章 · 青云道长 (原楼层: 3)'), '测试 2.2: 成功显示跳过用户楼层后的“原楼层: 3”标记');

        // 测试 3: 重新生成 / Swipe 分支智能替换测试 (is_regenerate = true)
        const testPayloadRegen = {
            name: '青云道长',
            mes: '　　山风拂面，竹林沙沙作响。重新生成的分支：天边划过一道金色剑芒！',
            is_user: false,
            characterName: testChar,
            chapterNumber: 2,
            chapterStyle: 'numbered_floor',
            floor: 3,
            is_regenerate: true
        };
        const res3 = await router.dispatch('POST', '/append', testPayloadRegen);
        assert(res3.status === 200 && res3.data.is_regenerate === true, '测试 3: 成功执行重新生成替换');
        const contentRegen = fs.readFileSync(filePath1, 'utf8');
        assert(contentRegen.includes('金色剑芒') && !contentRegen.includes('兽吼'), '测试 3.1: 最后一节成功被新分支替换，旧分支无残留');
        assert(contentRegen.includes('第 2 章 · 青云道长 (原楼层: 3)'), '测试 3.2: 替换后章节头保留原始楼层标记');

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

        // 测试 5: 全量历史小说同步 (/sync-all) 自动补全 UTF-8 BOM
        const syncPayload = {
            characterName: '全书同步测试',
            fullText: '《全书同步测试》\n\n第 1 节 · 序章\n\n　　这是第一章。\n\n\n第 2 节 · 终章\n\n　　这是第二章。\n\n\n',
            save_dir: ''
        };
        const res5 = await router.dispatch('POST', '/sync-all', syncPayload);
        assert(res5.status === 200 && res5.data.success === true, '测试 5: 成功执行全量历史同步');
        const syncFilePath = path.join(logsDir, '全书同步测试.txt');
        assert(fs.existsSync(syncFilePath), '测试 5.1: 确认同步生成的全本小说存在');
        const syncContent = fs.readFileSync(syncFilePath, 'utf8');
        assert(syncContent.startsWith('\uFEFF'), '测试 5.2: 全本同步自动补全 UTF-8 BOM 杜绝乱码');
        assert(syncContent.includes('第 1 节 · 序章') && syncContent.includes('第 2 节 · 终章'), '测试 5.3: 全本章节内容完整准确');
        if (fs.existsSync(syncFilePath)) fs.unlinkSync(syncFilePath);

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
