# NBA 比分

一个自用的 NBA 比分工具。打开就知道今天发生了什么。

> 打开。扫一眼。关掉。

**当前主线是安卓 APK（自用侧载）**，Web 版本与 PWA 仍保留。界面为中文，默认白底。
Next.js · TypeScript · Tailwind CSS · Capacitor。无数据库、无账号、无新闻流。

## 运行

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

```bash
pnpm build && pnpm start   # Web 生产模式
pnpm build:app             # 安卓静态导出（出 out/）
pnpm lint                  # eslint
pnpm typecheck             # tsc --noEmit
pnpm test                  # 确定性回归（Node 内置 runner，零依赖）
pnpm verify                # lint → typecheck → test → build → build:app
```

## v0.9 新增什么：数据可信度与 UI 第一轮

这一轮的主题不是加功能，而是**让界面说的话是真的**，并把主路径打磨顺。

| 变化 | 为什么 |
| --- | --- |
| 比赛钟只显示源数据，不再本地倒数 | 篮球每个哨声都停表，payload 里没有"表在走"的字段，本地推进就是编造时间 |
| 响应携带 `freshness`（源时间 / 覆盖率 / 两个源各自是否可用） | 赛程与实时源会分别失败，"没有比赛"和"读不到赛程"是两件事 |
| 降级时禁止状态倒退 | 实时源挂掉后，旧赛程会把 89–94 的比赛报成"未开始 / 无比分"，不能被当成一次成功的刷新 |
| 只有完整覆盖才敢说"这一天没有比赛" | 否则显示"暂时无法确认" |
| 未开赛与统计缺失分开呈现 | 已开始但统计读不到时，不再显示"尚未开始" |
| 队徽改为打包的静态资源 | APK 里没有服务器，原来的 `/api/logo/<id>` 在原生包里指向不存在的路由，队徽全是坏图 |
| 轮询单飞 + 后台停表 | 前台恢复会重复起链、旧响应可能覆盖新数据 |
| localStorage 形状校验 | 合法 JSON 但形状错误的收藏值会整页崩溃 |
| 首页：日期与筛选进 URL、返回恢复滚动、「回今天」、全部/关注筛选 | 从详情返回不再丢日期 |
| 关注 sheet：编辑期间顺序冻结、44px 触摸区、焦点陷阱、返回键先关 sheet | 选中球队后它会跳到别处，手指还在原地 |
| 详情：概览默认 6 项核心统计、球员表双方切换/首发替补/可排序/表头吸顶/长名点开 | 首屏看得完，深滚还知道每列含义 |
| 走势图补节次刻度与分差尺度；球场线 1px | 原先只有线没有刻度；`non-scaling-stroke` 下 0.22px 等于看不见 |
| 动态列表不抢滚动，改为「N 条新动态」 | 正在看旧回合时不被拽走 |

**0.9 的修复收口（如实范围）**：日期/筛选/滚动在 Web 版已实测恢复（375px，含 40 场长列表）；触摸区在**已点名的主要控件**上实测 ≥44px（球员表双方切换、排序、长名展开、投篮筛选、详情标签）——不是"全项目每个可点元素"都已核对。关注 sheet 的返回键优先关闭在 Web 浏览器已验；**安卓系统返回键、后台、字体放大与真机网络仍待设备验收**，见下面的真机清单。

**方向**：首页轻（快速扫完当天比赛），详情丰富（看懂一场比赛）。不新增新闻、社区、AI 分析、登录或云同步。

## v1.1.1 修复什么：冷启动不再等整季赛程

手机上没有服务器，服务层跑在 WebView 里，所以**每次冷启动都要重新下载**
`scheduleLeagueV2_1.json`（2026-10-21 实测 **7.4 MB 原始 JSON**，S3 镜像不返回
gzip），下载完再解析、规范化整个赛季，才轮到「今天有没有比赛」这个问题。加上
`cdn.nba.com` 在本网络下 TLS 握手被重置（每次尝试约 5 秒）却排在镜像前面串行尝试，
打开应用看今日比分要等十几秒到半分钟；真机记录里出现过 35 秒仍未出卡片。

