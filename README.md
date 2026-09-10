# SillyTavern 聊天记录自动存档到 TXT

专为 **SillyTavern** 设计的聊天记录自动归档扩展。每次 AI 回复完成后，自动将纯文本对话格式化追加保存至服务器上的 `.txt` 文件。

---

## ✨ 核心功能

- **自动存档**：每轮 AI 回复生成完毕后，自动保存到本地 txt 文件。
- **用户消息同步记录**：提供开关，可选择只存 AI 回复，或同时记录用户的提问与发言。
- **按角色独立归档**：
  - **开启**：每个角色拥有专属的 `<角色名>.txt` 文件；群聊时会自动按实际发言的角色分别归档。
  - **关闭**：所有角色的聊天历史按时间流水保存在同一个 `all.txt` 文件中。
- **思考过程过滤**：自动剔除 DeepSeek R1 等推理模型的 `<think>...</think>` 深度思考过程，仅保留最终回答。
- **格式净化**：自动剥离 `<div>`、`<span>` 等 HTML 排版标签，保留原始段落与换行。
- **自定义标签过滤**：支持自定义需要过滤排除的标签，或只提取指定标签内的内容。
- **防重复记录**：重新生成或滑动切换回复（Swipe）时，自动识别并跳过相同内容，避免记录堆叠。

---

## 📦 安装方法

### 第一步：在 SillyTavern 中安装前端扩展
1. 打开 SillyTavern，点击顶部导航栏的 **扩展菜单（三块积木/方块图标）**。
2. 点击 **“Install Extension”（安装扩展）**。
3. 在地址栏中粘贴本仓库地址并确认：
   ```text
   https://github.com/zgy-beep/ST-auto-save-to-txt
   ```
4. 安装完成后，刷新浏览器页面。

### 第二步：复制服务端插件文件夹
由于 SillyTavern 的官方安装器仅下载前端文件，后端插件需要简单复制一步：
1. 打开文件管理器，进入刚才下载的前端扩展目录：
   `SillyTavern/public/scripts/extensions/third-party/ST-auto-save-to-txt/plugins/auto-save`
2. 将整块 **`auto-save`** 文件夹复制到 SillyTavern 根目录的 **`plugins/`** 文件夹中：
   - 目标路径为：`SillyTavern/plugins/auto-save/`
   - （若没有 `plugins` 文件夹，可在 SillyTavern 根目录新建一个）

### 第三步：开启插件支持并重启
1. 用文本编辑器打开 SillyTavern 根目录下的 **`config.yaml`**。
2. 找到 `enableServerPlugins`，将其改为 `true`：
   ```yaml
   enableServerPlugins: true
   ```
3. **彻底重启 SillyTavern 服务端**（关闭运行终端并重新启动）。

---

## 🖥️ 使用指南

### 1. 找到扩展设置入口
1. 点击 SillyTavern 顶部导航栏的 **扩展图标（三块积木/方块图标）**。
2. 在弹出的侧边栏中向下滚动，找到并展开：  
   👉 **【自动存档到 TXT (Auto Save to TXT)】**。

### 2. 设置项说明
- **状态提示**：
  - 🟢 `服务端插件已就绪`：一切正常，随时可以开始自动存档。
  - 🔴 `服务端插件未运行`：请确认是否已完成上述第二步（复制文件夹）和第三步（修改 config.yaml 并重启）。
- **启用自动存档**：总开关，开启后生效。
- **同时保存用户消息**：开启后，用户发送的消息也会被记录进 txt。
- **按角色名分文件**：
  - 勾选：生成 `角色名.txt`
  - 取消：所有记录汇总到 `all.txt`
- **剔除 HTML 标签**：清除多余网页代码，保留干净文本。
- **剔除模型思考标签**：清除 `<think>...</think>` 推理内容。
- **排除的标签**：填入需要排除的标签名（逗号分隔，如 `details,think,script`）。
- **立即测试保存**：点击后会向服务器写入一条测试消息，用于快速验证功能是否正常。

---

## 📂 存档文件保存在哪里？

所有 txt 文本记录均保存在您的 SillyTavern 服务器目录内：
```text
SillyTavern/plugins/auto-save/logs/
├── 角色名A.txt
├── 角色名B.txt
└── all.txt
```

### 存档文本格式示例
```text
──────────────────────────────────────────────────
[2026-09-10 14:00:00] 角色名:

这是角色回复的文本内容。
换行与排版均完好保留。
```

---

## ❓ 常见问题

1. **点击“立即测试保存”提示失败？**
   - 确认 `SillyTavern/plugins/auto-save/index.js` 文件是否存在。
   - 确认 `config.yaml` 中的 `enableServerPlugins: true` 已保存，且重启了终端服务。
2. **在 Windows 记事本打开文件出现乱码？**
   - 存档文件统一采用标准 UTF-8 编码。老版本 Windows 记事本可能会误判编码，建议使用 VSCode、Notepad++、Sublime 或 Windows 11 新版记事本打开。
