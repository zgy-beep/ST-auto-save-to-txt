/**
 * 思考链/孤立闭标签清洗（cleanNovelText）回归测试
 * 运行方式: node test/test-think.js
 *
 * 本测试**不再手抄副本**：直接加载 index.js 的真实实现（见 test/_helpers/load-index.js）。
 * 历史教训：副本里的「开篇无头闭标签」正则仍是 `[a-zA-Z0-9_\-~.:#]+`（允许数字开头），
 * 而线上实现（index.js:1232）已收紧为 `[a-zA-Z][a-zA-Z0-9_\-~.:#]*`，
 * 于是 `</3d>` 这类数字开头的伪标签行为在测试里永远是"对的"——副本与实现各说各话。
 * 测试 8 就是针对该漂移补的正式用例。
 */

const { loadIndexModule } = require('./_helpers/load-index.js');
const api = loadIndexModule();
const cleanNovelText = api.cleanNovelText;

// 测试各种情况
const testCases = [
    {
        name: '测试1: 只有 </think_fox~> 结束标签，无开始标签的思考过程',
        input: '这是前置思考分析过程...\n角色心境应该是有些犹豫的。\n</think_fox~>\n第一章 启程\n清晨的微风穿过树林。',
        expected: '　　第一章 启程\n\n　　清晨的微风穿过树林。'
    },
    {
        name: '测试2: 只有 </think> 结束标签，无开始标签',
        input: '思考中...\n</think>\n第二章 离别\n少年踏上了远方的路。',
        expected: '　　第二章 离别\n\n　　少年踏上了远方的路。'
    },
    {
        name: '测试3: 完整成对的 <think_fox~>...</think_fox~>',
        input: '<think_fox~>\n成对思考内容\n</think_fox~>\n第三章 归途\n他终于回来了。',
        expected: '　　第三章 归途\n\n　　他终于回来了。'
    },
    {
        name: '测试4: 多段思考流，带有孤立闭标签',
        input: '思考一...\n</think_fox~>\n补充思考二...\n</think_fox~>\n正文内容第一段。',
        expected: '　　正文内容第一段。'
    },
    {
        name: '测试5: 思考流 + 黑名单标签 <status> + <memory>',
        input: '无头思考...\n</think_fox~>\n第一章\n正文在此。\n<status>血量: 100</status>',
        expected: '　　第一章\n\n　　正文在此。'
    },
    {
        name: '测试6: 思考流 + 白名单模式 <story>',
        input: '无头思考...\n</think_fox~>\n<story>这是被白名单包裹的真正小说正文。</story>',
        settings: { include_tags: '<story>' },
        expected: '　　这是被白名单包裹的真正小说正文。'
    },
    {
        name: '测试7: 自定义黑名单标签缺失开标签、仅有结束标签（如 </fox_draft>）',
        input: '这是草稿分析过程...\n</fox_draft>\n真正的章节正文内容。',
        settings: { exclude_tags: '<fox_draft>, <status>' },
        expected: '　　真正的章节正文内容。'
    },
    {
        // 副本漂移定点用例：真实实现的「开篇无头闭标签」正则要求标签名以字母开头，
        // `</3d>` 不构成闭标签（数字开头），因此必须作为普通文本保留下来，
        // 只在阶段三被当成裸标签剥掉外壳，段落照常保留。
        name: '测试8: 数字开头的伪闭标签 </3d> 不作为无头闭标签切除（真实实现的字母开头收紧边界）',
        input: '前导文字\n</3d>\n真正的正文。',
        expected: '　　前导文字\n\n　　真正的正文。'
    }
];

let allPassed = true;
for (const tc of testCases) {
    const result = cleanNovelText(tc.input, tc.settings || {});
    if (result === tc.expected) {
        console.log(`[PASS] ${tc.name}`);
    } else {
        console.error(`[FAIL] ${tc.name}`);
        console.error('Expected:\n' + JSON.stringify(tc.expected));
        console.error('Got:\n' + JSON.stringify(result));
        allPassed = false;
    }
}

// 测试 9: 黑名单缺省值来自真实 DEFAULT_SETTINGS（不再由测试自己手写一份字面量）
{
    const name = '测试9: 未传 exclude_tags 时回落到真实 DEFAULT_SETTINGS.exclude_tags';
    const result = cleanNovelText('正文。\n<status>血量: 100</status>\n<state>状态块</state>', {});
    // status 在默认黑名单里 → 被剔除；state 不在（副本曾误加）→ 保留
    const expected = '　　正文。\n\n　　状态块';
    if (result === expected) {
        console.log(`[PASS] ${name}`);
    } else {
        console.error(`[FAIL] ${name}`);
        console.error('Expected:\n' + JSON.stringify(expected));
        console.error('Got:\n' + JSON.stringify(result));
        allPassed = false;
    }
}

if (!allPassed) {
    process.exit(1);
} else {
    console.log('\n所有思考标签排除测试全部通过！');
}