| 变化 | 为什么 |
| --- | --- |
| 首屏只等「今天」的实时记分板（9.7 KB） | 赛程是给日期切换用的。`listGames` 今天最多等赛程 1.2 秒，超时先返回记分板并标 `schedulePending`，客户端 2 秒后自动补全 |
| 设备端持久化**赛程索引**（IndexedDB） | 首次下载后存「已规范化的索引」（几百 KB）而不是 7 MB 原文，按 6 小时 TTL 复用；二次冷启动不再下载，切日期也不用等 |
| 数据源竞速并记住胜者 | 首次并发请求两个源，先答者胜并写入 `localStorage`（24 小时）；之后先问胜者，失败才清零重赛。不再为被墙的源支付固定 5 秒 |
| 详情页不再串行等赛程 | 技术统计与赛程上下文并行请求；赛程只给 900 ms，超时用技术统计自己的信息渲染 |
| 「赛程慢」不再冒充「数据源失败」 | 新增 `schedulePending`：界面说实话「赛程还在加载，先显示实时比分」，不挂降级告警；补全前的空列表继续显示骨架，不谎报「无法确认这一天」 |

实测（本机生产构建，同一份服务层）：冷启动 `/api/games` **1.4 秒**返回当天 3 场
（`kind: partial`、`pending: true`），5 秒后同一请求返回完整列表（`kind: live`、
`coverage: full`），之后命中进程缓存 4 ms。改动前桌面冷启动已在 7 秒以上。

**边界**：APK 的 WebView 内路径（Capacitor HTTP 桥 + IndexedDB）无法在没有真机时
实测；已分别验证数据源竞速、超时语义（Node 回归）与 IndexedDB 读写/跨页面保留/损坏
记录拒绝（Chromium 真实 IndexedDB）。真机体感仍以安装 `dist/nba-score-1.1.1.apk`
后的实际冷启动为准。

## v1.1.2：没开打的比赛不再是一张空页

打开一场还没开打的比赛，原来的详情页是：比分位置空着 48px、两个队名下面各一行「常规赛 —」、
三个标签页里「概览」和「数据统计」内容完全一样、「动态」是空的，底部还挂着一条
「只有部分数据源返回」。赛前不是没东西可放，是没组织。

现在赛前有自己的页面，开赛后才回到原来的三个标签页：

| 区域 | 内容 |
| --- | --- |
| 对阵 | 两队队徽、队名、关注按钮，中间 `VS` 与「未开始 / 延期」，背后是两队的队色光晕 |
| 开赛卡 | 倒计时（共享 30 秒时钟）、本地日期时间、城市与球馆、`ATL @ ORL · 常规赛`；顶部一道两队色分界线 |
| 赛前 | 双方分区排名与战绩、近 5 场胜负点与连胜连败、本赛季交手；赛季刚开始确实没有数据时，用一句「本赛季首次交手，双方都还没有本赛季的已完赛记录」代替四处「暂无」，并说明开赛后会出现什么 |
| 来源 | 赛前不显示「部分数据源未返回」——赛前没有技术统计是预期，不是失败；只有赛程真的读不到时才提示 |

数据全部来自已有的赛程与排名，没有新增数据源，也没有编造任何赛前分析。
赛程尚未就绪时，详情页会在 2 秒后自动重试补全（与首页同一条补全规则）。

## v1.2.0 新增什么：赛前阵容与数据、更新提示、视觉统一

### 赛前页：预计阵容 + 本赛季数据对比

赛前页在原来的对阵、开赛卡、近况/交手之外，新增两块**全部来自真实数据**的内容：

