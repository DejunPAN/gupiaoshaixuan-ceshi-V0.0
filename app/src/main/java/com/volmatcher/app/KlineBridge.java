package com.volmatcher.app;

import android.content.Context;
import android.content.Intent;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生桥: 供 H5 通过 window.NativeData 调用, 拉取无 CORS 限制的行情数据。
 *
 * 为什么需要它:
 *   浏览器(WebView)里的 JS 直接 fetch 新浪 K 线会因 CORS 被拦;
 *   原生 HTTP 请求不受同源策略限制, 由它代拉即可绕过。
 *
 * 数据源:
 *   - fetchSinaKline : 新浪 K 线(历史成交量, 稳定无风控)
 *   - fetchQuotes    : 腾讯批量行情(名称/现价, GBK 编码)
 *   - shareText      : 唤起系统分享面板(可分享到通达信/微信/文件管理器等)
 */
public class KlineBridge {

    private final ExecutorService executor = Executors.newFixedThreadPool(6);
    private final Context context;
    private final WebView webView;

    public KlineBridge(Context context, WebView webView) {
        this.context = context;
        this.webView = webView;
    }

    // ---------------- 新浪 K 线 ----------------

    @JavascriptInterface
    public void fetchSinaKline(final String code, final int days, final String callback) {
        executor.execute(() -> {
            String json = doGetSinaKline(code, days);
            runCallback(callback, json);
        });
    }

    private String doGetSinaKline(String code, int days) {
        String symbol = (code.startsWith("6") ? "sh" : "sz") + code;
        String url = "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
                + "?symbol=" + symbol + "&scale=240&ma=no&datalen=" + days;
        String body = httpGet(url, "UTF-8",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
                "https://finance.sina.com.cn/");
        return body == null ? "null" : body;
    }

    // ---------------- 腾讯批量行情 ----------------

    @JavascriptInterface
    public void fetchQuotes(final String commaCodes, final String callback) {
        executor.execute(() -> {
            String json = doGetQuotes(commaCodes);
            runCallback(callback, json);
        });
    }

    private String doGetQuotes(String commaCodes) {
        String url = "https://qt.gtimg.cn/q=" + commaCodes;
        String body = httpGet(url, "GBK",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
                "https://gu.qq.com/");
        if (body == null) {
            return "null";
        }
        // 腾讯返回 v_sh600000="..." 一段一段; 前端自行解析。这里仅原样返回文本。
        return "\"" + escapeJson(body) + "\"";
    }

    // ---------------- 系统分享(通达信/微信/文件管理器) ----------------

    @JavascriptInterface
    public void shareText(final String text) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, text);
        Intent chooser = Intent.createChooser(send, "分享股票清单");
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(chooser);
    }

    // ---------------- 工具 ----------------

    private String httpGet(String urlStr, String charset, String ua, String referer) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("User-Agent", ua);
            conn.setRequestProperty("Referer", referer);
            conn.setRequestProperty("Accept", "*/*");

            int code = conn.getResponseCode();
            if (code != 200) {
                return null;
            }
            InputStream is = conn.getInputStream();
            return readStream(is, charset);
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private String readStream(InputStream is, String charset) throws Exception {
        BufferedReader br = new BufferedReader(new InputStreamReader(is, charset));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) {
            sb.append(line).append('\n');
        }
        br.close();
        return sb.toString();
    }

    private String escapeJson(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "")
                .replace("\n", "\\n");
    }

    private void runCallback(String callback, String arg) {
        // 在 UI 线程通过 evaluateJavascript 回调 H5 定义的回调函数。
        // arg 已是 JS 字面量字符串(null / JSON / "带引号文本"), 直接拼进函数参数。
        final String safeArg = arg == null ? "null" : arg;
        final String js = "javascript:" + callback + "(" + safeArg + ")";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
