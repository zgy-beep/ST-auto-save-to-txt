/**
 * 本轮修复的契约回归测试（F5）
 *
 * 目的：把 review/审核报告.md 里 D1/D2/D3/D4/D12/D18 的修复**变成可回归的断言**，
 * 这些断言在本轮修复之前必须是红的（已用定点突变实验单独验证过对应行为）。
 *
 * 覆盖：
 *   A. 替换守卫（D1 服务端）：is_regenerate 只能替换**末尾章**，否则 409 not_tail_chapter 且文件零改动
 *   B. 重复追加守卫（D4 服务端）：同号章节已存在 → 409 chapter_exists；同号且为末尾章 → 自动纠正为替换
 *   C. 备份与原子写（D18）：替换 / sync-all 覆盖前生成 .bak，目标目录不留 .tmp-*
 *   D. 问候语入书（D2 前端）：加载**真实 index.js**（test/_helpers/load-index.js），断言补写请求真的发出
 *   E. 转义（D3）：escapeHtml 覆盖五个字符；cleanNovelText 不做实体解码回流
 *   F. 长章节防重（D12）：30KB 量级长章节重复投递必须 skipped
 *   G. 端到端时序（集成盲区）：真实前端 handleMessageSave/ensureGreetingSerialized
 *      **直连真实服务端插件**（同进程 MockRouter，前端 fetch 走它），跑
 *      问候语入书 → AI 首答 → 真 regenerate → 下一轮 的完整时序。
 *      A~F 是分段隔离探针，G 补的正是"段与段之间的接缝"。
 *      其中"任何 is_regenerate 请求都不得指向文件中不存在的章号"是本组最关键的判据 ——
 *      这正是「问候语入书被误判为替换最后一章 → 409 chapter_not_found → AI 首答被丢弃」型回归的指纹。
 *
 * 运行：node test/test-fix-contract.js
 * 落盘：全部写进 os.tmpdir() 下的唯一临时目录，finally 里整目录删除。
 *       绝不写 plugins/auto-save/logs 或 custom_novels。
 *
 * 判别性验证（证明断言不是同义反复）：
 *   AUTOSAVE_PLUGIN_SOURCE=<副本>  node test/test-fix-contract.js   # 服务端契约对着突变副本整跑
 *   AUTOSAVE_INDEX_SOURCE=<副本>   node test/test-fix-contract.js   # 前端契约对着突变副本整跑
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 服务端插件支持源码路径覆盖（判别性验证用）。
const PLUGIN_SOURCE = process.env.AUTOSAVE_PLUGIN_SOURCE
    || path.join(__dirname, '..', 'plugins', 'auto-save', 'index.js');
const plugin = require(PLUGIN_SOURCE);

// 前端加载器必须延迟到 main() 里调用：loadIndexModule 会 new Function(index.js 全文)，
// 若 index.js 语法坏了，在模块顶层调用会让整个进程直接崩在 require 阶段 ——
// 那样测试会打印出"通过 N, 失败 0"却 exit 1，看起来像假绿灯。
// 延迟调用能让加载失败变成一条可读的 [FAIL]，并且不影响 A/B/C 服务端断言的执行。
let loadIndexModule = null;
try {
    ({ loadIndexModule } = require('./_helpers/load-index.js'));
} catch (e) {
    loadIndexModule = () => { throw new Error('test/_helpers/load-index.js 加载失败: ' + e.message); };
}

// ==================== 断言与计数 ====================
let pass = 0;
let fail = 0;
const failList = [];

function ok(cond, name, detail) {
    if (cond) {
        pass++;
        console.log(`[PASS] ${name}`);
    } else {
        fail++;
        failList.push(name);
        console.error(`[FAIL] ${name}`);
        if (detail) console.error(`       → ${detail}`);
    }
}

function eq(actual, expected, name) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, name, `期望 ${e}，实际 ${a}`);
}

// ==================== MockRouter（与 test/test-server.js 同款）====================
class MockRouter {
    constructor() {
        this.routes = {};
    }
    post(p, handler) { this.routes[`POST ${p}`] = handler; }
    get(p, handler) { this.routes[`GET ${p}`] = handler; }
    async dispatch(method, url, body) {
        const handler = this.routes[`${method} ${url}`];
        if (!handler) throw new Error(`404 Not Found: ${method} ${url}`);
        let statusCode = 200;
        let responseData = null;
        const req = { body };
        const res = {
            status(code) { statusCode = code; return this; },
            json(data) { responseData = data; return this; }
        };
        await handler(req, res);
        return { status: statusCode, data: responseData };
    }
}

// ==================== 临时目录：全部落盘写这里 ====================
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'st-novel-fix-contract-'));
let dirSeq = 0;
function freshDir(label) {
    const d = path.join(TMP_ROOT, `${String(++dirSeq).padStart(2, '0')}-${label}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

// ==================== 小工具 ====================
/** 解析文件里的章节标题编号（与插件同源的形态：第 N 章 / 第 N 节 · 标题） */
function chapterNumbers(content) {
    const src = content.startsWith('\uFEFF') ? content.slice(1) : content;
    return [...src.matchAll(/(?:^|\r?\n\r?\n)第\s*(\d+)\s*[章节]\s*·\s*([^\r\n]+)/g)].map((m) => Number(m[1]));
}
/** 文件字节快照，用于"文件零改动"断言 */
function bytesOf(file) {
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
}
function bytesEqual(a, b) {
    if (a === null || b === null) return a === b;
    return Buffer.compare(a, b) === 0;
}
function listTempLeftovers(dir) {
    return fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
}

/** 构造 /append 请求体：save_dir 一律指向临时目录 */
function appendPayload(dir, opts) {
    return Object.assign({
        name: '旁白',
        mes: '　　默认正文。',
        is_user: false,
        characterName: '契约测试',
        chapterNumber: 1,
        chapterStyle: 'numbered_floor',
        save_dir: dir,
        floor: 1
    }, opts);
}

