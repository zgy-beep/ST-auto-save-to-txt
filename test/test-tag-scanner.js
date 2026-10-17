/**
 * 会话标签检测器（scanChatTags / parseTagList / isAuxiliaryTag）单元测试
 * 运行方式: node test/test-tag-scanner.js
 *
 * 本测试**不再手抄副本**：直接加载 index.js 的真实实现（见 test/_helpers/load-index.js）。
 * 忽略集合（INLINE_TAGS / SCAN_IGNORE_TAGS）也从真实模块取用并做正向断言，
 * 防止「副本里忽略集合悄悄改小、测试照样绿」。
 */

const { loadIndexModule } = require('./_helpers/load-index.js');
const api = loadIndexModule();
const { parseTagList, scanChatTags, isAuxiliaryTag, DEFAULT_SETTINGS } = api;
const { INLINE_TAGS, SCAN_IGNORE_TAGS } = api.__internals;

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

// 测试 0: 真实实现自带的忽略集合结构（若被改小/改删，下面用例会连带变红）
assert(SCAN_IGNORE_TAGS instanceof Set && INLINE_TAGS instanceof Set,
    '测试 0.1: SCAN_IGNORE_TAGS / INLINE_TAGS 为真实 Set 实例');
assert(INLINE_TAGS.has('b') && INLINE_TAGS.has('mark'),
    '测试 0.2: INLINE_TAGS 含 b/mark 等行内标签');
assert([...INLINE_TAGS].every(t => SCAN_IGNORE_TAGS.has(t)) && SCAN_IGNORE_TAGS.size > INLINE_TAGS.size,
    '测试 0.2b: SCAN_IGNORE_TAGS 以 INLINE_TAGS 为子集并额外扩了结构标签');
assert(SCAN_IGNORE_TAGS.has('div') && SCAN_IGNORE_TAGS.has('script') && SCAN_IGNORE_TAGS.has('br'),
    '测试 0.3: SCAN_IGNORE_TAGS 含 div/script/br 等结构标签');

// 测试 1: parseTagList 解析（逗号/中文逗号/空白混用 + 尖括号剥离）
assertDeepEqual(parseTagList('status, memory, <ooc> note'), ['status', 'memory', 'ooc', 'note'], '测试 1.1: 混合分隔符与尖括号剥离');
assertDeepEqual(parseTagList(''), [], '测试 1.2: 空字符串返回空数组');
assertDeepEqual(parseTagList('   '), [], '测试 1.3: 纯空白返回空数组');
assertDeepEqual(parseTagList('story,'), ['story'], '测试 1.4: 尾部多余逗号不产生空标签');
assertDeepEqual(parseTagList('状态，记忆'), ['状态', '记忆'], '测试 1.5: 中文逗号正常分隔');

// 测试 2: 基础自定义标签扫描（story/status）+ 计数 + 按次数降序 + 总数统计
{
    const chatLog = [
        { mes: '<story>第一章正文</story>' },
        { mes: '<story>第二章正文</story><status>HP: 90</status>' },
        { mes: '<status>MP: 40</status>' }
    ];
    const { tags, total } = scanChatTags(chatLog);
    assertDeepEqual(tags.map(r => r.tag), ['status', 'story'], '测试 2.1: 结果包含 status 与 story（同次数按名称升序）');
    assertDeepEqual(tags.map(r => r.count), [2, 2], '测试 2.2: story×2、status×2 计数正确');
    assert(tags[0].count >= tags[1].count, '测试 2.3: 结果按出现次数降序排列');
    assert(total === 2, '测试 2.4: 总标签种数统计正确（total=2）');
}

// 测试 3: HTML 结构标签与行内标签全部排除
{
    const chatLog = [
        { mes: '<div><p>段落<br><img src="x"><b>加粗</b><span>行内</span></p></div>' },
        { mes: '<table><tr><td>单元格</td></tr></table><h1>标题</h1><script>var a=1;</script>' }
    ];
    const { tags, total } = scanChatTags(chatLog);
    assertDeepEqual(tags, [], '测试 3.1: <br>/<p>/<img>/<b>/<span>/<div>/<table>/<h1>/<script> 均不出现在结果中');
    assert(total === 0, '测试 3.2: 纯 HTML 标签会话 total 为 0');
}

