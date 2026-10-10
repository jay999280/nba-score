# NBA 比分

一个自用的 NBA 比分工具。打开就知道今天发生了什么。

> 打开。扫一眼。关掉。

界面为中文，默认白底。Next.js · TypeScript · Tailwind CSS。无数据库、无账号、无新闻流。

## 运行

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

```bash
pnpm build && pnpm start   # 生产模式
pnpm lint                  # eslint
pnpm typecheck             # tsc --noEmit
```

## v0.1 包含什么

今日比赛与实时/本地状态、按天切换、紧凑卡片，以及带「概览 / 数据统计」两个标签的详情页。

| 区域 | 行为 |
| --- | --- |
| 首页 | `进行中 > 未开始 > 已结束`，空分区不渲染，卡片高约 114px |
| 日期 | 左右箭头、系统日期选择器、手机左右滑动；默认今天 |
| 进行中 | 红点 + `进行中 · 第4节 · 6:21`，每 6 秒刷新，时钟每秒接着走，红点轻微呼吸 |
| 未开始 | 显示本地开赛时间，绝不显示 `0 - 0` |
| 已结束 | 弱化负方队名与队徽，比分保持清晰 |
| 详情 | 比分 + 节次表，然后是「概览」（领衔球员、十四项球队数据）、「数据统计」（移动端优先的 8 列）、「动态」（走势图＋节次筛选＋事件流） |
| 关注球队 | 存在 localStorage，只影响分区内排序；详情页可一键关注/取消 |
| 主题 | 默认白底，可切换深色并记住选择 |
| 状态 | 与卡片结构一致的骨架屏、`无法加载比赛 / 重试`、刷新失败时显示 `更新于 10:42` |

v0.1 不含：新闻、视频、评论、博彩、推送、登录、数据库。

## v0.2 新增什么

| 功能 | 行为 |
| --- | --- |
| 剧透模式 | 顶栏眼睛开关（`spoilerMode` 存 localStorage）。开启后已结束比赛只显示对阵：卡片点透显示比分，详情页用「显示比分」主按钮解锁节次与统计；单场解锁只在本次会话有效，重进恢复隐藏。迷你比分条在隐藏态不携带任何比分数字 |
| 收藏体验 | 详情页每队一个「关注 / 已关注」按钮；关注 sheet 里已关注的排前面并显示数量 |
| 比分动画 | 比分数字滚动到位（odometer），首屏静止；跟随系统 reduced-motion 设置 |
| PWA | `manifest.webmanifest`（standalone、白底）＋ 192/512/maskable/180 图标（`node scripts/build-icons.mjs` 生成，零依赖）＋ service worker（页面网络优先、静态缓存优先、比分不缓存旧数据；仅生产环境注册） |

## v0.3 新增什么

| 功能 | 行为 |
| --- | --- |
| 比赛动态 Tab | 新的第三个标签，比赛开始后才有内容，未开赛显示平静空态 |
| 比分走势 | 主场分差折线（上为领先），节次刻度＋终点，开赛从 0 开始；深浅色通用，中性单色 |
| 事件流 | 最新在前，按节分组并显示该节结束比分；得分事件高亮＋队色圆点，其余弱化；`全部 / 第1节…` 筛选 |
| 事件中文模板 | 罚球命中/投失按 `1 of 2` 显示第几罚；助攻＋出手距离进第二行；换人（常 100+ 条）与节次标记不进列表 |
| 球队数据扩展 | 概览从 5 项扩到 14 项：罚球命中率、进攻篮板、抢断、盖帽、内线得分、快攻得分、利用失误得分、替补得分、最大领先 |
| 数据接口 | `GET /api/games/[gameId]/plays`（事件＋走势＋投篮＋节次列表，未开赛返回 `available: false`）；详情页点开标签才请求，进行中每 6 秒轮询 |

## v0.5 新增什么：投篮分布

| 功能 | 行为 |
| --- | --- |
| 投篮分布图 | 动态 Tab 内，半场俯视 SVG：篮筐/油漆区/三分线/中圈按真实英尺比例绘制；命中实心圆、投失空心圆，颜色区分球队 |
| 球队筛选 | `全部 / 主队 / 客队` 切换，圆点与分区统计联动重算 |
| 分区命中率 | 油漆区 / 中距离 / 底角三分 / 弧顶三分四档（`12/18 · 66.7%`），随筛选变化 |
| 坐标说明 | 上游 x 是长边、y 是宽边（各 0–100），已用投篮距离反推验证：三分全在线外、两分全在线内、13/13 扣篮进油漆区；统一折叠到进攻半场、换算英尺后绘制 |

## v0.6 新增什么：比赛上下文