async function main() {
    const router = new MockRouter();
    await plugin.init(router);

    // ==================================================================
    // A. 替换守卫（D1 服务端）
    // ==================================================================
    console.log('\n=== A. 替换守卫（D1）：is_regenerate 只能替换末尾章 ===');

    const dirA = freshDir('A');
    const fileA = path.join(dirA, '契约测试.txt');

    for (const n of [1, 2, 3]) {
        const r = await router.dispatch('POST', '/append', appendPayload(dirA, {
            mes: `　　第${n}章的原始正文。`, chapterNumber: n, floor: n
        }));
        if (r.status !== 200 || !r.data || r.data.success !== true) {
            throw new Error(`A 组前置写入第 ${n} 章失败：HTTP ${r.status} ${JSON.stringify(r.data)}`);
        }
    }
    eq(chapterNumbers(fs.readFileSync(fileA, 'utf8')), [1, 2, 3], 'A0 前置：文件里恰好有第 1/2/3 章');

    // A1：替换非末尾章 → 409 not_tail_chapter，文件逐字节不变
    const beforeA1 = bytesOf(fileA);
    const rA1 = await router.dispatch('POST', '/append', appendPayload(dirA, {
        mes: '　　这是被拒绝的替换正文。', chapterNumber: 1, floor: 1, is_regenerate: true
    }));
    eq(rA1.status, 409, 'A1.1 替换第 1 章（非末尾章）返回 HTTP 409');
    eq(rA1.data && rA1.data.conflict, true, 'A1.2 响应带 conflict: true');
    eq(rA1.data && rA1.data.reason, 'not_tail_chapter', 'A1.3 reason === not_tail_chapter');
    ok(bytesEqual(beforeA1, bytesOf(fileA)), 'A1.4 被拒绝后文件逐字节零改动（本轮最关键断言）',
        `before=${beforeA1 && beforeA1.length}B after=${(bytesOf(fileA) || { length: -1 }).length}B`);
    ok(!fs.readFileSync(fileA, 'utf8').includes('这是被拒绝的替换正文'), 'A1.5 被拒绝的正文没有落进文件');
    eq(chapterNumbers(fs.readFileSync(fileA, 'utf8')), [1, 2, 3], 'A1.6 章节数不增加（仍为 1/2/3）');

    // A2：替换末尾章 → 成功，第 3 章被替换，第 1/2 章原样保留
    const rA2 = await router.dispatch('POST', '/append', appendPayload(dirA, {
        mes: '　　第3章的全新替换正文。', chapterNumber: 3, floor: 3, is_regenerate: true
    }));
    eq(rA2.status, 200, 'A2.1 替换末尾章（第 3 章）返回 HTTP 200');
    eq(rA2.data && rA2.data.success, true, 'A2.2 替换末尾章 success === true');
    eq(rA2.data && rA2.data.replaced_existing, true, 'A2.3 响应带 replaced_existing: true');
    const contentA2 = fs.readFileSync(fileA, 'utf8');
    eq(chapterNumbers(contentA2), [1, 2, 3], 'A2.4 替换后章节号仍是 1/2/3（无重复、无新增）');
    ok(contentA2.includes('第3章的全新替换正文'), 'A2.5 第 3 章已是新正文');
    ok(!contentA2.includes('第3章的原始正文'), 'A2.6 第 3 章旧正文已被移除');
    ok(contentA2.includes('第1章的原始正文') && contentA2.includes('第2章的原始正文'),
        'A2.7 第 1/2 章原样保留（替换没有误删前文）');

    // A3：chapterNumber 含正则元字符 → 不得抛异常、不得静默追加
    const beforeA3 = bytesOf(fileA);
    const rA3 = await router.dispatch('POST', '/append', appendPayload(dirA, {
        mes: '　　元字符章节号正文。', chapterNumber: '1 (', floor: 9, is_regenerate: true
    }));
    ok(rA3.status === 409 || (rA3.status >= 400 && rA3.status < 500),
        'A3.1 chapterNumber="1 (" 返回 4xx（409/4xx），不是 200', `实际 HTTP ${rA3.status}`);
    eq(rA3.data && rA3.data.reason, 'invalid_chapter_number', 'A3.2 reason === invalid_chapter_number');
    ok(bytesEqual(beforeA3, bytesOf(fileA)), 'A3.3 元字符请求后文件逐字节零改动');
    ok(!fs.readFileSync(fileA, 'utf8').includes('元字符章节号正文'), 'A3.4 元字符请求没有被静默追加进文件');

    // A4：chapterStyle 与文件实际排版不一致 → 不得"留着旧章又追加新章"
    const beforeA4 = bytesOf(fileA);
    const rA4 = await router.dispatch('POST', '/append', appendPayload(dirA, {
        mes: '　　风格不一致的替换正文。', chapterNumber: 3, chapterStyle: 'separator', floor: 3, is_regenerate: true
    }));
    const numsA4 = chapterNumbers(fs.readFileSync(fileA, 'utf8'));
    ok(numsA4.length <= 3, 'A4.1 风格不一致时文件章节数不增加（≤3）', `实际 ${JSON.stringify(numsA4)}`);
    ok(rA4.status === 409 || rA4.status === 200,
        'A4.2 风格不一致走 409 拒绝或 200 替换，绝不静默追加', `实际 HTTP ${rA4.status}`);
    if (rA4.status === 409) {
        eq(rA4.data && rA4.data.conflict, true, 'A4.3 风格不一致被拒时带 conflict: true');
        ok(bytesEqual(beforeA4, bytesOf(fileA)), 'A4.4 风格不一致被拒时文件逐字节零改动');
        eq(chapterNumbers(fs.readFileSync(fileA, 'utf8')), [1, 2, 3], 'A4.5 章节序列仍是 1/2/3');
    } else {
        ok(!/第\s*3\s*[章节][\s\S]*第\s*3\s*[章节]/.test(fs.readFileSync(fileA, 'utf8')),
            'A4.3 替换成功时文件里不得出现两个第 3 章');
    }

    // ==================================================================
    // B. 重复追加守卫（D4 服务端）
    // ==================================================================
    console.log('\n=== B. 重复追加守卫（D4）：同号章节不得重复落盘 ===');

    const dirB = freshDir('B');
    const fileB = path.join(dirB, '契约测试.txt');
    for (const n of [1, 2, 3]) {
        await router.dispatch('POST', '/append', appendPayload(dirB, {
            mes: `　　B组第${n}章正文。`, chapterNumber: n, floor: n
        }));
    }
    eq(chapterNumbers(fs.readFileSync(fileB, 'utf8')), [1, 2, 3], 'B0 前置：文件里恰好有第 1/2/3 章');

    // B1：非 regenerate 追加已存在的非末尾章 → 409 chapter_exists，文件不变
    const beforeB1 = bytesOf(fileB);
    const rB1 = await router.dispatch('POST', '/append', appendPayload(dirB, {
        mes: '　　B组重复的第2章正文。', chapterNumber: 2, floor: 2, is_regenerate: false
    }));
    eq(rB1.status, 409, 'B1.1 重复追加第 2 章返回 HTTP 409');
    eq(rB1.data && rB1.data.conflict, true, 'B1.2 响应带 conflict: true');
    eq(rB1.data && rB1.data.reason, 'chapter_exists', 'B1.3 reason === chapter_exists');
    ok(bytesEqual(beforeB1, bytesOf(fileB)), 'B1.4 重复追加被拒后文件逐字节零改动');
    const numsB1 = chapterNumbers(fs.readFileSync(fileB, 'utf8'));
    eq(numsB1.filter((n) => n === 2).length, 1, 'B1.5 文件里只有一个"第 2 章"');

    // B2：同号且为末尾章 → 自动纠正为替换，文件里仍只有一个第 3 章
    const rB2 = await router.dispatch('POST', '/append', appendPayload(dirB, {
        mes: '　　B组第3章的新正文（同号末尾自动纠正）。', chapterNumber: 3, floor: 3, is_regenerate: false
    }));
    eq(rB2.status, 200, 'B2.1 同号末尾章追加返回 HTTP 200');
    eq(rB2.data && rB2.data.success, true, 'B2.2 success === true');
    ok(rB2.data && (rB2.data.replaced_existing === true || rB2.data.is_regenerate === true),
        'B2.3 走替换成功路径（replaced_existing 或 is_regenerate 为真）',
        JSON.stringify(rB2.data));
    const contentB2 = fs.readFileSync(fileB, 'utf8');
    eq(chapterNumbers(contentB2).filter((n) => n === 3).length, 1, 'B2.4 文件里只有一个"第 3 章"');
    eq(chapterNumbers(contentB2), [1, 2, 3], 'B2.5 章节序列仍为 1/2/3');
    ok(contentB2.includes('同号末尾自动纠正'), 'B2.6 第 3 章内容已更新为新正文');

    // B3：is_greeting 请求不套用该守卫（问候语有自己的 isNewFile 语义）
    const dirB3 = freshDir('B3');
    const rB3 = await router.dispatch('POST', '/append', appendPayload(dirB3, {
        mes: '　　角色问候语。', chapterNumber: 1, floor: 1, is_greeting: true
    }));
    eq(rB3.status, 200, 'B3.1 问候语首次写入返回 200（不被 chapter_exists 守卫拦）');
    const rB3b = await router.dispatch('POST', '/append', appendPayload(dirB3, {
        mes: '　　角色问候语。', chapterNumber: 1, floor: 1, is_greeting: true
    }));
    ok(rB3b.status === 200 && rB3b.data && rB3b.data.skipped === true,
        'B3.2 问候语重复投递走 skipped（而非 409）',
        `HTTP ${rB3b.status} ${JSON.stringify(rB3b.data)}`);

    // ==================================================================
    // C. 备份与原子写（D18）
    // ==================================================================
    console.log('\n=== C. 备份与原子写（D18）：.bak 内容正确、无 .tmp-* 残留 ===');

    const dirC = freshDir('C');
    const fileC = path.join(dirC, '契约测试.txt');
    for (const n of [1, 2, 3]) {
        await router.dispatch('POST', '/append', appendPayload(dirC, {
            mes: `　　C组第${n}章正文。`, chapterNumber: n, floor: n
        }));
    }
    const beforeC = bytesOf(fileC);
    const rC = await router.dispatch('POST', '/append', appendPayload(dirC, {
        mes: '　　C组第3章替换正文。', chapterNumber: 3, floor: 3, is_regenerate: true
    }));
    eq(rC.status, 200, 'C1 替换末尾章成功（触发备份）');
    const bakC = `${fileC}.bak`;
    ok(fs.existsSync(bakC), `C1.1 替换后存在 ${path.basename(bakC)}`, bakC);
    if (fs.existsSync(bakC)) {
        ok(bytesEqual(beforeC, bytesOf(bakC)), 'C1.2 .bak 内容逐字节等于改动前的文件内容');
    }
    eq(listTempLeftovers(dirC), [], 'C1.3 替换后目标目录没有 .tmp-* 残留');

    const beforeSync = bytesOf(fileC);
    const rSync = await router.dispatch('POST', '/sync-all', {
        characterName: '契约测试',
        fullText: '\uFEFF《契约测试》\n\n\n第 1 章 · 旁白 (原楼层: 1)\n\n　　全量同步后的唯一章节。\n\n\n',
        save_dir: dirC
    });
    eq(rSync.status, 200, 'C2 /sync-all 覆盖写返回 200');
    eq(rSync.data && rSync.data.success, true, 'C2.1 /sync-all success === true');
    ok(bytesEqual(beforeSync, bytesOf(bakC)), 'C2.2 sync-all 覆盖后 .bak 等于覆盖前的内容');
    ok(fs.readFileSync(fileC, 'utf8').includes('全量同步后的唯一章节'), 'C2.3 覆盖后文件已是新内容');
    eq(listTempLeftovers(dirC), [], 'C2.4 sync-all 后目录没有 .tmp-* 残留');
    ok(rSync.data && rSync.data.backup !== false, 'C2.5 sync-all 成功响应未声明备份失败', JSON.stringify(rSync.data));

    // ==================================================================
    // D. 问候语入书（D2 前端契约，加载真实 index.js）
    // ==================================================================
    // ---- 真实 index.js 加载（D/E/G 共用）----
    let api = null;
    let apiLoadError = null;
    try {
        api = loadIndexModule();
    } catch (e) {
        apiLoadError = e;
    }
    ok(!!api && typeof api.seedLastSavedSignature === 'function' && typeof api.ensureGreetingSerialized === 'function'
        && typeof api.__testState === 'object',
        'D0 load-index 取到 seedLastSavedSignature / ensureGreetingSerialized / __testState',
        apiLoadError ? ('加载失败：' + apiLoadError.message) : '导出面不完整（缺少 seedLastSavedSignature / ensureGreetingSerialized / __testState）');

    // D/E 依赖真实前端导出面；加载失败时跳过（D0 已判红一条），
    // 但**不抛异常** —— 否则 G 组会被一起跳过，退化成"通过 47, 失败 2"的假绿灯。
    await (async () => {
        if (!api || typeof api.DEFAULT_SETTINGS !== 'object' || typeof api.__testState !== 'object') {
            console.error('       → 真实 index.js 导出面不可用，D/E 组本次未执行（已由 D0 判红）');
            return;
        }
    console.log('\n=== D. 问候语入书（D2）：加载真实 index.js 断言补写请求真的发出 ===');


        const greetingMes = '　　夜色沉静，故事即将开始。';
        function makeApi(chatLog, settingsOverride) {
            const calls = [];
            const settings = Object.assign({}, api.DEFAULT_SETTINGS, {
                enabled: true, chapter_style: 'numbered_floor', save_dir: '', include_user_dialogue: false
            }, settingsOverride || {});
            const ctxObj = {
                chat: chatLog,
                getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
                saveSettingsDebounced: () => {},
                eventSource: null,
                event_types: null
            };
            const mod = loadIndexModule({
                deps: {
                    getContext: () => ctxObj,
                    fetch: (url, init) => {
                        calls.push({ url, init });
                        return Promise.resolve({
                            ok: true,
                            status: 200,
                            json: () => Promise.resolve({ success: true, skipped: false, file: '契约测试.txt' })
                        });
                    }
                }
            });
            return { mod, calls, settings, ctxObj };
        }

        // D1：chat = [问候语, 用户消息] → 必须发出一次 chapterNumber:1 / is_greeting:true 的请求
        {
            const chat2 = [
                { is_user: false, name: '艾莉丝', mes: greetingMes },
                { is_user: true, name: '你', mes: '　　我推开了门。' }
            ];
            const h = makeApi(chat2);
            h.mod.__testState.setServerPluginVersion('1.17.7');
            h.mod.seedLastSavedSignature({ skipGreeting: true });
            await h.mod.ensureGreetingSerialized(h.settings, chat2);

            eq(h.calls.length, 1, 'D1.1 恰好发出 1 次补写请求');
            if (h.calls.length === 1) {
                const body = JSON.parse(h.calls[0].init.body);
                eq(h.calls[0].url, '/api/plugins/auto-save/append', 'D1.2 请求打到 /append');
                eq(body.chapterNumber, 1, 'D1.3 补写 chapterNumber === 1');
                eq(body.is_greeting, true, 'D1.4 补写 is_greeting === true');
                eq(body.is_regenerate, false, 'D1.5 补写 is_regenerate === false');
                ok(String(body.mes || '').includes('夜色沉静'), 'D1.6 补写正文是问候语清洗后的文本', String(body.mes).slice(0, 60));
            }
            eq(h.mod.__testState.getLastSettledSavedIndex(), 0, 'D1.7 补写后 lastSettledSavedIndex === 0');
        }

        // D2：chat 长度 3 → 既有门控：不触发补写
        {
            const chat3 = [
                { is_user: false, name: '艾莉丝', mes: greetingMes },
                { is_user: true, name: '你', mes: '　　我推开了门。' },
                { is_user: false, name: '艾莉丝', mes: '　　她回过头来。' }
            ];
            const h = makeApi(chat3);
            h.mod.__testState.setServerPluginVersion('1.17.7');
            h.mod.seedLastSavedSignature({ skipGreeting: true });
            await h.mod.ensureGreetingSerialized(h.settings, chat3);
            eq(h.calls.length, 0, 'D2.1 会话长度 3 时问候语补写不触发');
        }

        // D3：回归用例 —— 修复前 boot seed 会把问候语标成"已保存"
        {
            const chatGreetingOnly = [{ is_user: false, name: '艾莉丝', mes: greetingMes }];
            const h = makeApi(chatGreetingOnly);
            h.mod.seedLastSavedSignature({ skipGreeting: true });
            eq(h.mod.__testState.getLastSettledSavedIndex(), -1,
                'D3.1 只有问候语时 lastSettledSavedIndex === -1（修复前会被播种成 0）');
            eq(h.mod.__testState.getLastSavedSignature().messageId, null,
                'D3.2 只有问候语时 lastSavedSignature.messageId 为空');
        }

        // D4：反向对照 —— 不传 skipGreeting 时旧行为保留（证明参数确实在起作用）
        {
            const chatGreetingOnly = [{ is_user: false, name: '艾莉丝', mes: greetingMes }];
            const h = makeApi(chatGreetingOnly);
            h.mod.seedLastSavedSignature();
            eq(h.mod.__testState.getLastSettledSavedIndex(), 0,
                'D4.1 不传 skipGreeting 时仍播种为 0（默认参数保持旧行为）');
        }

        // ==================================================================
        // E. 转义（D3）
        // ==================================================================
        console.log('\n=== E. 转义（D3）：escapeHtml 五字符 + 清洗引擎不做实体回流 ===');

        const escaped = api.escapeHtml(`<img src="x" onerror='alert(1)'> & 正文`);
        ok(!escaped.includes('<img'), 'E1.1 escapeHtml 后没有裸 <img>', escaped);
        ok(escaped.includes('&lt;img'), 'E1.2 < 被转义为 &lt;', escaped);
        ok(escaped.includes('&gt;'), 'E1.3 > 被转义为 &gt;', escaped);
        ok(escaped.includes('&amp;'), 'E1.4 & 被转义为 &amp;', escaped);
        ok(escaped.includes('&quot;'), 'E1.5 " 被转义为 &quot;', escaped);
        ok(escaped.includes('&#39;'), "E1.6 ' 被转义为 &#39;（本轮修复点）", escaped);

        const escaped2 = api.escapeHtml(`'"><b>`);
        ok(!escaped2.includes("'") && !escaped2.includes('"') && !escaped2.includes('<b>'),
            'E1.7 引号闭合攻击串被完整转义', escaped2);

        {
            const raw = '&lt;img src=x onerror=alert(1)&gt;';
            const cleaned = api.cleanNovelText(raw, { indent_paragraphs: false });
            ok(!cleaned.includes('&lt;img') && !cleaned.includes('&amp;lt;'),
                'E2.1 已经是实体的输入不会被双重转义', cleaned);
            ok(cleaned.includes('<img src=x onerror=alert(1)>'),
                'E2.2 清洗引擎把实体解码为字面文本（不出现在 DOM，只断言函数层面事实）', cleaned);
        }


    })();
    // ==================================================================
    // F. 长章节防重（D12）
    // ==================================================================
    console.log('\n=== F. 长章节防重（D12）：30KB 长章节重复投递 ===');

    const dirF = freshDir('F');
    const fileF = path.join(dirF, '契约测试.txt');
    const longBody = '　　长章节段落内容。'.repeat(2000); // 约 30KB
    const longPayload = appendPayload(dirF, {
        mes: longBody, chapterNumber: 1, floor: 1
    });
    const rF1 = await router.dispatch('POST', '/append', longPayload);
    eq(rF1.status, 200, 'F1.1 长章节首次写入返回 200');
    const sizeAfterFirst = fs.statSync(fileF).size;
    const rF2 = await router.dispatch('POST', '/append', appendPayload(dirF, {
        mes: longBody, chapterNumber: 1, floor: 1
    }));
    eq(rF2.data && rF2.data.skipped, true, 'F1.2 长章节重复投递被识别为重复（skipped === true）',
        `HTTP ${rF2.status} ${JSON.stringify(rF2.data)}`);
    eq(fs.statSync(fileF).size, sizeAfterFirst,
        'F1.3 重复投递后文件字节数完全不变（没有写进第二份长章节）');
    eq(chapterNumbers(fs.readFileSync(fileF, 'utf8')), [1], 'F1.4 文件里仍只有一个第 1 章');

    // ---- G 组基础设施（提升到 D 段之前：G 必须在真实 index.js 加载失败时仍能逐场景判红）----
    let currentWire = null;
    function needApi() {
        if (!api) {
            throw new Error('真实 index.js 未成功加载（导出面不完整或语法错误），G 组无法验证真实前端行为'
                + (apiLoadError ? ('：' + apiLoadError.message) : ''));
        }
        return api;
    }
    // 场景收尾统一判一次"定位型章号是否指向不存在的章"（去重后只计一条）
    // requireNoMiss=false 用于 G3：那一组故意让替换目标不存在（文件被外部改动），
    // 期望行为就是 fail-closed 拒绝 —— 此时"有 miss"是正确结果而非缺陷。
    function gradeScenarioEnd(w, options = {}) {
        if (!w || !w.log) return;
        if (options.requireNoMiss === false) return;
        const misses = locateMisses(w.log);
        eq(misses.length, 0, 'G.判据 没有任何 is_regenerate 请求指向文件中不存在的章号', describeMisses(w.log));
    }

    function locateMisses(log) {
        return log.filter((e) => {
            if (!e.req || !e.req.is_regenerate) return false;
            const n = Number(e.req.chapterNumber);
            if (!Number.isFinite(n)) return true;
            return !e.before.nums.includes(n);
        });
    }

    function describeMisses(log) {
        return JSON.stringify(locateMisses(log).map((e) => ({
            chapterNumber: e.req.chapterNumber, fileNumsAtThatMoment: e.before.nums, status: e.status
        })));
    }

    // G 组共用的聊天消息（提升到基础设施段，供 chips / 各场景使用）
    const GREETING = '　　“欢迎来到这座小镇。”';
    const USER_LINE = '　　我推开了酒馆的门。';
    const AI_FIRST = '　　她抬起头，眼中闪过一丝惊讶。';

    const chips = {
        A: { is_user: false, name: '艾莉丝', mes: AI_FIRST },
        A2: { is_user: false, name: '艾莉丝', mes: '　　她抬起头，眼中闪过一丝惊讶。（第二版）' },
        B: { is_user: false, name: '艾莉丝', mes: '　　她低声说：“跟我来。”' }
    };

    async function wire(dir, label) {
        const route = new MockRouter();
        await plugin.init(route);
        // 目标文件名由插件按 file_name/characterName 决定，前端与插件各算一次；
        // 这里不硬编码，改为从服务端响应里取真实落盘路径（snapshot 时兜底扫描目录）。
        let targetFile = null;
        const guessedFile = path.join(dir, `${label}.txt`);

        function currentFile() {
            if (targetFile && fs.existsSync(targetFile)) return targetFile;
            if (fs.existsSync(guessedFile)) return guessedFile;
            const txts = fs.existsSync(dir)
                ? fs.readdirSync(dir).filter((n) => n.endsWith('.txt') && !n.endsWith('.bak'))
                : [];
            return txts.length ? path.join(dir, txts[0]) : (targetFile || guessedFile);
        }

        function snapshot() {
            const f = currentFile();
            if (!fs.existsSync(f)) return { exists: false, nums: [], content: '' };
            const content = fs.readFileSync(f, 'utf8');
            return { exists: true, nums: chapterNumbers(content), content };
        }

        const log = [];
        const rawDispatch = route.dispatch.bind(route);
        route.dispatch = async (method, url, body) => {
            const before = snapshot();
            const res = await rawDispatch(method, url, body);
            if (res && res.data && typeof res.data.file === 'string' && res.data.file) {
                const abs = path.isAbsolute(res.data.file) ? res.data.file : path.resolve(process.cwd(), res.data.file);
                if (fs.existsSync(abs)) targetFile = abs;
            }
            log.push({ method, url, req: body, status: res.status, data: res.data, before, after: snapshot() });
            return res;
        };

        const settings = Object.assign({}, api.DEFAULT_SETTINGS, {
            enabled: true,
            chapter_style: 'numbered_floor',
            save_dir: dir.replace(/\\/g, '/'),
            include_user_dialogue: false,
            buffer_latest_message: false,
            naming_rule: 'char_chat',
            show_toast: false
        });
        const ctxObj = {
            chat: [],
            chatId: '',
            extension_settings: { autoSaveTxt: settings },
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveSettingsDebounced: () => {},
            eventSource: null,
            event_types: null
        };
        const mod = loadIndexModule({
            deps: {
                getContext: () => ctxObj,
                // fetch 必须返回 Response 形状（ok/status/json()）：
                // 真实 postChapterToServer 会调 response.ok 与 response.json()，
                // 直接把 MockRouter 的 {status, data} 返回给它会让每次写入都抛
                // "response.json is not a function" 并被当成失败 —— 那样 G 组会因为
                // "什么都没写进文件"而假绿/假红（实测踩到过）。
                fetch: async (url, init) => {
                    const r = await route.dispatch(
                        'POST',
                        String(url).replace('/api/plugins/auto-save', ''),
                        JSON.parse(init.body)
                    );
                    return {
                        ok: r.status >= 200 && r.status < 300,
                        status: r.status,
                        json: async () => r.data
                    };
                }
            }
        });

        /** 直接改写小说文件，模拟"用户手工编辑过 / 文件丢失 / 换了保存目录" */
        function externalEdit(content) {
            fs.writeFileSync(currentFile(), content, 'utf8');
        }

        const handle = {
            route, log, settings, ctxObj, mod, snapshot, externalEdit,
            get file() { return currentFile(); }
        };
        currentWire = handle;
        return handle;
    }
    // ---------- G1：问候语入书 → AI 首答必须落地为第 2 章 ----------
    {
        let w = null;
        const __scenario = async () => {
            const w = await wire(freshDir('G1'), 'g1');
            // ① 新聊天只有问候语：boot 播种（跳过问候语）
            w.ctxObj.chat = [{ is_user: false, name: '艾莉丝', mes: GREETING }];
            w.mod.__testState.setServerPluginVersion('1.17.7');
            w.mod.seedLastSavedSignature({ skipGreeting: true });
            eq(w.mod.__testState.getLastSettledSavedIndex(), -1,
                'G1.0 新聊天播种后 lastSettledSavedIndex === -1（问候语未被视为已入书）');

            // ② 用户发出第一条消息 → 问候语补写入书
            w.ctxObj.chat = [
                { is_user: false, name: '艾莉丝', mes: GREETING },
                { is_user: true, name: '你', mes: USER_LINE }
            ];
            await w.mod.handleMessageSave(0, true);

            const greets = w.log.filter((e) => e.req && e.req.is_greeting === true);
            eq(greets.length, 1, 'G1.1 前端恰好发出 1 个 is_greeting 补写请求');
            if (greets.length === 1) {
                eq(greets[0].status, 200, 'G1.2 问候语补写经真实服务端返回 200');
                eq(greets[0].req.chapterNumber, 1, 'G1.3 补写 chapterNumber === 1');
                eq(greets[0].after.nums, [1], 'G1.4 补写后磁盘上确实落成第 1 章');
            }

            // ③ AI 首答 → saveSpecificMessage(2)
            w.ctxObj.chat = [
                { is_user: false, name: '艾莉丝', mes: GREETING },
                { is_user: true, name: '你', mes: USER_LINE },
                chips.A
            ];
            const beforeIdx = w.log.length;
            await w.mod.handleMessageSave(2, false);
            const aiCalls = w.log.slice(beforeIdx);

            eq(aiCalls.length, 1, 'G1.5 AI 首答恰好发出 1 个写入请求');
            ok(aiCalls.every((e) => e.status === 200),
                'G1.6 AI 首答返回 200（不是 409 —— 这是本组最关键断言）',
                JSON.stringify(aiCalls.map((e) => ({ status: e.status, reason: e.data && e.data.reason, req: e.req }))));
            eq(w.snapshot().nums, [1, 2], 'G1.8 最终章节序列严格等于 [1, 2]');
            ok(w.snapshot().content.includes('她抬起头'), 'G1.9 AI 首答正文确实写进了文件（没有被静默丢弃）');
            ok(!aiCalls.some((e) => Number(e.req.chapterNumber) === 2 && e.req.is_regenerate === true
                && !e.before.nums.includes(2)),
                'G1.10 未发出「chapterNumber=2 且 is_regenerate=true 而文件里没有第 2 章」的组合');
            // 反向锁：这一组的 AI 首答必须是"新增"，绝不能是替换（替换意图本身即回归）
            ok(aiCalls.every((e) => e.req.is_regenerate !== true),
                'G1.11 AI 首答没有携带替换意图（该楼层尚未落盘，替换必然 409 丢内容）',
                JSON.stringify(aiCalls.map((e) => ({ is_regenerate: e.req.is_regenerate, ch: e.req.chapterNumber }))));
            gradeScenarioEnd(w);
        };
        try {
            await __scenario();
        } catch (e) {
            fail++;
            failList.push('G1 场景执行异常');
            console.error('[FAIL] G1 场景执行异常');
            console.error('       → ' + (e && e.message));
        }
    }

    // ---------- G2：真 regenerate（同一楼层重新生成）必须替换、不新增章节 ----------
    {
        let w = null;
        const __scenario = async () => {
            const w = await wire(freshDir('G2'), 'g2');
            w.mod.__testState.setServerPluginVersion('1.17.7');
            const base = [{ is_user: false, name: '艾莉丝', mes: GREETING }, { is_user: true, name: '你', mes: USER_LINE }];
            w.ctxObj.chat = base.slice(0, 1);
            w.mod.seedLastSavedSignature({ skipGreeting: true });
            w.ctxObj.chat = base.slice(0, 2);
            await w.mod.handleMessageSave(0, true);
            w.ctxObj.chat = base.concat([chips.A]);
            await w.mod.handleMessageSave(2, false);
            eq(w.snapshot().nums, [1, 2], 'G2.0 前置：问候语 + AI 首答 = [1, 2]');

            const beforeIdx = w.log.length;
            w.ctxObj.chat = base.concat([chips.A2]);
            await w.mod.handleMessageSave(2, false);
            const calls = w.log.slice(beforeIdx);

            eq(calls.length, 1, 'G2.1 重新生成恰好发出 1 个请求');
            ok(calls.every((e) => e.status === 200), 'G2.2 重新生成返回 200',
                JSON.stringify(calls.map((e) => ({ status: e.status, reason: e.data && e.data.reason }))));
            ok(calls.every((e) => e.req.is_regenerate === true),
                'G2.2b 该楼层已落盘，重新生成确实走替换意图',
                JSON.stringify(calls.map((e) => ({ is_regenerate: e.req.is_regenerate, ch: e.req.chapterNumber }))));
            eq(w.snapshot().nums, [1, 2], 'G2.3 重新生成后章节序列仍是 [1, 2]（替换而非新增）');
            ok(w.snapshot().content.includes('第二版'), 'G2.4 文件中已是重新生成后的正文');
            ok(!w.snapshot().content.includes('眼中闪过一丝惊讶。\n\n\n'), 'G2.5 旧版本正文已被替换掉');
            gradeScenarioEnd(w);
        };
        try {
            await __scenario();
        } catch (e) {
            fail++;
            failList.push('G2 场景执行异常');
            console.error('[FAIL] G2 场景执行异常');
            console.error('       → ' + (e && e.message));
        }
    }

    // ---------- G3：文件被外部改动（只剩第 1 章）后 regenerate ----------
    // 这是**与 Lead 的回归不同**的场景：该楼层确实落过盘（前端状态"已知"），
    // 但文件在外部被改小/换目录了，于是替换目标章号在文件里不存在。
    // 此时正确的契约不是"硬写进去"，而是 fail-closed + 明确报错：
    //   ① 服务端拒绝（409 chapter_not_found），绝不改动已分歧的文件；
    //   ② 前端把状态置为 error 并提示用【同步历史连载】校准，绝不静默丢弃；
    //   ③ 不登记 lastSavedSignature，这样下次仍会重试而不是"以为写过了"。
    {
        let w = null;
        const __scenario = async () => {
            const w = await wire(freshDir('G3'), 'g3');
            w.mod.__testState.setServerPluginVersion('1.17.7');
            const base = [{ is_user: false, name: '艾莉丝', mes: GREETING }, { is_user: true, name: '你', mes: USER_LINE }];
            w.ctxObj.chat = base.slice(0, 1);
            w.mod.seedLastSavedSignature({ skipGreeting: true });
            w.ctxObj.chat = base.slice(0, 2);
            await w.mod.handleMessageSave(0, true);
            w.ctxObj.chat = base.concat([chips.A]);
            await w.mod.handleMessageSave(2, false);
            eq(w.snapshot().nums, [1, 2], 'G3.0 前置：[1, 2]');
            const sigBeforeExternal = JSON.stringify(w.mod.__testState.getLastSavedSignature());

            // 模拟外部改动：文件被回退到只有第 1 章（用户手工编辑 / 同步失败 / 换了保存目录）
            const trimmed = w.snapshot().content.split(/(?=第 2 章)/)[0].replace(/\s+$/, '');
            w.externalEdit(trimmed);
            eq(w.snapshot().nums, [1], 'G3.1 外部改动后文件只剩 [1]');

            const beforeIdx = w.log.length;
            w.ctxObj.chat = base.concat([chips.A2]);
            await w.mod.handleMessageSave(2, false);
            const calls = w.log.slice(beforeIdx);
            const status = w.mod.__testState.getRecentStatus();

            eq(calls.length, 1, 'G3.2 文件分歧后 regenerate 恰好发出 1 个请求');
            eq(calls[0].status, 409, 'G3.3 服务端 fail-closed 拒绝（409），绝不改动已分歧的文件',
                JSON.stringify(calls[0].data));
            eq(calls[0].data && calls[0].data.reason, 'chapter_not_found', 'G3.4 reason === chapter_not_found');
            ok(!w.snapshot().content.includes('第二版'),
                'G3.5 被拒绝的正文没有落盘（文件保持外部改动后的样子，未被悄悄覆盖）');
            eq(w.snapshot().nums, [1], 'G3.6 章节序列仍是 [1]（没有多写一章）');

            // 关键的"不静默"契约：状态必须是 error 且指引用户校准
            eq(status.state, 'error', 'G3.7 前端把结果标为 error（绝不当成成功、绝不静默）', JSON.stringify(status));
            ok(/同步历史连载/.test(String(status.text || '')),
                'G3.8 状态文案指引用户用【同步历史连载】校准', String(status.text));
            eq(JSON.stringify(w.mod.__testState.getLastSavedSignature()), sigBeforeExternal,
                'G3.9 冲突时不登记 lastSavedSignature（下次仍会重试，不会"以为写过了"）');
            gradeScenarioEnd(w, { requireNoMiss: false });
        };
        try {
            await __scenario();
        } catch (e) {
            fail++;
            failList.push('G3 场景执行异常');
            console.error('[FAIL] G3 场景执行异常');
            console.error('       → ' + (e && e.message));
        }
    }

    // ---------- G4：多轮推进，章节序列单调递增无重复 ----------
    {
        let w = null;
        const __scenario = async () => {
            const w = await wire(freshDir('G4'), 'g4');
            w.mod.__testState.setServerPluginVersion('1.17.7');
            const base = [{ is_user: false, name: '艾莉丝', mes: GREETING }, { is_user: true, name: '你', mes: USER_LINE }];
            w.ctxObj.chat = base.slice(0, 1);
            w.mod.seedLastSavedSignature({ skipGreeting: true });
            w.ctxObj.chat = base.slice(0, 2);
            await w.mod.handleMessageSave(0, true);

            w.ctxObj.chat = base.concat([chips.A]);
            await w.mod.handleMessageSave(2, false);

            w.ctxObj.chat = base.concat([chips.A, { is_user: true, name: '你', mes: '　　我点了点头。' }, chips.B]);
            await w.mod.handleMessageSave(4, false);

            const nums = w.snapshot().nums;
            eq(nums, [1, 2, 3], 'G4.1 三轮之后章节序列严格等于 [1, 2, 3]');
            ok(nums.every((n, i) => i === 0 || n === nums[i - 1] + 1),
                'G4.2 章节号连续递增，无跳号/无回退', JSON.stringify(nums));
            ok(w.log.every((e) => e.status === 200),
                'G4.3 全时序没有任何一次非 200 响应',
                JSON.stringify(w.log.filter((e) => e.status !== 200).map((e) => ({ req: e.req, status: e.status, reason: e.data && e.data.reason }))));
            for (const [name, body] of [['问候语', '欢迎来到这座小镇'], ['AI 首答', '她抬起头'], ['AI 次答', '跟我来']]) {
                ok(w.snapshot().content.includes(body), `G4.5 ${name}的正文都在文件里（无静默丢弃）`);
            }
            gradeScenarioEnd(w);
        };
        try {
            await __scenario();
        } catch (e) {
            fail++;
            failList.push('G4 场景执行异常');
            console.error('[FAIL] G4 场景执行异常');
            console.error('       → ' + (e && e.message));
        }
    }

    // ---------- G5：状态未知（模拟页面刷新）时替换必须退化为普通追加 ----------
    {
        let w = null;
        const __scenario = async () => {
            const w = await wire(freshDir('G5'), 'g5');
            w.mod.__testState.setServerPluginVersion('1.17.7');
            const base = [{ is_user: false, name: '艾莉丝', mes: GREETING }, { is_user: true, name: '你', mes: USER_LINE }];
            w.ctxObj.chat = base.slice(0, 1);
            w.mod.seedLastSavedSignature({ skipGreeting: true });
            w.ctxObj.chat = base.slice(0, 2);
            await w.mod.handleMessageSave(0, true);
            w.ctxObj.chat = base.concat([chips.A]);
            await w.mod.handleMessageSave(2, false);
            eq(w.snapshot().nums, [1, 2], 'G5.0 前置：[1, 2]');

            // 模拟页面刷新：内存里的落盘章号映射与 lastWrittenChapterNumber 全部丢失
            w.mod.__testState.setLastWrittenChapterNumber(0);
            const map = w.mod.__testState.getSavedChapterMap();
            for (const k of Object.keys(map)) delete map[k];
            eq(w.mod.__testState.getLastWrittenChapterNumber(), 0, 'G5.1 已把 lastWrittenChapterNumber 置 0（状态未知）');

            const beforeIdx = w.log.length;
            w.ctxObj.chat = base.concat([chips.A2]);
            await w.mod.handleMessageSave(2, false);
            const calls = w.log.slice(beforeIdx);

            eq(calls.length, 1, 'G5.2 状态未知时仍恰好发出 1 个请求');
            ok(calls.every((e) => e.req.is_regenerate === false),
                'G5.3 状态未知时不得发出替换意图（必须退化为普通追加）',
                JSON.stringify(calls.map((e) => ({ is_regenerate: e.req.is_regenerate, ch: e.req.chapterNumber }))));
            ok(calls.every((e) => e.status === 200),
                'G5.4 退化追加后返回 200（不因定位不到章号而 409 丢内容）',
                JSON.stringify(calls.map((e) => ({ status: e.status, reason: e.data && e.data.reason }))));
            ok(w.snapshot().content.includes('第二版'),
                'G5.6 退化为追加时新正文仍然落盘（宁可多一章也不丢内容）', w.snapshot().content.slice(-160));
            gradeScenarioEnd(w);
        };
        try {
            await __scenario();
        } catch (e) {
            fail++;
            failList.push('G5 场景执行异常');
            console.error('[FAIL] G5 场景执行异常');
            console.error('       → ' + (e && e.message));
        }
    }
    // ==================================================================
    // H. 命名同源（F7）：file_name 与 characterName 必须指向同一本书
    // 背景：F7 之前，无角色卡时 getBookFileName(settings) 走占位名「我的小说连载」，
    // 而写入载荷的 characterName 用 getBookTitle(settings, speakerName)='艾莉丝' ——
    // 同一次保存请求里两套命名，服务端按 file_name 落盘并注册锚点，扉页《书名》却用 bookTitle。
    // ==================================================================
    console.log('\n=== H. 命名同源（F7）：file_name 与 characterName 指向同一本书 ===');
    {
        const H_GREETING = { is_user: false, name: '艾莉丝', mes: '　　“欢迎来到这座小镇。”' };
        const H_USER = { is_user: true, name: '你', mes: '　　我推开了门。' };

        /** 去掉 .txt 与账号前缀，得到「写入载荷里真正的书名」 */
        function titleFromFileName(api, settings) {
            const prefix = api.getAccountPrefix();
            const fn = api.getBookFileName(settings);
            const noExt = fn.replace(/\.txt$/i, '');
            return prefix && noExt.startsWith(prefix) ? noExt.slice(prefix.length) : noExt;
        }

        /** 用指定上下文加载一份真实 index.js（每个场景独立上下文） */
        function hApi(ctxExtra, settingsOverride) {
            const settings = Object.assign({}, api.DEFAULT_SETTINGS, {
                enabled: true, chapter_style: 'numbered_floor', save_dir: '',
                include_user_dialogue: false, naming_rule: 'char_chat'
            }, settingsOverride || {});
            const ctxObj = Object.assign({
                chat: [], chatId: '', extension_settings: { autoSaveTxt: settings },
                getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
                saveSettingsDebounced: () => {}
            }, ctxExtra || {});
            return { api: loadIndexModule({ deps: { getContext: () => ctxObj } }), settings };
        }

        // ---- H1：有角色卡 → 二者同源，且都取角色名 ----
        {
            const h = hApi({ characters: [{ name: '艾莉丝' }], this_chid: 0, chat: [H_GREETING, H_USER] });
            const nameInPayload = h.api.getBookTitle(h.settings, '艾莉丝');
            const titleInFileName = titleFromFileName(h.api, h.settings);
            eq(titleInFileName, nameInPayload, 'H1.1 有角色卡：file_name 与 characterName 同源');
            eq(nameInPayload, '艾莉丝', 'H1.2 有角色卡：书名取角色卡名' );
            eq(h.api.getBookFileName(h.settings), '艾莉丝.txt', 'H1.3 有角色卡：磁盘文件名为 艾莉丝.txt');
        }

        // ---- H2（F7 核心）：无角色卡 + 问候语楼层 → 必须同源 ----
        {
            const h = hApi({ chat: [H_GREETING, H_USER] });
            const nameInPayload = h.api.getBookTitle(h.settings, '艾莉丝');
            const titleInFileName = titleFromFileName(h.api, h.settings);
            eq(nameInPayload, '艾莉丝', 'H2.1 无角色卡：写入载荷的 characterName 仍取问候语说话人');
            eq(titleInFileName, nameInPayload,
                'H2.2 无角色卡 + 问候语楼层：file_name 与 characterName 完全同源（F7 修复点）');
            eq(h.api.getBookFileName(h.settings), '艾莉丝.txt',
                'H2.3 无角色卡 + 问候语楼层：磁盘文件名为 艾莉丝.txt（修复前为 我的小说连载.txt）');
        }

        // ---- H3：无角色卡 + 无可推断说话人（仅用户消息）→ 仍必须同源（都退占位名） ----
        {
            const h = hApi({ chat: [H_USER] });
            const titleInFileName = titleFromFileName(h.api, h.settings);
            eq(titleInFileName, h.api.getBookTitle(h.settings),
                'H3.1 无可推断说话人：file_name 与 getBookTitle(settings) 同源');
            eq(titleInFileName, '我的小说连载',
                'H3.2 无可推断说话人：两者一致退到占位名「我的小说连载」（不得一处占位一处用别的）');
            eq(h.api.getBookFileName(h.settings), '我的小说连载.txt', 'H3.3 磁盘文件名为 我的小说连载.txt');
        }

        // ---- H4：char_only 语义未被改坏 ----
        {
            const h = hApi({ characters: [{ name: '艾莉丝' }], this_chid: 0, chat: [H_GREETING, H_USER] },
                { naming_rule: 'char_only' });
            eq(h.api.getBookFileName(h.settings), '艾莉丝.txt', 'H4.1 char_only：文件名为 艾莉丝.txt');
            eq(titleFromFileName(h.api, h.settings), '艾莉丝', 'H4.2 char_only：文件名去扩展名后等于角色名');
        }

        // ---- H5：多账号前缀下仍同源（前缀必须被正确剥离后比较） ----
        {
            const h = hApi({ chat: [H_GREETING, H_USER], currentUser: { name: '小明' } });
            const nameInPayload = h.api.getBookTitle(h.settings, '艾莉丝');
            eq(h.api.getAccountPrefix(), '[小明] ', 'H5.1 多账号前缀被识别为 [小明] ');
            eq(h.api.getBookFileName(h.settings), '[小明] 艾莉丝.txt',
                'H5.2 多账号前缀 + 问候语说话人：磁盘文件名为 [小明] 艾莉丝.txt');
            eq(titleFromFileName(h.api, h.settings), nameInPayload,
                'H5.3 去掉账号前缀后仍与 characterName 同源');
        }
    }

    // I. P0：<bbi_image> 标记 + prompt 不得污染正文（v1.17.8）
    await groupI();

    // J. 图片电子书：图片清单 / 原位保真 / 结构化正文（P0.5 / P1）
    await groupJ();

    // K. EPUB 导出前端契约（P2 配套）：多章结构化 / 无图 / 原位保真严格版 / 乱序数组形态
    //    默认路径逐字节 / 清单映射 / 防御式矩阵（覆盖 J 组未覆盖分支）
    await groupK();
}

