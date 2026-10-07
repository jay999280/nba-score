# NBA 自用比分工具 PRD + 技术方案 v0.2

## 1. 项目定位

这是一个仅供个人使用的 NBA 比分查看工具。

它不试图成为虎扑、NBA App 或 ESPN 的替代品，也不承担新闻、社区、视频、讨论、商业化等功能。

核心目标只有一个：

**用尽可能整洁、美观、直接的方式，让用户打开页面后立刻知道 NBA 今天发生了什么。**

产品优先级：

**视觉体验 > 信息层级 > 使用效率 > 功能数量 > 专业数据深度**

第一版宁可少做，也不要堆砌功能。

---

## 2. 核心使用场景

最典型的使用场景：

用户早上、比赛期间或比赛结束后想快速查看 NBA 比分。

理想流程：

**打开应用 → 直接看到今天的比赛 → 快速扫完比分 → 有兴趣再进入单场详情。**

整个过程中：

- 不需要登录
- 不需要进入 NBA 分区
- 不需要关闭广告
- 不需要浏览新闻流
- 不需要经过任何无关内容

目标是打开后 **1 秒内获得有效信息**。

---

## 3. 产品形态

第一阶段：

**响应式 Web App + PWA**

主要针对手机使用，同时兼容桌面浏览器。

PWA 安装到手机桌面后的理想体验：

```text
点击 NBA 图标
      ↓
直接进入今日比赛
      ↓
查看比分
      ↓
退出
```

第一阶段不开发：

- iOS Native App
- Android Native App
- 微信小程序

---

## 4. ESPN 页面调研结论

ESPN 的比赛页和比分页值得参考，但不直接复制其视觉风格。

主要借鉴以下几点：

### 4.1 高信息密度但层级清楚

ESPN 的优势不是“极简”，而是：

**能在有限空间中塞入足够多的比赛信息，同时保持可扫读性。**

这对 NBA 场景非常重要，因为一天可能有 8–15 场比赛。

因此，本项目不采用“每场比赛一个巨大海报式卡片”的方案。

首页应支持：

- 快速扫完整日比赛
- 在一屏中看到更多对阵
- 仍然保持足够留白和美观

---

### 4.2 首页比赛采用纵向双行球队结构

比起：

```text
Lakers                Warriors
  108        —          112
```

更推荐接近 ESPN 的纵向结构：

```text
Lakers                 108
Warriors               112

FINAL
```

LIVE：

```text
Lakers                  89
Warriors                94

● LIVE · Q4 · 6:21
```

优点：

- 一场比赛高度更低
- 视线移动路径更自然
- 适合一天大量比赛
- 更方便快速扫比分
- 手机上尤其高效

---

### 4.3 详情页顶部集中呈现比赛核心信息

详情页第一屏应直接显示：

- 球队
- Logo
- 比分
- 比赛状态
- 节次比分
- 球队战绩（弱化）

示例：

```text
NBA · REGULAR SEASON

Lakers                Warriors

  108                    112

           FINAL

      Q1   Q2   Q3   Q4    T
LAL   28   25   27   28   108
GSW   31   22   30   29   112
```

视觉上不照搬 ESPN，而是：

- 更多留白
- 更少边框
- 更大的比分
- 更克制的灰阶
- 更轻的视觉层次

---

### 4.4 使用 Tab 组织详情页

ESPN 典型结构：

```text
Gamecast
Box Score
Play-by-Play
Team Stats
```

本项目简化为：

```text
Overview
Box Score
```

v0.2 以后可增加：

```text
Plays
```

不加入：

- Recap
- Videos
- 新闻
- 评论
- 推荐内容

---

## 5. 首页结构

首页是整个产品最重要的页面。

核心原则：

**比赛本身就是内容。**

顶部保持极简：

```text
NBA

Mon, Oct 5
Today
```

顶部不需要：

- Banner
- 搜索框
- 用户头像
- 新闻入口
- 分类导航

