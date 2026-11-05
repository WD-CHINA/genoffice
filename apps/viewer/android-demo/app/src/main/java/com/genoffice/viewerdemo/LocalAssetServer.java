package com.genoffice.viewerdemo;

import android.content.res.AssetManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Loopback HTTP server for the bundled viewer:
 *
 * - static files from assets (the Vite build targets /viewer/, so that prefix is stripped)
 * - /v1: the parse-server surface the Viewer's remote session talks to, replayed from
 *   the cached bundle — sessions, units, text widths, fonts, and media parts with Range
 *   support so &lt;video&gt; can seek using local files.
 *
 * Everything is same-origin, which keeps canvas untainted and lets cached unit JSON
 * point at relative /v1/files/&lt;id&gt;/parts/... URLs.
 */
final class LocalAssetServer extends Thread {
    private static final String TAG = "ViewerDemo";
    private static final int MAX_BODY = 1 << 20;

    private final AssetManager assets;
    private final BundleStore store;
    private ServerSocket socket;
    private volatile int port;

    LocalAssetServer(AssetManager assets, BundleStore store) {
        this.assets = assets;
        this.store = store;
        setName("viewer-http");
    }

    int startAndWait() throws IOException {
        socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress("127.0.0.1", 0));
        port = socket.getLocalPort();
        start();
        return port;
    }

    void shutdown() {
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }

    @Override
    public void run() {
        while (!socket.isClosed()) {
            try {
                Socket client = socket.accept();
                new Thread(() -> handle(client), "viewer-http-conn").start();
            } catch (IOException e) {
                if (!socket.isClosed()) Log.w(TAG, "accept failed", e);
                break;
            }
        }
    }

    // ── request parsing ──────────────────────────────────────────────────────

    private static final class Request {
        String method;
        String path;
        final Map<String, String> headers = new HashMap<>();
        byte[] body;
    }

    private void handle(Socket client) {
        try (Socket socket = client) {
            socket.setSoTimeout(30000);
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            Request request = readRequest(in);
            if (request == null) return;
            OutputStream out = new BufferedOutputStream(socket.getOutputStream());
            route(request, out);
            out.flush();
        } catch (Exception e) {
            Log.w(TAG, "request failed", e);
        }
    }

    private static Request readRequest(BufferedInputStream in) throws IOException {
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        int p1 = -1;
        int p2 = -1;
        int p3 = -1;
        int p4 = -1;
        int value;
        while ((value = in.read()) >= 0) {
            header.write(value);
            p1 = p2;
            p2 = p3;
            p3 = p4;
            p4 = value;
            if (p1 == '\r' && p2 == '\n' && p3 == '\r' && p4 == '\n') break;
            if (header.size() > 65536) return null;
        }
        String text = new String(header.toByteArray(), StandardCharsets.ISO_8859_1);
        String[] lines = text.split("\r\n");
        if (lines.length == 0) return null;
        String[] start = lines[0].split(" ");
        if (start.length < 2) return null;
        Request request = new Request();
        request.method = start[0];
        String target = start[1];
        int query = target.indexOf('?');
        if (query >= 0) target = target.substring(0, query);
        request.path = target;
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon <= 0) continue;
            request.headers.put(
                    lines[i].substring(0, colon).trim().toLowerCase(Locale.US),
                    lines[i].substring(colon + 1).trim());
        }
        int length = 0;
        try {
            length = Integer.parseInt(request.headers.getOrDefault("content-length", "0"));
        } catch (NumberFormatException ignored) {
        }
        if (length > 0) {
            if (length > MAX_BODY) throw new IOException("body too large");
            request.body = readExactly(in, length);
        }
        return request;
    }

    // ── routing ──────────────────────────────────────────────────────────────

    private void route(Request request, OutputStream out) throws IOException {
        Log.i(TAG, request.method + " " + request.path);
        String[] raw = request.path.split("/");
        // raw[0] is empty for absolute paths
        if (raw.length >= 2 && "v1".equals(raw[1])) {
            handleApi(request, raw, out);
            return;
        }
        serveAsset(request, out);
    }

    private void handleApi(Request request, String[] raw, OutputStream out) throws IOException {
        String method = request.method;
        if (raw.length >= 3 && "health".equals(raw[2]) && "GET".equals(method)) {
            sendJson(out, 200, "{\"ok\":true}");
            return;
        }
        if (raw.length == 3 && "sessions".equals(raw[2]) && "POST".equals(method)) {
            handleSessionCreate(request, out);
            return;
        }
        if (raw.length >= 3 && "sessions".equals(raw[2])) {
            handleSession(request, raw, out);
            return;
        }
        if (raw.length >= 3 && "files".equals(raw[2])) {
            handleFile(request, raw, out);
            return;
        }
        sendText(out, 404, "Not Found");
    }

    private void handleSessionCreate(Request request, OutputStream out) throws IOException {
        String fileId = store.fileId();
        try {
            if (request.body != null) {
                JSONObject body = new JSONObject(new String(request.body, StandardCharsets.UTF_8));
                String requested = body.optString("fileId", fileId);
                if (!requested.isEmpty()) fileId = requested;
            }
            if (!store.isComplete() && store.unitCount() <= 0) {
                sendJson(out, 404, "{\"code\":\"bundle_missing\",\"message\":\"离线包不存在\"}");
                return;
            }
            JSONObject model = new JSONObject();
            model.put("format", "pptx");
            model.put("parserVersion", "android-demo");
            model.put("unitKind", "slide");
            model.put("unitCount", store.unitCount());
            model.put("stagesDone", new JSONArray().put("index").put("model").put("layout"));
            model.put("stagesPending", new JSONArray().put("measure"));
            model.put("warnings", new JSONArray());
            JSONObject result = new JSONObject();
            result.put("sessionId", "local");
            result.put("model", model);
            result.put("fonts", store.manifest().optJSONArray("fonts") == null
                    ? new JSONArray()
                    : store.manifest().optJSONArray("fonts"));
            sendJson(out, 200, result.toString());
        } catch (Exception e) {
            sendJson(out, 500, "{\"code\":\"bundle_error\",\"message\":"
                    + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
        }
    }

    private void handleSession(Request request, String[] raw, OutputStream out) throws IOException {
        String method = request.method;
        String session = decode(raw.length > 3 ? raw[3] : "");
        if (!"local".equals(session)) {
            sendText(out, 404, "Not Found");
            return;
        }
        if (raw.length == 4 && "DELETE".equals(method)) {
            sendEmpty(out, 204, "No Content");
            return;
        }
        if (raw.length >= 6 && "units".equals(raw[4]) && "GET".equals(method)) {
            int index;
            try {
                index = Integer.parseInt(decode(raw[5]));
            } catch (NumberFormatException e) {
                sendText(out, 400, "Bad Request");
                return;
            }
            File file = store.unitFile(index);
            if (!file.isFile()) {
                sendText(out, 404, "Not Found");
                return;
            }
            sendBytes(out, 200, "application/json; charset=utf-8", readFile(file),
                    "HEAD".equals(method), null);
            return;
        }
        if (raw.length == 5 && "layout".equals(raw[4]) && "GET".equals(method)) {
            File file = store.layoutInfoFile();
            if (!file.isFile()) {
                sendText(out, 404, "Not Found");
                return;
            }
            sendBytes(out, 200, "application/json; charset=utf-8", readFile(file), false, null);
            return;
        }
        if (raw.length == 7 && "layout".equals(raw[4]) && "slides".equals(raw[5])
                && "GET".equals(method)) {
            int index;
            try {
                index = Integer.parseInt(decode(raw[6]));
            } catch (NumberFormatException e) {
                sendText(out, 400, "Bad Request");
                return;
            }
            File file = store.layoutSlideFile(index);
            if (!file.isFile()) {
                sendText(out, 404, "Not Found");
                return;
            }
            sendBytes(out, 200, "application/json; charset=utf-8", readFile(file), false, null);
            return;
        }
        if (raw.length == 5 && "text-widths".equals(raw[4]) && "POST".equals(method)) {
            // Offline units keep the server's heuristic layout; no re-render to do.
            sendJson(out, 200, "{}");
            return;
        }
        if (raw.length >= 6 && "fonts".equals(raw[4]) && "GET".equals(method)) {
            String fontId = decode(raw[5]);
            File file = store.fontFile(fontId);
            if (!file.isFile()) {
                sendText(out, 404, "Not Found");
                return;
            }
            sendBytes(out, 200, "font/ttf", readFile(file), false, null);
            return;
        }
        sendText(out, 404, "Not Found");
    }

    private void handleFile(Request request, String[] raw, OutputStream out) throws IOException {
        String fileId = decode(raw[3]);
        if (!store.fileId().equals(fileId)) {
            sendText(out, 404, "Not Found");
            return;
        }
        if (raw.length == 4 && "GET".equals(request.method)) {
            try {
                JSONObject manifest = store.manifest();
                sendJson(out, 200, new JSONObject()
                        .put("fileId", fileId)
                        .put("format", manifest.optString("format", "pptx"))
                        .put("size", 0)
                        .toString());
            } catch (Exception e) {
                sendText(out, 404, "Not Found");
            }
            return;
        }
        if (raw.length >= 6 && "parts".equals(raw[4])) {
            StringBuilder builder = new StringBuilder();
            for (int i = 5; i < raw.length; i++) {
                if (builder.length() > 0) builder.append('/');
                builder.append(decode(raw[i]));
            }
            File file;
            try {
                file = store.partFile(builder.toString());
            } catch (IOException e) {
                sendText(out, 400, "Bad Request");
                return;
            }
            if (!file.isFile()) {
                sendText(out, 404, "Not Found");
                return;
            }
            serveRange(request, out, file);
            return;
        }
        sendText(out, 404, "Not Found");
    }

    // ── static assets ────────────────────────────────────────────────────────

    private void serveAsset(Request request, OutputStream out) throws IOException {
        if (!"GET".equals(request.method) && !"HEAD".equals(request.method)) {
            sendText(out, 405, "Method Not Allowed");
            return;
        }
        String path = decode(request.path);
        while (path.startsWith("/")) path = path.substring(1);
        // The release build targets /viewer/ (see apps/viewer/scripts/build.mjs)
        if (path.startsWith("viewer/")) path = path.substring("viewer/".length());
        if (path.isEmpty() || path.endsWith("/")) path += "index.html";
        if (path.contains("..") || path.contains("\\")) {
            sendText(out, 400, "Bad Request");
            return;
        }
        byte[] body;
        try (InputStream file = assets.open(path)) {
            body = readExactly(file);
        } catch (IOException e) {
            sendText(out, 404, "Not Found");
            return;
        }
        Map<String, String> extra = new HashMap<>();
        extra.put("Cache-Control", cache(path));
        sendBytes(out, 200, mime(path), body, "HEAD".equals(request.method), extra);
    }

    // ── range + responses ────────────────────────────────────────────────────

    private void serveRange(Request request, OutputStream out, File file) throws IOException {
        long size = file.length();
        long start = 0;
        long end = size - 1;
        boolean partial = false;
        String header = request.headers.get("range");
        if (header != null && header.startsWith("bytes=")) {
            String spec = header.substring("bytes=".length()).split(",")[0].trim();
            int dash = spec.indexOf('-');
            if (dash >= 0) {
                try {
                    String a = spec.substring(0, dash);
                    String b = spec.substring(dash + 1);
                    if (a.isEmpty()) {
                        long suffix = Long.parseLong(b);
                        start = Math.max(0, size - suffix);
                        end = size - 1;
                    } else {
                        start = Long.parseLong(a);
                        end = b.isEmpty() ? size - 1 : Math.min(size - 1, Long.parseLong(b));
                    }
                    partial = true;
                } catch (NumberFormatException ignored) {
                    partial = false;
                }
            }
        }
        if (size == 0) {
            sendBytes(out, 200, mime(file.getName()), new byte[0], false, null);
            return;
        }
        if (start < 0 || start >= size || end < start) {
            Map<String, String> extra = new HashMap<>();
            extra.put("Content-Range", "bytes */" + size);
            sendBytes(out, 416, "text/plain", new byte[0], false, extra);
            return;
        }
        long length = end - start + 1;
        Map<String, String> extra = new HashMap<>();
        extra.put("Accept-Ranges", "bytes");
        extra.put("Cache-Control", "public, max-age=31536000");
        if (partial) extra.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(partial ? "206 Partial Content" : "200 OK").append("\r\n");
        head.append("Content-Type: ").append(mime(file.getName())).append("\r\n");
        head.append("Content-Length: ").append(length).append("\r\n");
        for (Map.Entry<String, String> h : extra.entrySet()) {
            head.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
        }
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        if ("HEAD".equals(request.method)) return;
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            in.seek(start);
            byte[] buffer = new byte[65536];
            long remaining = length;
            while (remaining > 0) {
                int n = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                if (n < 0) break;
                out.write(buffer, 0, n);
                remaining -= n;
            }
        }
    }

    private static void sendJson(OutputStream out, int code, String json) throws IOException {
        sendBytes(out, code, "application/json; charset=utf-8",
                json.getBytes(StandardCharsets.UTF_8), false, null);
    }

    private static void sendText(OutputStream out, int code, String text) throws IOException {
        sendBytes(out, code, "text/plain; charset=utf-8",
                text.getBytes(StandardCharsets.UTF_8), false, null);
    }

    private static void sendEmpty(OutputStream out, int code, String reason) throws IOException {
        String head = "HTTP/1.1 " + code + " " + reason + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
    }

    private static void sendBytes(
            OutputStream out,
            int code,
            String type,
            byte[] body,
            boolean head,
            Map<String, String> extra) throws IOException {
        String reason = code == 200 ? "OK" : code == 204 ? "No Content"
                : code == 206 ? "Partial Content" : code == 404 ? "Not Found"
                : code == 416 ? "Range Not Satisfiable" : "Error";
        StringBuilder headers = new StringBuilder();
        headers.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
        if (type != null) headers.append("Content-Type: ").append(type).append("\r\n");
        headers.append("Content-Length: ").append(body.length).append("\r\n");
        if (extra != null) {
            for (Map.Entry<String, String> h : extra.entrySet()) {
                headers.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
            }
        }
        headers.append("Connection: close\r\n\r\n");
        out.write(headers.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (!head && body.length > 0) out.write(body);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    private static byte[] readExactly(InputStream input) throws IOException {
        return readExactly(input, -1);
    }

    private static byte[] readExactly(InputStream input, int length) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(length > 0 ? length : 16384);
        byte[] buffer = new byte[16384];
        int remaining = length;
        while (true) {
            int want = length > 0 ? Math.min(buffer.length, remaining) : buffer.length;
            if (length > 0 && remaining <= 0) break;
            int n = input.read(buffer, 0, want);
            if (n < 0) break;
            out.write(buffer, 0, n);
            remaining -= n;
        }
        return out.toByteArray();
    }

    private static byte[] readFile(File file) throws IOException {
        try (InputStream in = new BufferedInputStream(new java.io.FileInputStream(file))) {
            return readExactly(in);
        }
    }

    private static String cache(String path) {
        if (path.equals("index.html") || path.equals("preview.html")) return "no-cache";
        if (path.startsWith("assets/")) return "public, max-age=31536000, immutable";
        return "public, max-age=604800";
    }

    private static String mime(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".wasm")) return "application/wasm";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
        if (lower.endsWith(".mov")) return "video/quicktime";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".m4a")) return "audio/mp4";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".otf")) return "font/otf";
        return "application/octet-stream";
    }
}