// ==================== I. P0：<bbi_image> 标记与 prompt 清理 ====================
// 背景（v1.17.8 修复）：图像生成扩展会在正文里写 `<bbi_image>` + prompt 全文（到行末）。
// 旧实现只剥掉标签本身，把英文绘图提示词当作正文写进了小说（正文污染，实测每处 586~744 字符）。
// 前置清洗改为 `<bbi_image[^\n]*` 整段删除。本组锁定：
//   ① prompt 不泄漏  ② 标记前后的正文完好  ③ 无标记正文逐字节不变（回归）
async function groupI() {
    console.log('\n=== I. P0：<bbi_image> 标记 + prompt 不得污染正文 ===');
    let api;
    try {
        api = loadIndexModule();
    } catch (e) {
        ok(false, 'I0 index.js 可加载', String(e && e.message));
        return;
    }
    const clean = (s) => api.cleanNovelText(s, {});

    // I1：单标记 + 前后正文
    const a = clean('　　她推开门。\n<bbi_image>1boy 1girl, close-up, long pink hair\n　　第二段文字。');
    ok(!/1boy|close-up|pink hair/i.test(a), 'I1.1 prompt 不泄漏进正文', a);
    ok(a.includes('她推开门') && a.includes('第二段文字'), 'I1.2 标记前后的正文都保留', a);
    ok(!/bbi_image/i.test(a), 'I1.3 无 bbi_image 残留', a);

    // I2：多标记
    const b = clean('前文。\n<bbi_image>cat, soft light\n中段。\n<bbi_image>dog, warm tone\n后文。');
    ok(!/cat, soft|dog, warm/i.test(b), 'I2.1 多个 prompt 都不泄漏', b);
    ok(['前文', '中段', '后文'].every((s) => b.includes(s)), 'I2.2 多标记之间的正文都在', b);

    // I3：prompt 内含 '>'（旧的通用标签规则会只删半截，这里必须整行删）
    const c = clean('文字A。\n<bbi_image>1girl, rating: general> safe, masterpiece\n文字B。');
    ok(!/rating:|masterpiece|safe,/i.test(c), 'I3.1 含 ">" 的 prompt 被完整删除', c);
    ok(c.includes('文字A') && c.includes('文字B'), 'I3.2 含 ">" 场景前后正文保留', c);

    // I4：大小写变体
    ok(!/Cat, studio/i.test(clean('文字。\n<BBI_IMAGE>Cat, studio\n文字。')), 'I4.1 大写 BBI_IMAGE 同样被清理');

    // I5：标记在文件末尾（无后续换行）
    const e = clean('只有前文。\n<bbi_image>lone prompt here');
    ok(!/lone prompt here/i.test(e) && e.includes('只有前文'), 'I5.1 行末标记被删且前文保留', e);

    // I6：回归 —— 无标记正文逐字节不变
    const plain = '　　纯正文第一段。\n\n　　第二段含 <status>HP:1</status> 与 &lt;b&gt;实体&lt;/b&gt;。';
    eq(clean(plain), clean(plain.replace(/<bbi_image[^\n]*/gi, '')), 'I6.1 无标记正文输出逐字节不变');

    // I7：默认黑名单未被改动（回归：方案 A 会误删前文，已验证排除）
    ok(!String(api.DEFAULT_SETTINGS.exclude_tags || '').includes('bbi_image'),
        'I7.1 DEFAULT_SETTINGS.exclude_tags 未被加入 bbi_image（避免误删前文）');
}