---

## 6. 日期切换

推荐形式：

```text
‹        OCT 5 · TODAY        ›
```

或：

```text
SUN 4    MON 5    TUE 6
         TODAY
```

交互支持：

- 点击左右按钮
- 点击日期
- 手机端左右滑动

默认进入当前日期。

所有比赛时间统一根据用户设备本地时区显示。

---

## 7. 比赛列表

按照状态划分：

### LIVE

正在进行中的比赛。

### UPCOMING

尚未开始。

### FINAL

已经结束。

展示优先级：

**LIVE > UPCOMING > FINAL**

没有某一类比赛时，不显示空分区标题。

---

## 8. GameCard

GameCard 是首页核心组件。

### 8.1 默认形式

```text
┌──────────────────────────────┐
  Lakers                  108
  Warriors                112

  FINAL
└──────────────────────────────┘
```

### 8.2 LIVE

```text
┌──────────────────────────────┐
  Lakers                   89
  Warriors                 94

  ● LIVE · Q4 · 6:21
└──────────────────────────────┘
```

### 8.3 未开始

```text
┌──────────────────────────────┐
  Nuggets
  Thunder

  10:30 AM
└──────────────────────────────┘
```

不显示无意义的：

```text
0 - 0
```

---

## 9. GameCard 信息层级

一级信息：

- 球队
- 比分
- 比赛状态

二级信息：

- 球队 Logo
- 当前节次
- 剩余时间
- 开赛时间

三级信息：

- 球队战绩

第一版不加入：

- 球馆
- 裁判
- 转播平台
- 博彩赔率
- 新闻
- 社区
- 视频
- 比赛推荐

---

## 10. 信息密度原则

每场比赛卡片应尽可能控制在约 **90–130 px** 高度范围。

目标不是做“视觉海报”，而是：

**一屏能看到尽可能多的比赛，同时不显拥挤。**

页面应支持用户快速从上往下扫：

```text
球队 → 比分 → 状态
球队 → 比分 → 状态
球队 → 比分 → 状态
```

---

## 11. LIVE 状态

LIVE 必须明显，但不能喧宾夺主。

推荐：

- 小型红点
- `LIVE`
- 当前节次
- 剩余时间

允许非常克制的呼吸动画。

避免：

- 整张卡片变红
- 高频闪烁
- 大面积动态效果

---

## 12. 已结束比赛

FINAL 的视觉权重低于 LIVE。

可以：

- 降低文字亮度
- 降低 Logo 饱和度
- 弱化边框或背景
- 保留比分清晰度

目的是让正在进行中的比赛自然成为视觉焦点。

---

## 13. 比赛详情页

详情页第一屏先回答：

**比赛打成什么样了？**

推荐结构：

```text
Lakers                 Warriors

  108                     112

            FINAL
```

随后显示：

```text
      Q1   Q2   Q3   Q4    T
LAL   28   25   27   28   108
GSW   31   22   30   29   112
```

---

## 14. Overview

Overview 是详情页默认 Tab。

内容建议：

### 比分与节次

展示主比分和单节比分。

### Leaders

```text
Luka Doncic
31 PTS · 8 REB · 11 AST

Stephen Curry
36 PTS · 4 REB · 7 AST
```

### Team Stats

仅展示少量高价值指标，例如：

```text
FG%       48.2     51.3
3PT%      37.8     41.2
REB         44       41
AST         26       29
TO          12       10
```

不把 Overview 做成完整统计数据库。

---

## 15. Box Score

第二个 Tab：

```text
Overview    Box Score
```

移动端优先字段：

```text
PLAYER
MIN
PTS
REB
AST
FG
3PT
+/-
```

其他字段可以横向滚动或折叠。

原则：

**可读性优先于数据密度。**

---

## 16. Favorite Teams

用户可以选择自己关注的球队。

第一版只影响：

- 首页排序

