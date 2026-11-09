package com.genoffice.viewerdemo;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Versioned offline bundle cache.
 *
 * Layout (all under the app-private files directory):
 *
 *   bundle-cache/&lt;fileId&gt;/current.json              atomic fileId -> active generation pointer
 *   bundle-cache/&lt;fileId&gt;/versions/&lt;artifactKey&gt;/  immutable published bundle
 *   bundle-cache/&lt;fileId&gt;/staging/                  download in progress
 *   bundle-cache/&lt;fileId&gt;/resume/                   bounded partial transfers
 *   bundles/&lt;fileId&gt;/                               pre-versioning flat bundle (read-only fallback)
 *
 * The pointer is written only after a fully sealed bundle has been published into its
 * artifactKey directory. A failed update therefore keeps both the old pointer and the old
 * version. Reclamation never removes the active version, a version being published, or a
 * legacy flat bundle; it only drops inactive versions and leftover temporary state.
 */
final class BundleCache {
    static final long DEFAULT_MAX_BYTES = 2L * 1024 * 1024 * 1024;

    private final File root;
    private final File legacyRoot;
    private final long maxBytes;
    private volatile long lastEvictedBytes;

    BundleCache(File filesDir) { this(filesDir, DEFAULT_MAX_BYTES); }

    BundleCache(File filesDir, long maxBytes) {
        if (maxBytes <= 0) throw new IllegalArgumentException("invalid offline cache quota");
        this.root = new File(filesDir, "bundle-cache");
        this.legacyRoot = new File(filesDir, "bundles");
        this.maxBytes = maxBytes;
    }

    long maxBytes() { return maxBytes; }

    long lastEvictedBytes() { return lastEvictedBytes; }

    File root() { return root; }

    File container(String fileId) { return new File(root, BundleStore.safe(fileId)); }

    private File pointer(String fileId) { return new File(container(fileId), "current.json"); }

    BundleStore versionStore(String fileId, String artifactKey) {
        return BundleStore.at(new File(new File(container(fileId), "versions"), safeKey(artifactKey)), fileId);
    }

    BundleStore stagingStore(String fileId) {
        return BundleStore.at(new File(container(fileId), "staging"), fileId);
    }

    BundleResume resume(String fileId) {
        return BundleResume.at(new File(container(fileId), "resume"));
    }

    /** Pre-versioning flat bundle; still readable, never rewritten by the versioned path. */
    BundleStore legacy(String fileId) { return new BundleStore(legacyRoot.getParentFile(), fileId); }

    private static String safeKey(String artifactKey) {
        if (artifactKey == null || !artifactKey.matches("[a-f0-9]{64}"))
            throw new IllegalArgumentException("invalid artifactKey");
        return artifactKey;
    }

    /** Reject a single bundle that can never fit, instead of publishing it and deleting everything else. */
    void require(long incomingBytes) throws IOException {
        if (incomingBytes < 0 || incomingBytes > maxBytes)
            throw new IOException("离线包超过缓存配额，请调大配额或清理缓存");
    }

    /**
     * Resolve the active bundle. A present but invalid pointer is a hard failure: returning
     * an older version silently would mix generations behind the user's back.
     */
    BundleStore resolve(String fileId) {
        File file = pointer(fileId);
        if (file.isFile()) {
            JSONObject record = readCurrent(container(fileId));
            if (record == null) return BundleStore.at(new File(container(fileId), "invalid-current"), fileId);
            try {
                return versionStore(fileId, record.getString("artifactKey"));
            } catch (JSONException | IllegalArgumentException invalid) {
                return BundleStore.at(new File(container(fileId), "invalid-current"), fileId);
            }
        }
        return legacy(fileId);
    }

    /** Strictly validated active pointer, or null when absent or corrupt. */
    JSONObject current(String fileId) { return readCurrent(container(fileId)); }

