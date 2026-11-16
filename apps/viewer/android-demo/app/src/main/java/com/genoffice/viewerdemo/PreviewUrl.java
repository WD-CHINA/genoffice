package com.genoffice.viewerdemo;

import android.net.Uri;

/** Canonical preview entry shared by online viewing and local bundle replay. */
final class PreviewUrl {
    private PreviewUrl() { }

    static String build(String viewerAddress, String serverAddress, String fileId, String token, String theme) {
        Uri viewer = address(viewerAddress);
        Uri backend = address(serverAddress);
        String path = directory(viewer);
        Uri.Builder target = viewer.buildUpon().path(path + "preview.html").clearQuery().fragment(null);
        if (fileId != null && !fileId.isEmpty()) target.appendQueryParameter("fileId", fileId);
        if (!base(viewer).equals(base(backend)) || !rootPath(backend))
            target.appendQueryParameter("server", backend.buildUpon().clearQuery().fragment(null).build().toString().replaceAll("/+$", ""));
        if (token != null && !token.isEmpty()) target.appendQueryParameter("token", token);
        if ("dark".equals(theme) || "light".equals(theme)) target.appendQueryParameter("theme", theme);
        return target.build().toString();
    }

    static String home(String viewerAddress, String serverAddress, String token, String theme) {
        Uri viewer = address(viewerAddress);
        Uri backend = address(serverAddress);
        Uri.Builder target = viewer.buildUpon().path(directory(viewer)).clearQuery().fragment(null)
                .appendQueryParameter("parse", "auto");
        if (!base(viewer).equals(base(backend)) || !rootPath(backend))
            target.appendQueryParameter("server", backend.buildUpon().clearQuery().fragment(null).build().toString().replaceAll("/+$", ""));
        if (token != null && !token.isEmpty()) target.appendQueryParameter("token", token);
        if ("dark".equals(theme) || "light".equals(theme)) target.appendQueryParameter("theme", theme);
        return target.build().toString();
    }

    private static String directory(Uri viewer) {
        String path = viewer.getPath();
        if (path == null || path.isEmpty()) return "/";
        if (path.endsWith("/")) return path;
        String tail = path.substring(path.lastIndexOf('/') + 1);
        return tail.contains(".") ? path.substring(0, path.lastIndexOf('/') + 1) : path + "/";
    }
    private static boolean rootPath(Uri uri) {
        return uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath());
    }
    private static String base(Uri uri) {
        int port = uri.getPort() < 0 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : uri.getPort();
        return uri.getScheme().toLowerCase(java.util.Locale.ROOT) + "://" + uri.getHost().toLowerCase(java.util.Locale.ROOT) + ":" + port;
    }
    private static Uri address(String raw) {
        Uri uri = Uri.parse(raw.trim());
        if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
                || uri.getHost() == null || uri.getUserInfo() != null)
            throw new IllegalArgumentException("请填写有效的 HTTP(S) 地址");
        return uri;
    }
}
