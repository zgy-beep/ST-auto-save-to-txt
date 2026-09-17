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
        assert(res0.status === 200 && res0.data.ready === true && res0.data.version === '1.10.0', '测试 0: 服务端状态探针正常响应且版本为 1.10.0');

        const testChar = '我的仙侠传奇';
        const testPayload1 = {
            name: '青云道长',
            mes: '　　山风拂面，竹林沙沙作响。老道手抚长须，微微一笑道：“徒儿，今日便传你本门至高心法。”好的。',
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

        // 测试 2.3: 短文本同尾防误判测试（第 3 章回复仅为简短“好的。”，即使第 1 章也包含“好的。”，也绝不能被误杀）
        const testPayloadShort = {
            name: '青云道长',
            mes: '好的。',
            is_user: false,
            characterName: testChar,
            chapterNumber: 3,
            chapterStyle: 'numbered_floor',
            floor: 4
        };
        const res2_3 = await router.dispatch('POST', '/append', testPayloadShort);
        assert(res2_3.status === 200 && res2_3.data.skipped === false, '测试 2.3: 短回复新章节精准识别，未因历史尾部片段被误杀');

        // 测试 3: 重新生成 / Swipe 分支智能替换测试 (包含正文内部的 【系统提示】 与 * * *，验证绝不误伤正文)
        const testPayloadRegen = {
            name: '青云道长',
            mes: '　　正文开篇。\n\n* * *\n\n【系统提示：突破金丹期】\n\n重新生成的新分支：天边划过一道金色剑芒！',
            is_user: false,
            characterName: testChar,
            chapterNumber: 3,
            chapterStyle: 'numbered_floor',
            floor: 4,
            is_regenerate: true
        };
        const res3 = await router.dispatch('POST', '/append', testPayloadRegen);
        assert(res3.status === 200 && res3.data.is_regenerate === true, '测试 3: 成功执行重新生成替换');
        const contentRegen = fs.readFileSync(filePath1, 'utf8');
        assert(contentRegen.includes('金色剑芒') && !contentRegen.includes('第 3 章 · 青云道长 (原楼层: 4)\n\n好的。'), '测试 3.1: 最后一节成功被新分支替换，旧分支无残留');
        assert(contentRegen.includes('【系统提示：突破金丹期】'), '测试 3.2: 正文内部包含【系统提示】与分隔符未被截断误判');

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

        // 测试 6: 第一章直接重新生成（Swipe 分支），验证首部 UTF-8 BOM 与《书名》扉页完好保留
        const swipeChar = '第一章重生成测试';
        const swipeFile = path.join(logsDir, `${swipeChar}.txt`);
        await router.dispatch('POST', '/append', {
            name: '艾莉丝',
            mes: '第一版开篇内容。',
            is_user: false,
            characterName: swipeChar,
            chapterNumber: 1,
            chapterStyle: 'numbered_floor',
            floor: 1,
            is_regenerate: false
        });
        const resSwipe = await router.dispatch('POST', '/append', {
            name: '艾莉丝',
            mes: '第二版重新生成的开篇新内容！',
            is_user: false,
            characterName: swipeChar,
            chapterNumber: 1,
            chapterStyle: 'numbered_floor',
            floor: 1,
            is_regenerate: true
        });
        assert(resSwipe.status === 200 && resSwipe.data.is_regenerate === true, '测试 6: 第一章重新生成请求成功');
        const contentSwipe = fs.readFileSync(swipeFile, 'utf8');
        assert(contentSwipe.startsWith('\uFEFF《第一章重生成测试》'), '测试 6.1: 第一章重新生成后首部 UTF-8 BOM 与《书名》扉页完好保留');
        assert(contentSwipe.includes('第二版重新生成的开篇新内容！') && !contentSwipe.includes('第一版开篇内容。'), '测试 6.2: 旧第一版内容被完全替换');
        if (fs.existsSync(swipeFile)) fs.unlinkSync(swipeFile);

        // 测试 7: Windows 保留设备名作为角色名 (CON, AUX, PRN) 防御
        const reservedChar = 'aux';
        const resReserved = await router.dispatch('POST', '/append', {
            name: '助手',
            mes: '这是辅助角色的对白。',
            is_user: false,
            characterName: reservedChar,
            chapterNumber: 1,
            chapterStyle: 'numbered_floor',
            floor: 1
        });
        assert(resReserved.status === 200 && resReserved.data.success === true, '测试 7: Windows 保留设备名成功写入');
        const expectedReservedFile = path.join(logsDir, 'aux_novel.txt');
        assert(fs.existsSync(expectedReservedFile), '测试 7.1: 保留名自动附加 _novel 后缀安全防护');
        if (fs.existsSync(expectedReservedFile)) fs.unlinkSync(expectedReservedFile);

        // 测试 8: 空内容与非法入参拦截 (HTTP 400)
        const resEmpty = await router.dispatch('POST', '/append', { name: '测试', mes: '', characterName: '空测试' });
        assert(resEmpty.status === 400, '测试 8: 空正文请求被严格拦截 (HTTP 400)');

        // 测试 9: 超出 100KB 篇幅限制拦截 (HTTP 413)
        const hugeText = '超大篇幅测试'.repeat(20000);
        const resHuge = await router.dispatch('POST', '/append', { name: '测试', mes: hugeText, characterName: '超大测试' });
        assert(resHuge.status === 413, '测试 9: 超出 100KB 限制被安全拦截 (HTTP 413)');

        // 测试 10: 问候语补写（is_greeting）：全新文件作为第 1 章写入；已有内容的文件自动跳过（旧书绝不重复）
        const greetChar = '问候语补写测试';
        const greetFile = path.join(logsDir, `${greetChar}.txt`);
        const resG1 = await router.dispatch('POST', '/append', {
            name: '艾莉丝', mes: '　　夜色如墨，故事从这里开始。', is_user: false,
            characterName: greetChar, chapterNumber: 1, chapterStyle: 'numbered_floor', floor: 1, is_greeting: true
        });
        assert(resG1.status === 200 && resG1.data.success === true && resG1.data.skipped !== true, '测试 10.1: 问候语成功写入全新文件（第 1 章）');
        const resG2 = await router.dispatch('POST', '/append', {
            name: '艾莉丝', mes: '　　第二段剧情。', is_user: false,
            characterName: greetChar, chapterNumber: 2, chapterStyle: 'numbered_floor', floor: 3
        });
        assert(resG2.status === 200 && resG2.data.success === true, '测试 10.2: 问候语之后的章节正常续写（第 2 章）');
        const resG3 = await router.dispatch('POST', '/append', {
            name: '艾莉丝', mes: '　　夜色如墨，故事从这里开始。', is_user: false,
            characterName: greetChar, chapterNumber: 1, chapterStyle: 'numbered_floor', floor: 1, is_greeting: true
        });
        assert(resG3.status === 200 && resG3.data.skipped === true, '测试 10.3: 已有内容的文件补写问候语被自动跳过（旧书绝不重复）');
        const greetContent = fs.readFileSync(greetFile, 'utf8');
        assert(greetContent.includes('第 1 章 · 艾莉丝 (原楼层: 1)') && greetContent.includes('第 2 章 · 艾莉丝 (原楼层: 3)'), '测试 10.4: 问候语第 1 章与后续章节编号完整正确');
        if (fs.existsSync(greetFile)) fs.unlinkSync(greetFile);

        // 测试 11: 聊天 ID 锚定 —— 聊天改名自动跟随重命名（多账号 file_name 优先解析）
        const registryPath = path.join(__dirname, '../plugins/auto-save/.novel-registry.json');
        const registryExisted = fs.existsSync(registryPath);
        const registryBackup = registryExisted ? fs.readFileSync(registryPath, 'utf8') : null;

        // a. 首次带锚点写入：登记 registry，产生书名文件
        const anchorA = 'test-anchor-rename-A';
        const resA1 = await router.dispatch('POST', '/append', {
            name: '旁白', mes: '　　锚定第一章内容。', is_user: false,
            characterName: '锚定测试一', chapterNumber: 1, chapterStyle: 'numbered_floor', floor: 1,
            chat_anchor: anchorA
        });
        assert(resA1.status === 200 && resA1.data.success === true && !resA1.data.renamed_from, '测试 11.1: 带 chat_anchor 首次写入成功并登记锚点');
        const anchorFile1 = path.join(logsDir, '锚定测试一.txt');
        assert(fs.existsSync(anchorFile1), '测试 11.2: 首次写入产生 锚定测试一.txt');

        // b. 同锚点书名变化（模拟聊天改名）→ 自动重命名：旧文件消失、新文件存在、首行书同步为新书名、内容完整迁移
        const resA2 = await router.dispatch('POST', '/append', {
            name: '旁白', mes: '　　锚定第二章内容。', is_user: false,
            characterName: '锚定测试二', chapterNumber: 2, chapterStyle: 'numbered_floor', floor: 3,
            chat_anchor: anchorA
        });
        assert(resA2.status === 200 && resA2.data.success === true && !!resA2.data.renamed_from, '测试 11.3: 聊天改名后响应含 renamed_from');
        assert(!fs.existsSync(anchorFile1), '测试 11.4: 重命名后旧文件 锚定测试一.txt 已消失');
        const anchorFile2 = path.join(logsDir, '锚定测试二.txt');
        assert(fs.existsSync(anchorFile2), '测试 11.5: 重命名后新文件 锚定测试二.txt 存在');
        const anchorContent2 = fs.readFileSync(anchorFile2, 'utf8');
        assert(anchorContent2.startsWith('\uFEFF《锚定测试二》'), '测试 11.6: 首行书已同步为新书名《锚定测试二》');
        assert(anchorContent2.includes('锚定第一章内容') && anchorContent2.includes('锚定第二章内容'), '测试 11.7: 新旧章节内容完整迁移至新文件');

        // c. 撞名保底：另一锚点先占旧名，再改为与 A 相同的书名 → kept_name 继续写自己的原文件，绝不覆盖 A 的小说
        const anchorB = 'test-anchor-rename-B';
        const resB1 = await router.dispatch('POST', '/append', {
            name: '旁白', mes: '　　B 的原名第一章。', is_user: false,
            characterName: '锚定测试B', chapterNumber: 1, chapterStyle: 'numbered_floor', floor: 1,
            chat_anchor: anchorB
        });
        assert(resB1.status === 200 && resB1.data.success === true, '测试 11.8: 撞名场景前置写入（锚定测试B.txt）成功');
        const anchorFileB = path.join(logsDir, '锚定测试B.txt');
        const resB2 = await router.dispatch('POST', '/append', {
            name: '旁白', mes: '　　B 改名后的章节。', is_user: false,
            characterName: '锚定测试二', chapterNumber: 2, chapterStyle: 'numbered_floor', floor: 3,
            chat_anchor: anchorB
        });
        assert(resB2.status === 200 && resB2.data.success === true && resB2.data.kept_name === true, '测试 11.9: 期望文件名被 A 占用时响应 kept_name');
        assert(fs.existsSync(anchorFileB), '测试 11.10: 撞名后 B 仍写入自己的原文件');
        const anchorContentB = fs.readFileSync(anchorFileB, 'utf8');
        assert(anchorContentB.includes('B 的原名第一章') && anchorContentB.includes('B 改名后的章节'), '测试 11.11: B 的全部章节均在原文件内，A 的小说未被污染');

        // d. file_name 参数：前端算好的含账号前缀文件名优先（经服务端 sanitize 兜底）
        const resD1 = await router.dispatch('POST', '/append', {
            name: '旁白', mes: '　　多账号前缀章节。', is_user: false,
            characterName: '多账号前缀测试', chapterNumber: 1, chapterStyle: 'numbered_floor', floor: 1,
            file_name: '[小明]故事.txt'
        });
        assert(resD1.status === 200 && resD1.data.success === true, '测试 11.12: 带 file_name 写入成功');
        const prefixedFile = path.join(logsDir, '[小明]故事.txt');
        assert(fs.existsSync(prefixedFile), '测试 11.13: 磁盘产生含账号前缀的文件名 [小明]故事.txt');
        const prefixedContent = fs.readFileSync(prefixedFile, 'utf8');
        assert(prefixedContent.startsWith('\uFEFF《多账号前缀测试》'), '测试 11.14: 扉页书名为纯净标题（不含账号前缀与扩展名）');

        // 清理测试 11 产物与注册表现场
        if (fs.existsSync(anchorFile2)) fs.unlinkSync(anchorFile2);
        if (fs.existsSync(anchorFileB)) fs.unlinkSync(anchorFileB);
        if (fs.existsSync(prefixedFile)) fs.unlinkSync(prefixedFile);
        if (registryExisted) {
            fs.writeFileSync(registryPath, registryBackup);
        } else if (fs.existsSync(registryPath)) {
            fs.unlinkSync(registryPath);
        }

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
