/**
 * 楼层"已入书"章节映射（computeChapterMap）单元测试
 * 运行方式: node test/test-chapter-map.js
 *
 * 注意：与 test-tag-scanner.js 同模式，以下为从 index.js 复制的纯函数副本，前端模块为 ES module 无法直接 require。
 * cleanNovelText 在此为简化桩（仅驱动占号逻辑的"过滤后为空"分支）——真实清洗引擎由 test-think.js / test-universal-tags.js 锁定测试。
 */

// 清洗结果缓存：同一会话内避免每条消息被 cleanNovelText 重复全量正则清洗（O(n²) 性能优化）
const cleanTextCache = { sig: '', map: new Map() };

function getCleanMessageSig(settings) {
    return `${settings.include_tags || ''}|${settings.exclude_tags || ''}|${settings.indent_paragraphs !== false}`;
}

/**
 * 简化清洗桩：仅保留"注释剔除 + 黑名单成对块剔除 + 标签剥壳 + 段落化"行为，
 * 足够驱动 computeChapterMap 的"被过滤为空的楼层跳过不占号"逻辑
 */
function cleanNovelText(rawText, settings = {}) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText.replace(/<!--[\s\S]*?-->/g, '');
    const excludeTags = ['status', 'memory', 'details', 'ooc', 'note'];
    for (const tag of excludeTags) {
        const pairReg = new RegExp(`<\\s*(${tag})[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>\\s*`, 'gi');
        text = text.replace(pairReg, '');
    }
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '');
    const paragraphs = text.split(/\r?\n+/).map(p => p.trim()).filter(p => p.length > 0);
    return paragraphs.join('\n\n');
}

/**
 * 带缓存的消息清洗（与 index.js 同款签名与缓存语义）
 */
function getCleanedMessage(msg, index, settings) {
    if (!msg) return '';
    const sig = getCleanMessageSig(settings);
    if (cleanTextCache.sig !== sig) {
        cleanTextCache.sig = sig;
        cleanTextCache.map.clear();
    }
    const cached = cleanTextCache.map.get(index);
    if (cached && cached.src === msg && cached.mes === msg.mes) return cached.text;
    const text = cleanNovelText(msg.mes || '', settings);
    cleanTextCache.map.set(index, { src: msg, mes: msg.mes, text });
    return text;
}

/**
 * 楼层序号 → 已入书章节号（徽标展示用；切换聊天时重算）——与 index.js 逐字一致
 */
function computeChapterMap(settings, chatLog) {
    const map = {};
    if (!Array.isArray(chatLog)) return map;
    let chapter = 0;
    for (let i = 0; i < chatLog.length; i++) {
        const m = chatLog[i];
        if (!m) continue;
        if (m.is_user && !settings.include_user_dialogue) continue;
        if (getCleanedMessage(m, i, settings)) { chapter++; map[i] = chapter; }
    }
    return map;
}

let passCount = 0;
let failCount = 0;

function assert(condition, testName) {
    if (condition) {
        console.log(`[PASS] ${testName}`);
        passCount++;
    } else {
        console.error(`[FAIL] ${testName}`);
        failCount++;
    }
}

function assertDeepEqual(actual, expected, testName) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`[PASS] ${testName}`);
        passCount++;
    } else {
        console.error(`[FAIL] ${testName}`);
        console.error('Expected: ' + JSON.stringify(expected));
        console.error('Got:      ' + JSON.stringify(actual));
        failCount++;
    }
}

const baseSettings = { include_user_dialogue: false, indent_paragraphs: true };

// 测试 1: 普通混合聊天编号（关闭用户对白：用户楼层不入书不占号）
{
    const chatLog = [
        { is_user: true, mes: '用户的提问' },
        { is_user: false, mes: '第一段剧情正文' },
        { is_user: true, mes: '用户的第二次提问' },
        { is_user: false, mes: '第二段剧情正文' },
        { is_user: false, mes: '第三段剧情正文' }
    ];
    assertDeepEqual(computeChapterMap(baseSettings, chatLog), { 1: 1, 3: 2, 4: 3 }, '测试 1.1: 用户楼层跳过，AI 楼层连续编号 1/2/3');
}

// 测试 2: include_user_dialogue 开启后用户楼层入书并参与占号
{
    const settings = { ...baseSettings, include_user_dialogue: true };
    const chatLog = [
        { is_user: true, mes: '用户的提问' },
        { is_user: false, mes: '第一段剧情正文' },
        { is_user: true, mes: '用户的第二次提问' },
        { is_user: false, mes: '第二段剧情正文' }
    ];
    assertDeepEqual(computeChapterMap(settings, chatLog), { 0: 1, 1: 2, 2: 3, 3: 4 }, '测试 2.1: 开启主角对白后用户楼层入书占号');
}

// 测试 3: 被过滤为空的楼层跳过且不占章节号（编号不被掏空）
{
    const chatLog = [
        { is_user: false, mes: '<story>第一章正文</story>' },
        { is_user: false, mes: '<status>HP: 1/1</status>' },
        { is_user: false, mes: '<memory>仅记忆块，无正文</memory>' },
        { is_user: false, mes: '第三章正文' }
    ];
    assertDeepEqual(computeChapterMap(baseSettings, chatLog), { 0: 1, 3: 2 }, '测试 3.1: 纯黑名单块的楼层被跳过且不消耗章节号');
}

// 测试 4: 混合边界（null 楼层、空正文、纯空白）全部安全跳过
{
    const chatLog = [
        null,
        { is_user: false, mes: '' },
        { is_user: false, mes: '   \n\n  ' },
        { is_user: false, mes: '有效正文' },
        { is_user: false, mes: '<ooc>仅旁注</ooc>' }
    ];
    assertDeepEqual(computeChapterMap(baseSettings, chatLog), { 3: 1 }, '测试 4.1: null/空/纯空白/纯剔除块楼层全部跳过，仅有效楼层占第 1 章');
}

// 测试 5: 空聊天与非数组输入返回空映射
assertDeepEqual(computeChapterMap(baseSettings, []), {}, '测试 5.1: 空聊天返回空映射');
assertDeepEqual(computeChapterMap(baseSettings, null), {}, '测试 5.2: 非数组输入返回空映射（循环零次）');

console.log(`\n=== 楼层入书章节映射测试结果: 通过: ${passCount}, 失败: ${failCount} ===`);
if (failCount > 0) {
    process.exit(1);
} else {
    console.log('所有楼层入书章节映射测试全部通过！');
}