// ==================== J. 图片电子书：图片清单与结构化正文（P0.5 / P1）====================
// 契约（实机核对）：
//   · extra.bbiImage["0"][<promptHash>][i]，**存储顺序不保证等于 slotSeq 顺序**（实测 [2,1,0]）
//   · 正文 <bbi_image> 标记数 == 图片数（实测 56/56）；标记 + prompt 到行末
//   · path = /user/images/<聊天目录>/<文件>.jpg（中文未编码）
async function groupJ() {
    console.log('\n=== J. 图片电子书：图片清单 / 原位保真 / 结构化正文 ===');
    let api;
    try {
        api = loadIndexModule();
    } catch (e) {
        ok(false, 'J0 index.js 可加载', String(e && e.message));
        return;
    }

    // 构造 bbiImage（故意按乱序存储，验证排序）
    const bbi = (slots) => {
        const bucket = {};
        for (const s of slots) {
            bucket['h' + s.slotSeq] = [{
                generationId: 'g' + s.slotSeq,
                path: s.path,
                prompt: s.prompt || ('prompt' + s.slotSeq),
                seed: 1,
                status: s.status || 'ready',
                createdAt: 1,
                slotSeq: s.slotSeq
            }];
        }
        return { '0': bucket };
    };
    const hApi = (chat) => {
        const settings = { naming_rule: 'char_chat', chapter_style: 'numbered_floor', include_user_dialogue: false };
        const ctx = {
            chat,
            chatId: '契约测试.jsonl',
            chatMetadata: {},
            characters: [{ name: '艾莉丝', chat: '艾莉丝 - 2026-10-17' }],
            this_chid: 0,
            extension_settings: { autoSaveTxt: settings },
            currentUser: { name: '测试者' },
            getRequestHeaders: () => ({}),
            saveSettingsDebounced: () => {},
            eventSource: null,
            event_types: null
        };
        const mod = loadIndexModule({ deps: { getContext: () => ctx } });
        return { mod, settings: mod.getSettings() };
    };

    // J1：无图消息 → TXT 输出与此前完全一致（回归锁）
    {
        const chat = [{ mes: '　　她推开门。\n\n　　夜色如墨。', is_user: false, name: '艾莉丝', extra: {} }];
        const { mod, settings } = hApi(chat);
        const built = mod.buildNovelText(settings, chat);
        eq(built.novelText,
            '《艾莉丝 - 2026-10-17》\n\n第 1 章 · 艾莉丝 (原楼层: 1)\n\n　　她推开门。\n\n　　夜色如墨。\n\n\n',
            'J1.1 无图消息的 TXT 输出逐字节不变');
    }

    // J2：有图消息 → 默认 TXT 路径不泄漏占位符/prompt
    {
        const chat = [{
            mes: '　　她推开门。\n<bbi_image>1boy 1girl, close-up, pink hair\n　　夜色如墨。',
            is_user: false, name: '艾莉丝',
            extra: { bbiImage: bbi([{ path: '/user/images/契约测试/a.jpg', slotSeq: 0 }]) }
        }];
        const { mod, settings } = hApi(chat);
        const built = mod.buildNovelText(settings, chat);
        ok(!built.novelText.includes('IMGMARK'), 'J2.1 默认 TXT 不含内部占位符');
        ok(!/1boy|pink hair/i.test(built.novelText), 'J2.2 默认 TXT 不含图片 prompt');
        ok(built.novelText.includes('她推开门') && built.novelText.includes('夜色如墨'), 'J2.3 默认 TXT 正文完好');
    }

    // J3：结构化正文 —— 原位图片块
    {
        const chat = [{
            mes: '　　她推开门。\n<bbi_image>first\n　　中间段落。\n<bbi_image>second\n　　结尾段落。',
            is_user: false, name: '艾莉丝',
            extra: {
                bbiImage: bbi([
                    { path: '/user/images/契约测试/a.jpg', prompt: '<bbi_image>first', slotSeq: 0 },
                    { path: '/user/images/契约测试/b.jpg', prompt: '<bbi_image>second', slotSeq: 1 }
                ])
            }
        }];
        const { mod, settings } = hApi(chat);
        const s = mod.buildStructuredNovel(settings, chat);
        eq(s.chapters.length, 1, 'J3.1 生成 1 章');
        const blocks = s.chapters[0].blocks;
        eq(blocks.map((b) => b.type), ['text', 'image', 'text', 'image', 'text'], 'J3.2 块序列：文字/图/文字/图/文字');
        const imgs = blocks.filter((b) => b.type === 'image');
        eq(imgs.map((x) => x.path), ['/user/images/契约测试/a.jpg', '/user/images/契约测试/b.jpg'], 'J3.3 两张图 path 与顺序正确');
        ok(imgs.every((x) => /first|second/.test(x.alt)), 'J3.4 图片 alt 用 prompt 摘要');
        const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('|');
        ok(['她推开门', '中间段落', '结尾段落'].every((x) => texts.includes(x)), 'J3.5 三段正文都在原位');
        ok(!texts.includes('IMGMARK') && !/first|second/i.test(texts), 'J3.6 正文不含占位符与 prompt');
        eq(s.imagesFound, 2, 'J3.7 imagesFound === 2');
        eq(s.warnings.length, 0, 'J3.8 无降级警告');
    }

    // J4：slotSeq 乱序存储 → 必须按 slotSeq 排序（关键陷阱）
    {
        const bucket = {
            hA: [{ path: '/user/images/c/a.jpg', prompt: 'p0', slotSeq: 2, status: 'ready' }],
            hB: [{ path: '/user/images/c/b.jpg', prompt: 'p1', slotSeq: 0, status: 'ready' }],
            hC: [{ path: '/user/images/c/c.jpg', prompt: 'p2', slotSeq: 1, status: 'ready' }]
        };
        const chat = [{
            mes: '文字。\n<bbi_image>p0\n<bbi_image>p1\n<bbi_image>p2',
            is_user: false, name: '艾莉丝', extra: { bbiImage: { '0': bucket } }
        }];
        const { mod, settings } = hApi(chat);
        const s = mod.buildStructuredNovel(settings, chat);
        const imgs = s.chapters[0].blocks.filter((b) => b.type === 'image');
        eq(imgs.map((x) => x.slotSeq), [0, 1, 2], 'J4.1 图片按 slotSeq 升序（不是存储顺序）');
        eq(imgs.map((x) => x.path),
            ['/user/images/c/b.jpg', '/user/images/c/c.jpg', '/user/images/c/a.jpg'],
            'J4.2 path 与 slotSeq 一一对应');
    }

    // J5：标记数≠图片数 → 降级章尾，不丢图且有警告
    {
        const chat = [{
            mes: '　　正文。\n<bbi_image>only one marker',
            is_user: false, name: '艾莉丝',
            extra: {
                bbiImage: bbi([
                    { path: '/user/images/c/a.jpg', slotSeq: 0 },
                    { path: '/user/images/c/b.jpg', slotSeq: 1 }
                ])
            }
        }];
        const { mod, settings } = hApi(chat);
        const s = mod.buildStructuredNovel(settings, chat);
        const blocks = s.chapters[0].blocks;
        eq(blocks.filter((b) => b.type === 'image').length, 2, 'J5.1 降级后两张图都不丢');
        eq(blocks[blocks.length - 1].type, 'image', 'J5.2 降级时图片放章尾');
        ok(s.warnings.length === 1 && /标记数/.test(s.warnings[0]), 'J5.3 有降级警告', JSON.stringify(s.warnings));
    }

    // J6：图片清单扫描（P0.5）
    {
        const chat = [
            { mes: '无图楼层。', is_user: false, name: '艾莉丝', extra: {} },
            { mes: '有图。\n<bbi_image>p0', is_user: false, name: '艾莉丝', extra: { bbiImage: bbi([{ path: '/user/images/c/a.jpg', slotSeq: 0 }]) } },
            {
                mes: '两张图。\n<bbi_image>p0\n<bbi_image>p1', is_user: false, name: '艾莉丝',
                extra: { bbiImage: bbi([{ path: '/user/images/c/b.jpg', slotSeq: 0 }, { path: '/user/images/c/c.jpg', slotSeq: 1 }]) }
            }
        ];
        const { mod, settings } = hApi(chat);
        const scan = mod.scanBookImages(settings, chat);
        eq(scan.imageMessages, 2, 'J6.1 2 条消息含图');
        eq(scan.totalImages, 3, 'J6.2 共 3 张图');
        eq(scan.degradedCount, 0, 'J6.3 无降级');
        eq(scan.messages.map((m) => m.markerCount), [1, 2], 'J6.4 各消息标记数正确');
        eq(scan.messages.map((m) => m.imageCount), [1, 2], 'J6.5 各消息图片数正确');
    }

    // J7：非 ready 图片 → 不进原位、单独统计 missing
    {
        const chat = [{
            mes: '正文。\n<bbi_image>p0',
            is_user: false, name: '艾莉丝',
            extra: {
                bbiImage: bbi([
                    { path: '/user/images/c/a.jpg', slotSeq: 0, status: 'failed' },
                    { path: '/user/images/c/b.jpg', slotSeq: 1, status: 'ready' }
                ])
            }
        }];
        const { mod, settings } = hApi(chat);
        const scan = mod.scanBookImages(settings, chat);
        eq(scan.degradedCount, 0, 'J7.1 非 ready 图不导致降级（可嵌入数=标记数）');
        eq(scan.messages[0].notReadyCount, 1, 'J7.2 单独统计非 ready 图片数');
        ok(scan.missingList.length >= 1, 'J7.3 非 ready 图记入 missingList');
    }

    // J8：extra 缺失 / 结构异常 → 不抛异常、返回空清单（防御式）
    {
        const chat = [
            { mes: '正文。', is_user: false, name: '艾莉丝' },
            { mes: '正文。', is_user: false, name: '艾莉丝', extra: null },
            { mes: '正文。', is_user: false, name: '艾莉丝', extra: { bbiImage: null } },
            { mes: '正文。', is_user: false, name: '艾莉丝', extra: { bbiImage: { '0': { h: [] } } } }
        ];
        const { mod, settings } = hApi(chat);
        let threw = null;
        let scan = null;
        try { scan = mod.scanBookImages(settings, chat); } catch (e) { threw = e; }
        ok(!threw, 'J8.1 extra 缺失/异常时不抛异常', threw && threw.message);
        eq(scan && scan.totalImages, 0, 'J8.2 异常结构返回 0 张图');
    }
}

