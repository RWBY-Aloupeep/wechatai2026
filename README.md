# 云开发 quickstart

这是云开发的快速启动指引，其中演示了如何上手使用云开发的三大基础能力：

- 数据库：一个既可在小程序前端操作，也能在云函数中读写的 JSON 文档型数据库
- 文件存储：在小程序前端直接上传/下载云端文件，在云开发控制台可视化管理
- 云函数：在云端运行的代码，微信私有协议天然鉴权，开发者只需编写业务逻辑代码

## 参考文档

- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)

## 3D 预览（Phase 1：xr-frame 查看器 + 物理骨架）

启动页 `pages/viewer/viewer` 加载一个内置的示例 GLB 模型（Khronos 官方 CC0
"Duck" 模型），用 [xr-frame](https://developers.weixin.qq.com/miniprogram/dev/framework/xr-frame/)
渲染，物理模拟（重力、地面、弹性碰撞、点击跳跃冲量）由 [cannon-es](https://github.com/pmndrs/cannon-es)
驱动（xr-frame 自带的 Beta `rigidbody` 目前不支持弹性/摩擦/冲量，详见
`miniprogram/utils/physics.js` 顶部注释）。

### 前置条件

- 微信开发者工具，基础库版本 **≥ 2.32.1**（`xr-physics`/`cube-shape`/`touch-shape`
  等 Beta 能力所需的最低版本）。项目内 `project.config.json` 已设为 `2.32.1`；
  本地 `project.private.config.json` 中的 `3.17.0` 优先生效，属于开发者工具本地
  覆盖值，已高于该下限，无需改动。
- 建议同时准备一台安卓中端机和一台 iOS 设备用于真机预览（见下）。

### 安装依赖 / 构建 npm

物理引擎 `cannon-es` 通过 npm 引入，需要先构建：

```bash
cd miniprogram
npm install
```

然后在微信开发者工具中执行 **工具 → 构建 npm**。若该流程因 `cannon-es` 打包
异常而失败，可退化为将其预构建产物直接放入 `miniprogram/libs/cannon-es.js`
并用相对路径 `require`（当前项目未使用该退化方案，仅作为文档记录的应急选项）。

> **已知问题（已修复）：** `cannon-es@0.20.0` 的 CJS 构建产物
> (`node_modules/cannon-es/dist/cannon-es.cjs.js`) 会无条件执行
> `require('perf_hooks')` 作为 `performance.now()` 的兼容降级——这是 Node.js
> 专属模块，小程序沙箱环境没有，且其 `require()` 在找不到模块时会直接抛错
> （而不是像 Node 那样静默失败）。本仓库已直接修补该文件，改为读取运行时的
> 全局 `performance` 对象（不存在时走原有的 `Date.now()` 兜底逻辑）。**如果
> 未来重新执行 `npm install` 或升级 `cannon-es` 版本，该补丁会被覆盖，需要
> 重新打上**（搜索 `dist/cannon-es.cjs.js` 中的 `require('perf_hooks')` 一行
> 替换为读取 `globalThis.performance`/`global.performance` 即可）。

### 真机预览

xr-frame 在开发者工具内置模拟器中的渲染/物理表现并不完全可靠（部分 Beta 能力
在模拟器中行为异常或不渲染），**请以真机预览为准**：开发者工具中点击「预览」
生成二维码，用手机微信扫码在真实设备上验证：模型渲染与光照、单指拖拽旋转/
双指缩放相机、掉落弹跳 2-3 次后静止、点击模型向上小幅随机跳起、点击「重置」
按钮恢复初始状态。可通过「真机调试」查看设备端 console 报错。

> **已知问题（模拟器限定，非本项目代码 bug）：** 只要 `<xr-physics>` 存在，
> 开发者工具**模拟器**里 xr-frame 的引擎组件（`ENGINE_WASM.js`/
> `draco_mini.js`）就会因为 `WebAssembly is not defined` 而启动失败，进而级联
> 报错 `Cannot read property 'PhysSystem' of undefined`，导致整个场景渲染
> 失败。这是微信开发者社区中已被多次报告的模拟器限定问题（同样的 `PhysSystem
> of undefined` 报错，真机上完全正常），**不是** cannon-es 集成或本项目代码的
> bug。涉及 `<xr-physics>`（即 tap-to-jump 交互）的验证请直接使用真机预览，
> 不要依赖模拟器的报错来判断该功能是否正常。

> **已知问题（已修复）：相机默认朝向是 +Z，不是常见 3D 引擎约定的 -Z。**
> 通过真机调试的控制台实时排查（直接对存活的场景节点求值，而非反复改代码
> 重新编译）确认：`<xr-camera rotation="0 0 0">`（即不设置 rotation）时，
> 相机默认朝向 +Z 方向，而不是 OpenGL/WebGL 生态大多数 3D 引擎约定的 -Z。
> 模型的位置、缩放、物理模拟当时都已确认完全正确，相机却因为朝向反了而完全
> 看不到场景内容。`camera-orbit-control` 并不会在加载时自动将相机转向
> `target`——它只基于当前已有的朝向处理触摸拖拽旋转，因此初始 `rotation`
> 仍需手动设对。当前 `components/xr-viewer/index.wxml` 中 `<xr-camera>` 已加
> `rotation="0 180 0"` 修正此问题。

### 拍照上传（Phase 2 第一步，已实现客户端部分）

预览页右下角「拍照生成」按钮进入 `pages/capture/capture`：拍摄或从相册选择
一张照片 → 预览确认 → 上传到微信云开发存储（`captures/` 目录）→ 跳回预览页，
照片的云端 fileID 通过页面参数 `imageFileID` 传入（当前仅在 console 打印，
即未来生成管线的输入）。3D 模型此时仍为内置示例；接入真实生成服务后，云函数
将以该 fileID 为输入产出 GLB 并替换模型来源。

> 上传依赖云开发环境：需在微信开发者工具中为当前 AppID 开通云开发并选择环境
> （`miniprogram/app.js` 中 `env` 为空字符串时使用默认环境；如上传报环境相关
> 错误，请在 `app.js` 的 `globalData.env` 填入实际环境 ID）。

### 图生 3D 服务选型（调研结论，尚未接入）

推荐 **腾讯混元生 3D（极速版）**（`cloud.tencent.com/product/ai3d`）：与微信
同生态（云函数内用腾讯云 SDK 直接调用，无跨境网络/外币支付问题）、支持单图
生 3D、极速版约 1 分半出模型（适合小程序交互节奏）、按积分计费且首次开通有
免费额度、异步"提交任务 + 轮询"的 API 形态与云函数/客户端轮询天然匹配。注意
官方文档提到新模型服务在向 TokenHub 平台迁移，接入时以控制台实际开通路径
为准。备选：Tripo（$0.01/积分，注册送 2000 积分）、Meshy、Rodin（质量最高、
最贵）——均为海外服务，云函数跨境调用与付款均有额外摩擦，仅在混元质量/时延
不满足时考虑。

### 已知限制 / Phase 2 预留点

- 模型来源目前是本地内置的 `miniprogram/assets/sample.glb`；接入生成服务后，
  只需替换资源来源（详见 `components/xr-viewer/index.wxml` 与 `index.js` 中
  `onSceneReady` 附近的注释）。上传照片的 fileID 已作为页面参数打通（见上）。
- 碰撞代理目前是手工指定的包围盒（`miniprogram/utils/proxy-shape.js` 中的
  `FALLBACK_HALF_EXTENTS`），Phase 2 将替换为随模型一起生成的凸包。
- `camera-orbit-control` 的双指捏合缩放在真机上无效（拖拽旋转正常；已通过
  真机调试确认 `isLockZoom: false`、`zoomSpeed: 1`，动态改 `zoomMin`/
  `zoomMax`/`isEnabled` 均无效果），原因未明，暂缓处理。

