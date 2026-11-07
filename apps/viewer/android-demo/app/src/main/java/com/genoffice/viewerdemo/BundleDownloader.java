package com.genoffice.viewerdemo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Downloads a parse-server session into a local bundle: every slide unit, every media
 * part the units reference (posts, audio, video) and the embedded fonts. Unit JSON is
 * rewritten so part URLs are same-origin relative paths — the bundled local server
 * can then replay the session with no network.
 */
final class BundleDownloader {
    interface Listener {
        /** Stage text for the setup screen; called from the worker thread. */
        void stage(String text);
    }

    private final String server;
    private final String token;
    private final String fileId;
    private BundleStore store;
    private final Listener listener;
    private final BundleSpace space;
    private final Set<String> partsSeen = new HashSet<>();
    private String sessionId;
    private String sessionApi = "/v1/sessions";
    private int partsDownloaded;
    private final Object lifecycle = new Object();
    private final Set<HttpURLConnection> connections = new HashSet<>();
    private volatile boolean cancelled;
    private volatile Thread runner;
    private boolean finished;
    private boolean publishing;

    void cancel() {
        final List<HttpURLConnection> active;
        synchronized (lifecycle) {
            if (finished || publishing || cancelled) return;
            cancelled = true;
            active = new ArrayList<>(connections);
        }
        Thread thread = runner;
        if (thread != null) thread.interrupt();
        // Disconnect may wait on a platform socket lock; keep it off the UI thread.
        new Thread(() -> { for (HttpURLConnection connection : active) connection.disconnect(); }, "bundle-cancel").start();
    }

    boolean isCancelled() { return cancelled; }

    private void checkCancelled() throws IOException {
        if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("下载已取消");
    }

    private void release(HttpURLConnection connection) {
        synchronized (lifecycle) { connections.remove(connection); }
        connection.disconnect();
    }


    BundleDownloader(String server, String token, String fileId, BundleStore store, Listener listener) {
        this(server, token, fileId, store, listener, File::getUsableSpace);
    }

    BundleDownloader(String server, String token, String fileId, BundleStore store, Listener listener, BundleSpace.Probe probe) {
        this.space = new BundleSpace(store.dir(), probe);
        this.server = normalizeServerUrl(server);
        this.token = token == null ? "" : token.trim();
        this.fileId = fileId;
        this.store = store;
        this.listener = listener;
    }

