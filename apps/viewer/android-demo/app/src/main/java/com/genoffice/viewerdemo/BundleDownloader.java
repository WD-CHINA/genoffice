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
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

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
    private final BundleStore store;
    private final Listener listener;
    private final Set<String> partsSeen = new HashSet<>();
    private String sessionId;
    private int partsDownloaded;

    BundleDownloader(String server, String token, String fileId, BundleStore store, Listener listener) {
        this.server = server.replaceAll("/+$", "");
        this.token = token == null ? "" : token.trim();
        this.fileId = fileId;
        this.store = store;
        this.listener = listener;
    }

    void run() throws Exception {
        listener.stage("准备离线包…");
        store.reset();
        //noinspection ResultOfMethodCallIgnored
        store.dir().mkdirs();
        JSONObject created = openSession();
        JSONArray fonts = created.optJSONArray("fonts");
        int count = created.optJSONObject("model") == null
                ? 0
                : created.optJSONObject("model").optInt("unitCount");
        if (count <= 0) throw new IOException("演示文稿没有幻灯片");
        for (int i = 0; i < count; i++) {
            listener.stage("下载第 " + (i + 1) + " / " + count + " 页（媒体 " + partsDownloaded + " 个）…");
            JSONObject unit = fetchUnit(i);
            rewrite(unit);
            // Nothing will re-measure offline: keep the heuristic layout and drop the
            // pending-measurement list so the viewer does not wait on a refinement.
            unit.remove("measurements");
            writeFile(store.unitFile(i), unit.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (fonts != null) {
            for (int i = 0; i < fonts.length(); i++) {
                JSONObject font = fonts.optJSONObject(i);
                if (font == null) continue;
                String id = font.optString("id", "");
                if (id.isEmpty()) continue;
                listener.stage("下载字体 " + (i + 1) + " / " + fonts.length() + "…");
                byte[] bytes = readBytes(server + "/v1/sessions/" + encode(sessionId)
                        + "/fonts/" + encode(id));
                writeFile(store.fontFile(id), bytes);
            }
        }
        JSONObject manifest = new JSONObject();
        manifest.put("fileId", fileId);
        manifest.put("format", "pptx");
        manifest.put("unitCount", count);
        manifest.put("fonts", fonts == null ? new JSONArray() : fonts);
        manifest.put("createdAt", System.currentTimeMillis());
        manifest.put("parts", partsDownloaded);
        writeFile(store.manifestFile(), manifest.toString().getBytes(StandardCharsets.UTF_8));
        store.markComplete();
        closeSession();
        listener.stage("离线包完成：共 " + count + " 页、" + partsDownloaded + " 个媒体文件");
    }

    // ── session / units ──────────────────────────────────────────────────────

    private JSONObject openSession() throws IOException, JSONException {
        JSONObject body = new JSONObject();
        body.put("fileId", fileId);
        JSONObject created = requestJson(server + "/v1/sessions", "POST", body.toString());
        sessionId = created.optString("sessionId", "");
        if (sessionId.isEmpty()) throw new IOException("解析服务未返回会话");
        return created;
    }

    private JSONObject fetchUnit(int index) throws IOException, JSONException {
        String url = server + "/v1/sessions/" + encode(sessionId) + "/units/" + index;
        HttpURLConnection connection = open(url, "GET");
        try {
            int code = connection.getResponseCode();
            if (code == 404 || code == 410) {
                // Session expired while downloading a large deck: reopen and retry once.
                connection.disconnect();
                openSession();
                return fetchUnit(index);
            }
            if (code != 200) throw httpError(connection, url);
            return new JSONObject(readText(connection.getInputStream()));
        } finally {
            connection.disconnect();
        }
    }

    private void closeSession() {
        if (sessionId == null || sessionId.isEmpty()) return;
        try {
            HttpURLConnection connection = open(
                    server + "/v1/sessions/" + encode(sessionId), "DELETE");
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
        writeFile(file, readBytes(url));
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
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(120000);
        connection.setRequestProperty("Accept", "*/*");
        if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
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
            connection.disconnect();
        }
    }

    private byte[] readBytes(String url) throws IOException {
        HttpURLConnection connection = open(url, "GET");
        try {
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) throw httpError(connection, url);
            return readAll(connection.getInputStream());
        } finally {
            connection.disconnect();
        }
    }

    private static IOException httpError(HttpURLConnection connection, String url) throws IOException {
        String detail = "";
        InputStream error = connection.getErrorStream();
        if (error != null) {
            try {
                detail = new String(readAll(error), StandardCharsets.UTF_8);
            } catch (IOException ignored) {
            }
        }
        return new IOException("HTTP " + connection.getResponseCode() + " " + url
                + (detail.isEmpty() ? "" : ": " + detail));
    }

    private static String readText(InputStream input) throws IOException {
        return new String(readAll(input), StandardCharsets.UTF_8);
    }

    private static byte[] readAll(InputStream input) throws IOException {
        try (InputStream in = new BufferedInputStream(input)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) >= 0) out.write(buffer, 0, n);
            return out.toByteArray();
        }
    }

    private static void writeFile(File file, byte[] bytes) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("cannot create " + parent);
        }
        File temp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(bytes);
        }
        if (!temp.renameTo(file)) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            if (!temp.renameTo(file)) throw new IOException("cannot write " + file);
        }
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }
}
