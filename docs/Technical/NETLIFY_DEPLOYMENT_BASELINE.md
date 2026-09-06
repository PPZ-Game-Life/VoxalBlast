# VoxalBlast Netlify Deployment Baseline

> 项目：VoxalBlast  
> 技术栈：H5 + Three.js  
> 研发预览平台：Netlify  
> 最终发布平台：CrazyGames  
> 文档状态：研发期技术基线

## 1. 文档目的

本文规定 VoxalBlast 在研发阶段使用 Netlify 构建、预览和测试时的工程要求。Netlify 用于前端静态产物和浏览器体验验证，不能替代 CrazyGames 对 SDK、广告、iframe 和平台审核的最终验证。

官方文档入口：<https://docs.netlify.com/>

## 2. 平台职责边界

### Netlify 负责

- Git 提交触发构建和部署。
- Deploy Preview 预览指定分支或 Pull Request 的版本。
- 托管 HTML、JavaScript、CSS 和其他静态发布产物；当前 VoxalBlast 运行时视觉资产由代码程序化生成，不依赖外部模型、纹理或视频。
- 验证桌面端和移动端浏览器的加载、WebGL、输入和性能表现。
- 作为策划、美术、程序和 QA 的研发验收入口。

### CrazyGames 负责

- CrazyGames SDK 初始化与平台生命周期。
- iframe 环境下的尺寸、输入和页面行为。
- gameplay start/stop、插屏广告和激励视频。
- 平台存档、用户能力和最终发布审核。

Netlify Deploy Preview 不能作为 CrazyGames 平台能力的替代测试环境。

## 3. 推荐分支和部署流程

```text
feature/* -> Netlify Deploy Preview
      |
   develop -> 集成测试部署
      |
     main -> Production Deploy
      |
CrazyGames 测试环境 -> CrazyGames 发布审核
```

推荐流程：

1. 功能在 `feature/*` 分支开发。
2. 创建 Pull Request 后使用 Deploy Preview 验证改动。
3. 合并到 `develop` 后进行跨功能集成测试。
4. `main` 只接受已验收的稳定版本。
5. 稳定版本再送入 CrazyGames 测试环境，完成平台相关验收。

## 4. 构建配置

Netlify 部署必须明确以下配置：

```text
Build command: npm run build
Publish directory: dist
```

如果项目未来变成 monorepo，再根据实际目录设置 Base directory。配置优先写入仓库根目录的 `netlify.toml`，不要只依赖 Netlify 控制台中的手动配置。

推荐起点：

```toml
[build]
  command = "npm run build"
  publish = "dist"
```

Three.js 工程建议使用 Vite 或同类标准前端构建工具，并提供：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

生产构建必须：

- 输出完整的 `dist/` 静态产物。
- 让构建错误导致部署失败。
- 不使用本机绝对路径。
- 不依赖开发服务器地址。
- 若未来增加非运行时媒体资源，确认其进入最终发布目录；当前版本的模型、纹理、视频等视觉资产均由代码程序化生成。
- 使用资源 hash 或等效版本策略，避免加载旧资源。
- 将非首屏资源拆分为按需加载内容。

官方参考：

- <https://docs.netlify.com/build/configure-builds/overview/>
- <https://docs.netlify.com/build/configure-builds/file-based-configuration/>
- <https://docs.netlify.com/build/configure-builds/monorepos/>

## 5. SPA 路由

如果 VoxalBlast 仅使用 `/` 单页入口，不需要额外路由规则。

如果后续加入设置页、帮助页、排行榜页或测试页等客户端路由，需要添加 fallback：