| 区块 | 行为 |
| --- | --- |
| 本赛季数据 | 双方 7 项对比：场均得分、场均失分、投篮命中率、三分命中率、场均篮板、场均助攻、场均失误。某队本赛季还没打过常规赛时显示「尚无本赛季常规赛数据」，不是一排破折号 |
| 预计阵容 | 优先取该队**最近一场已完赛比赛的首发五人**（含季前赛，卡片上写明是哪一场、对手、比赛类型），每名球员显示位置、球衣号、本赛季场均 得分/篮板/助攻；该队本赛季没有任何已完赛比赛时回落到**球队名单**，标题改为「阵容名单」并说明「按名单位置列出，不是官方首发」。没有常规赛统计的球员显示「暂无赛季数据」 |

- 数据源是 ESPN 公开的 site/core API（NBA 官方 feed 不含赛季统计和赛前阵容），经同一 service 层读取：Web 走服务端、Android 走原生 HTTP 桥，不新增依赖。
- 缓存：球队统计 10 分钟、名单与球员统计 30 分钟、已完赛 box score 1 小时；球员统计最多 4 个并发。
- **懒加载**：球队对比随赛前页挂载即加载（两个小文档）；阵容默认折叠，展开才请求（需要 box score + 名单 + 最多 10 个球员统计）。
- 两块各自独立降级：读不到的那一块明说「暂不可用」，不会把整页拖垮，也不会用 0 或空格冒充数据。

### 更新提示（GitHub Releases）

- App 启动后（距上次检查 ≥24 小时）读取 GitHub Releases 的最新版；有新版且 release 里带 `.apk` 资产时，首页出现一条「发现新版本 x.y.z · 更新」，点击用系统浏览器打开下载安装。
- 当天关掉后不再提示；网络失败、仓库私有、GitHub 限流、预发布版本一律**静默**——更新提示出问题不能变成用户的错误页。
- 发布一个版本：改三处版本号（`package.json` 的 `version`、`android/app/build.gradle` 的 `versionCode`/`versionName`）→ 推 `main` → `git tag v1.2.0 && git push origin v1.2.0`。CI 会校验 tag ≡ versionName ≡ package.json、versionCode 相对上一版递增，然后创建 Release 并上传 APK。
- **前提：仓库必须是 Public**。私有仓库匿名请求 `releases/latest` 返回 404，App 内永远不会出现提示（按设计静默）。

### 视觉统一

- 字号收敛为 7 档（11/12/13/15/20/24/48），间距回到 4px 网格，圆角 4 档（card 14 / inner 12 / sheet 20 / full），按钮三态（primary / secondary / ghost，全部 ≥44px），卡片两种形态（`card` / `state-panel`），并新增 `notice` 提示条、`segmented` 分段控件、`chip` 筛选胶囊。
- 修掉的硬伤：`plays` 里引用了一个不存在的 `hover:bg-surface-2`（hover 完全失效）、比赛卡的内联底色把 hover 覆盖掉、深色下选中态和开关旋钮看起来「凹陷」、4 处触摸区不足 44px。
- 深色主题补齐 `[data-theme="dark"]` 变体与 `--control-*` / `--team-tint` / `--team-glow` / `--overlay` token：队色底纹、光晕、控制件、遮罩在深浅色下各一套，不再靠写死值。
- 刻意保留：比分数字滚动、直播点呼吸、详情页 48px 比分、球员表的列宽与字号、tab 滑动指示条、关注弹层的焦点陷阱。

## v0.1 包含什么

今日比赛与实时/本地状态、按天切换、紧凑卡片，以及带「概览 / 数据统计」两个标签的详情页。

| 区域 | 行为 |
| --- | --- |
| 首页 | `进行中 > 未开始 > 已结束`，空分区不渲染，卡片高约 114px |
| 日期 | 左右箭头、系统日期选择器、手机左右滑动；默认今天，离开今天后出现「回今天」 |
| 进行中 | 红点 + `进行中 · 第4节 · 6:21`（源的比赛钟，不本地倒数），每 6 秒刷新，红点轻微呼吸 |
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
| PWA | `manifest.webmanifest`（standalone、白底）＋ 192/512/maskable/180 图标（`node scripts/build-icons.mjs` 生成，零依赖）＋ service worker（页面网络优先、静态缓存优先、比分不缓存旧数据；**Web 版仅生产环境注册，原生构建跳过注册**） |

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

