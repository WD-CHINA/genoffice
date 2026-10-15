package com.genoffice.viewerdemo;

import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Serves the packaged viewer from assets on 127.0.0.1 only. */
final class LocalAssetServer extends Thread {
    private static final String TAG = "ViewerDemo";
    private final AssetManager assets;
    private ServerSocket socket;
    private volatile int port;

    LocalAssetServer(AssetManager assets) {
        this.assets = assets;
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

    private void handle(Socket client) {
        try (Socket ignored = client) {
            client.setSoTimeout(15000);
            InputStream input = client.getInputStream();
            String request = readHeaders(input);
            if (request.isEmpty()) return;
            String[] lines = request.split("\r\n");
            String[] start = lines[0].split(" ");
            if (start.length < 2) return;
            String method = start[0];
            String rawPath = start[1];
            int query = rawPath.indexOf('?');
            if (query >= 0) rawPath = rawPath.substring(0, query);
            String path = URLDecoder.decode(rawPath, "UTF-8");
            if (path.contains("..") || path.contains("\\")) {
                writeStatus(client, 400, "Bad Request");
                return;
            }
            if (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty() || path.endsWith("/")) path += "index.html";
            boolean gzip = false;
            for (String line : lines) {
                if (line.toLowerCase(Locale.US).startsWith("accept-encoding:") && line.toLowerCase(Locale.US).contains("gzip")) {
                    gzip = true;
                }
            }
            byte[] body;
            try (InputStream file = assets.open(path)) {
                body = readAll(file);
            } catch (IOException e) {
                writeStatus(client, 404, "Not Found");
                return;
            }
            gzip = false;
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                writeStatus(client, 405, "Method Not Allowed");
                return;
            }
            String type = mime(path);
            StringBuilder headers = new StringBuilder();
            headers.append("HTTP/1.1 200 OK\r\n");
            headers.append("Content-Type: ").append(type).append("\r\n");
            headers.append("Content-Length: ").append(body.length).append("\r\n");
            if (gzip) headers.append("Content-Encoding: gzip\r\n");
            headers.append("Cache-Control: ").append(cache(path)).append("\r\n");
            headers.append("Connection: close\r\n\r\n");
            OutputStream out = client.getOutputStream();
            out.write(headers.toString().getBytes(StandardCharsets.US_ASCII));
            if ("GET".equals(method)) out.write(body);
            out.flush();
        } catch (Exception e) {
            Log.w(TAG, "request failed", e);
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = input.read(buf)) >= 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private boolean exists(String path) {
        try (InputStream in = assets.open(path)) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static void writeStatus(Socket client, int code, String text) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 " + code + " " + text + "\r\nContent-Type: text/plain\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
        OutputStream out = client.getOutputStream();
        out.write(headers.getBytes(StandardCharsets.US_ASCII));
        out.write(body);
    }

    private static String readHeaders(InputStream input) throws IOException {
        byte[] buf = new byte[8192];
        int used = 0;
        while (used < buf.length) {
            int n = input.read(buf, used, buf.length - used);
            if (n < 0) break;
            used += n;
            for (int i = 0; i + 3 < used; i++) {
                if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') {
                    return new String(buf, 0, i, StandardCharsets.ISO_8859_1);
                }
            }
        }
        return "";
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
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".otf")) return "font/otf";
        return "application/octet-stream";
    }
}
