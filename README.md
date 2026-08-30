# 量形选股 (VolMatcher)

手机端（Android APK）成交量形态筛选工具。无需服务器，全在手机本地运行。

## 形态规则

扫描全市场，找出「40日内两次爆量 + 第二次更高 + 缩量连跌 + 今日首次转增」形态的股票。

6 条精筛规则（参数均可在 App 内调整）：
1. 40 日内出现 ≥2 次爆量（当日量 ≥ 前10日均量 × `SURGE_RATIO`）
2. 第二次爆量量能 > 第一次
3. 两次爆量都非「一日游」（次日量不回落到基线 × `SUSTAIN_RATIO` 以下）
4. 二次爆量后连续下跌 ≥ `FALL_DAYS` 天
5. 今日量 > 昨日量
6. 今日量 < 二次爆量峰值 × `TODAY_PEAK_RATIO`

粗筛规则：沪深主板+创业板（600/601/603/605/000/001/002/003/300/301）、排除 ST、现价 ≤ 70。

## 数据源

- 粗筛（名称+现价）：腾讯批量行情 `qt.gtimg.cn`（GBK）
- 精筛（历史成交量）：新浪 K 线 `quotes.sina.cn`（由原生桥拉取，绕过 CORS）

## 技术栈

- Android WebView + `addJavascriptInterface` 原生桥
- H5 前端 + 纯 JS 形态匹配算法（`matcher.js`，由 `pattern_scanner.py` 翻译而来）
- 零第三方依赖，零服务器

## 如何构建 APK（GitHub Actions 云端，本机零安装）

1. 登录 github.com → New repository（Public）
2. 把本文件夹整个上传到仓库根目录（Add file → Upload files）
3. 进 Actions 标签 → 选中 workflow → Run workflow
4. 构建完成后，在本次运行的 Artifacts 区下载 `VolMatcher-release`，解压得到 APK
5. 传手机安装即可

首次构建约 5-10 分钟（需下载 JDK/Android SDK/Gradle 依赖）。

> 注意：build.gradle 里的 release 签名密码是写死的默认值（volmatcher123），
> 仅供个人自用。若要发布到应用商店，请自行更换 keystore 与密码。

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
        │   └── matcher.js             # 形态算法 + 数据层
        └── res/...                     # 图标/主题/布局
```