```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

新增规则后必须确认它不会覆盖静态资源路径，也不会隐藏真实的 404 错误。

官方参考：<https://docs.netlify.com/build/configure-builds/javascript-spas.md>

## 6. 环境变量和安全

环境变量按部署上下文区分：

```text
development
deploy-preview
production
```

可以使用以下公开配置：

```text
VITE_GAME_ENV=development
VITE_ENABLE_CRAZYGAMES_SDK=false
VITE_ASSET_BASE_URL=
```

安全规则：

- Vite 中以 `VITE_` 开头的变量会进入浏览器代码。
- `VITE_` 变量不得保存密钥、私有 Token 或服务端凭证。
- Deploy Preview 不应默认连接生产数据或使用生产密钥。
- CrazyGames 适配层必须支持 SDK 缺失时的 mock/no-op 实现。
- 公开配置和私密凭证必须分开管理。

官方参考：

- <https://docs.netlify.com/build/environment-variables/overview/>
- <https://docs.netlify.com/build/configure-builds/environment-variables/>
- <https://docs.netlify.com/build/environment-variables/secrets-controller/>

## 7. 静态资源和缓存

Three.js 游戏的模型、纹理和音频通常体积较大，应采用按需加载和可控缓存策略：

- `index.html` 使用短缓存或 `no-cache`，确保新版本能获得最新入口。
- 带 hash 的 JS、CSS、模型、纹理和音频可以使用长期缓存。
- 不带 hash 的资源不得设置永久缓存。
- 资源变更优先通过构建 hash 产生新文件名。
- 不要对所有路径统一设置永久缓存。

配置示例，待实际构建目录和资源命名确定后再启用：

```toml
[[headers]]
  for = "/assets/*"

  [headers.values]
    Cache-Control = "public,max-age=31536000,immutable"

[[headers]]
  for = "/index.html"

  [headers.values]
    Cache-Control = "no-cache"
```

官方参考：

- <https://docs.netlify.com/build/caching/caching-overview/>
- <https://docs.netlify.com/manage/routing/headers/>

## 8. Deploy Preview 验收

每个重要功能合并前，至少在 Deploy Preview 验证：

- 页面能正常加载。
- Three.js 和 WebGL 能正常初始化。
- 模型、纹理、音频和字体路径正确。
- Chrome、Edge、Safari 基本表现正常。
- 桌面端鼠标、滚轮和键盘输入正常。
- 移动端触控、横竖屏和不同宽高比正常。
- 页面切后台后游戏暂停，恢复后没有时间跳跃或重复输入。
- 音频在用户首次交互后按浏览器策略正常启动。
- WebGL 初始化失败时有可理解的错误状态。
- 资源失败时可以提示并恢复或重试。
- 首屏加载时间、内存和 GPU 压力可接受。
- 直接刷新当前支持的路由不会错误地返回 404。

## 9. CrazyGames 交付前额外验收

Netlify 验收通过后，仍需在 CrazyGames 测试环境验证：

- CrazyGames SDK 初始化。
- iframe 尺寸、输入和焦点行为。
- gameplay start/stop 生命周期。
- 插屏广告和激励视频。
- 广告开始前暂停，广告结束后正确恢复。
- 激励视频未完整观看时不发放奖励。
- CrazyGames 数据存档和异常降级。
- 平台对加载、广告、外部链接和用户体验的审核要求。

## 10. 建议的工程文件

工程建立后建议包含：

```text
package.json
index.html
vite.config.js
netlify.toml
src/
  main.js
  game/
  platform/
    crazygames/
  input/
  ui/
public/
```

`dist/` 为构建生成目录，不手动维护，也不应提交未经需要的构建产物。

## 11. 官方文档索引

- Netlify Docs：<https://docs.netlify.com/>
- 构建配置：<https://docs.netlify.com/build/configure-builds/overview/>
- 文件配置：<https://docs.netlify.com/build/configure-builds/file-based-configuration/>
- 创建部署：<https://docs.netlify.com/deploy/create-deploys/>
- Deploy Previews：<https://docs.netlify.com/deploy/deploy-types/deploy-previews/>
- JavaScript SPA：<https://docs.netlify.com/build/configure-builds/javascript-spas.md>
- 环境变量：<https://docs.netlify.com/build/environment-variables/overview/>
- 缓存：<https://docs.netlify.com/build/caching/caching-overview/>
- 自定义 Headers：<https://docs.netlify.com/manage/routing/headers/>