// ==================== K. EPUB 导出前端契约（P2 配套）====================
// J 组覆盖了单章内的原位保真/乱序/降级/清单；K 组补的是 J 未覆盖的分支：
//   ① 多消息 → 结构化章节数必须与 buildNovelText 完全同口径（回归：只处理首条消息 = 只导出第 1 章）
//   ② 无图消息的结构化输出（全 text / imagesFound=0 / 无警告）
//   ③ 原位保真的严格形式（正文块逐字相等，而非子串包含）
//   ④ 乱序 + 数组形态 bucket（J4 只覆盖单图对象形态）
//   ⑤ 反向不一致（标记数 > 图片数）也降级
//   ⑥ 默认 TXT 路径：开关关闭时与"无图片参与"的输出**逐字节相等**（J2 只验证"不含"）
//   ⑦ scanBookImages 的章节/楼层映射（J6 只验证计数）
//   ⑧ extractBbiImageList 防御式矩阵（含 Lead 点名的 {"0":{}}）
async function groupK() {
    console.log('\n=== K. EPUB 导出前端契约：多章结构化 / 无图 / 默认路径零变化 ===');
    let api;
    try {
        api = loadIndexModule();
    } catch (e) {
        ok(false, 'K0 index.js 可加载', String(e && e.message));
        return;
    }

    const bbi = (slots) => {
        const bucket = {};
        for (const sl of slots) {
            bucket['h' + sl.slotSeq] = [{
                generationId: 'g' + sl.slotSeq, path: sl.path,
                prompt: sl.prompt || ('prompt' + sl.slotSeq), seed: 1,
                status: sl.status || 'ready', createdAt: 1, slotSeq: sl.slotSeq
            }];
        }
        return { '0': bucket };
    };
    const kApi = (chat, settingsOverride) => {
        const settings = Object.assign({
            naming_rule: 'char_chat', chapter_style: 'numbered_floor', include_user_dialogue: false
        }, settingsOverride || {});
        const ctx = {
            chat, chatId: '契约测试.jsonl', chatMetadata: {},
            characters: [{ name: '艾莉丝', chat: '艾莉丝 - 2026-10-17' }], this_chid: 0,
            extension_settings: { autoSaveTxt: settings }, currentUser: { name: '测试者' },
            getRequestHeaders: () => ({}), saveSettingsDebounced: () => {},
            eventSource: null, event_types: null
        };
        const mod = loadIndexModule({ deps: { getContext: () => ctx } });
        return { mod, settings: mod.getSettings() };
    };

    // ---- K1：多消息 → 结构化章节数/标题必须与 buildNovelText 完全同口径 ----
    // 这是 EPUB 导出的主链路：buildEbookPayload(settings, chatLog) 会把完整 chatLog 传进来。
    // 若结构化只处理首条消息，导出的 EPUB 就只剩第 1 章（TXT 不受影响，故极易漏测）。
    {
        const chat = [
            { mes: '　　第一楼正文。', is_user: false, name: '艾莉丝' },
            { mes: '　　第二楼正文。', is_user: false, name: '艾莉丝' },
            { mes: '　　第三楼正文。', is_user: false, name: '艾莉丝' }
        ];
        const { mod, settings } = kApi(chat);
        const st = mod.buildStructuredNovel(settings, chat);
        const plain = mod.buildNovelText(settings, chat);
        eq(st.chapterCount, 3, 'K1.1 多消息：结构化章节数 = 3（与 buildNovelText 同口径）');
        eq(st.chapters.length, 3, 'K1.2 多消息：chapters 数组包含全部 3 章');
        eq(st.chapters.map((c) => c.title), [
            '第 1 章 · 艾莉丝 (原楼层: 1)',
            '第 2 章 · 艾莉丝 (原楼层: 2)',
            '第 3 章 · 艾莉丝 (原楼层: 3)'
        ], 'K1.3 多消息：章节标题与楼层映射正确');
        eq(st.chapterCount, plain.chapterCount, 'K1.4 多消息：chapterCount 与 buildNovelText 完全一致');
    }

    // ---- K2：无图消息 → 结构化输出全 text、imagesFound=0、无降级警告 ----
    // 用单消息，避免与 K1 的多消息缺陷混在一起判断。
    {
        const chat = [{
            mes: '　　第一段。\n\n　　第二段。', is_user: false, name: '艾莉丝', extra: {}
        }];
        const { mod, settings } = kApi(chat);
        const st = mod.buildStructuredNovel(settings, chat);
        eq(st.chapters.length, 1, 'K2.1 无图：生成 1 章');
        ok(st.chapters[0].blocks.every((b) => b.type === 'text'),
            'K2.2 无图：blocks 全部是 text', JSON.stringify(st.chapters[0].blocks.map((b) => b.type)));
        eq(st.imagesFound, 0, 'K2.3 无图：imagesFound === 0');
        eq(st.warnings.length, 0, 'K2.4 无图：无降级警告');
    }

    // ---- K3：原位保真严格版（J3 用子串包含，这里要求正文块逐字相等）----
    {
        const chat = [{
            mes: '　　文字A\n<bbi_image>p0\n　　文字B\n<bbi_image>p1\n　　文字C',
            is_user: false, name: '艾莉丝',
            extra: {
                bbiImage: bbi([
                    { path: '/user/images/契约测试/p0.jpg', prompt: '<bbi_image>p0', slotSeq: 0 },
                    { path: '/user/images/契约测试/p1.jpg', prompt: '<bbi_image>p1', slotSeq: 1 }
                ])
            }
        }];
        const { mod, settings } = kApi(chat);
        const blocks = mod.buildStructuredNovel(settings, chat).chapters[0].blocks;
        eq(blocks.map((b) => b.type), ['text', 'image', 'text', 'image', 'text'],
            'K3.1 块序列严格为 text,image,text,image,text');
        eq(blocks.filter((b) => b.type === 'text').map((b) => b.text), ['文字A', '文字B', '文字C'],
            'K3.2 三个正文块与原文逐字相等（不只是包含）');
        eq(blocks.filter((b) => b.type === 'image').map((b) => ({ path: b.path, slotSeq: b.slotSeq })), [
            { path: '/user/images/契约测试/p0.jpg', slotSeq: 0 },
            { path: '/user/images/契约测试/p1.jpg', slotSeq: 1 }
        ], 'K3.3 图片块 path/slotSeq 严格对应');
        const allText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('|');
        ok(!/IMGMARK|<bbi_image|p0|p1/i.test(allText), 'K3.4 正文块不含占位符 / 标记 / prompt', allText);
    }

    // ---- K4：乱序 + 数组形态 bucket（J4 只覆盖「单图对象」形态）----
    {
        const chat = [{
            mes: '文字。\n<bbi_image>a\n<bbi_image>b\n<bbi_image>c',
            is_user: false, name: '艾莉丝',
            extra: { bbiImage: {
                '0': {
                    hA: [{ path: '/user/images/c/a.jpg', prompt: 'pa', slotSeq: 2, status: 'ready' }],
                    hB: [
                        { path: '/user/images/c/b.jpg', prompt: 'pb', slotSeq: 0, status: 'ready' },
                        { path: '/user/images/c/c.jpg', prompt: 'pc', slotSeq: 1, status: 'ready' }
                    ]
                }
            } }
        }];
        const { mod, settings } = kApi(chat);
        const imgs = mod.buildStructuredNovel(settings, chat).chapters[0].blocks
            .filter((b) => b.type === 'image');
        eq(imgs.map((x) => x.slotSeq), [0, 1, 2], 'K4.1 数组形态 + 乱序存储 → 仍按 slotSeq 升序');
        eq(imgs.map((x) => x.path),
            ['/user/images/c/b.jpg', '/user/images/c/c.jpg', '/user/images/c/a.jpg'],
            'K4.2 数组形态下 path 与 slotSeq 一一对应');
    }

    // ---- K5：反向不一致（标记数 > 图片数）也必须降级，且不丢图 ----
    {
        const chat = [{
            mes: '正文。\n<bbi_image>m1\n<bbi_image>m2',
            is_user: false, name: '艾莉丝',
            extra: { bbiImage: bbi([{ path: '/user/images/c/a.jpg', slotSeq: 0 }]) }
        }];
        const { mod, settings } = kApi(chat);
        const st = mod.buildStructuredNovel(settings, chat);
        eq(st.chapters[0].blocks.filter((b) => b.type === 'image').length, 1,
            'K5.1 标记多于图片时图片不丢（1 张仍在）');
        ok(st.warnings.length === 1 && /标记数/.test(st.warnings[0]),
            'K5.2 标记数>图片数 也产生降级警告', JSON.stringify(st.warnings));
        eq(mod.scanBookImages(settings, chat).degradedCount, 1, 'K5.3 清单扫描同样标记降级');
    }

    // ---- K6：默认 TXT 路径零变化（最关键回归）----
    // 同一 chat（带图 + 带标记），开关关闭时 buildNovelText 必须与内联期望**逐字节相等**；
    // 也必须与「同正文但不带 extra」完全一致 —— 证明图片功能对既有 TXT 通道零侵入。
    {
        const mesWithMarker = '　　她推开门。\n<bbi_image>1boy 1girl, close-up, pink hair\n　　夜色如墨。';
        const chat = [{
            mes: mesWithMarker, is_user: false, name: '艾莉丝',
            extra: { bbiImage: bbi([{ path: '/user/images/契约测试/a.jpg', slotSeq: 0 }]) }
        }];
        const { mod, settings } = kApi(chat, { ebook_embed_images: false });
        const built = mod.buildNovelText(settings, chat);
        const expected = '《艾莉丝 - 2026-10-17》\n\n第 1 章 · 艾莉丝 (原楼层: 1)\n\n　　她推开门。\n\n　　夜色如墨。\n\n\n';
        eq(built.novelText, expected, 'K6.1 开关关闭：TXT 输出与内联期望逐字节相等');
        const chatNoExtra = [{ mes: mesWithMarker, is_user: false, name: '艾莉丝' }];
        eq(built.novelText, mod.buildNovelText(settings, chatNoExtra).novelText,
            'K6.2 开关关闭：与「同正文不带 extra」输出完全一致（功能零侵入）');
        ok(!built.novelText.includes('IMGMARK'), 'K6.3 默认 TXT 不含内部占位符 IMGMARK');
        ok(!built.novelText.includes('<bbi_image'), 'K6.4 默认 TXT 不含 bbi_image 标记');
    }

    // ---- K7：scanBookImages 的章节/楼层映射（J6 只验证计数）----
    {
        const chat = [
            { mes: '无图楼层。', is_user: false, name: '艾莉丝', extra: {} },
            { mes: '一图。\n<bbi_image>p0', is_user: false, name: '艾莉丝', extra: { bbiImage: bbi([{ path: '/user/images/c/a.jpg', slotSeq: 0 }]) } },
            {
                mes: '两图一标记。\n<bbi_image>p0', is_user: false, name: '艾莉丝',
                extra: { bbiImage: bbi([{ path: '/user/images/c/b.jpg', slotSeq: 0 }, { path: '/user/images/c/c.jpg', slotSeq: 1 }]) }
            }
        ];
        const { mod, settings } = kApi(chat);
        const scan = mod.scanBookImages(settings, chat);
        eq(scan.messages.map((m) => m.index), [1, 2], 'K7.1 只把含图楼层列入清单（index 正确）');
        eq(scan.messages.map((m) => m.chapter), [2, 3], 'K7.2 章节号按有效楼层累计（chapter 正确）');
        eq(scan.messages.map((m) => m.floor), [2, 3], 'K7.3 原楼层 = index + 1（floor 正确）');
        eq(scan.degradedCount, 1, 'K7.4 混合清单里降级楼层计入 degradedCount');
    }

    // ---- K8：extractBbiImageList 防御式矩阵（含 {"0":{}}）----
    {
        const msgs = [
            { mes: 'x', is_user: false },                                  // 无 extra
            { mes: 'x', is_user: false, extra: null },                    // extra=null
            { mes: 'x', is_user: false, extra: {} },                      // extra={}
            { mes: 'x', is_user: false, extra: { bbiImage: null } },      // bbiImage=null
            { mes: 'x', is_user: false, extra: { bbiImage: 'str' } },     // 非对象
            { mes: 'x', is_user: false, extra: { bbiImage: {} } },        // 空对象
            { mes: 'x', is_user: false, extra: { bbiImage: { '0': {} } } },        // 空 bucket（Lead 点名）
            { mes: 'x', is_user: false, extra: { bbiImage: { '0': { h: [] } } } }  // 空数组
        ];
        let threw = null;
        const outs = [];
        try {
            for (const m of msgs) outs.push(api.extractBbiImageList(m));
        } catch (e) { threw = e; }
        ok(!threw, 'K8.1 全部防御式输入都不抛异常', threw && threw.message);
        ok(outs.length === msgs.length && outs.every((o) => Array.isArray(o) && o.length === 0),
            'K8.2 全部防御式输入都返回空数组', JSON.stringify(outs.map((o) => (Array.isArray(o) ? o.length : o))));
    }
}

