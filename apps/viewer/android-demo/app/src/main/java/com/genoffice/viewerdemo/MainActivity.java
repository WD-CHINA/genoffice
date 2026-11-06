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

    private LocalAssetServer server;
    private int port;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private volatile boolean destroyed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true);
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
        if (intent.getBooleanExtra("download", false)) startDownload();
        else if (intent.getBooleanExtra("open", false)) {
            String current = fileId != null ? fileId : fileInput.getText().toString().trim();
            if (!current.isEmpty()) openCached(current);
        }
    }

    private void updateStatus(String fileId) {
        if (status == null) return;
        if (fileId == null || fileId.isEmpty()) {
            status.setText("尚未下载离线包。");
            return;
        }
        BundleStore store = new BundleStore(getFilesDir(), fileId);
        status.setText(store.isComplete()
                ? "已有离线包：" + store.unitCount() + " 页，可直接离线打开。"
                : "没有找到 " + fileId.substring(0, Math.min(12, fileId.length())) + " 的离线包。");
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
        setBusy(true);
        setStatus("连接解析服务…");
        new Thread(() -> {
            BundleStore store = new BundleStore(getFilesDir(), fileId);
            try {
                new BundleDownloader(serverUrl, token, fileId, store,
                        text -> runOnUiThread(() -> setStatus(text))).run();
                runOnUiThread(() -> {
                    if (destroyed) return;
                    setBusy(false);
                    updateStatus(fileId);
                    openCached(fileId);
                });
            } catch (Exception e) {
                Log.e(TAG, "offline bundle failed", e);
                runOnUiThread(() -> {
                    if (destroyed) return;
                    setBusy(false);
                    setStatus("下载失败：" + e.getMessage());
                    Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }, "bundle-download").start();
    }

    private void setBusy(boolean busy) {
        if (downloadButton != null) downloadButton.setEnabled(!busy);
        if (openButton != null) openButton.setEnabled(!busy);
    }

    private void setStatus(String text) {
        if (status != null) status.setText(text);
    }

    // ── offline viewer ───────────────────────────────────────────────────────

    private void openCached(String fileId) {
        BundleStore store = new BundleStore(getFilesDir(), fileId);
        if (!store.isComplete()) {
            Toast.makeText(this, "还没有下载该文件的离线包", Toast.LENGTH_SHORT).show();
            return;
        }
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
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (webView != null) webView.destroy();
        if (server != null) server.shutdown();
        super.onDestroy();
    }
}
