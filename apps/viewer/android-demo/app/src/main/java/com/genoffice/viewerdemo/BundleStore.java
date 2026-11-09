package com.genoffice.viewerdemo;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.HashSet;
import java.util.Set;
import java.util.Arrays;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * One cached offline bundle: the parse server's per-slide units plus the media parts
 * and fonts they reference. Layout mirrors what the server would serve:
 *
 *   bundles/&lt;fileId&gt;/manifest.json
 *   bundles/&lt;fileId&gt;/units/&lt;i&gt;.json
 *   bundles/&lt;fileId&gt;/parts/&lt;part path&gt;
 *   bundles/&lt;fileId&gt;/fonts/&lt;font id&gt;
 *   bundles/&lt;fileId&gt;/complete   (written last: the bundle is reusable)
 */
final class BundleStore {
    private final File dir;
    private final String fileId;

    BundleStore(File filesDir, String fileId) {
        this.fileId = fileId;
        this.dir = new File(new File(filesDir, "bundles"), safe(fileId));
    }

    private BundleStore(File dir, String fileId, boolean staging) {
        this.dir = dir;
        this.fileId = fileId;
    }

    /** Explicit directory, used by BundleCache for versioned and staging bundles. */
    static BundleStore at(File dir, String fileId) {
        return new BundleStore(dir, fileId, true);
    }

    BundleStore staging() {
        return new BundleStore(new File(dir.getPath() + ".download"), fileId, true);
    }

    void publishTo(BundleStore destination) throws IOException {
        if (!isComplete()) throw new IOException("cannot publish an unsealed offline bundle");
        destination.recoverPrevious();
        File backup = new File(destination.dir.getPath() + ".previous");
        delete(backup);
        boolean hadPrevious = destination.dir.exists();
        if (hadPrevious && !destination.dir.renameTo(backup)) {
            throw new IOException("cannot preserve previous bundle");
        }
        if (!dir.renameTo(destination.dir)) {
            if (hadPrevious && !backup.renameTo(destination.dir)) {
                throw new IOException("cannot restore bundle: " + backup);
            }
            throw new IOException("cannot publish bundle");
        }
        delete(backup);
    }

    String fileId() {
        return fileId;
    }

    File dir() {
        return dir;
    }

    File manifestFile() {
        return new File(dir, "manifest.json");
    }

    File unitFile(int index) {
        return new File(new File(dir, "units"), index + ".json");
    }

    /** Deck-level layout input (size, slide count, fonts). */
    File layoutInfoFile() {
        return new File(dir, "layout.json");
    }

    /** Parsed slide model the viewer lays out itself. */
    File layoutSlideFile(int index) {
        return new File(new File(dir, "layout"), index + ".json");
    }

    /** Media part path (relative to the package, e.g. ppt/media/media1.mp4). */
    File partFile(String partPath) throws IOException {
        File parts = new File(dir, "parts");
        File file = new File(parts, partPath);
        String base = parts.getCanonicalPath() + File.separator;
        if (!file.getCanonicalPath().startsWith(base)) {
            throw new IOException("invalid part path: " + partPath);
        }
        return file;
    }

    File fontFile(String fontId) {
        try {
            JSONArray fonts = manifest().optJSONArray("fonts");
            if (fonts != null) for (int index = 0; index < fonts.length(); index++) {
                JSONObject font = fonts.getJSONObject(index);
                if (fontId.equals(font.optString("id")) && font.has("resourcePath")) return resourceFile(font.getString("resourcePath"));
            }
        } catch (IOException | JSONException unavailable) { /* Legacy downloads have no manifest yet. */ }
        return new File(new File(dir, "fonts"), safe(fontId) + ".sfnt");
    }

    boolean isComplete() {
        try { validate(false, true); return true; }
        catch (IOException | JSONException failure) { return false; }
    }

    /** Lightweight presence check for the UI thread; verifyIntegrity() does the full hash pass. */
    boolean isSealed() {
        File complete = new File(dir, "complete");
        return manifestFile().isFile() && complete.isFile() && complete.length() == 64;
    }

    /** Hash local bytes on the download/verification thread, never on the UI thread. */
    void seal(JSONObject manifest) throws IOException, JSONException {
        manifest.put("bundleSchemaVersion", 1);
        JSONArray resources = new JSONArray();
        collect(dir, resources);
        manifest.put("resources", resources);
        writeSynced(manifestFile(), manifest.toString().getBytes(StandardCharsets.UTF_8));
        markComplete();
    }

    void verifyIntegrity() throws IOException {
        recoverPrevious();
        try { validate(true, true); }
        catch (JSONException failure) { throw new IOException("invalid offline manifest", failure); }
    }

    void recoverPrevious() throws IOException {
        if (dir.exists()) return;
        File backup = new File(dir.getPath() + ".previous");
        if (new BundleStore(backup, fileId, true).isComplete() && !backup.renameTo(dir))
            throw new IOException("cannot recover previous offline bundle");
    }

    void markComplete() throws IOException {
        try { validate(true, false); }
        catch (JSONException failure) { throw new IOException("invalid offline manifest", failure); }
        writeSynced(new File(dir, "complete"), digest(manifestFile()).getBytes(StandardCharsets.US_ASCII));
    }

