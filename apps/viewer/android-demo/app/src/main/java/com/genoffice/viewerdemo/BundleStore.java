package com.genoffice.viewerdemo;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

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

    BundleStore staging() {
        return new BundleStore(new File(dir.getPath() + ".download"), fileId, true);
    }

    void publishTo(BundleStore destination) throws IOException {
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
        return new File(new File(dir, "fonts"), safe(fontId) + ".sfnt");
    }

    boolean isComplete() {
        return new File(dir, "complete").isFile() && manifestFile().isFile();
    }

    void markComplete() throws IOException {
        File marker = new File(dir, "complete");
        if (!marker.createNewFile()) marker.setLastModified(System.currentTimeMillis());
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
        return name.isEmpty() ? "x" : name;
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
