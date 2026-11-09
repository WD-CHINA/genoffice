package com.genoffice.viewerdemo;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Bounded, identity-checked partial transfers for declared bundle resources.
 *
 * Lives beside (not inside) the staging directory: a cancelled download still clears
 * staging, but the bytes already received survive for the next attempt. A partial file
 * is only reused when its recorded identity matches the current authoritative manifest,
 * so a different artifact generation or a tampered resource can never be spliced in.
 */
final class BundleResume {
    static final long DEFAULT_MAX_BYTES = 512L * 1024 * 1024;

    private final File dir;
    private final long maxBytes;

    BundleResume(File bundleDir) { this(bundleDir, DEFAULT_MAX_BYTES); }

    BundleResume(File bundleDir, long maxBytes) {
        this.dir = new File(bundleDir.getPath() + ".resume");
        this.maxBytes = maxBytes;
    }

    private BundleResume(File exactDir, long maxBytes, boolean exact) {
        this.dir = exactDir;
        this.maxBytes = maxBytes;
    }

    /** Exact directory, used when the cache owns the resume state. */
    static BundleResume at(File dir) { return at(dir, DEFAULT_MAX_BYTES); }

    static BundleResume at(File dir, long maxBytes) {
        return new BundleResume(dir, maxBytes, true);
    }

    File dir() { return dir; }

    /** Stable per-resource key; identity itself is compared via the meta record. */
    static String key(String path) { return sha256Hex(path.getBytes(StandardCharsets.UTF_8)); }

    File part(String key) { return new File(dir, key + ".part"); }

    File meta(String key) { return new File(dir, key + ".json"); }

    /** Returns the reusable partial file, or null when nothing trustworthy exists. */
    File acquire(String path, long size, String sha256, String artifactKey) throws IOException {
        String key = key(path);
        File part = part(key);
        File meta = meta(key);
        if (!meta.isFile() || !part.isFile()) { discard(key); return null; }
        try {
            JSONObject record = new JSONObject(readText(meta));
            if (!path.equals(record.optString("path")) || size != record.optLong("size", -1)
                    || !sha256.equals(record.optString("sha256"))
                    || !artifactKey.equals(record.optString("artifactKey"))) {
                discard(key);
                return null;
            }
        } catch (JSONException invalid) {
            discard(key);
            return null;
        }
        long length = part.length();
        if (length <= 0 || length > size) { discard(key); return null; }
        return part;
    }

    /** Persist the identity of an existing partial file after an interrupted transfer. */
    void record(String path, long size, String sha256, String artifactKey) throws IOException {
        String key = key(path);
        File part = part(key);
        if (!part.isFile() || part.length() <= 0) { discard(key); return; }
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory())
            throw new IOException("cannot create resume directory");
        try {
            JSONObject record = new JSONObject()
                    .put("path", path).put("size", size)
                    .put("sha256", sha256).put("artifactKey", artifactKey);
            writeSynced(meta(key), record.toString().getBytes(StandardCharsets.UTF_8));
        } catch (JSONException impossible) {
            throw new IOException(impossible);
        }
        trim();
    }

    void discard(String key) {
        //noinspection ResultOfMethodCallIgnored
        part(key).delete();
        //noinspection ResultOfMethodCallIgnored
        meta(key).delete();
    }

    /** Called only after a bundle has been atomically published. */
    void clear() { delete(dir); }

    long usedBytes() {
        long total = 0;
        File[] files = dir.listFiles();
        if (files != null) for (File file : files)
            if (file.isFile() && file.getName().endsWith(".part")) total += file.length();
        return total;
    }

    /** Drop oldest partials first; an interrupted download can never grow without bound. */
    void trim() throws IOException {
        File[] files = dir.listFiles();
        if (files == null) return;
        List<File> parts = new ArrayList<>();
        long total = 0;
        for (File file : files) {
            if (file.isFile() && file.getName().endsWith(".part")) {
                parts.add(file);
                total += file.length();
            }
        }
        if (total <= maxBytes) return;
        parts.sort(Comparator.comparingLong(File::lastModified));
        for (File part : parts) {
            if (total <= maxBytes) break;
            long bytes = part.length();
            String key = part.getName().substring(0, part.getName().length() - ".part".length());
            discard(key);
            total -= bytes;
        }
        if (usedBytes() > maxBytes) throw new IOException("cannot bound resumed download bytes");
    }

    static String sha256Hex(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder out = new StringBuilder();
            for (byte value : digest) out.append(String.format(Locale.US, "%02x", value & 255));
            return out.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String readText(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int n;
            while ((n = in.read(buffer)) >= 0) out.write(buffer, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void writeSynced(File file, byte[] bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
            output.getFD().sync();
        }
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) {
            if (child.isDirectory()) delete(child);
            else {
                //noinspection ResultOfMethodCallIgnored
                child.delete();
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
