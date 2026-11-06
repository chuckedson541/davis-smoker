package com.edson.davissmoker;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Davis Smoker: the app's screens are one web page (assets/index.html) shown in a WebView.
 * This class adds what a phone app needs that a web page can't do on its own:
 * talking to the Google Sheet, copying text, saving files and keeping the screen on.
 */
public class MainActivity extends Activity {

    private WebView web;
    private final ExecutorService net = Executors.newFixedThreadPool(2);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // the log is kept on the phone between syncs
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);             // the page itself is a file inside the app
        s.setTextZoom(100);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("file".equals(u.getScheme())) return false;
                // Links to other sites open in the phone's browser
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "Native");

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        // Let the page step back (meat -> run -> list) before leaving the app
        web.evaluateJavascript("window.appBack ? String(window.appBack()) : 'false'", result -> {
            if (result == null || result.contains("false")) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        net.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    private void callJs(final String script) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(script, null); });
    }

    /** Methods the page calls as window.Native.something(...) */
    private class Bridge {

        @JavascriptInterface
        public String version() {
            try {
                return "v" + getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        /** HTTP request to the Google Sheet. Answers via window.__nativeHttp(id, status, text). */
        @JavascriptInterface
        public void http(final String id, final String method, final String url, final String body) {
            net.execute(() -> {
                int code;
                String text;
                try {
                    String[] res = request(method, url, body, 0);
                    code = Integer.parseInt(res[0]);
                    text = res[1];
                } catch (Exception e) {
                    code = 0;
                    text = e.getMessage() == null ? "offline" : e.getMessage();
                }
                callJs("window.__nativeHttp(" + JSONObject.quote(id) + "," + code + "," + JSONObject.quote(text) + ")");
            });
        }

        @JavascriptInterface
        public void copy(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Davis Smoker", text));
            });
        }

        /** Saves a CSV to Downloads (Android 10+) or offers it through the share sheet. */
        @JavascriptInterface
        public String saveFile(String name, String mime, String content) {
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    ContentResolver cr = getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new Exception("no uri");
                    try (OutputStream os = cr.openOutputStream(uri)) {
                        if (os == null) throw new Exception("no stream");
                        os.write(bytes);
                    }
                    return "Saved to Downloads: " + name;
                } catch (Exception e) {
                    // fall through to sharing
                }
            }
            runOnUiThread(() -> {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_SUBJECT, name);
                send.putExtra(Intent.EXTRA_TEXT, content);
                startActivity(Intent.createChooser(send, "Send " + name));
            });
            return "Choose where to send " + name;
        }

        /** Keeps the screen on while a run is live. */
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }

    /**
     * Google Apps Script answers a POST with a redirect to a second address that must be fetched with GET.
     * Redirects are followed by hand so that works the same on every Android version.
     */
    private static String[] request(String method, String address, String body, int hops) throws Exception {
        if (hops > 5) throw new Exception("Too many redirects");
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestMethod(method);
        c.setRequestProperty("Accept", "application/json");
        if ("POST".equals(method)) {
            byte[] out = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "text/plain;charset=utf-8");
            c.setFixedLengthStreamingMode(out.length);
            try (OutputStream os = c.getOutputStream()) { os.write(out); }
        }
        int code = c.getResponseCode();
        if (code >= 300 && code < 400) {
            String next = c.getHeaderField("Location");
            c.disconnect();
            if (next == null) throw new Exception("Redirect without an address");
            String nextMethod = (code == 307 || code == 308) ? method : "GET";
            return request(nextMethod, new URL(new URL(address), next).toString(), body, hops + 1);
        }
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = "";
        if (in != null) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            in.close();
            text = buf.toString("UTF-8");
        }
        c.disconnect();
        return new String[]{String.valueOf(code), text};
    }
}
