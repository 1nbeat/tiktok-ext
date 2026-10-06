# 抖音下载助手

一个运行在本地的抖音作品同步与下载工具。它通过 Chrome DevTools Protocol（CDP）连接已经登录的 Chrome，在浏览器页面上下文中读取抖音作品数据，并在本地页面中完成筛选、预览和下载。

项目支持同步个人页中的喜欢和收藏，也支持输入指定的抖音用户主页链接加载该用户的作品。视频和图集都可以预览、批量下载，下载任务在 Node.js 服务端后台运行。

<img width="1920" height="913" alt="image" src="https://github.com/user-attachments/assets/54f33d36-3a08-49af-b301-32ae4bd25da1" />
<img width="1901" height="913" alt="image" src="https://github.com/user-attachments/assets/87c99128-004c-42f1-902e-84ad122baf0a" />

## 功能

- 同步当前抖音账号的喜欢和收藏作品。
- 输入用户主页链接，加载指定用户的作品列表。
- 支持视频和图集识别，并按标题、作者搜索。
- 支持按列表顺序、发布时间、点赞数和时长排序。
- 支持分页浏览作品，点击卡片打开本地详情弹窗。
- 视频支持播放、循环播放、进度拖动和清晰度切换。
- 图集支持逐张查看、键盘切换、放大、缩小、拖动和单张或全部下载。
- 支持输入作品链接解析指定作品，复用详情弹窗进行预览和下载。
- 支持批量下载当前列表中的视频和图集。
- 批量下载支持最高画质或标准画质、1 到 10 个并发任务。
- 图集可以按作品分文件夹保存，也可以与视频直接保存到同一目录。
- 下载文件默认按作品标题命名；同名作品会自动追加序号。
- 支持暂停、继续、取消、失败重试和跳过已存在文件。
- 下载进度、当前文件、速度、文件大小和并发数会实时显示。
- 下载任务状态会保存到本地，服务重启后可以继续处理未完成任务。

## 工作方式

```text
已登录的 Chrome（9222 调试端口）
             │ Chrome DevTools Protocol
             ▼
        server.mjs
   本地 HTTP API、数据同步、详情请求、媒体代理、下载任务
             │
             ▼
 public/index.html + public/app.js + public/styles.css
       作品列表、筛选、详情弹窗和下载控制
```

服务端不会读取或保存独立的 Cookie 文件。登录状态由带调试端口的 Chrome 用户目录管理，项目只通过 CDP 使用该浏览器当前会话。

## 环境要求

- Windows
- Google Chrome
- Node.js 22 或更高版本
- 可以正常登录并访问抖音的账号

项目只使用 Node.js 内置模块，不需要安装第三方 npm 依赖。

## 启动

### 推荐方式

双击项目目录中的 `start.bat`。脚本会依次完成：

1. 检查 Chrome 和 Node.js 是否可用。
2. 检查本机 `9222` 调试端口；端口不可用时启动独立 Chrome 用户目录。
3. 打开抖音个人页 `https://www.douyin.com/user/self`。
4. 启动 Node.js 本地服务。
5. 打开 `http://localhost:5173`。

首次使用时，在新打开的 Chrome 窗口中完成抖音登录。登录状态会保存在项目目录的 `.chrome-debug-profile/`，之后再次运行 `start.bat` 会继续使用该状态。

### 手动方式

如果不使用 `start.bat`，先用调试端口启动 Chrome。Windows 示例：

```bat
chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\code\tiktok-ext\.chrome-debug-profile" "https://www.douyin.com/user/self"
```

然后在项目目录执行：

```bash
npm start
```

最后打开：

```text
http://localhost:5173
```

默认服务端口是 `5173`，也可以通过 `PORT` 环境变量修改。Chrome 调试端口固定使用 `9222`。这两个端口都只建议在本机使用，不要暴露到公网或不受信任的局域网。

## 使用说明

### 同步喜欢和收藏

1. 确认带 `9222` 调试端口的 Chrome 已经登录抖音，并打开个人页。
2. 打开本地页面，点击“同步喜欢与收藏”。
3. 等待同步完成，页面会显示喜欢、收藏两个列表及其数量。
4. 使用顶部搜索、排序、分页和标签切换浏览结果。

程序优先调用抖音列表接口分页获取数据；接口不可用时会回退到页面滚动方式。同步结果保存在当前 Node.js 进程内存中，服务重启后需要重新同步。

### 加载指定用户作品

1. 在带调试端口的 Chrome 中打开目标用户主页，或准备一个有效的抖音用户主页链接。
2. 点击“加载用户作品”。
3. 输入类似下面的地址：

   ```text
   https://www.douyin.com/user/USER_SEC_UID
   ```

4. 点击“开始加载”，等待用户作品列表完成。

程序会优先请求用户作品分页接口。如果调试 Chrome 中没有找到对应页面，会尝试在该 Chrome 会话中打开输入的用户主页；如果接口分页失败，再使用页面滚动方式加载。加载结果会出现在“用户作品”标签中，也支持当前列表的批量下载。

### 查看作品详情

点击任意作品卡片即可打开本地详情弹窗。视频会请求最新播放地址；图集会进入逐张浏览模式。详情弹窗还会显示作者资料、互动数据、发布时间、音乐、标签、位置和技术信息（接口有数据时显示）。

### 解析指定作品

点击“下载作品链接”，粘贴抖音作品链接后点击“解析并打开”。程序会从链接中提取作品 ID，打开详情弹窗进行预览、切换清晰度和下载。

### 批量下载

