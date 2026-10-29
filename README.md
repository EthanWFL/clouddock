# CloudDock

CloudDock 不是阿里云官方客户端，文档中的产品名称仅用于说明支持范围。项目代码和原创图标采用 [MIT 许可证](LICENSE)，版权声明使用 `CloudDock contributors`。第三方依赖和素材仍遵循各自的许可证。

CloudDock 是一个 macOS 阿里云运维工作区。它在一个窗口中承载 ACK、Kafka、MSE、DMS、Codeup 和 SLS 原生控制台：ACK、Kafka 和 MSE 分别按各自配置的地域提供入口，其中 MSE 仅支持北京和上海；DMS、Codeup 和 SLS 使用全局入口。侧栏底部固定提供阿里云“控制台首页”，位于“管理模块”上方。首次启动可选择需要的产品模块及其地域，之后也可从侧栏“管理模块”调整。`Command+K` 打开始终为空的快速切换器，不读取剪贴板；顶部“打开链接”按钮和 `Command+T` 进入链接打开模式，可从一段消息中提取、去重并预览最多 10 个受支持控制台 URL，再单独或批量打开。

快速切换器可搜索标签、最近关闭、收藏、模块快捷入口、按产品整理的最近访问和产品入口，也可输入受支持的控制台 URL。最近访问总计最多保存 50 条；空查询时每个产品最多显示 5 条，输入查询后搜索全部记录。用户可以选择恢复任一最近关闭标签，还可搜索完成当前并切到下一条、收藏/取消收藏、保存快捷入口、复制链接、复制当前工作区上下文、顺序重试失败标签、浏览器打开，以及关闭其他、已完成或未固定标签等常用动作；批量关闭逐页遵守页面的未保存内容保护。同名条目显示产品上下文和不含 query 的 hostname/path。输入“操作: 标签关键词”（例如“固定: 集群”或“关闭: 日志”）可操作单个匹配标签，支持固定、取消固定、待处理、处理中、已完成、清除状态和关闭。标签同时支持产品和任务状态筛选，筛选条件随工作区保存；`Command+1…9`、`Control+Tab` 等全局切换快捷键使用筛选后的可见队列。Codeup 与 SLS 当前页可保存为只在所属模块侧栏显示的命名快捷入口。ECS、RDS、OSS 和 CloudMonitor 等明确允许的阿里云控制台地址可作为临时 `aliyun` 标签打开，不会加入固定模块。即使焦点位于阿里云页面内，`Command+F` 也可打开页内查找，Enter / Shift+Enter 切换匹配项，Esc 关闭；`Command+[` / `Command+]`、`Command+D`、`Command+R`、`Command+W`、`Command+Shift+T` 和上述切换快捷键也可以后退/前进、切换收藏、刷新、关闭、恢复或切换标签。

应用不调用阿里云产品 OpenAPI，不保存 AccessKey，也不解析或自动操作产品控制台页面。工具栏“页内查找”按钮或 `Command+F` 使用 Electron 原生 `findInPage` 高亮并滚动定位当前页面中的关键词，显示当前序号与匹配总数；Enter / Shift+Enter 或上下箭头切换匹配，Esc 清除高亮并将焦点返回页面。应用只接收匹配数量和序号，不读取页面正文。可选的 RAM 登录自动填充只在精确允许的登录域名内填写空的用户名和密码字段，不点击或提交表单。RAM 登录 Cookie 保存在 CloudDock 独立的 Electron Session 中。

## 开发环境

- Apple Silicon Mac
- Node.js 24.18.0 LTS，最低版本 22.12.0
- npm 11

```bash
npm install
npm run dev
```

常用检查：

```bash
npm run typecheck
npm run test
npm run test:e2e
npm run package:mac
npm run verify:release
```

`verify:release` 会依次运行类型检查、单元测试、Renderer 测试、Electron E2E、`npm audit` 和 ARM64 DMG 打包，并检查 DMG 校验和、严格代码签名、Mach-O 架构、Electron Fuses，以及 Renderer 分包和依赖边界，最后输出安装包 SHA-256。检查失败时会立即停止。仅验证代码和依赖、不重新打包时运行：

```bash
npm run verify:release -- --skip-package
```

Electron 下载较慢时，可以使用国内镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