// ==================== 执行 + 清理 ====================
(async () => {
    let fatal = null;
    try {
        await main();
    } catch (e) {
        fatal = e;
        // 致命异常必须计入失败数：否则汇总行会打印"通过 N, 失败 0"却 exit 1，
        // 看起来像假绿灯（实测踩到过：index.js 语法被突变坏时 loadIndexModule 抛错）。
        fail++;
        failList.push('致命异常：' + (e && e.message));
        console.error('\n[FAIL] 测试执行异常：' + (e && e.message));
        console.error(e && e.stack);
    } finally {
        // 无论成功/异常都清理：临时目录里有 .bak、.tmp-*、txt，绝不留在磁盘上
        try {
            fs.rmSync(TMP_ROOT, { recursive: true, force: true });
        } catch (e) { /* 清理失败不覆盖原错误 */ }
        const leftover = fs.existsSync(TMP_ROOT);
        console.log(`\n清理: ${TMP_ROOT} ${leftover ? '仍存在（清理失败！）' : '已删除'}`);
    }

    console.log(`\n契约测试结果: 通过: ${pass}, 失败: ${fail}`);
    if (fail > 0) {
        console.error('失败用例：' + failList.join('；'));
        process.exit(1);
    }
    if (fatal) process.exit(1);
    console.log('本轮修复契约（替换守卫 / 重复追加守卫 / 备份与原子写 / 问候语入书 / 转义 / 长章节防重 / 端到端时序 / 命名同源 / bbi 标记清理）全部符合预期');
})();