| 功能 | 行为 |
| --- | --- |
| 球队近况 | 详情页节次表下方：双方近 5 场胜负圆点（实心胜/空心负）＋连胜/连败；无记录显示"暂无近况"；只统计本场开赛前的已完赛 |
| 交手记录 | 中间列显示本赛季交手比分（如 `交手 1-1`），无交手显示"首次交手"；过去的结果不可能剧透本场，剧透模式也照常显示 |
| 关键回合 | 事件流新增 `关键时刻` 筛选（第四节/加时最后 2 分钟、分差 5 分内）；命中行红点高亮；无关键回合时该筛选不出现 |
| 开赛倒计时 | 未开始卡片 `19:30 · 还有3小时`（24 小时以上显示 `明天/周X 时间`）；详情赛前面板同步显示；共享 30 秒时钟，无未开始比赛时不 tick |
| 领衔三项 | 概览从"得分王一行"扩展为得分/篮板/助攻各第一（并列按总贡献破平），沿用现有两栏布局 |

## v0.4 新增什么：比赛提醒

| 功能 | 行为 |
| --- | --- |
| 提醒设置 | 藏在关注 sheet 里：主开关＋开赛前 15/30/60 分钟＋开赛/完赛两个子开关；只提醒已关注球队，无关注时拒绝开启并提示 |
| 订阅链路 | Web Push（VAPID），`POST /api/push/subscribe` 存浏览器订阅，设置变更走 `PATCH`，取消走 `DELETE`；密钥在 `.env.local`，订阅落 `data/push.json`（已 gitignore） |
| 调度器 | 服务端每 60 秒检查一次：关注球队开赛进入提前窗口推开赛提醒，终场 8 小时内的完赛推比分；已推送记账，重启不重推；410/404 自动清理过期订阅 |
| 通知体验 | SW 显示通知（标题＋比分＋球队图标），点通知直达比赛详情页，同场同类只保留一条 |
| 测试 | 调度决策是纯函数，`node scripts/test-reminders.mjs` 20 项单测；订阅全链路 Playwright E2E（沙箱无推送服务密钥，握手一环用桩代替） |

## 部署到 Vercel（手机随时看）

本地 `pnpm start` 关机即停；部署后手机在任何网络都能看，且 https 让手机推送真正可用。

1. GitHub 仓库 Import 到 Vercel（Next.js 默认配置即可，无需改代码）
2. Environment Variables 填四个值（格式见 `.env.example`）：
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`，以及随机生成的 `CRON_SECRET`
3. Storage → Create → KV，Vercel 会自动注入 `KV_REST_API_URL` / `KV_REST_API_TOKEN`；
   有它就走 KV 持久化订阅，没有就回落成本地文件（本地开发零配置）
4. 提醒调度：在 cron-job.org 建一个每分钟任务，GET
   `https://<你的域名>/api/push/check?secret=<CRON_SECRET>`
  （Vercel Cron 也行，但免费版频率受限；本地开发不需要这一步，进程内 timer 会自己跑）

注意：serverless 没有常驻进程，所以生产环境不会启动进程内 timer（`store: "kv"` 可在
`/api/push/status` 确认）；`push.json` 只用于本地开发。

注意：Web Push 需要安全上下文——`localhost` 可用，局域网 `http://` 不可用。手机上要收提醒需要一次 https 部署（如 Vercel），本地只能在电脑浏览器验证订阅流程。

## 安卓 App（v0.8 起，推荐路径）

**真正的 APK，自用侧载，不要任何申请材料**：没有开发者账号、不上架、不备案、不需要域名。

```bash
# 本地只管生成静态包；APK 由 CI 构建（本机无需 Android SDK）
APP_TARGET=android pnpm build     # -> out/
pnpm exec cap sync android        # -> android/app/src/main/assets/public/
```

推送到 `main` 后 GitHub Actions（`.github/workflows/android.yml`）会自动跑
`./gradlew assembleDebug`，产物在 Actions 的 **nba-score-apk** artifacts 里，下载即得
`app-debug.apk`（约 4.5 MB）。命令行取：

```bash
gh run list --limit 1                                # 找 run id
gh run download <run-id> -n nba-score-apk -D ./apk
```

### 它是怎么工作的（关键：没有服务器）

| 层 | 做法 |
| --- | --- |
| 界面 | `APP_TARGET=android next build` 把整个前端导出成静态文件，**打进 APK**（`webDir: "out"`）。打开即渲染，不联网也能看壳 |
| 数据 | 手机上没有 Node 服务器，所以**服务层直接跑在 WebView 里**：`src/lib/client/data-source.ts` 在原生环境下动态载入 `src/lib/nba/games.ts`，用 Capacitor 的原生 HTTP 桥请求 NBA 数据源 |
| 为什么必须用原生桥 | NBA 的 CDN **不发 CORS 头**，且要求 `Referer`（浏览器禁止脚本设置）——普通 fetch 会被拦。原生桥不受 CORS 约束，也能自带 header。实测 S3 镜像甚至裸请求就返回 200 |
| 路由 | 静态导出要求每个路由都是真实的 `index.html`，所以详情页从 `/game/<id>` 改成 `/game?id=<id>`（`trailingSlash: true` 生成 `game/index.html`） |
| 双构建目标 | `next.config.ts` 用 `pageExtensions` 让 API 路由在 Web 构建里生效、在 App 构建里被忽略（`route.api.ts` 不再匹配 `route`）。**Web 部署依然完好**，Vercel 照常工作 |