安装依赖后，发布打包会直接复用 `node_modules/electron/dist`，不再二次下载 Electron。发布验证仍会继承当前环境中的镜像配置，供依赖安装或后续工具使用：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run verify:release
```

## 安装 DMG

1. 打开 `CloudDock-<版本>-arm64.dmg`。
2. 将 CloudDock 拖入 Applications。
3. 在 Finder 的 Applications 中按住 Control 点击 CloudDock，选择“打开”。
4. 如果 macOS 仍然阻止启动，进入“系统设置 → 隐私与安全性”，在安全性区域选择“仍要打开”。

首版安装包没有 Developer ID 签名或 Apple 公证，但包含 Apple Silicon 运行所需的 ad-hoc 完整性签名。Gatekeeper 仍会显示未知开发者提示；不要关闭 Gatekeeper，也不需要运行移除隔离属性的命令。

目前只支持 macOS Apple Silicon（ARM64），尚未提供 Intel Mac、Windows 或 Linux 安装包。公开前整理版本使用应用标识 `io.github.wuerlong.clouddock`，保留原有数据目录和跳转协议；覆盖旧安装前建议备份工作区，并验证钥匙串访问、登录状态与浏览器跳转。不要同时运行两个版本。

## 安全与问题反馈

登录 Cookie 保存在本机独立浏览器会话中；可选保存的账号密码通过系统加密能力保护。工作区 JSON 中的页面 URL、收藏和查询参数仍可能包含内部资源信息，不应直接提交到仓库或附在公开问题中。退出 RAM 登录会清除会话，保存的账号密码需通过账号密码管理单独清除。

普通问题请提供应用版本、macOS 版本、复现步骤和脱敏截图。涉及凭据、未授权访问或其他安全问题时，先私下联系仓库维护者；不要在公开 Issue 中粘贴 Cookie、密码、认证回调、完整工作区文件或可利用细节。用于演示和测试的项目名、资源 ID 应使用虚构值。

项目与第三方服务的兼容性取决于控制台页面、登录策略和 Electron 版本。自动化测试使用本地模拟控制台；真实 RAM/MFA、企业 SSO 和另一台 Mac 的安装结果以人工验收记录为准。

## 浏览器跳转协议（第一阶段）

CloudDock 注册 `clouddock://` 为 macOS 外部跳转协议，并兼容旧的 `opsdock://` scheme。浏览器或其他应用可用下面的格式把一个经过 URL 编码的 HTTPS 控制台地址交给 CloudDock：

```text
clouddock://open?url=<encoded HTTPS URL>
```

应用会复用已有窗口或完成冷启动，随后打开目标标签并聚焦窗口。入口只接受一个 `url` 参数，拒绝 HTTP、凭据、自定义端口、超长或格式错误的地址。安全默认白名单允许 `*.aliyun.com` 子域名，但不匹配根域 `aliyun.com` 或相似域名；区域型控制台链接还必须包含可识别的地域。

如确需允许额外内部站点，可在启动 CloudDock 前设置 `CLOUDDOCK_URL_ALLOWLIST`，使用逗号分隔的精确主机或仅匹配子域的 `*.example.com` 规则：

```bash
CLOUDDOCK_URL_ALLOWLIST="docs.example.com,*.tools.example.com" npm run dev
```

通配规则不匹配根域名，例如 `*.tools.example.com` 不允许 `tools.example.com`。这项配置用于外部协议入口及其标签的重启恢复，不会放宽 HTTP、凭据或端口限制。已保存的外部标签在启动时按当前白名单重新校验，撤销白名单后不会继续恢复。

## Chrome 扩展（第二阶段，本地开发）

扩展源码位于 `chrome-extension/`，使用 Manifest V3，无需打包即可本地加载：

1. 先安装并至少启动一次 CloudDock，使 macOS 注册 `clouddock://`。
2. 在 Chrome 打开 `chrome://extensions`，启用右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本仓库的 `chrome-extension` 目录。
4. 打开扩展的“详细信息 → 扩展程序选项”，添加允许的域名和路径前缀。
5. 在匹配页面点击工具栏中的 CloudDock 扩展按钮，或使用页面右键菜单“在 CloudDock 中打开此页”。Chrome 首次调用自定义协议时可能要求确认。

扩展默认没有任何允许规则，不固定单一域名。域名支持精确匹配与 `*.example.com` 子域匹配，路径使用大小写敏感的前缀匹配。规则保存在 `chrome.storage.sync`。扩展只申请 `activeTab`、`contextMenus` 和 `storage`，没有 host permissions、内容脚本、Cookie 权限或页面内容读取能力。

