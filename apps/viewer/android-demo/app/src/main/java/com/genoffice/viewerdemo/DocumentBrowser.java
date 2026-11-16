package com.genoffice.viewerdemo;

import android.app.Activity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import java.text.DateFormat;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/** One native screen owns its endpoint, cursor and in-flight request until it is closed. */
final class DocumentBrowser {
    interface Actions {
        void open(ServerDocuments.Document document, String action);
        void settings();
        void cancelDownload();
    }
    private final Activity activity;
    private final String server, token;
    private final BundleCache cache;
    private final Actions actions;
    private final List<ServerDocuments.Document> documents = new ArrayList<>();
    private final Set<String> fileIds = new HashSet<>(), cursors = new HashSet<>();
    private final LinearLayout root;
    private final TextView status;
    private final Button refresh, more, settings, cancelDownload;
    private final BaseAdapter adapter;
    private ServerDocuments request;
    private String next;
    private int generation;
    private boolean closed, loading, busy;

    DocumentBrowser(Activity activity, String server, String token, BundleCache cache, Actions actions) {
        this.activity = activity; this.server = server; this.token = token; this.cache = cache; this.actions = actions;
        root = new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(16), dp(24), dp(16), dp(12));
        TextView title = new TextView(activity); title.setText("服务端文档"); title.setTextSize(22); root.addView(title);
        LinearLayout toolbar = new LinearLayout(activity);
        settings = button("返回设置", actions::settings); refresh = button("刷新", () -> load(true));
        toolbar.addView(settings, weight()); toolbar.addView(refresh, weight()); root.addView(toolbar);
        status = new TextView(activity); status.setTextSize(13); status.setPadding(0, dp(8), 0, dp(8)); root.addView(status);
        ListView list = new ListView(activity);
        adapter = new BaseAdapter() {
            @Override public int getCount() { return documents.size(); }
            @Override public Object getItem(int position) { return documents.get(position); }
            @Override public long getItemId(int position) { return position; }
            @Override public View getView(int position, View recycled, ViewGroup parent) {
                LinearLayout row;
                if (recycled instanceof LinearLayout) row = (LinearLayout) recycled;
                else {
                    row = new LinearLayout(activity); row.setOrientation(LinearLayout.VERTICAL); row.setPadding(dp(8), dp(12), dp(8), dp(12));
                    TextView name = new TextView(activity); name.setTextSize(17); name.setMaxLines(2); row.addView(name);
                    TextView detail = new TextView(activity); detail.setTextSize(12); row.addView(detail);
                    LinearLayout buttons = new LinearLayout(activity);
                    for (String label : new String[]{"在线预览", "下载离线", "打开缓存"}) buttons.addView(button(label, () -> {}), weight());
                    row.addView(buttons);
                }
                ServerDocuments.Document document = documents.get(position);
                ((TextView) row.getChildAt(0)).setText(document.displayName);
                boolean cached = cache.resolve(document.fileId).isSealed();
                ((TextView) row.getChildAt(1)).setText(document.format.toUpperCase(Locale.ROOT) + " · " + bytes(document.size)
                        + " · " + time(document.createdAt) + (cached ? " · 已缓存" : ""));
                LinearLayout buttons = (LinearLayout) row.getChildAt(2);
                String[] actionNames = {"online", "download", "cached"};
                for (int i = 0; i < actionNames.length; i++) {
                    Button button = (Button) buttons.getChildAt(i); String action = actionNames[i];
                    button.setEnabled(!busy); button.setVisibility(i == 2 && !cached ? View.GONE : View.VISIBLE);
                    button.setOnClickListener(v -> actions.open(document, action));
                }
                return row;
            }
        };
        list.setAdapter(adapter); root.addView(list, new LinearLayout.LayoutParams(-1, 0, 1));
        more = button("加载更多", () -> load(false)); root.addView(more);
        cancelDownload = button("取消下载", actions::cancelDownload); cancelDownload.setVisibility(View.GONE); root.addView(cancelDownload);
        controls();
    }
    View view() { return root; }
    TextView statusView() { return status; }
    void refresh() { load(true); }
    void stop() { generation++; if (request != null) request.cancel(); request = null; loading = false; controls(); }
    void close() { closed = true; stop(); }
    void setBusy(boolean busy, boolean downloading) {
        this.busy = busy;
        cancelDownload.setVisibility(busy && downloading ? View.VISIBLE : View.GONE);
        cancelDownload.setEnabled(busy && downloading); controls(); adapter.notifyDataSetChanged();
    }
    private void controls() {
        refresh.setEnabled(!busy && !loading); settings.setEnabled(!busy);
        more.setVisibility(next == null ? View.GONE : View.VISIBLE); more.setEnabled(!busy && !loading);
    }
    private void load(boolean reset) {
        if (closed || busy || loading || (!reset && next == null)) return;
        stop();
        if (reset) { documents.clear(); fileIds.clear(); cursors.clear(); next = null; adapter.notifyDataSetChanged(); }
        final String cursor = reset ? null : next;
        final int owned = ++generation;
        final ServerDocuments client = new ServerDocuments(); request = client; loading = true;
        status.setText(reset ? "正在获取服务端文档…" : "正在加载更多文档…"); controls();
        new Thread(() -> {
            try {
                ServerDocuments.Page page = client.list(server, token, cursor);
                activity.runOnUiThread(() -> {
                    if (closed || generation != owned) return;
                    request = null; loading = false;
                    if (page.next != null && cursors.contains(page.next)) {
                        next = null; status.setText("服务端返回重复的分页游标，请刷新重试"); controls(); return;
                    }
                    if (cursor != null) cursors.add(cursor);
                    for (ServerDocuments.Document document : page.items) if (fileIds.add(document.fileId)) documents.add(document);
                    next = page.next; adapter.notifyDataSetChanged();
                    status.setText(documents.isEmpty() ? "服务端暂无文档，上传后点击刷新" : "已加载 " + documents.size() + " 个文档" + (next == null ? "，已全部加载" : ""));
                    controls();
                });
            } catch (Exception failure) {
                activity.runOnUiThread(() -> {
                    if (closed || generation != owned) return;
                    request = null; loading = false;
                    status.setText("获取文档失败：" + failure.getMessage() + "。请检查连接设置后重试"); controls();
                });
            }
        }, "server-documents").start();
    }
    private Button button(String label, Runnable action) { Button button = new Button(activity); button.setText(label); button.setOnClickListener(v -> action.run()); return button; }
    private int dp(int value) { return (int) (activity.getResources().getDisplayMetrics().density * value + .5f); }
    private static LinearLayout.LayoutParams weight() { return new LinearLayout.LayoutParams(0, -2, 1); }
    private static String bytes(long bytes) { return bytes >= 1024 * 1024 ? String.format(Locale.getDefault(), "%.1f MiB", bytes / (1024.0 * 1024.0)) : String.format(Locale.getDefault(), "%.1f KiB", bytes / 1024.0); }
    private static String time(String raw) {
        try {
            SimpleDateFormat source = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT); source.setTimeZone(TimeZone.getTimeZone("UTC"));
            return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(source.parse(raw));
        } catch (Exception ignored) { return "时间未知"; }
    }
}