### 还没做的

**手机本地通知**（`@capacitor/local-notifications` 已装好并注册，代码未接）。没做的原因是
**没有真机我无法验证通知是否真的弹出**——不想交一个看起来能用、实际收不到的东西。App 里
Web Push 的设置入口已按平台隐藏，不会出现点了没反应的按钮。等你在真机确认 App 能跑通，
我再把「关注球队开赛/完赛提醒」接到本地通知上（那时不依赖 FCM，也不需要梯子）。

### 注意

- **安装时系统会提示「未知来源」**——侧载的正常提示，允许即可
- 用的是 debug 签名（AGP 默认 v2/v3，Android 7+ 均可）。**每次 CI 重新构建签名可能不同**，
  升级时若提示签名冲突，先卸载旧版再装
- 本仓库的 `android/` 工程是提交进版本库的（含 gradle wrapper）；Web 资源由 CI 用
  `cap sync` 生成，不入库

## 装到安卓手机（PWA 路径，Web 版仍在）

**不需要 APK。** 这个应用同时满足安卓的可安装标准（manifest ＋ `standalone` ＋ service worker ＋
图标），装到主屏幕后打开**没有地址栏、没有浏览器界面**，有启动器图标、独立任务卡、推送通知和
离线外壳——和原生 App 的观感一致，因为它走的就是同一套系统集成。

怎么装：

1. 手机 Chrome 打开你的部署地址
2. 首页会出现一条「装到主屏幕，全屏打开｜安装」——点它即可（Chrome 自带的安装横幅经常不弹，
   所以应用自己提供入口，用 `beforeinstallprompt` 接管）
3. 或者手动：Chrome 右上角 ⋮ → 「安装应用」/「添加到主屏幕」

### 重要：国内网络下必须用自定义域名，别用 `*.vercel.app`

实测（2026-10-09，上海电信）：`nba-score-bay.vercel.app` **间歇性完全不可达**。定位到的机制是
**针对 `vercel.app` 后缀的 SNI 阻断**，证据是同一个 IP 只换 SNI 就结果相反：

```
curl --resolve vercel.com:443:76.76.21.21              https://vercel.com/            -> 200
curl --resolve nba-score-bay.vercel.app:443:76.76.21.21 https://nba-...vercel.app/    -> Connection reset
```

TCP 到 Vercel 的 anycast IP 是通的（`Test-NetConnection 76.76.21.21 -Port 443` 为 True），
被重置的是 TLS 握手——所以**换一个普通域名指向 Vercel 就能解决**（SNI 不再是 `*.vercel.app`）。
附带一提，本机 DNS 还会把这个域名污染到 Facebook 的 IP 段（157.240.12.5），所以解析层面也不可信。

因为它是**间歇性**的（当天早些时候还能正常访问），装在手机上的图标会表现为"有时候能开、
有时候打不开"——比稳定打不开更让人困惑。所以：**买一个便宜域名（约 ¥30–60/年，Namecheap /
Cloudflare / Spaceship 都行，Vercel 在海外不需要备案），在 Vercel → Settings → Domains 里加上，
之后一律用那个域名安装和使用。**

### 关于推送提醒的实话

`fcm.googleapis.com` 在这张网络下同样不可达（实测 15s 超时），而 Chrome 的 Web Push 走的正是
Google 的 FCM 通道。所以**在国内网络下不挂梯子，手机收不到比赛提醒**——这跟域名和代码都无关，
是通道本身被墙。想在手机上真正收到推送，需要 VPN 或在境外网络下使用；应用本身的订阅、存储、
调度逻辑都是好的（本地与境外环境已验证）。

`public/sw.js` 的 fetch 处理、`display: standalone`、maskable 图标、`screenshots`（安装对话框
里的预览图）都是这条路径的一部分。`manifest` 还带 `id`（避免重复部署被当成第二个应用）和
`launch_handler: focus-existing`（点图标复用已开窗口，不叠窗口）。

截图由 `scripts/capture_screenshots.py` 生成（需先跑起生产构建；生成后要 `pnpm build` 一次，
因为 `next start` 在构建时就固定了 public 文件清单）。

