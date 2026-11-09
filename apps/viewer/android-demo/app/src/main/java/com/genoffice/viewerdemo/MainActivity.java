package com.genoffice.viewerdemo;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Locale;

/**
 * Offline viewer demo:
 *
 * 1. The setup screen takes the parse server address and a fileId, and downloads the
 *    server-parsed bundle (units + media parts + fonts) into app storage.
 * 2. The bundled Web Viewer is served from assets on 127.0.0.1 together with a local
 *    /v1 implementation replaying that bundle, so rendering works with no network and
 *    audio/video play from the cached local parts.
 */
public class MainActivity extends Activity {
    private static final String TAG = "ViewerDemo";
    private static final String PREFS = "viewer-demo";
    private static final int FILE_REQ = 1;

    private EditText serverInput;
    private EditText fileInput;
    private EditText tokenInput;
    private TextView status;
    private Button downloadButton;
    private Button openButton;
    private Button cancelButton;
    private Button cleanupButton;
    private BundleCache cache;
    private volatile BundleDownloader activeDownload;

    private LocalAssetServer server;
    private int port;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private volatile boolean destroyed;
    private int openGeneration;
    private int downloadGeneration;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true);
        cache = new BundleCache(getFilesDir());
        showSetup();
    }

    // ── setup screen ─────────────────────────────────────────────────────────

    private void showSetup() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        root.setPadding(pad, dp(40), pad, pad);

        TextView title = new TextView(this);
        title.setText("Office Viewer 离线演示");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setTextColor(Color.BLACK);
        root.addView(title, matchWrap());

        TextView hint = new TextView(this);
        hint.setText("先从解析服务下载该文件的解析结果（每页渲染树、音视频与字体），之后断网也能预览；音视频使用本地缓存文件播放。");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        hint.setPadding(0, dp(8), 0, dp(16));
        root.addView(hint);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverInput = field("解析服务地址", prefs.getString("server", "http://127.0.0.1:8787"));
        fileInput = field("文件 ID（sha256）", prefs.getString("fileId", ""));
        tokenInput = field("访问令牌（可留空）", prefs.getString("token", ""));
        root.addView(labeled("解析服务地址", serverInput));
        root.addView(labeled("文件 ID", fileInput));
        root.addView(labeled("访问令牌（可留空）", tokenInput));

        downloadButton = new Button(this);
        downloadButton.setText("下载离线包并打开");
        downloadButton.setOnClickListener(v -> startDownload());
        root.addView(downloadButton, matchWrapTop(dp(24)));

        openButton = new Button(this);
        openButton.setText("打开已缓存离线包");
        openButton.setOnClickListener(v -> {
            String fileId = fileInput.getText().toString().trim();
            if (fileId.isEmpty()) {
                Toast.makeText(this, "请填写文件 ID", Toast.LENGTH_SHORT).show();
                return;
            }
            openCached(fileId);
        });
        root.addView(openButton, matchWrapTop(dp(8)));

        cancelButton = new Button(this);
        cancelButton.setText("取消下载");
        cancelButton.setEnabled(false);
        cancelButton.setOnClickListener(v -> {
            BundleDownloader download = activeDownload;
            if (download != null) {
                cancelButton.setEnabled(false);
                setStatus("正在取消下载…");
                download.cancel();
            }
        });
        root.addView(cancelButton, matchWrapTop(dp(8)));

        cleanupButton = new Button(this);
        cleanupButton.setText("清理离线缓存（保留当前包）");
        cleanupButton.setOnClickListener(v -> cleanupCache());
        root.addView(cleanupButton, matchWrapTop(dp(8)));

        status = new TextView(this);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        status.setPadding(0, dp(20), 0, 0);
        root.addView(status);
        updateStatus(prefs.getString("fileId", ""));

        setContentView(root);
        applyIntent(getIntent());
    }

    /** adb convenience: --es server … --es fileId … [--ez download true] */
    private void applyIntent(Intent intent) {
        if (intent == null) return;
        String server = intent.getStringExtra("server");
        String fileId = intent.getStringExtra("fileId");
        String token = intent.getStringExtra("token");
        if (server != null) serverInput.setText(server);
        if (fileId != null) fileInput.setText(fileId);
        if (token != null) tokenInput.setText(token);
        // The status line must describe the intent's fileId, not the last saved preference.
        updateStatus(fileInput.getText().toString().trim());
        if (intent.getBooleanExtra("download", false)) startDownload();
        else if (intent.getBooleanExtra("open", false)) {
            String current = fileId != null ? fileId : fileInput.getText().toString().trim();
            if (!current.isEmpty()) openCached(current);
        }
    }

    private void updateStatus(String fileId) {
        if (status == null) return;
        String size = String.format(Locale.US, "%.1f MiB", cache.usedBytes() / (1024.0 * 1024.0));
        if (fileId == null || fileId.isEmpty()) {
            status.setText("尚未下载离线包；缓存共 " + size + "。");
            return;
        }
        BundleStore store = cache.resolve(fileId);
        if (!store.isSealed()) {
            status.setText("没有找到 " + fileId.substring(0, Math.min(12, fileId.length()))
                    + " 的离线包；缓存共 " + size + "。");
            return;
        }
        StringBuilder text = new StringBuilder("已有离线包：")
                .append(store.unitCount()).append(" 页，可直接离线打开。");
        if (!store.claimsFullOffline())
            text.append(" 部分离线：").append(store.externalResourceCount())
                    .append(" 个外部资源需联网，未保证完整离线。");
        text.append(" 缓存共 ").append(size).append(" / 配额 ")
                .append(cache.maxBytes() / (1024 * 1024)).append(" MiB，历史版本 ")
                .append(cache.versionCount()).append(" 个。");
        status.setText(text.toString());
    }

    /** Manual cleanup: inactive generations, staging, partial transfers and interrupted backups. */
    private void cleanupCache() {
        if (activeDownload != null) {
            Toast.makeText(this, "下载进行中，暂不能清理缓存", Toast.LENGTH_SHORT).show();
            return;
        }
        String fileId = fileInput.getText().toString().trim();
        JSONObject current = cache.current(fileId);
        String key = current == null ? null : current.optString("artifactKey", null);
        setBusy(true);
        setStatus("正在清理离线缓存…");
        new Thread(() -> {
            long freed = cache.clearInactive(fileId, key);
            runOnUiThread(() -> {
                if (destroyed) return;
                setBusy(false);
                updateStatus(fileId);
                Toast.makeText(this, "已清理 " + String.format(Locale.US, "%.1f MiB",
                        freed / (1024.0 * 1024.0)) + " 非当前缓存", Toast.LENGTH_SHORT).show();
            });
        }, "bundle-cleanup").start();
    }

    private EditText field(String hint, String value) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setText(value);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        return input;
    }

    private View labeled(String label, EditText input) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, dp(10), 0, 0);
        TextView text = new TextView(this);
        text.setText(label);
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        box.addView(text);
        box.addView(input, matchWrap());
        return box;
    }

    private static LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private static LinearLayout.LayoutParams matchWrapTop(int top) {
        LinearLayout.LayoutParams params = matchWrap();
        params.topMargin = top;
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ── download ─────────────────────────────────────────────────────────────

    private void startDownload() {
        if (activeDownload != null) return;
        String serverUrl = serverInput.getText().toString().trim();
        String fileId = fileInput.getText().toString().trim();
        String token = tokenInput.getText().toString().trim();
        if (serverUrl.isEmpty() || fileId.isEmpty()) {
            Toast.makeText(this, "请填写解析服务地址和文件 ID", Toast.LENGTH_SHORT).show();
            return;
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("server", serverUrl)
                .putString("fileId", fileId)
                .putString("token", token)
                .apply();
        final int generation = ++downloadGeneration;
        BundleDownloader download = new BundleDownloader(serverUrl, token, fileId,
                cache.resolve(fileId), text -> runOnUiThread(() -> {
                    if (!destroyed && generation == downloadGeneration && activeDownload != null && !activeDownload.isCancelled()) setStatus(text);
                }), File::getUsableSpace, cache);
        activeDownload = download;
        setBusy(true);
        setStatus("连接解析服务…");
        new Thread(() -> {
            try {
                download.run();
                runOnUiThread(() -> {
                    if (destroyed || activeDownload != download) return;
                    activeDownload = null;
                    setBusy(false);
                    updateStatus(fileId);
                    openCached(fileId);
                });
            } catch (Exception e) {
                Log.e(TAG, "offline bundle failed", e);
                runOnUiThread(() -> {
                    if (destroyed || activeDownload != download) return;
                    activeDownload = null;
                    setBusy(false);
                    if (download.isCancelled()) { setStatus("下载已取消"); return; }
                    setStatus("下载失败：" + e.getMessage());
                    Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }, "bundle-download").start();
    }

    private void setBusy(boolean busy) {
        if (downloadButton != null) downloadButton.setEnabled(!busy);
        if (openButton != null) openButton.setEnabled(!busy);
        if (cleanupButton != null) cleanupButton.setEnabled(!busy);
        if (cancelButton != null) cancelButton.setEnabled(busy && activeDownload != null);
    }

    private void setStatus(String text) {
        if (status != null) status.setText(text);
    }

    // ── offline viewer ───────────────────────────────────────────────────────

    private void openCached(String fileId) {
        final int generation = ++openGeneration;
        setBusy(true);
        setStatus("正在校验离线资源…");
        new Thread(() -> {
            BundleStore store = cache.resolve(fileId);
            try {
                store.verifyIntegrity();
                runOnUiThread(() -> {
                    if (destroyed || generation != openGeneration) return;
                    setBusy(false);
                    if (!store.claimsFullOffline())
                        Toast.makeText(this, "部分离线：" + store.externalResourceCount()
                                + " 个外部资源需联网，未保证完整离线", Toast.LENGTH_LONG).show();
                    showCached(store);
                });
            } catch (IOException failure) {
                runOnUiThread(() -> {
                    if (destroyed || generation != openGeneration) return;
                    setBusy(false);
                    setStatus("离线包校验失败，请重新下载：" + failure.getMessage());
                });
            }
        }, "bundle-verify").start();
    }

    private void showCached(BundleStore store) {
        String fileId = store.fileId();
        try {
            if (server == null) {
                server = new LocalAssetServer(getAssets(), store);
                port = server.startAndWait();
            }
        } catch (Exception e) {
            Log.e(TAG, "local server failed", e);
            Toast.makeText(this, "本地服务启动失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            return;
        }
        if (webView == null) webView = createWebView();
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(VIEWER_BACKGROUND);
        container.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        FrameLayout loading = new FrameLayout(this);
        loading.setBackgroundColor(VIEWER_BACKGROUND);
        container.addView(loading, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        ProgressBar spinner = new ProgressBar(this);
        FrameLayout.LayoutParams spinnerParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.CENTER);
        loading.addView(spinner, spinnerParams);
        setContentView(container);
        // Load the preview document directly: the host shell (header + iframe) would add a
        // second document load and a blank frame before the deck appears.
        String base = "http://127.0.0.1:" + port;
        String url = base + "/viewer/preview.html?src=bundle&format=pptx&name="
                + Uri.encode(fileId)
                + "&server=" + Uri.encode(base)
                + "&fileId=" + Uri.encode(fileId)
                + "&layout=client&theme=dark";
        Log.i(TAG, "open " + url);
        webView.loadUrl(url);
        revealWhenReady(webView, loading);
    }

    /** Viewer page background (dark); the app forces the same theme on the WebView. */
    private static final int VIEWER_BACKGROUND = 0xFF16181A;

    /**
     * Keep the native loading screen up until the viewer has actually rendered its first
     * slide (or reported an error). A blank WebView document would otherwise flash
     * between the activity window and the first paint.
     */
    private void revealWhenReady(WebView view, View loading) {
        final long deadline = SystemClock.uptimeMillis() + 15000;
        final Runnable[] poll = new Runnable[1];
        poll[0] = () -> {
            if (view != webView) return;
            if (SystemClock.uptimeMillis() > deadline) {
                loading.setVisibility(View.GONE);
                return;
            }
            view.evaluateJavascript(
                    "!!document.querySelector('.viewer-slide-stage canvas')"
                            + " || !!document.querySelector('[role=alert]')",
                    value -> {
                        if ("true".equals(value)) {
                            view.postVisualStateCallback(0, new WebView.VisualStateCallback() {
                                @Override public void onComplete(long requestId) {
                                    if (view == webView) loading.setVisibility(View.GONE);
                                }
                            });
                        }
                        else view.postDelayed(poll[0], 120);
                    });
        };
        view.postDelayed(poll[0], 150);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView view = new WebView(this);
        view.setBackgroundColor(VIEWER_BACKGROUND);
        // A foreground presentation must not be interrupted by the screen timeout.
        view.setKeepScreenOn(true);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return false;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQ);
                } catch (Exception e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i(TAG, message.message() + " (" + message.sourceId() + ":"
                        + message.lineNumber() + ")");
                return true;
            }
        });
        return view;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQ || fileCallback == null) return;
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        fileCallback = null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (webView != null) {
            setContentView(webView);
        } else {
            applyIntent(intent);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            // Leave the viewer; the next launch reopens the setup screen.
            webView = null;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (activeDownload != null) activeDownload.cancel();
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (webView != null) webView.destroy();
        if (server != null) server.shutdown();
        super.onDestroy();
    }
}