1. 先切换到要下载的列表：喜欢、收藏或用户作品。
2. 点击“批量下载当前列表”。
3. 在下载弹窗中选择：
   - 视频画质：最高画质或标准画质。
   - 同时下载：1 到 10 个并发任务，默认 2 个。
   - 图集目录：按图集分文件夹，或与视频放在同一目录。
4. 确认数量和保存目录后点击“开始下载”。

下载根目录为项目下的 `downloads/`。文件名使用作品标题，非法文件名字符会被清理；同名作品会自动追加 `-2`、`-3` 等序号。

按图集分文件夹时，文件夹使用作品 ID，文件仍按作品标题和图片序号命名：

```text
downloads/
├─ douyin-作品ID/
│  ├─ 作品标题-1.jpg
│  └─ 作品标题-2.jpg
└─ 另一个视频.mp4
```

选择“与视频同一目录”时不会为图集创建额外文件夹，图集图片会直接与视频保存在 `downloads/` 下，并按作品标题和图片序号命名。

下载任务在服务端后台执行。页面关闭不会主动终止任务；重新打开页面后可以恢复任务状态。下载面板支持暂停、继续、取消和重试失败项。

## 项目结构

```text
tiktok-ext/
├─ public/
│  ├─ index.html          # 页面结构、标签、弹窗和下载设置
│  ├─ app.js              # 前端状态、渲染、详情交互和任务轮询
│  ├─ styles.css          # 页面、弹窗、卡片和下载面板样式
│  └─ favicon.svg         # 页面图标
├─ server.mjs             # Node.js 服务、CDP 同步、详情、媒体代理和下载任务
├─ start.bat              # Windows 一键启动脚本
├─ package.json           # 项目元数据和启动命令
├─ downloads/             # 下载文件目录，运行时自动创建
├─ download-state.json    # 下载任务状态，运行时生成
└─ .chrome-debug-profile/ # 独立 Chrome 用户目录，保存登录状态
```

其中 `.chrome-debug-profile/`、`downloads/` 和 `download-state.json` 已加入 `.gitignore`，不要将它们提交到代码仓库。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/sync/start` | 后台开始同步喜欢和收藏 |
| `GET` | `/api/sync/status` | 查询喜欢和收藏同步状态及结果 |
| `GET` | `/api/sync` | 获取最近一次同步结果 |
| `POST` | `/api/profile/sync` | 根据用户主页链接开始加载作品 |
| `GET` | `/api/profile/sync/status` | 查询用户作品加载状态及结果 |
| `POST` | `/api/download/jobs` | 创建批量下载任务 |
| `GET` | `/api/download/jobs` | 获取最近的下载任务 |
| `GET` | `/api/download/jobs/:id` | 获取指定任务详情和进度 |
| `POST` | `/api/download/jobs/:id/pause` | 暂停任务 |
| `POST` | `/api/download/jobs/:id/resume` | 继续任务 |
| `POST` | `/api/download/jobs/:id/cancel` | 取消任务 |
| `POST` | `/api/download/jobs/:id/retry-failed` | 重试失败项 |
| `GET` / `HEAD` | `/api/video/stream` | 通过本地代理访问视频、音频或图片 |
| `GET` | `/api/video?id=:id` | 获取作品最新详情和播放地址 |

批量下载任务请求示例：

```json
{
  "source": "like",
  "quality": "highest",
  "concurrency": 2,
  "albumMode": "folder",
  "skipExisting": true
}
```

`source` 支持 `like`、`collect` 和 `user`；`quality` 支持 `highest` 和 `standard`；`albumMode` 支持 `folder` 和 `flat`；并发数会被服务端限制在 1 到 10 之间。

## 数据和安全

- 页面默认通过 `http://localhost:5173` 访问；请不要将服务端口暴露到公网或不受信任的局域网。
- Chrome 调试端口为 `9222`，该端口拥有控制浏览器页面的能力，不要对外暴露。
- `.chrome-debug-profile/` 可能包含 Cookie、登录状态和浏览记录，应保留在本机。
- `downloads/` 可能包含大量视频和图片，不建议提交到 Git。
- `download-state.json` 可能包含作品标题、作者和下载路径，也不应提交到 Git。
- 抖音媒体地址通常有时效性；地址失效时，重新打开作品详情即可获取新地址。
- 请遵守抖音服务条款、版权要求和适用法律，仅下载你有权保存和使用的内容。

## 常见问题

### 提示“未找到 Chrome 调试页面”

确认 Chrome 是通过 `start.bat` 启动，或手动启动时带有 `--remote-debugging-port=9222`。同时确认抖音页面是在这个调试 Chrome 窗口中打开并已登录，而不是普通 Chrome 窗口。

### 第一次加载出现 `Execution context was destroyed`

这通常发生在用户主页仍处于导航状态。程序会自动重试；如果仍然失败，等待页面完全加载后再次执行。确认输入的用户主页链接和当前打开页面路径一致也有助于避免重复导航。

### 用户作品或喜欢收藏数量不完整

抖音使用虚拟列表，页面可见数量不一定等于接口返回数量。程序会优先使用分页接口，并在接口失败时回退到页面滚动。建议等待进度显示完成后再比较数量。

### 视频或图集无法播放或下载

播放地址可能已过期。关闭详情弹窗后重新打开作品，让服务端重新获取详情和媒体地址；同时确认 Chrome 登录状态仍然有效。

### 服务重启后下载任务显示暂停

这是预期行为。服务重启时，正在下载的项目会恢复为待处理或暂停状态，已完成文件不会被删除。打开下载面板后点击“继续”即可恢复剩余任务。

## 开发检查

```bash
node --check server.mjs
node --check public/app.js
git diff --check
```

启动服务：

```bash
npm start
```