    private JSONObject readCurrent(File container) {
        File file = new File(container, "current.json");
        if (!file.isFile() || isLink(file) || file.length() > 64 * 1024) return null;
        try {
            JSONObject record = new JSONObject(readText(file));
            String fileId = record.optString("fileId", "");
            String key = record.optString("artifactKey", "");
            String scope = record.optString("offlineScope", "complete");
            if (record.optInt("schema") != 1 || fileId.isEmpty()
                    || !BundleStore.safe(fileId).equals(container.getName())
                    || !key.matches("[a-f0-9]{64}")
                    || (!"complete".equals(scope) && !"partial".equals(scope))
                    || record.optInt("externalCount") < 0
                    || ("partial".equals(scope) != (record.optInt("externalCount") > 0)))
                return null;
            return record;
        } catch (IOException | JSONException invalid) {
            return null;
        }
    }

    /** Commit the pointer after publishTo() has placed a sealed bundle at its version path. */
    JSONObject commit(String fileId, BundleStore published, JSONObject manifest)
            throws IOException, JSONException {
        String artifactKey = manifest.optString("artifactKey", "");
        BundleStore expected = versionStore(fileId, artifactKey);
        if (!expected.dir().getAbsolutePath().equals(published.dir().getAbsolutePath()))
            throw new IOException("published bundle is not at its artifactKey directory");
        // publishTo() already verified every resource hash. Recheck the seal and the stored
        // manifest here without hashing large media a second time.
        if (!fileId.equals(manifest.optString("fileId"))
                || !new File(published.dir(), "complete").isFile())
            throw new IOException("cannot point at an incomplete offline bundle");
        String scope = manifest.optString("offlineScope", "complete");
        int externalCount = manifest.optJSONArray("externalResources") == null
                ? 0 : manifest.getJSONArray("externalResources").length();
        JSONObject stored = published.manifest();
        if (!artifactKey.equals(stored.optString("artifactKey"))
                || !scope.equals(stored.optString("offlineScope", "complete"))
                || !fileId.equals(stored.optString("fileId"))
                || stored.optJSONArray("resources") == null
                || !manifest.getJSONArray("resources").toString().equals(stored.getJSONArray("resources").toString()))
            throw new IOException("offline cache pointer does not match the published manifest");
        if ((!"complete".equals(scope) && !"partial".equals(scope))
                || ("partial".equals(scope) != (externalCount > 0)))
            throw new IOException("offline scope does not match external resources");
        long size = treeBytes(published.dir());
        JSONObject record = new JSONObject()
                .put("schema", 1)
                .put("fileId", fileId)
                .put("artifactKey", artifactKey)
                .put("offlineScope", scope)
                .put("externalCount", externalCount)
                .put("sizeBytes", size)
                .put("publishedAt", System.currentTimeMillis());
        File container = container(fileId);
        if (!container.isDirectory() && !container.mkdirs() && !container.isDirectory())
            throw new IOException("cannot create offline cache directory");
        File target = pointer(fileId);
        File temp = new File(container, "current.json.tmp");
        writeSynced(temp, record.toString().getBytes(StandardCharsets.UTF_8));
        if (!temp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw new IOException("cannot publish offline cache pointer");
        }
        return record;
    }

    /** All bytes owned by this cache, including inactive versions, staging and partial transfers. */
    long usedBytes() { return treeBytes(root) + treeBytes(legacyRoot); }

    int versionCount() {
        int total = 0;
        File[] containers = root.listFiles();
        if (containers == null) return 0;
        for (File container : containers) {
            File versions = new File(container, "versions");
            File[] entries = versions.listFiles();
            if (entries == null) continue;
            for (File entry : entries) if (entry.isDirectory() && !isLink(entry)) total++;
        }
        return total;
    }

    /** Trim inactive versions/temp state until the cache fits. The active version is never removed. */
    long trim(String protectedFileId, String protectedArtifactKey) {
        return reclaim(false, protectedFileId, protectedArtifactKey);
    }

    /** Manual cleanup entry: drop everything except the active bundle and legacy flat bundle. */
    long clearInactive(String protectedFileId, String protectedArtifactKey) {
        return reclaim(true, protectedFileId, protectedArtifactKey);
    }

