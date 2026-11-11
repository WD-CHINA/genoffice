package com.genoffice.viewerdemo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
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
import java.util.Map;
import java.util.HashMap;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Downloads a parse-server session into a local bundle: every slide unit, every media
 * part the units reference (posts, audio, video) and the embedded fonts. Unit JSON is
 * rewritten so part URLs are same-origin relative paths — the bundled local server
 * can then replay the session with no network.
 * PDF stores its original bytes using authenticated file metadata and content, without a parse session.
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
    private final BundleSpace.Probe probe;
    private final BundleCache cache;
    private BundleSpace space;
    private BundleResume resume;
    private final Set<String> partsSeen = new HashSet<>();
    private String sessionId;
    private String sessionApi = "/v1/sessions";
    private int partsDownloaded;
    private final Object lifecycle = new Object();
    private final Set<HttpURLConnection> connections = new HashSet<>();
    private volatile boolean cancelled;
    private volatile int rangeResumes;
    private volatile int rangeResponses;
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

    /** Instrumentation probe: number of resources that actually requested a Range. */
    int rangeResumes() { return rangeResumes; }

    /** Instrumentation probe: number of responses that passed the strict 206 checks. */
    int rangeResponses() { return rangeResponses; }

    private void checkCancelled() throws IOException {
        if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("下载已取消");
    }

    private void release(HttpURLConnection connection) {
        synchronized (lifecycle) { connections.remove(connection); }
        connection.disconnect();
    }


    BundleDownloader(String server, String token, String fileId, BundleStore store, Listener listener) {
        this(server, token, fileId, store, listener, File::getUsableSpace, null);
    }

    BundleDownloader(String server, String token, String fileId, BundleStore store, Listener listener, BundleSpace.Probe probe) {
        this(server, token, fileId, store, listener, probe, null);
    }

    /** With a cache, declared bundles are published under their artifactKey and pointed to atomically. */
    BundleDownloader(String server, String token, String fileId, BundleStore store, Listener listener,
                     BundleSpace.Probe probe, BundleCache cache) {
        this.probe = probe;
        this.cache = cache;
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
        ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "bundle-heartbeat");
            thread.setDaemon(true);
            return thread;
        });
        BundleStore destination = store;
        BundleStore staging = null;
        try {
            JSONObject pdf = pdfManifest();
            JSONObject created = pdf == null ? openSession() : new JSONObject();
            if (pdf == null) heartbeat.scheduleWithFixedDelay(() -> {
                    try { requestJson(server + "/v1/sessions/" + encode(sessionId), "GET", null); }
                    catch (Exception ignored) { /* the active download reports connection failures */ }
                }, 60, 60, TimeUnit.SECONDS);
            JSONObject model = created.optJSONObject("model");
            String format = pdf != null ? "pdf" : model == null ? "pptx" : model.optString("format", "pptx");
            if (!"pptx".equals(format) && !"docx".equals(format) && !"pdf".equals(format)) throw new IOException("离线包支持 PPTX、DOCX 和 PDF");
            // The authoritative manifest identifies the generation before any staging is chosen.
            JSONObject declared = pdf == null ? fetchDeclaredManifest() : pdf;
            if (declared != null && !format.equals(declared.optString("format"))) throw new IOException("离线清单文档类型与会话不符");
            if (cache != null && declared != null) {
                destination = cache.versionStore(fileId, declared.getString("artifactKey"));
                staging = cache.stagingStore(fileId);
                resume = cache.resume(fileId);
            } else {
                // Without an authoritative manifest there is no artifactKey to version by:
                // keep the pre-versioning flat layout and leave the current pointer untouched.
                destination = cache == null ? store : cache.legacy(fileId);
                staging = destination.staging();
                resume = new BundleResume(destination.dir());
            }
            space = new BundleSpace(staging.dir(), probe);
            File versionParent = destination.dir().getParentFile();
            if (versionParent != null && !versionParent.isDirectory()
                    && !versionParent.mkdirs() && !versionParent.isDirectory())
                throw new IOException("cannot create offline version directory");
            destination.recoverPrevious();
            staging.reset();
            //noinspection ResultOfMethodCallIgnored
            staging.dir().mkdirs();
            space.require(0);
            store = staging;

            JSONObject manifest;
            int count;
            if (declared == null) {
                if ("docx".equals(format)) throw new IOException("DOCX 离线需要支持权威清单的新版解析服务");
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
            } else {
                manifest = declared;
                count = downloadDeclaredResources(manifest);
                manifest.put("sourceVerified", true);
                manifest.put("createdAt", System.currentTimeMillis());
                manifest.put("parts", partsDownloaded);
                JSONArray external = manifest.optJSONArray("externalResources");
                manifest.put("offlineScope", external != null && external.length() > 0 ? "partial" : "complete");
                if ("pptx".equals(format)) prepareOfflineMedia(manifest, count);
                else manifest.put("mediaPreparation", "not-needed");
                if (cache != null && manifest.has("sourceArtifactKey")) {
                    destination = cache.versionStore(fileId, manifest.getString("artifactKey"));
                    destination.recoverPrevious();
                }
            }
            listener.stage("正在校验离线资源…");
            checkCancelled();
            store.seal(manifest);
            if (cache != null) cache.require(manifest.toString().getBytes(StandardCharsets.UTF_8).length
                    + 64L + manifest.getLong("totalBytes"));
            synchronized (lifecycle) {
                checkCancelled();
                publishing = true;
            }
            // Publication is the commit point. Never hold the UI cancellation lock
            // while filesystem replacement/backup cleanup is in progress.
            store.publishTo(destination);
            if (cache != null && declared != null) {
                JSONObject record = cache.commit(fileId, destination, manifest);
                // Reclaim inactive versions only after the new pointer is durable.
                cache.trim(fileId, record.getString("artifactKey"));
            }
            // Publication is committed: nothing is left to resume for this bundle.
            resume.clear();
            synchronized (lifecycle) { finished = true; }
            String text = "pdf".equals(format) ? "PDF 离线文件已下载并校验，可断网阅读。"
                    : "docx".equals(format) ? "Word 离线包已下载并校验，可断网阅读。"
                    : "离线包完成：共 " + count + " 页、" + partsDownloaded + " 个媒体文件";
            JSONArray external = manifest.optJSONArray("externalResources");
            if (external != null && external.length() > 0)
                text += "；部分离线：" + external.length() + " 个外部资源需联网，未保证完整离线";
            listener.stage(text);
        } finally {
            heartbeat.shutdownNow();
            boolean interrupted = Thread.interrupted();
            try { closeSession(); }
            finally {
                // Only the staging directory may be discarded. Resetting `store` before it was
                // swapped would delete the user's already published offline bundle.
                if (staging != null) staging.reset();
                store = destination;
                runner = null;
                synchronized (lifecycle) { finished = true; }
                if (interrupted) Thread.currentThread().interrupt();
            }
        }
    }

    /** PDF keeps the original bytes; authenticated file metadata is its source manifest. */
    private JSONObject pdfManifest() throws IOException, JSONException {
        JSONObject meta;
        try { meta = requestJson(server + "/v1/files/" + encode(fileId), "GET", null); }
        catch (HttpFailure failure) {
            // Older model-only servers can still download PPTX through their existing route.
            if (failure.status == 404 || failure.status == 405) return null;
            throw failure;
        }
        if (!"pdf".equals(meta.optString("format"))) return null;
        long size = meta.getLong("size");
        String hash = meta.getString("sha256");
        if (!fileId.equals(meta.optString("fileId")) || !hash.matches("[a-f0-9]{64}")
                || !fileId.equals(hash) || size <= 0 || size > 9007199254740991L || meta.getDouble("size") != size)
            throw new IOException("PDF 原文件身份、大小或哈希无效");
        String key;
        try { key = hex(MessageDigest.getInstance("SHA-256").digest(("genoffice-pdf-original-v1:" + hash).getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IOException(impossible); }
        return new JSONObject().put("bundleSchemaVersion", 1).put("fileId", fileId).put("format", "pdf")
                .put("artifactKey", key).put("inventory", "pdf-original-v1").put("pdfPath", "document.pdf")
                .put("sourceSha256", hash).put("sourceSize", size).put("unitCount", 0)
                .put("fonts", new JSONArray()).put("externalResources", new JSONArray()).put("totalBytes", size)
                .put("resources", new JSONArray().put(new JSONObject().put("path", "document.pdf").put("size", size).put("sha256", hash)));
    }

    /** Fetch and fully validate the authoritative manifest; 404/405 keeps the legacy flow. */
    private JSONObject fetchDeclaredManifest() throws IOException, JSONException {
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
        boolean docx = "docx".equals(manifest.optString("format"));
        if (manifest.optInt("bundleSchemaVersion") != 1 || manifest.optInt("modelSchemaVersion") != 2
                || !fileId.equals(manifest.optString("fileId")) || (!docx && !"pptx".equals(manifest.optString("format")))
                || !manifest.optString("artifactKey").matches("[a-f0-9]{64}")
                || !manifest.optString("modelArtifactKey").matches("[a-f0-9]{64}")
                || manifest.optString("parserVersion").isEmpty() || manifest.optString("parserFingerprint").isEmpty()
                || !(docx ? "docx-media-v1" : "ppt-media-v1").equals(manifest.optString("inventory"))) throw new IOException("不支持的离线清单版本或资源身份");
        int count = manifest.getInt("unitCount");
        if (count <= 0 || count > 100000) throw new IOException("无效的离线页数");
        JSONArray external = manifest.getJSONArray("externalResources");
        if (external.length() > 10000) throw new IOException("外部资源数量过多");
        for (int index = 0; index < external.length(); index++) {
            Object value = external.get(index);
            if (!(value instanceof String) || ((String) value).isEmpty() || ((String) value).length() > 4096)
                throw new IOException("外部资源标识无效");
        }
        JSONArray resources = manifest.getJSONArray("resources");
        if (resources.length() > 100000) throw new IOException("离线资源数量过多");
        Set<String> paths = new HashSet<>();
        long total = 0;
        for (int index = 0; index < resources.length(); index++) {
            checkCancelled();
            JSONObject resource = resources.getJSONObject(index);
            String path = resource.getString("path");
            boolean allowed = path.matches("fonts/[^/]+\\.sfnt") || (docx
                ? path.equals("document.json") || path.equals("styles.json") || path.matches("units/(0|[1-9][0-9]*)\\.json")
                    || path.startsWith("parts/word/media/") || path.startsWith("parts/word/embeddings/")
                : path.equals("layout.json") || path.matches("layout/(0|[1-9][0-9]*)\\.json") || path.startsWith("parts/ppt/media/"));
            if (!paths.add(path) || !allowed)
                throw new IOException("离线资源路径无效或重复");
            long size = resource.getLong("size");
            if (size < 0 || size > 9007199254740991L || resource.getDouble("size") != size
                    || !resource.getString("sha256").matches("[a-f0-9]{64}") || total > Long.MAX_VALUE - size)
                throw new IOException("离线资源大小或哈希无效");
            total += size;
        }
        if (total != manifest.getLong("totalBytes") || manifest.getDouble("totalBytes") != total || !paths.contains(docx ? "document.json" : "layout.json") || (docx && !paths.contains("styles.json"))) throw new IOException("离线清单总量不匹配");
        for (int index = 0; index < count; index++) if (!paths.contains((docx ? "units/" : "layout/") + index + ".json")) throw new IOException("离线清单缺少页面");
        JSONArray fonts = manifest.getJSONArray("fonts");
        for (int index = 0; index < fonts.length(); index++) if (!paths.contains(fonts.getJSONObject(index).getString("resourcePath")))
            throw new IOException("离线清单缺少字体");
        return manifest;
    }

    private int downloadDeclaredResources(JSONObject manifest) throws IOException, JSONException {
        boolean pdf = "pdf".equals(manifest.optString("format"));
        String root = pdf ? null : "/v2/sessions/" + encode(sessionId) + "/bundle";
        String artifactKey = manifest.getString("artifactKey");
        int count = manifest.getInt("unitCount");
        JSONArray resources = manifest.getJSONArray("resources");
        // Each resource still validates its own path against the staging root before writing.
        for (int index = 0; index < resources.length(); index++) store.resourceFile(resources.getJSONObject(index).getString("path"));
        listener.stage("检查离线包空间并核验服务端资源…");
        long incoming = manifest.getLong("totalBytes") + manifest.toString().getBytes(StandardCharsets.UTF_8).length + 65536L;
        if (cache != null) cache.require(incoming);
        space.require(incoming);
        for (int index = 0; index < resources.length(); index++) {
            checkCancelled();
            JSONObject resource = resources.getJSONObject(index);
            String path = resource.getString("path");
            listener.stage("下载并核验资源 " + (index + 1) + " / " + resources.length() + "…");
            StringBuilder encoded = new StringBuilder();
            for (String segment : path.split("/")) { if (encoded.length() > 0) encoded.append('/'); encoded.append(encode(segment).replace("+", "%20")); }
            downloadDeclaredFile(pdf ? server + "/v1/files/" + encode(fileId) + "/content"
                            : server + root + "/resources/" + encoded, store.resourceFile(path),
                    path, resource.getLong("size"), resource.getString("sha256"), artifactKey);
            if (path.startsWith("parts/")) partsDownloaded++;
        }
        return count;
    }

    /** Add verified compatible media without changing the source manifest resources. */
    private void prepareOfflineMedia(JSONObject manifest, int count) throws Exception {
        Map<String, JSONObject> requests = PreparedMedia.requests(store, count, server, manifest.getJSONArray("resources"));
        manifest.put("mediaObjectCount", requests.size());
        if (requests.isEmpty()) { manifest.put("mediaPreparation", "not-needed"); return; }
        JSONObject capabilities;
        try { capabilities = requestJson(server + "/v2/capabilities", "GET", null); }
        catch (HttpFailure failure) {
            if (failure.status != 404 && failure.status != 405) throw failure;
            manifest.put("mediaPreparation", "unavailable"); return;
        }
        JSONObject features = capabilities.optJSONObject("features");
        if (features == null || !features.optBoolean("mediaTranscoding")) {
            manifest.put("mediaPreparation", "unavailable"); return;
        }
        if (!features.optBoolean("mediaPreparationIntegrity"))
            throw new IOException("请升级解析服务，以提供离线兼容媒体的哈希校验。");
        Map<String, JSONObject> sources = new HashMap<>();
        JSONArray original = manifest.getJSONArray("resources");
        for (int i = 0; i < original.length(); i++) {
            JSONObject resource = original.getJSONObject(i);
            sources.put(resource.getString("path"), resource);
        }
        String sourceKey = manifest.getString("artifactKey");
        JSONArray mappings = new JSONArray();
        Set<String> downloaded = new HashSet<>();
        long extra = 0;
        int index = 0;
        for (JSONObject request : requests.values()) {
            checkCancelled();
            String part = request.getString("part"), kind = request.getString("kind");
            JSONObject source = sources.get("parts/" + part);
            if (source == null) throw new IOException("媒体引用不在服务端资源清单内。");
            JSONObject prepared = null;
            String path = null;
            File target = null;
            for (int attempt = 0; attempt < 2; attempt++) {
                listener.stage("准备兼容媒体 " + (index + 1) + " / " + requests.size() + "…");
                JSONObject body = new JSONObject().put("partPath", part).put("kind", kind).put("retry", attempt > 0);
                String endpoint = server + "/v1/files/" + encode(fileId) + "/media";
                prepared = requestJson(endpoint, "POST", body.toString());
                long deadline = android.os.SystemClock.elapsedRealtime() + 30 * 60 * 1000L;
                while ("queued".equals(prepared.optString("state")) || "processing".equals(prepared.optString("state"))) {
                    checkCancelled();
                    if (android.os.SystemClock.elapsedRealtime() > deadline) throw new IOException("兼容媒体处理超时。");
                    String job = prepared.optString("jobId");
                    if (!job.matches("[a-f0-9]{64}")) throw new IOException("媒体任务身份无效。");
                    String stage = prepared.optString("stage");
                    listener.stage("queued".equals(prepared.optString("state")) ? "兼容媒体正在排队…"
                            : "converting".equals(stage) ? "正在转换媒体（" + Math.max(0, Math.min(99, prepared.optInt("progress"))) + "%）…"
                            : "verifying".equals(stage) ? "正在校验兼容媒体…" : "正在检查兼容媒体…");
                    try { Thread.sleep(750); }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); checkCancelled(); throw new IOException("下载已取消", interrupted); }
                    prepared = requestJson(endpoint + "/" + job, "GET", null);
                }
                if (!"ready".equals(prepared.optString("state"))) throw new IOException("兼容媒体准备失败：" + prepared.optString("errorCode", "unknown"));
                String sha = prepared.optString("sha256"), profile = prepared.optString("profile"), job = prepared.optString("jobId");
                long size = prepared.optLong("bytes", -1);
                if (!sha.matches("[a-f0-9]{64}") || !profile.matches("[a-f0-9]{64}") || !job.matches("[a-f0-9]{64}")
                        || !source.getString("sha256").equals(prepared.optString("sourceSha256"))
                        || !kind.equals(prepared.optString("kind")) || size <= 0 || prepared.getDouble("bytes") != size
                        || !("video".equals(kind) ? "video/mp4" : "audio/mpeg").equals(prepared.optString("mime")))
                    throw new IOException("兼容媒体哈希或资源身份不匹配。");
                path = PreparedMedia.PREFIX + sha + ("video".equals(kind) ? ".mp4" : ".mp3");
                target = store.resourceFile(path);
                if (!downloaded.contains(path)) extra = Math.addExact(extra, size);
                if (cache != null) cache.require(Math.addExact(manifest.getLong("totalBytes"), extra + 65536L));
                if (target.isFile() && (target.length() != size || !sha.equals(BundleStore.digest(target)))) {
                    if (!target.delete()) throw new IOException("无法清理未完成的兼容媒体。");
                }
                if (!target.isFile()) {
                    space.require(size);
                    if (sha.equals(source.getString("sha256")) && size == source.getLong("size")) {
                        copyLocal(store.resourceFile("parts/" + part), target);
                    } else {
                        // Never follow an untrusted returned URL or leak the token to another host.
                        downloadDeclaredFile(endpoint + "/" + job + "/content", target, path, size, sha, profile);
                    }
                }
                if (PreparedMedia.decodable(target, kind)) break;
                if (!downloaded.contains(path)) {
                    if (!target.delete()) throw new IOException("无法清理不兼容的临时媒体。");
                    extra -= size;
                }
                if (attempt == 1) throw new IOException("系统缺少该兼容媒体的解码器，离线包未更新。");
            }
            downloaded.add(path);
            mappings.put(new JSONObject().put("part", part).put("kind", kind).put("path", path)
                    .put("sha256", prepared.getString("sha256")).put("size", prepared.getLong("bytes"))
                    .put("sourceSha256", prepared.getString("sourceSha256")).put("profile", prepared.getString("profile")));
            index++;
        }
        manifest.put("sourceArtifactKey", sourceKey);
        manifest.put("sourceTotalBytes", manifest.getLong("totalBytes"));
        manifest.put("preparedMedia", mappings);
        manifest.put("mediaPreparation", "complete");
        manifest.put("artifactKey", PreparedMedia.version(sourceKey, mappings));
    }

    private void copyLocal(File source, File target) throws IOException {
        File parent = target.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create prepared media directory");
        try (InputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[65536]; int size;
            while ((size = input.read(buffer)) != -1) {
                checkCancelled(); space.require(size); output.write(buffer, 0, size);
            }
            output.getFD().sync();
        }
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
        downloadLegacyFile(url, file, -1, null);
    }

    /** Legacy resource discovery has no declared strong validator, so it never resumes. */
    private void downloadLegacyFile(String url, File file, long declaredSize, String declaredHash) throws IOException {
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

    /**
     * Resumable transfer for resources named by the authoritative manifest.
     * The declared SHA-256 is the strong validator: it is sent as If-Range, checked
     * against the 206 ETag and finally over the complete file. A changed generation
     * can therefore never be spliced onto bytes received for an older one.
     */
    private void downloadDeclaredFile(String url, File file, String path, long size,
                                      String hash, String artifactKey) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory())
            throw new IOException("cannot create " + parent);
        String key = BundleResume.key(path);
        File partial = resume.acquire(path, size, hash, artifactKey);
        long offset = partial == null ? 0 : partial.length();
        boolean published = false;
        HttpURLConnection connection = open(url, "GET");
        try {
            if (offset > 0) {
                rangeResumes++;
                connection.setRequestProperty("Range", "bytes=" + offset + "-");
                connection.setRequestProperty("If-Range", "\"" + hash + "\"");
            }
            int code = connection.getResponseCode();
            boolean cachedComplete = false;
            if (code == 206) {
                if (offset <= 0) throw new IOException("服务端返回了意外的分段响应");
                String etag = connection.getHeaderField("ETag");
                if (etag == null || !etag.equals("\"" + hash + "\"")) {
                    resume.discard(key);
                    throw new IOException("离线资源 ETag 与清单不一致");
                }
                try { verifyContentRange(connection.getHeaderField("Content-Range"), offset, size); }
                catch (IOException invalid) { resume.discard(key); throw invalid; }
                long expected = connection.getContentLengthLong();
                if (expected >= 0 && expected != size - offset) {
                    resume.discard(key);
                    throw new IOException("服务端续传长度与清单不一致");
                }
                rangeResponses++;
            } else if (code == 200) {
                // Range ignored, If-Range rejected or resource replaced: discard and start over.
                if (offset > 0) { resume.discard(key); partial = null; offset = 0; }
                long expected = connection.getContentLengthLong();
                if (expected >= 0 && expected != size) throw new IOException("服务端资源长度与清单不一致");
            } else if (code == 416 && offset > 0 && offset == size
                    && ("bytes */" + size).equals(connection.getHeaderField("Content-Range"))) {
                // Everything was already received before the previous attempt stopped.
                cachedComplete = true;
            } else {
                if (code == 416) resume.discard(key);
                throw httpError(connection, url);
            }

            space.require(cachedComplete ? 0 : size - offset);
            MessageDigest digest;
            try { digest = MessageDigest.getInstance("SHA-256"); }
            catch (NoSuchAlgorithmException impossible) { throw new IOException(impossible); }
            if (offset > 0) digestExisting(digest, partial, offset);
            if (!cachedComplete) {
                if (!resume.dir().isDirectory() && !resume.dir().mkdirs() && !resume.dir().isDirectory())
                    throw new IOException("cannot create resume directory");
                if (partial == null) partial = resume.part(key);
                long received = offset;
                try (InputStream in = new BufferedInputStream(connection.getInputStream());
                     FileOutputStream out = new FileOutputStream(partial, offset > 0)) {
                    byte[] buffer = new byte[65536];
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        checkCancelled();
                        if (n > size - received) {
                            resume.discard(key);
                            throw new IOException("服务端资源超出清单大小");
                        }
                        space.require(n);
                        digest.update(buffer, 0, n);
                        out.write(buffer, 0, n);
                        received += n;
                    }
                    long expected = connection.getContentLengthLong();
                    if (expected >= 0 && received - offset != expected) throw new IOException("incomplete download");
                    if (received != size) throw new IOException("服务端资源不完整");
                    out.getFD().sync();
                }
            }
            if (!hex(digest.digest()).equals(hash)) {
                resume.discard(key);
                throw new IOException("服务端资源 SHA-256 校验失败");
            }
            checkCancelled();
            if (!move(partial, file)) throw new IOException("cannot write " + file);
            resume.discard(key);
            published = true;
        } finally {
            release(connection);
            if (!published && partial != null && partial.isFile()
                    && partial.length() > 0 && partial.length() < size) {
                // Interrupted/cancelled transfer: keep the bytes for the next attempt.
                try { resume.record(path, size, hash, artifactKey); }
                catch (IOException ignored) { resume.discard(key); }
            }
        }
    }

    private static void verifyContentRange(String value, long start, long total) throws IOException {
        if (value == null || !value.startsWith("bytes ")) throw new IOException("离线资源缺少 Content-Range");
        String[] halves = value.substring(6).split("/", -1);
        if (halves.length != 2 || !Long.toString(total).equals(halves[1]))
            throw new IOException("离线资源 Content-Range 总量无效");
        int dash = halves[0].indexOf('-');
        if (dash <= 0) throw new IOException("离线资源 Content-Range 格式无效");
        try {
            long from = Long.parseLong(halves[0].substring(0, dash));
            long to = Long.parseLong(halves[0].substring(dash + 1));
            if (from != start || to != total - 1) throw new IOException("离线资源续传范围无效");
        } catch (NumberFormatException invalid) {
            throw new IOException("离线资源 Content-Range 格式无效", invalid);
        }
    }

    private static void digestExisting(MessageDigest digest, File file, long bytes) throws IOException {
        long remaining = bytes;
        try (InputStream in = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[65536];
            while (remaining > 0) {
                int n = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                if (n < 0) throw new IOException("续传文件已被截断");
                digest.update(buffer, 0, n);
                remaining -= n;
            }
        }
    }

    private static boolean move(File source, File target) throws IOException {
        if (source.renameTo(target)) return true;
        // Some filesystems refuse cross-directory rename; copy via a temp file instead.
        File temp = new File(target.getPath() + ".tmp");
        try (InputStream in = new FileInputStream(source);
             FileOutputStream out = new FileOutputStream(temp)) {
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            out.getFD().sync();
        }
        if (!temp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            return false;
        }
        //noinspection ResultOfMethodCallIgnored
        source.delete();
        return true;
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte value : bytes) out.append(String.format(java.util.Locale.US, "%02x", value & 255));
        return out.toString();
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
