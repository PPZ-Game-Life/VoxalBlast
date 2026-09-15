# 构建与部署现状

> v0.5.0 / 2026-09-14。依据 package.json、vite.config.js、netlify.toml；未查询远端平台配置。

## 仓库实际配置

- 构建：npm run build；发布目录：dist。
- Vite base 为 ./，产物使用相对资源路径。
- netlify.toml 为 /assets/* 设置 public,max-age=31536000,immutable，为 /index.html 设置 no-cache。
- 开发命令 npm run dev；本地产物预览 npm run preview。
- 运行时视觉由代码生成，无外部美术素材包依赖。

依赖锁文件随仓库保存，干净环境可用 npm ci 安装。构建不自动执行 npm test，发布前需单独执行回归。主包仍有 Vite 大于 500 kB 的提示，见 [验收记录](VISUAL_REFRESH_050.md)。

## 仓库不能证明的事项

Netlify 站点是否绑定、哪个分支触发生产、Deploy Preview 是否启用、远端环境变量和某次部署是否成功，都需要平台侧确认。本地 main 和 push 成功不能替代部署日志。

旧稿 feature → develop → main 是建议流程，不是已存在的强制分支或 CI 配置。当前任务若使用分支，按当次协作约定执行；不要从历史图推断已有 develop 环境。

## CrazyGames 边界

适配层可选读取全局 SDK，仓库页面未自行加载 SDK 脚本。全局排行的开关、授权、API 和加密提交仍需实平台联调。没有完整广告请求及广告回调生命周期实现，不能认为 Netlify 预览已经验证这些能力。

## 发布检查

1. 安装依赖，执行规则测试和正式构建。
2. 本地预览产物，检查版本隐藏、拖放、翻面、续玩及桌面/竖屏/矮横屏。
3. 若需要部署，确认平台站点、分支、环境变量和构建日志。
4. 在实际 iframe/平台环境验证 SDK、暂停恢复和任何启用的外部接口。

旧平台建议与流程见 [历史部署稿](../Archive/Technical/NETLIFY_DEPLOYMENT_BASELINE.md)。