    private long reclaim(boolean clearAll, String protectedFileId, String protectedArtifactKey) {
        Set<String> protectedPaths = protectedPaths(protectedFileId, protectedArtifactKey);
        List<File> candidates = new ArrayList<>();
        File[] containers = root.listFiles();
        if (containers != null) for (File container : containers) {
            if (!container.isDirectory() || isLink(container)) continue;
            File versions = new File(container, "versions");
            File[] entries = versions.listFiles();
            if (entries != null) for (File entry : entries) {
                if (entry.isDirectory() && !isLink(entry) && !protectedPaths.contains(entry.getAbsolutePath()))
                    candidates.add(entry);
            }
            addTemp(candidates, container, clearAll, protectedPaths);
        }
        File[] legacy = legacyRoot.listFiles();
        if (legacy != null) for (File entry : legacy) {
            String name = entry.getName();
            if (name.endsWith(".previous") || name.endsWith(".download") || name.endsWith(".resume"))
                candidates.add(entry);
        }
        candidates.sort(Comparator.comparingLong(File::lastModified));
        long freed = 0;
        for (File candidate : candidates) {
            if (!clearAll && usedBytes() <= maxBytes) break;
            long bytes = treeBytes(candidate);
            deleteTree(candidate);
            if (!candidate.exists()) freed += bytes;
        }
        lastEvictedBytes = freed;
        return freed;
    }

    private void addTemp(List<File> candidates, File container, boolean clearAll, Set<String> protectedPaths) {
        File[] entries = container.listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            String name = entry.getName();
            if (name.equals("current.json") || name.equals("current.json.tmp") || name.equals("versions")) continue;
            if (protectedPaths.contains(entry.getAbsolutePath())) continue;
            boolean temporary = name.equals("staging") || name.equals("staging.previous")
                    || name.equals("resume") || name.endsWith(".download") || name.endsWith(".previous")
                    || name.endsWith(".resume");
            if ((clearAll || temporary) && !candidates.contains(entry)) candidates.add(entry);
        }
    }

    private Set<String> protectedPaths(String protectedFileId, String protectedArtifactKey) {
        Set<String> paths = new HashSet<>();
        if (protectedFileId != null && protectedArtifactKey != null) {
            try { paths.add(versionStore(protectedFileId, protectedArtifactKey).dir().getAbsolutePath()); }
            catch (IllegalArgumentException ignored) { /* nothing to protect */ }
        }
        File[] containers = root.listFiles();
        if (containers != null) for (File container : containers) {
            if (!container.isDirectory() || isLink(container)) continue;
            JSONObject record = readCurrent(container);
            if (record == null) continue;
            try {
                String fileId = record.getString("fileId");
                paths.add(versionStore(fileId, record.getString("artifactKey")).dir().getAbsolutePath());
            } catch (JSONException ignored) { /* invalid pointers are never trusted */ }
        }
        // Legacy flat bundles are the user's existing offline data, not reclaimable here.
        File[] legacy = legacyRoot.listFiles();
        if (legacy != null) for (File entry : legacy) {
            String name = entry.getName();
            if (!name.endsWith(".previous") && !name.endsWith(".download") && !name.endsWith(".resume"))
                paths.add(entry.getAbsolutePath());
        }
        return paths;
    }

    private static boolean isLink(File file) {
        try { return Files.isSymbolicLink(file.toPath()); }
        catch (RuntimeException unsupported) { return false; }
    }

    private static long treeBytes(File file) {
        if (isLink(file)) return 0;
        if (file.isFile()) return file.length();
        File[] children = file.listFiles();
        if (children == null) return 0;
        long total = 0;
        for (File child : children) total += treeBytes(child);
        return total;
    }

    private static void deleteTree(File file) {
        if (isLink(file)) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return;
        }
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static void writeSynced(File file, byte[] bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
            output.getFD().sync();
        }
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
}
