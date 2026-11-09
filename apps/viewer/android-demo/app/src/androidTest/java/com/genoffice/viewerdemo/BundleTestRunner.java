package com.genoffice.viewerdemo;

import android.app.Activity;
import android.test.InstrumentationTestRunner;
import android.os.Bundle;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Explicit integration probe; the host harness supplies an isolated real parse server. */
public final class BundleTestRunner extends InstrumentationTestRunner {
    private Bundle arguments;
    private boolean probe;
    @Override public void onCreate(Bundle arguments) {
        this.arguments = arguments;
        probe = "true".equals(arguments.getString("backendProbe"));
        if (probe) start(); else super.onCreate(arguments);
    }
    @Override public void onStart() {
        if (!probe) { super.onStart(); return; }
        Bundle result = new Bundle();
        int code = Activity.RESULT_OK;
        File root = new File(getTargetContext().getCacheDir(), "backend-probe-" + java.util.UUID.randomUUID());
        try {
            String fileId = arguments.getString("fileId");
            BundleCache cache = new BundleCache(root);
            String key = null;
            BundleStore store = null;
            for (int attempt = 0; attempt < 2; attempt++) {
                new BundleDownloader(arguments.getString("server"), arguments.getString("token"), fileId,
                        cache.resolve(fileId), stage -> {}, File::getUsableSpace, cache).run();
                store = cache.resolve(fileId);
                store.verifyIntegrity();
                JSONObject manifest = store.manifest();
                if (!manifest.getBoolean("sourceVerified")) throw new IOException("real backend unexpectedly used legacy downloads");
                if (key != null && !key.equals(manifest.getString("artifactKey"))) throw new IOException("artifact identity changed on cached reopen");
                key = manifest.getString("artifactKey");
                if (manifest.getJSONArray("fonts").length() != 1 || !store.fontFile("embed:0").isFile()) throw new IOException("embedded font identity/path mapping failed");
                if (manifest.getInt("unitCount") != 1) throw new IOException("unexpected slide count");
                if (!store.partFile("ppt/media/inventory-only.bin").isFile()) throw new IOException("unused inventory resource was omitted");
                JSONObject pointer = cache.current(fileId);
                if (pointer == null || !key.equals(pointer.getString("artifactKey")))
                    throw new IOException("versioned cache pointer does not reference the active generation");
            }
            if (cache.versionCount() != 1) throw new IOException("cached reopen must not create another generation directory");
            verifyCacheCleanup(cache, fileId, key, result);
            verifyResume(arguments.getString("server"), arguments.getString("token"), fileId, store, root, result);
            LocalAssetServer replay = new LocalAssetServer(getTargetContext().getAssets(), store);
            try {
                int port = replay.startAndWait();
                HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/v1/sessions/local/layout/slides/0").openConnection();
                try {
                    if (connection.getResponseCode() != 200) throw new IOException("offline model replay failed");
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    try (java.io.InputStream input = connection.getInputStream()) {
                        byte[] bytes = new byte[65536]; int count;
                        while ((count = input.read(bytes)) != -1) buffer.write(bytes, 0, count);
                    }
                    String json = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
                    if (!new JSONObject(json).has("slide")) throw new IOException("offline slide contract missing");
                } finally { connection.disconnect(); }
                HttpURLConnection font = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/v1/sessions/local/fonts/embed%3A0").openConnection();
                try {
                    if (font.getResponseCode() != 200 || font.getContentLengthLong() != store.fontFile("embed:0").length())
                        throw new IOException("offline embedded font replay failed");
                    try (java.io.InputStream input = font.getInputStream()) {
                        byte[] bytes = new byte[65536]; while (input.read(bytes) != -1) { /* consume the streamed font */ }
                    }
                } finally { font.disconnect(); }
            } finally { replay.shutdown(); replay.join(2000); }
            result.putString("result", "ok");
            result.putString("artifactKey", key);
            result.putBoolean("sourceVerified", true);
        } catch (Throwable failure) {
            code = Activity.RESULT_CANCELED;
            result.putString("result", "failed");
            result.putString("error", android.util.Log.getStackTraceString(failure));
        } finally { delete(root); }
        finish(code, result);
    }
    /** Real-server probe: half a resource is pre-seeded, so the download must use If-Range/206. */
    private void verifyResume(String server, String token, String fileId, BundleStore source,
                              File root, Bundle result) throws Exception {
        JSONObject manifest = source.manifest();
        JSONArray resources = manifest.getJSONArray("resources");
        String artifactKey = manifest.getString("artifactKey");
        java.util.List<JSONObject> targets = new java.util.ArrayList<>();
        for (int index = 0; index < resources.length(); index++) {
            JSONObject candidate = resources.getJSONObject(index);
            if (candidate.getString("path").startsWith("parts/") && candidate.getLong("size") > 8192)
                targets.add(candidate);
        }
        if (targets.isEmpty()) throw new IOException("real backend has no resumable media resource");

        BundleCache cache = new BundleCache(new File(root, "resume-files"));
        BundleResume resume = cache.resume(fileId);
        long totalPrefix = 0;
        for (JSONObject target : targets) {
            String path = target.getString("path");
            long size = target.getLong("size");
            long prefix = size / 2;
            File part = resume.part(BundleResume.key(path));
            if (!part.getParentFile().isDirectory() && !part.getParentFile().mkdirs())
                throw new IOException("cannot create resume directory");
            try (InputStream in = new FileInputStream(source.resourceFile(path));
                 OutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[8192];
                long remaining = prefix;
                while (remaining > 0) {
                    int count = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                    if (count < 0) throw new IOException("source resource truncated");
                    out.write(buffer, 0, count);
                    remaining -= count;
                }
            }
            resume.record(path, size, target.getString("sha256"), artifactKey);
            totalPrefix += prefix;
        }
        BundleDownloader download = new BundleDownloader(server, token, fileId, cache.resolve(fileId),
                stage -> {}, File::getUsableSpace, cache);
        download.run();
        if (download.rangeResumes() != targets.size())
            throw new IOException("real backend did not resume every seeded resource: " + download.rangeResumes());
        // STORE parts honour 206; DEFLATE parts are streamed inflated and fall back to a full 200.
        if (download.rangeResponses() < 1)
            throw new IOException("real backend returned no ranged 206 response");
        BundleStore published = cache.resolve(fileId);
        published.verifyIntegrity();
        for (JSONObject target : targets)
            if (published.resourceFile(target.getString("path")).length() != target.getLong("size"))
                throw new IOException("resumed resource has wrong size");
        if (resume.dir().exists()) throw new IOException("resume state was not cleared after publish");
        result.putBoolean("resumeVerified", true);
        result.putInt("rangeResponses", download.rangeResponses());
        result.putLong("resumedPrefixBytes", totalPrefix);
    }

    /** Real-device check: the cleanup entry drops inactive versions but never the active one. */
    private void verifyCacheCleanup(BundleCache cache, String fileId, String key, Bundle result) throws Exception {
        char[] inactiveKey = new char[64];
        java.util.Arrays.fill(inactiveKey, '0');
        BundleStore inactive = cache.versionStore(fileId, new String(inactiveKey));
        if (!inactive.dir().mkdirs() && !inactive.dir().isDirectory())
            throw new IOException("cannot seed inactive generation");
        try (OutputStream out = new FileOutputStream(new File(inactive.dir(), "old.bin"))) {
            out.write(new byte[4096]);
        }
        long freed = cache.clearInactive(fileId, key);
        if (freed <= 0 || inactive.dir().exists())
            throw new IOException("cleanup did not remove the inactive generation");
        if (!key.equals(cache.current(fileId).getString("artifactKey")))
            throw new IOException("cleanup changed the active generation pointer");
        cache.resolve(fileId).verifyIntegrity();
        result.putBoolean("versionedCache", true);
        result.putLong("cacheBytes", cache.usedBytes());
        result.putLong("cleanupBytes", freed);
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }
}
