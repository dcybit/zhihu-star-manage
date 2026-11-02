# Edge 扩展商店上架完整指南

适用项目：zhihu-star-manage（知乎收藏夹批量管理）
上架目标：Microsoft Edge Add-ons（https://microsoftedge.microsoft.com/addons）

---

## 一、上架前准备

### 1. 注册开发者账号（免费）

1. 打开 [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)，使用 Microsoft 账号登录（个人版即可）。
2. 进入「Marketplace → Microsoft Edge」计划，接受开发者协议并完成注册。
3. 发布者显示名称（Publisher display name）会公开展示，建议使用稳定、无侵权的名称（避免使用"知乎"字样，见第六节命名规范）。
4. 个人开发者无需企业认证，注册即可提交。

### 2. 准备上传包（ZIP）

**要求：ZIP 根目录必须直接包含 `manifest.json`，且不得包含与运行无关的文件。**

发布前先排除不应上架的内容：`.git/`、`.gitignore`、`docs/`、`.screenshots/`、`.trae-html-share-packages/` 等。

PowerShell 打包命令（在仓库根目录执行）：

```powershell
$src = "d:\Code\program\zhihu_star_manage"
$dst = "$env:TEMP\zhihu-star-manage-v1.0.zip"
Compress-Archive -Path "$src\manifest.json","$src\background.js","$src\popup.html","$src\popup.js","$src\manager.html","$src\manager.css","$src\manager.js","$src\icons" -DestinationPath $dst -Force
```

> 文件名建议带版本号，如 `zhihu-star-manage-v1.0.zip`，方便后续更新管理。

### 3. 核对清单（提交前自查）

- [ ] `manifest.json` 中 `version` 为正式版本号（当前 `1.0`，后续更新必须递增）
- [ ] 插件在 `edge://extensions` 中加载后能完整跑通：登录检测 → 打开管理器 → 加载收藏夹 → 移动/取消收藏/导出
- [ ] Console 无报错（审核员会看）
- [ ] 没有遗留的 `console.log` 调试输出（`console.warn` 失败诊断可保留）
- [ ] 图标齐全（16/48/128，当前已具备）

---

## 二、商店资料（建议提前准备好再开始填表）

### 名称（Display name，≤45 字符，不得含"知乎"商标）

```
收藏夹批量管理助手
```

> 备用名：`收藏批量导出助手`、`Favorites Batch Manager`。使用"知乎"作为扩展名会被商标规则驳回，可在描述中说明"适用于 zhihu.com"。

### 简短描述（Short description，≤80 字符）

```
批量浏览、管理收藏夹，一键移动、取消收藏，导出为 Markdown/JSON/CSV。
```

### 完整描述（Description，≤10000 字符，建议用 Markdown）

```markdown
批量管理你在 zhihu.com 上的收藏内容：浏览、筛选、移动、取消收藏、多格式导出，一个页面全部搞定。

【主要功能】
• 收藏夹总览：自动列出全部收藏夹及内容数量
• 全量加载：自动分页加载收藏夹内全部回答与文章
• 快速筛选：按标题 / 作者在当前收藏夹内过滤
• 批量取消收藏：勾选后一键取消，限速请求避免触发风控
• 移动收藏：先加入目标收藏夹成功后再移除原收藏，避免内容丢失
• 多种导出：JSON / Markdown / CSV / 仅标题链接(TXT) / 正文 Markdown(ZIP 打包)

【使用方法】
1. 在浏览器中登录 zhihu.com
2. 点击工具栏扩展图标 →「打开收藏管理器」
3. 选择左侧收藏夹，勾选内容后即可批量操作或导出

【隐私说明】
本扩展只与 zhihu.com 域名通信，不收集、上传或共享任何用户数据，
所有操作均发生在本地浏览器中。源代码已开源，欢迎审查。

【声明】
本扩展为第三方独立工具，与知乎官方无任何隶属关系。
```

### 分类与标签

- **类别（Category）**：`Productivity`（生产工具）
- **搜索关键词（Search terms，最多 7 个，建议）**：`收藏夹` `批量管理` `导出` `备份` `markdown` `zhihu` `favorites`

### 支持信息

| 项目 | 填写内容 |
| --- | --- |
| 支持网址（Support URL） | https://github.com/dcybit/zhihu-star-manage |
| 隐私政策网址（Privacy policy URL，**必填**） | https://github.com/dcybit/zhihu-star-manage/blob/main/docs/privacy-policy.md |
| 定价 | 免费 |
| 可见性 | Public（公开） |
| 市场 | 默认全部地区即可 |

> 隐私政策页面模板见附录 A，建议先提交该文件到仓库再填链接。

### 截图（Store logos & screenshots）

- 尺寸要求：**1280×800** 或 **640×400**，最多 10 张，至少 1 张
- 项目已有素材（`docs/screenshots/`）：
  - `manager.png`（主界面，1280×800）
  - `move-modal.png`（移动收藏弹窗）
  - `popup.png`（工具栏弹窗，尺寸偏小，可用可不投）
- 审核更偏好"能看懂功能"的截图，可在截图上叠加一行说明文字后使用
- **商店图标**：复用 `icons/icon128.png`

---

## 三、权限理由说明（审核必填项）

Edge 对敏感权限要求逐条填写使用理由（Justification），本项目需要填：