**为什么不打包 APK：** APK 只有两条路，TWA 或 Capacitor，两者本质仍是同一份 Web 内容套一层
外壳——能多给的只有「应用抽屉里的独立条目」和「可上架 Play 商店」。代价是本机要装 JDK 17 ＋
Android SDK（约 1GB＋），产物还得手动侧载或上架。装在主屏幕的 PWA 已经覆盖了日常使用的全部
好处；真要做 APK 的话，`id`/图标/`screenshots` 这些 manifest 字段 Bubblewrap 也是直接复用的，
现在这份配置就已经是它的输入。

### 语言说明

界面文案、日期时间（24 小时制）、状态、分区标题、统计项、30 支球队名称与**球员姓名**均为中文。

球员中文名来自生成好的译名表 [`src/lib/nba/player-names.json`](src/lib/nba/player-names.json)（585 条）。
NBA 官方数据不含中文名，所以译名取自虎扑球员库，用下面这条命令可随时重新生成：

```bash
node scripts/build-player-names.mjs
```

译名表以**规范化英文名**为键（`Luka Dončić` → `lukadoncic`），因此最坏情况只是两个同名球员共用一个中文名（中文媒体也如此），
不会把某位球员标成另一个人。实测今日 6 场比赛：190 / 197 名出场球员命中中文名（96.4%），
未命中的是季前赛临时名单球员，自动回落到英文原名。

数据统计表里超长的中文名（如「肯塔维厄斯·考德威尔·波普」）在 375px 屏幕上会省略号截断，桌面端悬停可看全名——
这个宽度上限同时也是保证 8 列不横向溢出的关键，不要去掉。

球馆名称保持英文：数据源只有英文，且它只在赛前详情页出现一次。

## Architecture

```
NBA Live Data  →  source.ts  →  normalize.ts  →  games.ts  →  /api/*  →  React
                   (adapter)     (internal model)   (service)
```

Nothing above the adapter knows what an NBA payload looks like: components only
ever see the types in `src/lib/types.ts` (PRD §24).

```
src/
  app/
    page.tsx                 home
    game/[gameId]/page.tsx   detail
    api/games/               GET ?date=&from=&to=   and   GET /[gameId]
    api/logo/[teamId]        team crests, served from our own origin
    globals.css              design tokens, utilities, motion
  components/                presentational components
  lib/
    types.ts                 the internal data model
    format.ts                clock/date/percentage formatting (pure)
    client/                  polling resource, stored values, hooks
    nba/
      source.ts              CDN fetch + mirror fallback + memoization
      schedule.ts            season schedule index
      normalize.ts           raw → internal model
      games.ts               schedule ⇄ live scoreboard merge rules
      team-meta.ts           accents and crest paths
```

### Data sources

| Purpose | Endpoint |
| --- | --- |
| Today's live scores | `liveData/scoreboard/todaysScoreboard_00.json` |
| Any date's fixtures | `staticData/scheduleLeagueV2_1.json` |
| Box score / periods | `liveData/boxscore/boxscore_{gameId}.json` |

Two origins serve identical payloads: `cdn.nba.com` (documented) and the
media-ops S3 mirror that the CDN itself reports in `meta.request`. The mirror is
used automatically when the CDN answers with anything other than valid JSON.

Upstream has no box score before tip-off (it answers 403 rather than 404), so the
detail page falls back to the schedule and shows tip-off and venue until the game
starts. Failed lookups are remembered for 15s so a polling loop cannot hammer a
file that does not exist yet.

### Time zones

The server keeps everything in UTC. The browser computes the `[from, to)` window
for the selected local day and sends it to `/api/games`, so a game is listed on
the calendar day it actually starts on **for the reader**, and every time label is
rendered with `Intl.DateTimeFormat` in the device zone. No offset is ever
hard-coded.

### Refresh policy

Driven by what the payload contains: any live game → 6s, an upcoming game
tipping within 10 minutes → 15s (tip-off watch), any other upcoming game →
60s, everything final → polling stops. Regaining focus always refreshes once. The
last good payload stays in memory, so returning to a date paints instantly.

Live clocks tick locally every second between polls and resync on each
response, so the displayed time never freezes for a whole interval.

## Verification

`_probe/` holds the scripts used against a production build (`pnpm build && pnpm start`).

```bash
node _probe/test_format.ts                                  # parsing primitives
python _probe/verify_zh.py                                  # 白底 + 中文：首页/日期/关注/详情/深色
python _probe/verify_extra.py                               # favorites, persistence, swipe
python _probe/verify_states.py                              # skeleton, error, retry, stale
python _probe/verify_live.py                                # live card, ticking clock, 6s cadence, tip-off watch
python _probe/verify_box.py                                 # box score fit at 375/390/430
python _probe/verify_v02.py                                # v0.2：剧透、详情关注、滚动数字、PWA
```

`verify_ui.py` 是改中文前那一版的全流程脚本（选择器仍是英文），保留作对照。

Screenshots land in `_probe/shots/`.