推荐方式：

关注球队的比赛自动排到对应分区顶部。

不要额外创建复杂的：

```text
Favorite Games
Other Games
```

避免视觉层级变复杂。

存储方式：

`localStorage`

---

## 17. Spoiler Mode

后续版本可以加入隐藏比分模式。

开启后：

```text
Lakers
vs
Warriors

FINAL
```

不显示：

- 最终比分
- 胜负
- 球员统计结果

用户主动点击：

```text
Reveal Score
```

才显示结果。

此功能属于 v0.2，不阻塞 v0.1。

---

## 18. 视觉方向

关键词：

**Minimal / Calm / Premium / Sports**

参考方向：

**Apple Sports × ESPN 信息结构 × Linear 的克制感**

不复制任何单一产品。

避免：

- 虎扑式体育门户
- ESPN 的全部信息密度
- 电竞 HUD
- 大面积球队主题色
- 霓虹灯
- 强渐变
- 重玻璃拟态
- AI SaaS Dashboard 风格

---

## 19. 色彩

支持：

- Dark Mode
- Light Mode

优先把 Dark Mode 做好。

深色背景不建议使用纯黑：

```text
#000000
```

建议使用接近：

```text
#0A0A0A
#111111
```

的中性色。

球队颜色只作为 Accent 使用。

例如：

- 小状态条
- Logo
- 极轻微强调
- Hover 反馈

不允许整张页面跟随球队颜色变化。

---

## 20. 字体与数字

优先使用系统字体。

比分数字要求：

- 大字号
- 高可读性
- Tabular Numerals
- 足够留白

比分始终是比赛卡片中最强的视觉元素之一。

---

## 21. 动效

允许：

- 页面淡入
- 卡片轻微 Hover
- 日期滑动
- 比分数字平滑变化
- LIVE 状态轻微呼吸
- Skeleton Loading

禁止：

- 3D 翻转
- 卡片飞入
- 强烈弹簧动画
- 粒子效果
- 过度 Motion

---

## 22. 响应式设计

优先设计宽度：

**375–430 px**

Mobile：

```text
单列比赛
```

Desktop：

```text
居中内容区域
最大宽度约 800–1000px
```

桌面端不要简单把手机卡片拉满整个屏幕。

---

# 技术方案

## 23. 技术栈

推荐：

```text
Next.js
TypeScript
React
Tailwind CSS
Vercel
```

整个项目保持单体结构。

不拆：

- 独立后端
- 微服务
- 多仓库

---

## 24. 数据架构

```text
NBA Data Source
       ↓
Next.js Server
       ↓
Normalize Layer
       ↓
Internal API
       ↓
React UI
```

UI 不直接依赖 NBA 原始 JSON。

统一数据模型：

```ts
Game {
  id
  homeTeam
  awayTeam
  status
  period
  clock
  score
  startTime
}
```

未来数据源变化时，只修改 Adapter。

---

## 25. NBA 数据源

优先使用 NBA Live Data CDN。

今日比赛：

```text
https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json
```

单场 Box Score：

```text
https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{gameId}.json
```

不要让前端组件直接请求这些地址。

统一经过自己的 API 层。

---

## 26. Internal API

第一阶段：

```text
GET /api/games?date=YYYY-MM-DD
GET /api/games/[gameId]
```

前端只和自己的 Internal API 通信。

---

## 27. 数据刷新策略

不使用 WebSocket。

LIVE：

```text
10–15 秒刷新一次
```

即将开始：

```text
约 60 秒刷新一次
```

FINAL：

```text
停止轮询
```

页面重新获得焦点时：

```text
立即刷新一次
```

---

## 28. 时区

内部保留标准时间。

UI 使用浏览器本地时区。

禁止写死：

```text
UTC+8
```

未来如果需要，可以增加：

```text
Local
Beijing
ET
```

手动切换。

---

## 29. 本地存储

第一版不需要数据库。