专项检查：

```bash
npm run test:extension
npm run build:extension
```

## 本地数据

工作区的运行态更新跳过耐久快照比较，页面状态广播按 16 ms 合并；操作响应只返回成功或错误，状态统一来自订阅。标签激活与窗口尺寸最多延迟 250 ms 合并保存，收藏等重要操作立即落盘，退出时显式等待保存完成。批量关闭逐页检查保护后统一保存。Renderer 复用未变化的数据引用，后台标签加载只重渲染对应标签，不触发侧栏整体重渲染。登录凭据与工作区复用同目录临时文件加原子替换，权限均为 `0600`；凭据读取或解密失败会显示错误，并支持重新保存或清除。

批量重试逐页执行，每页最多等待 30 秒，并在每页结束后回收后台视图，避免整批页面同时驻留；正在加载的重试页受保护。已关闭的标签不会重新创建，退出应用或退出 RAM 登录会取消正在等待的重试。窗口缩放只调整可见当前页，后台页激活时补齐尺寸。

为兼容升级前的数据，CloudDock 继续使用原有的 macOS `opsdock` Application Support 目录保存工作区状态和 Chromium Session，不迁移或重置已有配置。状态文件保存标签、固定与任务状态、产品/任务筛选、稳定 URL、最近访问、收藏、模块快捷入口、产品模块、地域和窗口尺寸；加载状态、错误提示、密码和 AccessKey 不会写入该文件。可选登录信息使用 Electron `safeStorage` 加密后保存到权限为 `0600` 的独立本地文件，不进入工作区、诊断或日志。应用完整退出时会先刷新 DOM Storage，再等待 Session Cookie 落盘；工作区写入失败会保留最新待保存快照，并在后续操作中重试。关闭产品模块只隐藏入口，不会删除已有标签、收藏、模块快捷入口或最近关闭记录。

工具栏“更多操作”集中提供账号密码管理、复制诊断摘要和退出 RAM 登录，使用原生菜单，不遮挡控制台。诊断摘要包含应用、Electron、macOS、进程、内存、回收次数、回收后激活重载次数和峰值视图数，不包含 URL、资源 ID、Cookie 或页面内容。单独的“复制工作区上下文”会按用户操作复制当前稳定控制台 URL 和筛选后的任务队列；登录页和外部跳转页禁用该操作并说明原因。登录过程中不能复制认证回调链接，也不能把它发送到系统浏览器。

收藏和模块快捷入口通过行末“更多操作”菜单重命名、上下排序或删除，悬浮时名称和点击区域保持不变；删除后在工具栏提供 7 秒撤销入口，撤销时恢复到原位置。编辑弹窗固定目标标签，中文输入法确认候选词不会提前保存。快速切换器空查询默认选中当前标签，常用操作位于标签列表之后，直接回车不会改变任务状态。通知、错误和删除撤销均使用工具栏内联反馈，不覆盖或隐藏当前控制台页面。常见断网、DNS、超时和 TLS/证书错误会显示中文处理建议，同时保留 Chromium 错误码供排查。

控制台页面的右键菜单只提供上下文允许的复制、粘贴和全选；已识别的控制台链接还可复制链接地址或在 CloudDock 新标签页中打开。认证页、未知链接和非安全协议不会获得链接操作。可信下载使用系统保存流程，工具栏反馈开始、进度、完成、取消或失败状态。

“更多操作 → 退出 RAM 登录”经确认后会关闭控制台标签并清除 Cookie、Local Storage、IndexedDB、Cache 和 Service Worker。收藏、模块与地域配置会保留；清理失败时恢复当前页面，允许重试。正常退出应用或关闭主窗口遵守页面的未保存内容保护，被阻止时取消退出并保留编辑内容。

控制台 POST 表单弹窗会在独立标签中保留请求体、Content-Type 和 referrer，同一 URL 的不同提交不会合并；请求体只暂存在内存中。通过外部协议打开的登录链接也不会将认证查询参数保存到工作区，重启时返回安全控制台入口，旧版本保存的认证链接会在恢复时清理。

## 技术方案

完整设计见 [docs/technical-design.md](docs/technical-design.md)，发布前人工检查见 [docs/manual-acceptance.md](docs/manual-acceptance.md)。
