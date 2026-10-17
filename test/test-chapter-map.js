/**
 * 楼层"已入书"章节映射（computeChapterMap）单元测试
 * 运行方式: node test/test-chapter-map.js
 *
 * 本测试**不再手抄副本**：computeChapterMap / getCleanedMessage / getCleanMessageSig
 * 以及清洗缓存 cleanTextCache 全部取自 index.js 真实实现（见 test/_helpers/load-index.js）。
 * 原先的「简化清洗桩」已删除 —— 占号逻辑依赖的真实清洗行为（注释剔除、黑名单、
 * 未闭合尾部标签、空段落过滤、缩进）一律由真实 cleanNovelText 决定。
 */

const { loadIndexModule } = require('./_helpers/load-index.js');
const api = loadIndexModule();
const { computeChapterMap, getCleanedMessage, getCleanMessageSig, cleanTextCache } = api;

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

// 测试 0: 真实实现的缓存对象与签名函数已就位（下面缓存语义用例依赖它们）
assert(cleanTextCache && cleanTextCache.map instanceof Map && typeof cleanTextCache.sig === 'string',
    '测试 0.1: cleanTextCache 为真实缓存对象（Map + sig）');
assertDeepEqual(
    getCleanMessageSig({ include_tags: 'story', exclude_tags: 'status', indent_paragraphs: false }),
    'story|status|false',
    '测试 0.2: getCleanMessageSig 拼装 include|exclude|indent 签名'
);
assertDeepEqual(getCleanMessageSig({}), '||true', '测试 0.3: 缺省设置下 indent 视为开启（||true）');

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

// 测试 6: getCleanedMessage 缓存语义（与 index.js 同款：消息对象/内容/签名变化都要重洗）
{
    const settings = { include_tags: '', exclude_tags: 'status', indent_paragraphs: true };
    cleanTextCache.sig = '';
    cleanTextCache.map.clear();
    const a = { is_user: false, mes: '<status>HP:1</status>正文甲' };
    const b = { is_user: false, mes: '正文乙' };
    const chatLog = [a, b];

    const first = getCleanedMessage(a, 0, settings);
    assertDeepEqual(first, '　　正文甲', '测试 6.1: 首次清洗按真实引擎输出');

    // 原地改写 mes（酒馆编辑消息 / 切分支的真实行为）→ 缓存必须失效重洗
    a.mes = '<status>HP:2</status>正文甲改';
    assertDeepEqual(getCleanedMessage(a, 0, settings), '　　正文甲改', '测试 6.2: 同一消息对象 mes 原地改写后缓存失效重洗');

    // 换对象（Regenerate / Swipe 会替换消息对象）→ 缓存同样必须失效
    chatLog[1] = { is_user: false, mes: '正文乙' };
    assertDeepEqual(getCleanedMessage(chatLog[1], 1, settings), '　　正文乙', '测试 6.3: 消息对象被替换后按新对象清洗');

    // 设置签名变化 → 全量清缓存
    const otherSettings = { include_tags: '', exclude_tags: '', indent_paragraphs: true };
    assertDeepEqual(getCleanedMessage(a, 0, otherSettings), '　　HP:2正文甲改', '测试 6.4: 黑名单设置变化后缓存按新签名重洗');
}

console.log(`\n=== 楼层入书章节映射测试结果: 通过: ${passCount}, 失败: ${failCount} ===`);
if (failCount > 0) {
    process.exit(1);
} else {
    console.log('所有楼层入书章节映射测试全部通过！');
}