使用 `localStorage` 保存：

```text
favoriteTeams
theme
spoilerMode
```

暂时不使用：

- PostgreSQL
- MySQL
- MongoDB
- Supabase
- Firebase

---

## 30. 不做用户系统

不加入：

- Register
- Login
- OAuth
- Profile
- Cloud Sync
- Account Settings

这是个人工具，没有必要。

---

## 31. PWA

基础功能稳定后加入 PWA。

目标：

- 添加到手机主屏幕
- 独立图标
- 独立窗口
- Theme Color
- 合理 Splash Screen
- 基础缓存

不需要复杂离线能力。

---

## 32. Loading

不用满屏 Spinner。

使用与真实 GameCard 结构接近的 Skeleton。

要求：

- 避免 Layout Shift
- 页面加载时保持版式稳定

---

## 33. 错误状态

数据失败时：

```text
Unable to load games

Retry
```

已有旧数据时：

```text
Last updated 10:42
```

继续显示缓存，同时明确数据可能不是最新。

---

## 34. 性能目标

要求：

- 首页快速加载
- 比分更新不导致整页闪烁
- 单场更新尽量局部重绘
- Logo 和静态资源缓存
- 不加载无关 JS
- 动画不影响滚动性能

不追求纯 Lighthouse 分数，而看主观体验。

---

# MVP

## 35. v0.1

必须实现：

1. 今日比赛
2. 日期切换
3. 比赛状态
4. 实时比分
5. 紧凑型 GameCard
6. 比赛详情
7. 节次比分
8. Overview
9. Box Score
10. Leaders
11. Dark / Light Mode
12. 响应式 UI
13. Favorite Teams
14. Local Storage
15. NBA Data Adapter
16. Loading
17. Error State

---

## 36. v0.1 明确不做

- 新闻
- 集锦
- 视频
- 评论
- 社区
- 球员新闻
- 球队新闻
- AI 比赛分析
- Fantasy
- 博彩
- Odds
- Push Notification
- 用户登录
- 云同步
- 数据库
- 后台管理
- 多语言
- WNBA
- NCAA
- NFL
- MLB

---

## 37. 后续版本

### v0.2

- Spoiler Mode
- PWA
- 更好的 Favorite Team 体验
- 比分变化动画

### v0.3

- Play-by-Play
- Team Stats 扩展
- 比赛走势

### Future

只有长期使用后确认有需求再考虑：

- 比赛开始提醒
- Final 提醒
- Favorite Team Widget
- Live Activities
- Dynamic Island
- Apple Watch

---

# 开发原则

## 38. Codex 实现原则

### 1. 不过度工程化

能简单解决的问题不要引入复杂架构。

### 2. UI 优先

如果“实现更多功能”和“把已有页面做好看”冲突：

**优先 UI。**

### 3. 信息密度要适中

不要为了极简让每场比赛占据过多空间。

### 4. 移动端优先

先保证 375–430 px 屏幕体验优秀。

### 5. 数据层与 UI 解耦

NBA 原始数据结构不得扩散到整个代码库。

### 6. 不擅自增加功能

PRD 没要求的功能不要主动加入。

### 7. ESPN 只借鉴信息架构

参考：

- 比分列表扫描效率
- 纵向球队排列
- 详情页顶部比分结构
- Tab 组织

不复制：

- 广告
- 新闻
- 视频
- 推荐
- 复杂导航
- 门户化信息布局

---

## 39. 最终验收标准

用户第二天想看 NBA 比分时：

如果第一反应逐渐从：

**打开虎扑 / ESPN**

变成：

**打开自己的比分工具**

那么项目成功。

最终体验应可以概括为：

> **Open. Scan. Done.**

---

## 40. 参考

- ESPN NBA Game 页面：https://global.espn.com/nba/game/
- NBA Live Scoreboard：
  `https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json`
- NBA Live Box Score：
  `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{gameId}.json`
