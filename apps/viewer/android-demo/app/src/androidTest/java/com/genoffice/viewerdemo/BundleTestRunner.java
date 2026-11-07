package com.genoffice.viewerdemo;

import android.app.Activity;
import android.test.InstrumentationTestRunner;
import android.os.Bundle;
import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
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
            BundleStore store = new BundleStore(root, fileId);
            String key = null;
            for (int attempt = 0; attempt < 2; attempt++) {
                new BundleDownloader(arguments.getString("server"), arguments.getString("token"), fileId, store, stage -> {}).run();
                store.verifyIntegrity();
                JSONObject manifest = store.manifest();
                if (!manifest.getBoolean("sourceVerified")) throw new IOException("real backend unexpectedly used legacy downloads");
                if (key != null && !key.equals(manifest.getString("artifactKey"))) throw new IOException("artifact identity changed on cached reopen");
                key = manifest.getString("artifactKey");
                if (manifest.getJSONArray("fonts").length() != 1 || !store.fontFile("embed:0").isFile()) throw new IOException("embedded font identity/path mapping failed");
                if (manifest.getInt("unitCount") != 1) throw new IOException("unexpected slide count");
                if (!store.partFile("ppt/media/inventory-only.bin").isFile()) throw new IOException("unused inventory resource was omitted");
            }
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
    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }
}
