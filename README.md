# 图像生成（dsh-imagegen）

把 [Seedream](https://www.volcengine.com/product/ark)（火山方舟 Ark）图像生成接进 DeepSeek Harness：
在设置页配置 API 与用量，在输入框下方一键开关，模型即可在对话里直接出图。

## 它做什么

- **生图工具**：`imagegen` 支持文生图、图生图、多图参考、批量出图（`n` 张），返回本地图片路径。
  模型只拿到路径与尺寸，不会把图片二进制塞进上下文。
- **软开关**：打开后向模型注入「图像生成模式」上下文，模型看到用户描述画面的消息会直接出图；
  关闭即消失。开关是全局的（所有会话共享一份），重启 DSH 后回到关闭。
- **设置页**：默认模型、默认尺寸、输出目录、API Key、火山 AK/SK、余额与资源包/账单查询、连通性测试。
- **状态胶囊**：输入框下方的 `🖼 生图 · 开 · seedream 5.5 ▾`，点一下开关，点模型名切模型。

## 安装

```bash
# 在 DSH 里
plugin_manager install_bundle <本地路径或 npm 包名>
```

或把本目录放进 `<profile>/node_modules/dsh-imagegen`，并在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: tool-imagegen
  name: dsh-imagegen
  config: {}
```

## 配置

| 项 | 说明 |
| --- | --- |
| 方舟 API Key | console.volcengine.com/ark → API Key 管理。存进 DSH 凭据库，配置文件里不出现明文。 |
| 火山 AK/SK | 仅「用量与账单」需要。方舟 API Key 查不到余额。 |
| 默认模型 | `doubao-seedream-5-5-261028` / `doubao-seedream-4-0-20260415`，可用短别名 5.5 / 4.0。 |
| 默认尺寸 | `1K` / `2K` / `4K` 或 `宽x高`。 |
| 输出目录 | 相对工作区，默认 `images/`。 |

Key 解析顺序：DSH 凭据库 → 环境变量（`ARK_API_KEY`）→ `~/.dsh/secrets/imagegen.env` → seedream skill 的 `.secrets.env`。

## 计费参考

| 模型 | 价格 |
| --- | --- |
| seedream 5.5 | 约 ¥0.28 / 张（2K 方图） |
| seedream 4.0 | 约 ¥0.20 / 张 |

工具返回 `costEstimate`，设置页可查火山账户余额与 Seedream 资源包余量。

## 与 seedream skill 的关系

skill 仍然可用（`gen.py` 直出），插件是它的「常驻形态」：同样的 Ark 协议与尺寸规则，
但入口从命令行脚本变成对话内的工具、设置页和开关，不需要每轮读 skill 说明。

## License

MIT
