package com.genoffice.viewerdemo;

import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Cancellable, authenticated metadata-only file paging. No redirects carry the bearer token. */
final class ServerDocuments {
    static final class Document {
        final String fileId, displayName, format, createdAt;
        final long size;
        Document(JSONObject value) throws Exception {
            fileId = value.getString("fileId"); format = value.getString("format");
            size = value.getLong("size"); createdAt = value.getString("createdAt");
            displayName = value.getString("displayName");
            if (!fileId.matches("[a-f0-9]{64}") || !("pptx".equals(format) || "docx".equals(format) || "pdf".equals(format))
                    || size < 0 || displayName.isEmpty() || displayName.length() > 255)
                throw new IOException("服务端返回无效的文档信息");
        }
    }
    static final class Page {
        final List<Document> items;
        final String next;
        Page(List<Document> items, String next) { this.items = Collections.unmodifiableList(items); this.next = next; }
    }
    private volatile HttpURLConnection active;
    private volatile boolean cancelled;
    void cancel() { cancelled = true; HttpURLConnection connection = active; if (connection != null) connection.disconnect(); }

    Page list(String server, String token, String cursor) throws IOException {
        if (cancelled) throw new IOException("请求已取消");
        Uri root = Uri.parse(server.trim());
        if (!("http".equalsIgnoreCase(root.getScheme()) || "https".equalsIgnoreCase(root.getScheme()))
                || root.getHost() == null || root.getUserInfo() != null || root.getQuery() != null || root.getFragment() != null)
            throw new IOException("请填写有效的 HTTP(S) 解析服务地址");
        Uri.Builder uri = Uri.parse(server.trim().replaceAll("/+$", "") + "/v1/files").buildUpon().appendQueryParameter("limit", "20");
        if (cursor != null) uri.appendQueryParameter("cursor", cursor);
        HttpURLConnection connection = (HttpURLConnection) new URL(uri.build().toString()).openConnection();
        active = connection;
        try {
            if (cancelled) throw new IOException("请求已取消");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
            connection.setRequestProperty("Accept", "application/json");
            if (token != null && !token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new IOException("访问令牌无效或权限不足（HTTP " + status + "）");
            if (status == 404 || status == 405) throw new IOException("服务端尚未提供文档列表，请更新解析服务");
            if (status != 200) throw new IOException("获取文档列表失败（HTTP " + status + "）");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[8192]; int read;
                while ((read = input.read(buffer)) != -1) {
                    if (cancelled) throw new IOException("请求已取消");
                    if (bytes.size() + read > 2 * 1024 * 1024) throw new IOException("文档列表响应过大");
                    bytes.write(buffer, 0, read);
                }
            }
            if (cancelled) throw new IOException("请求已取消");
            JSONObject body = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            JSONArray values = body.getJSONArray("items");
            if (values.length() > 100) throw new IOException("服务端返回过多的文档记录");
            List<Document> items = new ArrayList<>();
            for (int i = 0; i < values.length(); i++) items.add(new Document(values.getJSONObject(i)));
            String next = body.isNull("next") ? null : body.getString("next");
            if (next != null && (!next.matches("[A-Za-z0-9_-]{1,256}") || next.equals(cursor)))
                throw new IOException("服务端分页游标未推进或无效");
            return new Page(items, next);
        } catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("文档列表数据无效", error); }
        finally { connection.disconnect(); if (active == connection) active = null; }
    }
}
