# 换手突破选股 (TurnoverBreakout)

手机端（Android APK）本地选股工具。无需服务器，全在手机本地运行。

## 选股规则

按以下规则扫描全市场：

1. 换手率 > 下限（默认 `5%`）且 < 上限（默认 `30%`，可在 App 内修改）。
2. 振幅 < 上限（默认 `12%`，可在 App 内修改）。
3. 当日最低价 > 前 2 个交易日的最低价。
4. 当日最高价 > 前 2 个交易日的最高价。
5. 排除北交所和科创板，只保留沪深主板 + 创业板（`600/601/603/605/000/001/002/003/300/301/302`）。

说明：
- “前 2 个交易日”指 K 线中倒数第 2、倒数第 3 根日 K。
- “当日”指 K 线最后一根日 K；盘中运行时为当天实时日 K，收盘后为当天收盘日 K。
- 当前版本不额外加入 ST、股价上限等未指定过滤条件；如需要可以后续再加开关。

## 详情页

在结果列表中点击任意股票，会进入详情页：

- 顶部显示：现价、涨跌幅、最高、开盘、最低、换手率、振幅、昨收、成交量、成交额。
- 日K线：最近 180 个交易日蜡烛图，下方为成交量；阴线用淡蓝色，阳线用红色。
- 左右滑动切换列表中的上一只/下一只股票，也可以点「上一只 / 下一只」。
- 双指缩放，或点「放大 / 缩小 / 重置」调整K线显示数量（20~180日）。
- 不显示分时图，也不显示 MACD、KDJ、RSI 等额外指标。

## 数据源

- 粗筛（名称 + 现价 + 换手率）：腾讯批量行情 `qt.gtimg.cn`（GBK），换手率取行情字段第 38 位。
- 精筛：**当日最高/最低价、换手率、振幅取腾讯实时行情**；前 2 个交易日高低价取新浪日 K `quotes.sina.cn`，由原生桥拉取，绕过 CORS。盘中新浪日 K 可能还没有当天这一根，因此不能把它的最后一根当作“当日”。
- 数据新鲜度：K 线最后一根日期需距今 60 天内，用于过滤长期停牌/退市股的陈旧数据；这不是选股规则本身。

## 技术栈

- Android WebView + `addJavascriptInterface` 原生桥。
- H5 前端 + 纯 JS 筛选算法（`matcher.js`）。
- 零第三方依赖，零服务器。

## 如何构建 APK（GitHub Actions 云端，本机零安装）

1. 登录 github.com → 打开本仓库或新建仓库。
2. 把本文件夹内容放到仓库根目录。
3. 进 Actions 标签 → 选中 `Build APK` workflow → Run workflow。
4. 构建完成后，下载本次运行的 `VolMatcher-release` artifact，解压得到 APK。
5. 传到手机安装即可。

首次构建约 5-10 分钟（需下载 JDK/Android SDK/Gradle 依赖）。

> 注意：`build.gradle` 里的 release 签名密码默认是 `volmatcher123`，仅供个人自用。若要发布到应用商店，请自行更换 keystore 与密码。

## 目录结构

```
.
├── settings.gradle
├── build.gradle
├── gradle.properties
├── .github/workflows/build-apk.yml   # 云端构建配置
└── app/
    ├── build.gradle
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/volmatcher/app/
        │   ├── MainActivity.java      # WebView 壳
        │   └── KlineBridge.java       # 原生网络桥(绕 CORS)
        ├── assets/
        │   ├── index.html             # H5 前端
        │   └── matcher.js             # 换手突破算法 + 数据层
        └── res/...                     # 图标/主题/布局
```