**这条路径装的是 Web 版本，不产出 APK；主线交付仍是上面的 APK。** 这个应用同时满足安卓的可安装标准（manifest ＋ `standalone` ＋ service worker ＋
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

**这条 PWA 路径是备选，不是主线。** 主推是上面的 APK：它不需要域名、不需要服务器，也就绕开了
`*.vercel.app` 在国内被 SNI 阻断的问题。PWA 路径仍然可用，适合已经在用 Web 版本的情况。

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

比赛列表及详情显示比赛类型；球队比分旁使用当前赛季常规赛分区排名和胜负战绩。
从首页「排名」进入东西部排名页，季前赛结果不会计入这份常规赛数据。
季后赛系列赛大比分按官方赛程的同系列比赛计算，包含已结束本场，排除未来比赛和常规赛交手；
缺少前序赛程时显示暂无数据。常规赛未产生战绩时显示 0 胜 0 负、暂无排名。

排名在开赛后来自 ESPN 公共 standings 接口，固定 `seasontype=2`，并校验 NBA 赛程赛季、
东西部各 15 队及来源排名。赛前仅在当前 NBA 官方赛程可确认尚未开始时使用 30 队 0-0；
排名请求独立于比分请求，失败会提示不可用或明确标注同赛季限时保留的数据。
当前 APK 尚未接入热更新，页面功能变更仍需安装新 APK。

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
60s, everything final → polling stops. At most **one request is in flight** and
**one timer is scheduled**; regaining focus or visibility syncs once (coalesced,
so both firing together is still one sync) and the loop is suspended entirely
while the document is hidden. The last good payload stays in memory, so
returning to a date paints instantly.

### Freshness

The two upstream feeds fail independently, so every payload carries a
`freshness` record (`src/lib/types.ts`) instead of a client-invented timestamp:

- `sourceAt` — the upstream's own data time; `null` when the source has none.
- `coverage` — `full` (the season schedule answered), `partial` (only the live
  scoreboard answered, and it covers this window), or `unknown` (only the live
  scoreboard answered, and it cannot speak for this date).
- `scoreboardOk` / `scheduleOk` — which feeds answered this round.

The rules consuming it live in `src/lib/game-state.ts` and are unit tested: a
degraded payload may not move a game backwards, may not retire a game it cannot
see, and only a `full` answer may report "no games". The client's own receive
time is tracked separately by the polling hook and shown as 更新于 …, while a
failed refresh is marked 数据可能不是最新.

The displayed clock is the source's, verbatim. It is never ticked locally: the
payload carries no trustworthy "clock is running" flag, and basketball stops the
clock on every whistle.

## Verification

`_probe/` holds the scripts used against a production build (`pnpm build && pnpm start`).
Deterministic regression lives in `tests/` and runs with `pnpm test`.

```bash
pnpm test                                                   # deterministic tests, no network
python _probe/ui-2026-10-11/capture.py                      # v0.9 UI + measured checks
python _probe/verify_zh.py                                  # 白底 + 中文：首页/日期/关注/详情/深色
python _probe/verify_extra.py                               # favorites, persistence, swipe
python _probe/verify_states.py                              # skeleton, error, retry, stale
python _probe/verify_live.py                                # 见下方说明
python _probe/verify_box.py                                 # box score fit at 375/390/430
python _probe/verify_v02.py                                 # 见下方说明
```

`verify_live.py` 与 `verify_v02.py` 仍然断言 v0.7 的行为，其中**包含本地每秒倒数的比赛钟**——
v0.9 已按审查 F01 有意移除该行为（篮球会停表，payload 里没有可信的"表在走"标志）。把它们的时间
断言当作历史记录看待，不要当成回归。

`verify_ui.py` 是改中文前那一版的全流程脚本（选择器仍是英文），保留作对照。

Screenshots land in `_probe/shots/`.