// 测试 4: 带属性标签与自闭合标签正确识别
{
    const chatLog = [
        { mes: '<story type="novel">带属性正文</story>' },
        { mes: '<custom/>' }
    ];
    const { tags } = scanChatTags(chatLog);
    const tagNames = tags.map(r => r.tag);
    assert(tagNames.includes('story') && tagNames.includes('custom'), '测试 4.1: <story type="novel"> 与 <custom/> 分别识别为 story / custom');
    assertDeepEqual(tags.filter(r => r.tag === 'story').map(r => r.count), [1], '测试 4.2: 带属性开标签仅计 1 次');
}

// 测试 5: details 可检测（不被 SCAN_IGNORE_TAGS 排除，默认黑名单含 details）
{
    const chatLog = [{ mes: '<details>补充设定</details>' }];
    const { tags } = scanChatTags(chatLog);
    assertDeepEqual(tags.map(r => r.tag), ['details'], '测试 5.1: details 可正常被检测器扫出');
    assert(parseTagList(DEFAULT_SETTINGS.exclude_tags).includes('details'),
        '测试 5.2: details 确实在真实 DEFAULT_SETTINGS 黑名单里（与上一条语义对齐）');
}

// 测试 6: 闭标签 </story> 不产生额外计数
{
    const chatLog = [
        { mes: '正文前缀</story>正文后缀' },
        { mes: '<story>甲</story>' }
    ];
    const { tags } = scanChatTags(chatLog);
    assertDeepEqual(tags.map(r => r.tag), ['story'], '测试 6.1: 孤立闭标签不产生误检条目');
    assertDeepEqual(tags.map(r => r.count), [1], '测试 6.2: 成对块的闭标签不重复计数（总计 1 次）');
}

// 测试 7: 标签全量展示绝不截断（构造 20 个不同标签，应全部返回）
{
    const chatLog = [];
    for (let i = 0; i < 20; i++) {
        chatLog.push({ mes: `<tag${String(i).padStart(2, '0')}>内容</tag${String(i).padStart(2, '0')}>` });
    }
    const { tags, total } = scanChatTags(chatLog);
    assert(tags.length === 20, '测试 7.1: 超过 15 个标签时仍全部展示（不截断）');
    assert(total === 20, '测试 7.2: total 与 tags 长度一致（全量返回）');
}

// 测试 8: 健壮性 —— 非数组输入与异常消息对象
assertDeepEqual(scanChatTags(null), { tags: [], total: 0 }, '测试 8.1: null 输入返回空结构');
assertDeepEqual(scanChatTags('not-an-array'), { tags: [], total: 0 }, '测试 8.2: 非数组输入返回空结构');
{
    const chatLog = [null, undefined, {}, { mes: 123 }, { mes: '<story>正常</story>' }];
    const { tags } = scanChatTags(chatLog);
    assertDeepEqual(tags.map(r => r.tag), ['story'], '测试 8.3: 异常消息对象被跳过，正常消息不受影响');
}

// 测试 9: 同次数按标签名字典序升序（排序稳定性）
{
    const chatLog = [
        { mes: '<beta>1</beta><alpha>2</alpha>' },
        { mes: '<beta>3</beta><alpha>4</alpha>' }
    ];
    const { tags } = scanChatTags(chatLog);
    assertDeepEqual(tags.map(r => r.tag), ['alpha', 'beta'], '测试 9.1: 计数相同时按名称升序排列');
}

// 测试 10: 思维链/草稿类标签识别（供 chips「自动」徽标使用，与清洗引擎行为保持一致）
assert(isAuxiliaryTag('think') && isAuxiliaryTag('think_fox~') && isAuxiliaryTag('agent:cot'), '测试 10.1: think/think_fox~/agent:cot 判定为思维链标签');
assert(isAuxiliaryTag('scratchpad') && isAuxiliaryTag('inner_thought') && isAuxiliaryTag('cot') && isAuxiliaryTag('analysis') && isAuxiliaryTag('plan'), '测试 10.2: scratchpad/inner_thought/cot/analysis/plan 判定为思维链标签');
assert(!isAuxiliaryTag('story') && !isAuxiliaryTag('status') && !isAuxiliaryTag('response') && !isAuxiliaryTag('content') && !isAuxiliaryTag('details'), '测试 10.3: 普通正文标签不误标');
assert(!isAuxiliaryTag('') && !isAuxiliaryTag(null) && !isAuxiliaryTag(123), '测试 10.4: 异常输入安全返回 false');

console.log(`\n=== 会话标签检测器测试结果: 通过: ${passCount}, 失败: ${failCount} ===`);
if (failCount > 0) {
    process.exit(1);
} else {
    console.log('所有会话标签检测器测试全部通过！');
}