| 权限 | 填写理由（可直接照抄） |
| --- | --- |
| `cookies` | 扩展需读取 zhihu.com 的登录 Cookie 与 _xsrf 令牌，以完成用户主动发起的收藏夹管理操作（取消收藏、移动收藏）。所有 Cookie 仅在本地浏览器内使用，不会外传。 |
| `storage` | 用于保存扩展界面的本地状态设置，不涉及用户数据上传。 |
| `https://www.zhihu.com/*` | 扩展的全部功能（读取收藏夹列表、收藏内容、取消收藏、移动收藏、抓取正文）都依赖与知乎网页端接口的通信，这是扩展的核心功能。 |
| `https://api.zhihu.com/*` | 作为知乎接口的备用域名，在主域名请求失败时完成用户发起的同一操作。 |
| `tabs`（如 manifest 已声明） | 用于在用户点击扩展图标时打开管理器页面。 |

---

## 四、提交流程（Partner Center 逐步操作）

1. 进入 [Partner Center](https://partner.microsoft.com/dashboard) → **Microsoft Edge** → **Extensions** → 点击 **Create new extension**
2. **Package（上传包）**：上传第一节准备好的 ZIP，等待系统解析 manifest
3. **Availability（可用性）**：市场默认全选；可见性选 Public
4. **Properties（属性）**：选择类别 Productivity，隐私政策 URL，支持 URL
5. **Store listings（商店列表）**：至少填写 **中文(zh-CN)** 一种语言：
   - 名称、简短描述、完整描述（第二节的文案）
   - 上传商店图标与 1–3 张截图
   - （可选）若提供 English (en-US) 列表，审核覆盖更广
6. **Notes for certification（审核备注，重要！）**：审核员没有知乎账号，务必写清测试方法（附录 B）
7. **Permissions justification**：按第三节逐条填写
8. 点击 **Publish** 提交

### 审核周期与状态

- 一般 **2–7 个工作日**，首次上架可能更久
- 状态可在 Partner Center → Extension overview 查看（In review / Published / Rejected）
- 被拒会附具体原因，修改后重新上传新包即可（版本号不用递增，被拒的提交可替换）

---

## 五、驳回高发点（本项目要特别注意）

1. **商标问题**：扩展名称、图标、描述中不得暗示与知乎官方有关。名称不含"知乎"，描述必须写明"第三方工具，与知乎官方无关"（已在文案中包含）。
2. **功能无法验证**：审核员若无法登录知乎会认为扩展不可用——审核备注里要给出明确的测试路径，最好附一个测试账号或注明"需要自有知乎账号"并提供操作截图说明。
3. **权限与功能不匹配**：权限理由没写清楚会被要求补充，务必按第三节填写。
4. **隐私政策缺失**：读取 Cookie 的扩展必须提供隐私政策 URL，提前把附录 A 提交到仓库。
5. **远程代码**：禁止加载远程 JS。本项目所有代码均在本地包内，符合要求。

---

## 六、发布后的维护

- **更新流程**：改代码 → `manifest.json` 的 `version` 递增（如 1.0 → 1.1）→ 重新打包 ZIP → Partner Center 中创建 New package → 更新提交 → 重新审核（一般比首次快）
- **版本号规则**：只会向上递增，不能回退；商店自动向已安装用户推送更新
- **数据看板**：Partner Center 可查看安装量、评分与卸载数据
- **知乎接口变更**：若接口失效，修复后需重新发版，建议 README 引导用户反馈问题

---

## 附录 A：隐私政策（docs/privacy-policy.md 建议内容）

```markdown
# 隐私政策

本扩展（收藏夹批量管理助手）承诺：

1. 不收集、存储、上传或共享任何用户个人信息。
2. 扩展读取的知乎登录 Cookie 与收藏数据仅保存在用户本地浏览器中，
   用于执行用户主动发起的收藏夹管理操作，绝不发送至任何第三方服务器。
3. 扩展仅与 zhihu.com（www/api）通信，用于完成收藏夹的读取与管理。
4. 源代码公开于 GitHub，欢迎审查：
   https://github.com/dcybit/zhihu-star-manage

如本政策更新，将同步发布到上述仓库。生效日期：2026-11-02
```

## 附录 B：审核备注（Notes for certification，中英对照照抄）

```
【Test instructions】
This extension manages favorites (collections) on zhihu.com and REQUIRES
a signed-in zhihu.com account in the browser.

Test steps:
1. Sign in to https://www.zhihu.com in Edge (any account).
2. Click the extension icon → "打开收藏管理器" (Open Manager).
3. The left panel lists the signed-in user's collections.
   Click one to load its saved items.
4. Select items via checkboxes, then try: 取消收藏 (remove),
   移动到其他收藏夹 (move), or any export button.
5. All requests go only to zhihu.com. No data leaves the browser.

中文说明：扩展需要已登录的知乎账号才能演示功能，核心操作均在
本地完成，仅请求知乎官方域名接口。源代码见 GitHub 仓库。
```

## 附录 C：常用链接

- Partner Center：https://partner.microsoft.com/dashboard
- Edge Add-ons 文档：https://learn.microsoft.com/microsoft-edge/extensions-chromium/publish/publish-extension
- 开发者政策：https://learn.microsoft.com/legal/microsoft-edge/extensions/developer-policies
