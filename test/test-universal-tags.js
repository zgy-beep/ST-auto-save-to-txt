/**
 * 通用全标签清洗引擎（cleanNovelText）自动化测试
 * 运行方式: node test/test-universal-tags.js
 *
 * 本测试**不再手抄副本**：直接加载 index.js 的真实实现（见 test/_helpers/load-index.js）。
 * 两处历史漂移已按真实实现校正：
 *   ① 副本的「开篇无头闭标签」正则允许数字开头，真实实现（index.js:1232）要求字母开头；
 *   ② 副本内联的黑名单字面量比 DEFAULT_SETTINGS.exclude_tags 多一个 state，
 *      现在黑名单与缺省值一律取真实 DEFAULT_SETTINGS，不再硬编码。
 */

const { loadIndexModule } = require('./_helpers/load-index.js');
const api = loadIndexModule();
const cleanNovelTextUniversal = api.cleanNovelText;
const DEFAULT_EXCLUDE_TAGS = api.DEFAULT_SETTINGS.exclude_tags;

// 自动化测试集
const cases = [
    {
        name: '测试1: 任意自定义标签孤立闭合（如 </custom_logic~>），无需手动配置',
        input: '这是前置逻辑推导过程...\n角色心境分析...\n</custom_logic~>\n第一章 启程\n少年走在青石街道上。',
        expected: '　　第一章 启程\n\n　　少年走在青石街道上。'
    },
    {
        name: '测试2: 冒号命名的特殊标签（如 </agent:cot>）',
        input: '思考当前任务...\n</agent:cot>\n微风吹拂。',
        expected: '　　微风吹拂。'
    },
    {
        name: '测试3: 带有空格的闭合标签（如 </ think_fox~ >）',
        input: '思考中...\n</ think_fox~ >\n窗外下着小雨。',
        expected: '　　窗外下着小雨。'
    },
    {
        name: '测试4: 多层嵌套或连续无头标签（如 </scratchpad> 后跟 </plan>）',
        input: '草稿分析1...\n</scratchpad>\n剧情步骤2...\n</plan>\n他握紧了手中的剑。',
        expected: '　　他握紧了手中的剑。'
    },
    {
        name: '测试5: 黑名单标签末尾未闭合（如最后附带 <status>HP:100 但没有 </status>）',
        input: '正文内容第一段。\n正文内容第二段。\n<status>\nHP: 100\nMP: 50',
        settings: { exclude_tags: '<status>' },
        expected: '　　正文内容第一段。\n\n　　正文内容第二段。'
    },
    {
        name: '测试6: 带有属性的成对排除标签（如 <details type="memory" version="1.0">...</details>）',
        input: '<details type="memory" version="1.0">记忆碎片内容</details>\n这是真正的小说正文。',
        settings: { exclude_tags: '<details>' },
        expected: '　　这是真正的小说正文。'
    },
    {
        name: '测试7: 普通正文内含合法标签不被误伤（如 <b>加粗</b> 与 <i>斜体</i>）',
        input: '他大喊一声：<b>快走！</b>随后冲入<i>暴风雨</i>中。',
        expected: '　　他大喊一声：快走！随后冲入暴风雨中。'
    },
    {
        // 取舍说明：本用例锁死「实体解码发生在剥标签之后」的既有顺序。
        // 若把实体解码前移（或解码后再剥一次标签），<b>加粗</b> 会被二次剥离，
        // 用户正文里的字面量标签就会被悄悄吃掉 —— 因此只做出口转义，不动引擎顺序。
        name: '测试7b: 实体转义的字面标签解码后保留为正文（解码顺序不得前移）',
        input: '他写到：&lt;b&gt;加粗&lt;/b&gt; 只是字面示例。',
        expected: '　　他写到：<b>加粗</b> 只是字面示例。'
    },
    {
        name: '测试8: HTML 隐藏注释过滤（如 <!-- Lorebook: 世界观提示 -->）',
        input: '<!-- [Lorebook: 艾莉丝对主角的好感度+10] -->\n艾莉丝微笑着递来一杯热茶。<!-- 隐藏心理描写 -->',
        expected: '　　艾莉丝微笑着递来一杯热茶。'
    },
    {
        name: '测试9: Markdown 表情图片与 img 标签过滤',
        input: '艾莉丝露出了笑容。![微笑表情](https://example.com/smile.png)\n<img src="avatar.jpg" alt="头像" />“今天天气真好呀。”',
        expected: '　　艾莉丝露出了笑容。\n\n　　“今天天气真好呀。”'
    },
    {
        name: '测试10: max_tokens 截断导致末尾未闭合的思考链（如 <think>正在分析...）',
        input: '艾莉丝叹了一口气。<think>正在构思下一步行动，但是突然被截断了',
        expected: '　　艾莉丝叹了一口气。'
    },
    {
        // 漂移定点：副本内联黑名单多出 state，用真实 DEFAULT_SETTINGS 后 state 应被保留
        name: '测试11: 缺省黑名单 = 真实 DEFAULT_SETTINGS.exclude_tags（state 不在其中，必须保留）',
        input: '正文一。\n<state>HP: 100</state>\n正文二。',
        expected: '　　正文一。\n\n　　HP: 100\n\n　　正文二。'
    },
    {
        // 同上的正向对照：直接在默认黑名单里的 status 必须被剔除
        name: '测试12: 缺省黑名单里的 status 仍被剔除（正向对照）',
        input: '正文一。\n<status>HP: 100</status>\n正文二。',
        expected: '　　正文一。\n\n　　正文二。'
    }
];

if (typeof DEFAULT_EXCLUDE_TAGS !== 'string' || !DEFAULT_EXCLUDE_TAGS.includes('status')) {
    console.error(`[FAIL] 前置：DEFAULT_SETTINGS.exclude_tags 异常: ${JSON.stringify(DEFAULT_EXCLUDE_TAGS)}`);
    process.exit(1);
}

let allPassed = true;
for (const tc of cases) {
    const result = cleanNovelTextUniversal(tc.input, tc.settings || {});
    if (result === tc.expected) {
        console.log(`[PASS] ${tc.name}`);
    } else {
        console.error(`[FAIL] ${tc.name}`);
        console.error('Expected:\n' + JSON.stringify(tc.expected));
        console.error('Got:\n' + JSON.stringify(result));
        allPassed = false;
    }
}

if (!allPassed) {
    process.exit(1);
} else {
    console.log('\n=== 通用全标签清洗引擎自动化测试全部通过！ ===');
}