    void run() throws Exception {
        runner = Thread.currentThread();
        checkCancelled();
        listener.stage("准备离线包…");
        BundleStore destination = store;
        destination.recoverPrevious();
        store = destination.staging();
        store.reset();
        ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "bundle-heartbeat");
            thread.setDaemon(true);
            return thread;
        });
        try {
            //noinspection ResultOfMethodCallIgnored
            store.dir().mkdirs();
            space.require(0);
            JSONObject created = openSession();
            heartbeat.scheduleWithFixedDelay(() -> {
                try { requestJson(server + "/v1/sessions/" + encode(sessionId), "GET", null); }
                catch (Exception ignored) { /* the active download reports connection failures */ }
            }, 60, 60, TimeUnit.SECONDS);
            JSONObject model = created.optJSONObject("model");
            if (model != null && !"pptx".equals(model.optString("format", "pptx")))
                throw new IOException("离线包目前仅支持 PPTX");
            JSONObject manifest = downloadDeclaredBundle();
            int count;
            if (manifest == null) {
                JSONArray fonts = created.optJSONArray("fonts");
                String sessionPath = server + "/v1/sessions/" + encode(sessionId);
                JSONObject layout = requestJson(sessionPath + "/layout", "GET", null);
                count = layout.optInt("slideCount");
                if (count <= 0) throw new IOException("演示文稿没有幻灯片");
                writeFile(store.layoutInfoFile(), layout.toString().getBytes(StandardCharsets.UTF_8));
                for (int i = 0; i < count; i++) {
                    checkCancelled();
                    listener.stage("下载第 " + (i + 1) + " / " + count + " 页模型（媒体 "
                            + partsDownloaded + " 个）…");
                    JSONObject slide = requestJson(sessionPath + "/layout/slides/" + i, "GET", null);
                    rewrite(slide);
                    writeFile(store.layoutSlideFile(i), slide.toString().getBytes(StandardCharsets.UTF_8));
                }
                if (fonts != null) {
                    for (int i = 0; i < fonts.length(); i++) {
                        JSONObject font = fonts.optJSONObject(i);
                        if (font == null) continue;
                        String id = font.optString("id", "");
                        if (id.isEmpty()) continue;
                        listener.stage("下载字体 " + (i + 1) + " / " + fonts.length() + "…");
                        downloadFile(server + "/v1/sessions/" + encode(sessionId)
                                + "/fonts/" + encode(id), store.fontFile(id));
                    }
                }
                manifest = new JSONObject();
                manifest.put("fileId", fileId);
                manifest.put("format", "pptx");
                manifest.put("unitCount", count);
                manifest.put("fonts", fonts == null ? new JSONArray() : fonts);
                manifest.put("createdAt", System.currentTimeMillis());
                manifest.put("parts", partsDownloaded);
                manifest.put("sourceVerified", false);
            } else { count = manifest.getInt("unitCount"); }
            listener.stage("正在校验离线资源…");
            checkCancelled();
            store.seal(manifest);
            synchronized (lifecycle) {
                checkCancelled();
                publishing = true;
            }
            // Publication is the commit point. Never hold the UI cancellation lock
            // while filesystem replacement/backup cleanup is in progress.
            store.publishTo(destination);
            synchronized (lifecycle) { finished = true; }
            listener.stage("离线包完成：共 " + count + " 页、" + partsDownloaded + " 个媒体文件");
        } finally {
            heartbeat.shutdownNow();
            boolean interrupted = Thread.interrupted();
            try { closeSession(); }
            finally {
                store.reset();
                store = destination;
                runner = null;
                synchronized (lifecycle) { finished = true; }
                if (interrupted) Thread.currentThread().interrupt();
            }
        }
    }

    private JSONObject downloadDeclaredBundle() throws IOException, JSONException {
        listener.stage("正在准备离线资源清单…");
        String root = "/v2/sessions/" + encode(sessionId) + "/bundle";
        JSONObject manifest;
        HttpURLConnection connection = open(server + root, "GET");
        try {
            int status = connection.getResponseCode();
            if (status == 404 || status == 405) return null;
            if (status != 200) throw httpError(connection, server + root);
            if (connection.getContentLengthLong() > 16 * 1024 * 1024) throw new IOException("离线资源清单过大");
            manifest = new JSONObject(new String(readAll(connection.getInputStream(), 16 * 1024 * 1024), StandardCharsets.UTF_8));
        } finally { release(connection); }
        checkCancelled();
        if (manifest.optInt("bundleSchemaVersion") != 1 || manifest.optInt("modelSchemaVersion") != 2
                || !fileId.equals(manifest.optString("fileId")) || !"pptx".equals(manifest.optString("format"))
                || !manifest.optString("artifactKey").matches("[a-f0-9]{64}")
                || !manifest.optString("modelArtifactKey").matches("[a-f0-9]{64}")
                || manifest.optString("parserVersion").isEmpty() || manifest.optString("parserFingerprint").isEmpty()
                || !"ppt-media-v1".equals(manifest.optString("inventory"))) throw new IOException("不支持的离线清单版本或资源身份");
        int count = manifest.getInt("unitCount");
        if (count <= 0 || count > 100000) throw new IOException("无效的离线页数");
        JSONArray external = manifest.getJSONArray("externalResources");
        if (external.length() > 0) throw new IOException("包含外部媒体，暂不支持保证完整离线");
        JSONArray resources = manifest.getJSONArray("resources");
        if (resources.length() > 100000) throw new IOException("离线资源数量过多");
        Set<String> paths = new HashSet<>();
        long total = 0;
        for (int index = 0; index < resources.length(); index++) {
            checkCancelled();
            JSONObject resource = resources.getJSONObject(index);
            String path = resource.getString("path");
            store.resourceFile(path);
            if (!paths.add(path) || !(path.equals("layout.json") || path.matches("layout/(0|[1-9][0-9]*)\\.json")
                    || path.startsWith("parts/ppt/media/") || path.matches("fonts/[^/]+\\.sfnt")))
                throw new IOException("离线资源路径无效或重复");
            long size = resource.getLong("size");
            if (size < 0 || size > 9007199254740991L || resource.getDouble("size") != size
                    || !resource.getString("sha256").matches("[a-f0-9]{64}") || total > Long.MAX_VALUE - size)
                throw new IOException("离线资源大小或哈希无效");
            total += size;
        }
        if (total != manifest.getLong("totalBytes") || manifest.getDouble("totalBytes") != total || !paths.contains("layout.json")) throw new IOException("离线清单总量不匹配");
        for (int index = 0; index < count; index++) if (!paths.contains("layout/" + index + ".json")) throw new IOException("离线清单缺少页面");
        JSONArray fonts = manifest.getJSONArray("fonts");
        for (int index = 0; index < fonts.length(); index++) if (!paths.contains(fonts.getJSONObject(index).getString("resourcePath")))
            throw new IOException("离线清单缺少字体");
        listener.stage("检查离线包空间并核验服务端资源…");
        space.require(total + manifest.toString().getBytes(StandardCharsets.UTF_8).length + 65536L);
        for (int index = 0; index < resources.length(); index++) {
            checkCancelled();
            JSONObject resource = resources.getJSONObject(index);
            String path = resource.getString("path");
            listener.stage("下载并核验资源 " + (index + 1) + " / " + resources.length() + "…");
            StringBuilder encoded = new StringBuilder();
            for (String segment : path.split("/")) { if (encoded.length() > 0) encoded.append('/'); encoded.append(encode(segment).replace("+", "%20")); }
            downloadFile(server + root + "/resources/" + encoded, store.resourceFile(path), resource.getLong("size"), resource.getString("sha256"));
            if (path.startsWith("parts/")) partsDownloaded++;
        }
        manifest.put("sourceVerified", true);
        manifest.put("createdAt", System.currentTimeMillis());
        manifest.put("parts", partsDownloaded);
        return manifest;
    }

    // ── session / units ──────────────────────────────────────────────────────

    private JSONObject openSession() throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("fileId", fileId);
        JSONObject created;
        sessionApi = "/v2/sessions";
        try {
            created = requestJson(server + sessionApi, "POST", body.toString());
        } catch (HttpFailure failure) {
            if (failure.status != 404 && failure.status != 405) throw failure;
            sessionApi = "/v1/sessions";
            created = requestJson(server + sessionApi, "POST", body.toString());
        }
        sessionId = created.optString("sessionId", "");
        if (sessionId.isEmpty()) throw new IOException("解析服务未返回会话");
        while (true) {
            checkCancelled();
            String state = created.optString("state", "ready");
            if ("ready".equals(state)) return created;
            if ("failed".equals(state)) {
                JSONObject error = created.optJSONObject("error");
                throw new IOException(error == null ? "文档解析失败" : error.optString("message", "文档解析失败"));
            }
            if (!"queued".equals(state) && !"building".equals(state)) throw new IOException("解析服务返回未知状态");
            listener.stage("queued".equals(state) ? "正在排队等待解析…" : "正在解析文档…");
            try {
                Thread.sleep(Math.max(100, Math.min(5000, created.optInt("pollAfterMs", 500))));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("下载已取消", interrupted);
            }
            JSONObject polled = requestJson(server + sessionApi + "/" + encode(sessionId), "GET", null);
            if (!sessionId.equals(polled.optString("sessionId", sessionId))) throw new IOException("解析服务返回不匹配的会话");
            created = polled;
        }
    }

    private void closeSession() {
        if (sessionId == null || sessionId.isEmpty()) return;
        try {
            HttpURLConnection connection = open(
                    server + sessionApi + "/" + encode(sessionId), "DELETE", true);
            connection.getResponseCode();
            connection.disconnect();
        } catch (IOException ignored) {
        }
    }

    // ── unit rewriting: absolute part URLs → relative, and cache their bytes ──

    private static final String PART_PREFIX = "/v1/files/";

    private Object rewrite(Object node) throws IOException, JSONException {
        if (node instanceof JSONObject) {
            JSONObject object = (JSONObject) node;
            List<String> keys = new ArrayList<>();
            for (Iterator<String> it = object.keys(); it.hasNext(); ) keys.add(it.next());
            for (String key : keys) object.put(key, rewrite(object.get(key)));
            return object;
        } else if (node instanceof JSONArray) {
            JSONArray array = (JSONArray) node;
            for (int i = 0; i < array.length(); i++) array.put(i, rewrite(array.get(i)));
            return array;
        } else if (node instanceof String) {
            String value = (String) node;
            String encodedMarker = PART_PREFIX + encode(fileId) + "/parts/";
            String rawMarker = PART_PREFIX + fileId + "/parts/";
            int at = value.indexOf(rawMarker);
            String marker = rawMarker;
            if (at < 0) {
                at = value.indexOf(encodedMarker);
                marker = encodedMarker;
            }
            if (at >= 0) {
                String suffix = value.substring(at + marker.length());
                int query = suffix.indexOf('?');
                if (query >= 0) suffix = suffix.substring(0, query);
                downloadPart(value, decodePartPath(suffix));
                // Same-origin relative URL: the local server decodes the segments again.
                return "/v1/files/" + fileId + "/parts/" + suffix;
            }
        }
        return node;
    }

    private void downloadPart(String url, String partPath) throws IOException {
        if (!partsSeen.add(partPath)) return;
        File file = store.partFile(partPath);
        if (file.isFile() && file.length() > 0) return;
        downloadFile(url, file);
        partsDownloaded++;
    }

    private static String decodePartPath(String suffix) throws IOException {
        StringBuilder out = new StringBuilder();
        for (String segment : suffix.split("/")) {
            if (segment.isEmpty()) continue;
            if (out.length() > 0) out.append('/');
            out.append(URLDecoder.decode(segment, "UTF-8"));
        }
        return out.toString();
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    private HttpURLConnection open(String url, String method) throws IOException {
        return open(url, method, false);
    }

    private HttpURLConnection open(String url, String method, boolean cleanup) throws IOException {
        if (!cleanup) checkCancelled();
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(cleanup ? 3000 : 15000);
        connection.setReadTimeout(cleanup ? 3000 : 120000);
        connection.setRequestProperty("Accept", "*/*");
        if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
        if (!cleanup) synchronized (lifecycle) {
            checkCancelled();
            connections.add(connection);
        }
        return connection;
    }

    private JSONObject requestJson(String url, String method, String body)
            throws IOException, JSONException {
        HttpURLConnection connection = open(url, method);
        try {
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) throw httpError(connection, url);
            return new JSONObject(readText(connection.getInputStream()));
        } finally {
            release(connection);
        }
    }

    private void downloadFile(String url, File file) throws IOException {
        downloadFile(url, file, -1, null);
    }

    private void downloadFile(String url, File file, long declaredSize, String declaredHash) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("cannot create " + parent);
        }
        File temp = new File(file.getPath() + ".tmp");
        HttpURLConnection connection = open(url, "GET");
        try {
            if (connection.getResponseCode() != 200) throw httpError(connection, url);
            long expected = connection.getContentLengthLong();
            if (declaredSize >= 0 && expected >= 0 && expected != declaredSize) throw new IOException("服务端资源长度与清单不一致");
            space.require(declaredSize >= 0 ? declaredSize : expected >= 0 ? expected : 0);
            MessageDigest digest;
            try { digest = declaredHash == null ? null : MessageDigest.getInstance("SHA-256"); }
            catch (NoSuchAlgorithmException impossible) { throw new IOException(impossible); }
            long received = 0;
            try (InputStream in = new BufferedInputStream(connection.getInputStream());
                 FileOutputStream out = new FileOutputStream(temp)) {
                byte[] buffer = new byte[65536];
                int n;
                while ((n = in.read(buffer)) != -1) {
                    checkCancelled();
                    if (declaredSize >= 0 && n > declaredSize - received) throw new IOException("服务端资源超出清单大小");
                    space.require(n);
                    if (digest != null) digest.update(buffer, 0, n);
                    out.write(buffer, 0, n);
                    received += n;
                }
                if (expected >= 0 && received != expected) throw new IOException("incomplete download");
                if (declaredSize >= 0 && received != declaredSize) throw new IOException("服务端资源不完整");
                if (digest != null) {
                    StringBuilder actual = new StringBuilder();
                    for (byte value : digest.digest()) actual.append(String.format(java.util.Locale.US, "%02x", value & 255));
                    if (!declaredHash.equals(actual.toString())) throw new IOException("服务端资源 SHA-256 校验失败");
                }
                out.getFD().sync();
            }
            checkCancelled();
            if (!temp.renameTo(file)) throw new IOException("cannot write " + file);
        } finally {
            release(connection);
            if (temp.exists()) temp.delete();
        }
    }

    private static final class HttpFailure extends IOException {
        final int status;
        HttpFailure(int status, String message) { super(message); this.status = status; }
    }

    private static HttpFailure httpError(HttpURLConnection connection, String url) throws IOException {
        String detail = "";
        InputStream error = connection.getErrorStream();
        if (error != null) {
            try {
                detail = new String(readAll(error), StandardCharsets.UTF_8);
            } catch (IOException ignored) {
            }
        }
        return new HttpFailure(connection.getResponseCode(), "HTTP " + connection.getResponseCode() + " " + url
                + (detail.isEmpty() ? "" : ": " + detail));
    }

    private static String readText(InputStream input) throws IOException {
        return new String(readAll(input), StandardCharsets.UTF_8);
    }

    private static byte[] readAll(InputStream input) throws IOException {
        return readAll(input, Integer.MAX_VALUE);
    }

    private static byte[] readAll(InputStream input, int limit) throws IOException {
        try (InputStream in = new BufferedInputStream(input)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) >= 0) {
                if (n > limit - out.size()) throw new IOException("响应超过允许大小");
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        }
    }

    private void writeFile(File file, byte[] bytes) throws IOException {
        checkCancelled();
        space.require(bytes.length);
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("cannot create " + parent);
        }
        File temp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(bytes);
            out.getFD().sync();
        }
        if (!temp.renameTo(file)) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            if (!temp.renameTo(file)) throw new IOException("cannot write " + file);
        }
    }

    /** Host must include a scheme; bare `127.0.0.1:8790` becomes `http://127.0.0.1:8790`. */
    static String normalizeServerUrl(String server) {
        String s = server == null ? "" : server.trim();
        if (s.endsWith("/")) s = s.replaceAll("/+$", "");
        if (s.isEmpty()) return s;
        if (s.startsWith("http:/") && !s.startsWith("http://")) s = "http://" + s.substring(6);
        else if (s.startsWith("https:/") && !s.startsWith("https://")) s = "https://" + s.substring(7);
        else if (!s.contains("://")) s = "http://" + s;
        return s;
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }
}