    private void collect(File directory, JSONArray resources) throws IOException, JSONException {
        File[] files = directory.listFiles();
        if (files == null) throw new IOException("cannot list " + directory);
        Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
        for (File file : files) {
            String relative = dir.toURI().relativize(file.toURI()).getPath();
            if (file.equals(manifestFile()) || relative.equals("complete")) continue;
            resourceFile(relative.endsWith("/") ? relative.substring(0, relative.length() - 1) : relative);
            if (file.isDirectory()) collect(file, resources);
            else {
                if (relative.endsWith(".tmp") || !file.isFile()) throw new IOException("unfinished bundle resource");
                resources.put(new JSONObject().put("path", relative).put("size", file.length()).put("sha256", digest(file)));
            }
        }
    }

    File resourceFile(String path) throws IOException {
        if (path.isEmpty() || path.startsWith("/") || path.contains("\\")) throw new IOException("invalid resource path");
        for (String segment : path.split("/", -1))
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) throw new IOException("invalid resource path");
        File file = new File(dir, path);
        if (!file.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) throw new IOException("resource escapes bundle");
        return file;
    }

    private void validate(boolean hashes, boolean marker) throws IOException, JSONException {
        if (!manifestFile().isFile() || manifestFile().length() > 16 * 1024 * 1024) throw new IOException("offline manifest missing or too large");
        if (marker && (!new File(dir, "complete").isFile() || new File(dir, "complete").length() != 64 || !readText(new File(dir, "complete")).equals(digest(manifestFile()))))
            throw new IOException("offline manifest seal mismatch");
        JSONObject manifest = manifest();
        if (manifest.optInt("bundleSchemaVersion") != 1 || !fileId.equals(manifest.optString("fileId")) || !"pptx".equals(manifest.optString("format")))
            throw new IOException("unsupported offline bundle version or identity");
        int count = manifest.getInt("unitCount");
        if (count <= 0 || count > 100000) throw new IOException("invalid offline slide count");
        // A bundle with external references must never be presented as fully offline.
        String scope = manifest.optString("offlineScope", "complete");
        if (!"complete".equals(scope) && !"partial".equals(scope))
            throw new IOException("unsupported offline scope");
        JSONArray external = manifest.optJSONArray("externalResources");
        int externalCount = external == null ? 0 : external.length();
        if (("partial".equals(scope)) != (externalCount > 0))
            throw new IOException("offline scope does not match external resources");
        JSONArray resources = manifest.getJSONArray("resources");
        if (resources.length() > 100000) throw new IOException("too many offline resources");
        Set<String> paths = new HashSet<>();
        for (int index = 0; index < resources.length(); index++) {
            JSONObject resource = resources.getJSONObject(index);
            String path = resource.getString("path");
            if (!paths.add(path) || path.equals("manifest.json") || path.equals("complete")) throw new IOException("duplicate or reserved resource path");
            File file = resourceFile(path);
            long size = resource.getLong("size");
            String hash = resource.getString("sha256");
            if (size < 0 || !hash.matches("[a-f0-9]{64}") || !file.isFile() || file.length() != size) throw new IOException("offline resource missing or truncated: " + path);
            if (hashes && !hash.equals(digest(file))) throw new IOException("offline checksum mismatch: " + path);
        }
        if (!paths.contains("layout.json")) throw new IOException("offline layout missing");
        for (int index = 0; index < count; index++) if (!paths.contains("layout/" + index + ".json")) throw new IOException("offline slide missing");
        JSONArray fonts = manifest.optJSONArray("fonts");
        if (fonts != null) for (int index = 0; index < fonts.length(); index++)
            if (!paths.contains(fonts.getJSONObject(index).optString("resourcePath", "fonts/" + safe(fonts.getJSONObject(index).getString("id")) + ".sfnt"))) throw new IOException("offline font missing");
    }

    private static String digest(File file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (FileInputStream input = new FileInputStream(file)) {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("下载已取消");
                    digest.update(buffer, 0, count);
                }
            }
            StringBuilder out = new StringBuilder();
            for (byte value : digest.digest()) out.append(String.format(Locale.US, "%02x", value & 255));
            return out.toString();
        } catch (NoSuchAlgorithmException impossible) { throw new IOException(impossible); }
    }

    private static void writeSynced(File file, byte[] bytes) throws IOException {
        new BundleSpace(file.getParentFile()).require(bytes.length);
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); output.getFD().sync(); }
    }

    JSONObject manifest() throws IOException, JSONException {
        return new JSONObject(readText(manifestFile()));
    }

    int unitCount() {
        try {
            return manifest().optInt("unitCount");
        } catch (IOException | JSONException e) {
            return 0;
        }
    }

    /** Local resources are complete, but external references can still require a network. */
    boolean claimsFullOffline() {
        try {
            return "complete".equals(manifest().optString("offlineScope", "complete"));
        } catch (IOException | JSONException e) {
            return false;
        }
    }

    int externalResourceCount() {
        try {
            JSONArray external = manifest().optJSONArray("externalResources");
            return external == null ? 0 : external.length();
        } catch (IOException | JSONException e) {
            return 0;
        }
    }

    void reset() {
        delete(dir);
    }

    static String safe(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            out.append((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '.' || c == '_' || c == '-' ? c : '_');
        }
        String name = out.toString().toLowerCase(Locale.US);
        return name.isEmpty() || name.equals(".") || name.equals("..") ? "x" : name;
    }

    private static String readText(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int n;
            while ((n = in.read(buffer)) >= 0) out.write(buffer, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
