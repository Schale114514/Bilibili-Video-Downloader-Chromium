<div align="center">

# 📥 B站视频下载器

**Bilibili Video Downloader — B 站视频下载浏览器扩展，支持下载视频、纯音频**

[![Manifest V3](https://img.shields.io/badge/Manifest%20V3-MV3-8A2BE2)](https://developer.chrome.com/docs/extensions/develop/migrate)
[![JavaScript](https://img.shields.io/badge/Language-JavaScript-yellow)](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript)
[![Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen)]()
[![License](https://img.shields.io/badge/License-MIT-blue)]()

**在 B 站视频页面右下角一键下载视频，即可下载视频或音频。**

</div>

---

## 📖 项目简介

本项目是一个基于 **Chrome Manifest V3** 的浏览器扩展（支持 Chrome / Edge / 其他 Chromium 系浏览器），
为 [bilibili.com](https://www.bilibili.com) 视频页面提供一站式下载能力：

- 在视频页面右下角显示 **“📥 打开B站视频下载”** 浮动按钮，点击弹出下载面板
- 支持选择 **分P / 清晰度 / 编码 / 下载格式**
- 通过接口获取 DASH 分片流，可分离视频轨与音频轨
- 使用**自研JavaScript 合并器**（`lib/muxer.js`）在浏览器内把视频轨与音频轨重封装为
  单个可播放的 **MP4 文件**
- 复用当前页面登录状态，登录/大会员可下载对应清晰度

> ⚠️ 仅供学习交流，请仅下载自己有权限获取的内容，尊重创作者版权。

---

## ✨ 功能特性

-  **右下角浮动按钮**：视频页（`/video/`）与番剧页（`/bangumi/play/`）自动出现，一键打开下载面板
-  **清晰度选择**：360P / 480P / 720P / 1080P / 1080P60 / 4K / 8K 等（以视频实际提供为准，
  高清晰度需要登录 / 大会员）
-  **编码选择**：同一清晰度存在多种编码时，可选 AVC(H.264) / HEVC(H.265) / AV1，
  默认优先 H.264 保证兼容性
-  **分P支持**：多 P 视频可任选分P下载
-  **下载格式**：
  | 格式 | 说明 |
  | --- | --- |
  | 合并音视频（MP4） | **推荐**，浏览器内自动合并，无需 ffmpeg |
  | 仅视频（无声音） | 下载视频轨 |
  | 仅音频（M4A） | 下载音频轨 |
  | 视频+音频（两个文件） | 分别保存，可自行用剪辑软件合并 |
-  **下载进度**：进度条、已下载大小、实时速度、剩余时间，支持中途取消
-  **登录态复用**：自动携带页面 Cookie，大会员清晰度可直接下载
-  **深色模式适配**：跟随 B 站页面深色主题
-  **偏好记忆**：记住上次选择的清晰度 / 编码 / 格式
-  **多 CDN 自动重试**：主地址失败自动尝试备用地址，直连被拦截自动切换后台通道

---

## 🧩 项目结构

```
bilibili-downloader/
├── manifest.json          # 扩展清单（Manifest V3）
├── background.js          # 后台 Service Worker：CORS 备用下载通道（流式转发）
├── content.js             # 主逻辑：浮动按钮 / 下载面板 / 下载流程编排
├── content.css            # 面板 UI 样式（方形风格，含深色模式适配）
├── lib/
│   └── muxer.js           # 自研 fMP4 → MP4 合并器（零依赖纯 JS）
├── icons/                 # 扩展图标（16 / 32 / 48 / 128 px）
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── test/
│   └── muxer.test.mjs     # 合并器结构化自测（66 项断言）
└── README.md
```

---

## 🛠️ 工作原理（项目详细信息）

### 1. 获取视频信息与播放地址

扩展通过 B 站官方公开接口获取数据（请求自动携带页面登录 Cookie）：

| 场景 | 接口 |
| --- | --- |
| 视频信息（标题 / 分P / cid） | `GET https://api.bilibili.com/x/web-interface/view?bvid=...` |
| 普通视频播放地址 | `GET https://api.bilibili.com/x/player/playurl?bvid=...&cid=...&qn=127&fnval=4048&fourk=1` |
| 番剧 / 影视播放地址 | `GET https://api.bilibili.com/pgc/player/web/playurl?ep_id=...&qn=127&fnval=4048&fourk=1` |

- `fnval=4048` 请求 DASH 分片流（含 4K / 8K / AV1 / 杜比等信息）
- `qn=127` 请求尽可能高的清晰度，再根据返回的 `support_formats` 过滤出实际可用的选项
- 页面数据优先取自 `window.__INITIAL_STATE__`（免请求、更快），缺失时回退到接口

### 2. DASH 分片流

B 站高清视频（H.264 / HEVC / AV1 编码）是 **视频轨与音频轨分离** 的 **分片 MP4**
（fragmented MP4）：

```
ftyp + moov + (moof + mdat) × N
```

每个轨道都是独立的文件，需要下载两条流并在本地合并成一个完整的 MP4。

### 3. 合并器（lib/muxer.js）

由于无法依赖 CDN 引入 mp4box.js 等第三方库，本项目**从零实现**了一个纯 JavaScript 的
fMP4 → MP4 重封装器，符合 MV3 安全策略（无 eval、无 Worker、无外部请求）：

- **解析阶段**：遍历盒结构，解析 `moov`（tkhd / mdhd / hdlr / stsd 样本描述）与每个
  `moof` 分片（tfhd / tfdt / trun，读取样本的时长、大小、关键帧标志、合成时间偏移、数据偏移）
- **重建阶段**：重新生成完整可播放的 MP4——
  `mvhd` / `tkhd` / `mdhd` / `hdlr` / `stbl`（`stsd` / `stts` / `ctts` / `stss` / `stsc` / `stsz` / `stco`）
- **交错写入**：视频与音频样本交错存放于 `mdat`，通过两遍构建（占位偏移 → 真实偏移）
  保证 `stco` 偏移精确
- 音视频起始时间自动对齐（必要时插入空 edit list 延迟）
- 合并失败时自动降级为“视频 + 音频两个文件”分别保存

合并器配有合成数据的**结构化自测**（`test/muxer.test.mjs`，66 项断言），覆盖盒结构、
样本偏移连续性、时长统计、关键帧表、合成时间偏移与样本数据逐字节往返一致性：

```bash
node test/muxer.test.mjs
```

### 4. 双通道下载（应对跨域限制）

媒体流位于 `*.bilivideo.com` 等 CDN，页面直连可能受 CORS 限制：

1. **页面直连**：content script 直接 `fetch`（`credentials: 'omit'`，媒体流无需 Cookie）
2. **后台通道**：若直连被拦截（如 `Failed to fetch`），自动改由后台 Service Worker
   （拥有 `*://*/*` host 权限，不受页面 CORS 限制）代为下载，并通过 `MessagePort`
   将数据块**流式转发**回页面，进度照常显示

同时主地址失败会自动依次重试 `backupUrl` 备用 CDN 地址。

---

## 🔧 安装方法

### Chrome / Edge

1. 下载本项目代码（`Code → Download ZIP` 并解压，或 `git clone`）
2. 打开浏览器扩展管理页：
   - Chrome：地址栏输入 `chrome://extensions/` 回车
   - Edge：地址栏输入 `edge://extensions/` 回车
3. 打开右上角 **“开发者模式”** 开关
4. 点击 **“加载已解压的扩展程序”**（Load unpacked）
5. 选择本项目目录（包含 `manifest.json` 的文件夹）
6. 完成 ✅

> 修改代码后，在扩展管理页点击扩展卡片上的刷新按钮即可生效。
> 扩展会申请“读取所有网站数据”权限（`*://*/*`），用于后台代为下载媒体流以绕过页面
> 跨域限制——仅在您点击下载时访问 B 站相关地址，代码完全开源可审计。

---

## 📖 使用方法

1. 打开任意 B 站视频页面
2. 点击右下角 **“📥 打开B站视频下载”**
3. 在弹出面板中选择分P（如有）、清晰度、编码、下载格式
4. 点击 **“开始下载”**
5. 等待进度完成——合并完成后浏览器自动保存 `.mp4` 文件

> 💡 大文件（如 4K 长视频）合并时浏览器会占用较多内存，建议一次只下载一个任务。

---

## ❓ 常见问题

| 问题 | 说明 |
| --- | --- |
| 只能选到低清晰度 | 高清晰度需要登录 B 站账号；大会员专属清晰度需要大会员，请先在网页端登录 |
| 提示“获取播放地址失败” | 可能未登录、视频为会员专享或受地区限制 |
| 合并失败，改为分别保存 | 极少数特殊编码/异常流可能无法合并，扩展会自动降级为“视频+音频两个文件” |
| 下载很慢 | 受 B 站 CDN 速度影响；直连被拦截时会自动切换到后台通道重试 |
| 403 / 412 错误 | 风控触发：请先正常打开视频页刷新一次再下载、稍后再试或更换浏览器 |
| 提示“Failed to fetch” | 媒体 CDN 跨域限制导致，扩展已内置后台通道与备用地址自动重试；若仍失败，请将面板日志反馈到 Issues |
| 无法下载某些视频 | 出于版权考虑，付费购买 / 大会员专享 / 需要额外权限的内容可能无法下载，请遵守平台规则 |

---


## ⚠️ 免责声明

1. 本项目**仅供学习交流使用**，禁止用于任何商业用途。
2. 请仅下载**您本人有权限获取**的内容（如自己创作、已获授权、平台明确允许下载的视频）。
3. 下载他人作品时请注意：B 站视频内容版权归原作者及平台所有，请勿二次传播侵权内容。
4. 使用者应自行承担因使用本项目产生的一切法律责任，项目作者不对任何下载、传播行为负责。
5. 本项目与哔哩哔哩（bilibili）官方**无任何关联**，未获得官方认可或授权。
6. 本扩展依赖 B 站公开接口，接口变动可能导致功能失效，请关注项目更新。

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。

如果本项目对你有帮助，欢迎 ⭐ Star 支持！
