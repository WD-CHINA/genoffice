package com.genoffice.viewerdemo;

import android.media.MediaCodecList;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Verified local overlays. Original source resources and model bytes stay intact. */
final class PreparedMedia {
    static final String PREFIX = "prepared-media/";
    static String part(String value, String fileId, String origin) {
        try {
            URI uri = new URI(value);
            if (!uri.isAbsolute() && uri.getRawAuthority() != null) return null;
            if (uri.isAbsolute() && origin != null) {
                URI allowed = new URI(origin);
                if (!uri.getScheme().equalsIgnoreCase(allowed.getScheme())
                        || !uri.getAuthority().equalsIgnoreCase(allowed.getAuthority())) return null;
            } else if (uri.isAbsolute()) return null;
            String path = uri.getRawPath();
            String marker = "/v1/files/" + fileId + "/parts/";
            String basePath = origin == null ? "" : new URI(origin).getPath();
            if (!path.startsWith(marker) && !path.startsWith(basePath + marker)) return null;
            String raw = path.startsWith(marker) ? path.substring(marker.length())
                    : path.substring(basePath.length() + marker.length());
            String decoded = URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8");
            if (!decoded.startsWith("ppt/media/") || decoded.contains("..") || decoded.contains("\\")
                    || decoded.length() > 1024) return null;
            for (int i = 0; i < decoded.length(); i++) if (decoded.charAt(i) < 32) return null;
            return decoded;
        } catch (Exception invalid) { return null; }
    }

    static Map<String, JSONObject> requests(BundleStore store, int count, String origin, JSONArray resources)
            throws IOException, JSONException {
        Map<String, JSONObject> result = new TreeMap<>();
        for (int index = 0; index < count; index++) {
            File file = store.layoutSlideFile(index);
            if (file.length() > 32 * 1024 * 1024) throw new IOException("页面模型过大");
            collect(new JSONObject(BundleStore.readText(file)), store.fileId(), origin, result);
        }
        // Include known audio/video in the authoritative inventory even when the current
        // renderer does not expose an object (for example a transition sound).
        Set<String> referenced = new HashSet<>();
        for (JSONObject request : result.values()) referenced.add(request.getString("part"));
        for (int index = 0; index < resources.length(); index++) {
            String path = resources.getJSONObject(index).getString("path");
            if (!path.startsWith("parts/ppt/media/")) continue;
            String part = path.substring("parts/".length());
            if (referenced.contains(part)) continue;
            String lower = part.toLowerCase(java.util.Locale.ROOT);
            String kind = lower.matches(".*\\.(mp4|m4v|mov|wmv|avi|asf|mpg|mpeg|mkv|webm|3gp|3g2|ts|mts|m2ts)$") ? "video"
                    : lower.matches(".*\\.(mp3|wav|wma|aac|m4a|flac|ogg|oga|opus|aif|aiff|au)$") ? "audio" : null;
            if (kind != null) result.put(part + "\n" + kind, new JSONObject().put("part", part).put("kind", kind));
        }
        if (result.size() > 10000) throw new IOException("媒体对象过多");
        return result;
    }
    private static void collect(Object value, String fileId, String origin, Map<String, JSONObject> result)
            throws JSONException, IOException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            String kind = object.optString("kind");
            if (("video".equals(kind) || "audio".equals(kind)) && object.has("url")) {
                String part = part(object.optString("url"), fileId, origin);
                if (part != null) result.put(part + "\n" + kind, new JSONObject().put("part", part).put("kind", kind));
                if (result.size() > 10000) throw new IOException("媒体对象过多");
            }
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) collect(object.get(keys.next()), fileId, origin, result);
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) collect(array.get(i), fileId, origin, result);
        }
    }
    static String version(String sourceKey, JSONArray mappings) throws Exception {
        StringBuilder identity = new StringBuilder("android-media-v1\n").append(sourceKey);
        for (int i = 0; i < mappings.length(); i++) {
            JSONObject item = mappings.getJSONObject(i);
            identity.append('\n').append(item.getString("part")).append('\n').append(item.getString("kind"))
                    .append('\n').append(item.getString("sha256")).append('\n').append(item.getString("profile"));
        }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        StringBuilder out = new StringBuilder();
        for (byte b : digest.digest(identity.toString().getBytes(StandardCharsets.UTF_8))) out.append(String.format(java.util.Locale.US, "%02x", b & 255));
        return out.toString();
    }
    static void validate(JSONObject manifest) throws JSONException, IOException {
        JSONArray mappings = manifest.optJSONArray("preparedMedia");
        if (mappings == null) return;
        if (mappings.length() > 10000 || !manifest.optString("sourceArtifactKey").matches("[a-f0-9]{64}"))
            throw new IOException("兼容媒体清单身份无效");
        Map<String, JSONObject> resources = new HashMap<>();
        JSONArray all = manifest.getJSONArray("resources");
        for (int i = 0; i < all.length(); i++) resources.put(all.getJSONObject(i).getString("path"), all.getJSONObject(i));
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < mappings.length(); i++) {
            JSONObject item = mappings.getJSONObject(i);
            String kind = item.getString("kind"), part = item.getString("part"), path = item.getString("path");
            JSONObject source = resources.get("parts/" + part), target = resources.get(path);
            String suffix = "video".equals(kind) ? ".mp4" : ".mp3";
            if ((!"video".equals(kind) && !"audio".equals(kind)) || !seen.add(part + "\n" + kind)
                    || !path.equals(PREFIX + item.getString("sha256") + suffix)
                    || !item.getString("profile").matches("[a-f0-9]{64}")
                    || source == null || target == null
                    || !source.getString("sha256").equals(item.getString("sourceSha256"))
                    || !target.getString("sha256").equals(item.getString("sha256"))
                    || target.getLong("size") != item.getLong("size")) throw new IOException("兼容媒体完整性记录不匹配");
        }
        try {
            if (!manifest.getString("artifactKey").equals(version(manifest.getString("sourceArtifactKey"), mappings)))
                throw new IOException("兼容媒体版本不匹配");
        } catch (IOException failure) { throw failure; }
        catch (Exception failure) { throw new IOException("兼容媒体版本无效", failure); }
    }
    static void rewrite(Object value, BundleStore store) throws IOException, JSONException {
        Map<String, String> mapping = new HashMap<>();
        JSONArray all = store.manifest().optJSONArray("preparedMedia");
        if (all == null) return;
        for (int i = 0; i < all.length(); i++) {
            JSONObject item = all.getJSONObject(i);
            mapping.put(item.getString("part") + "\n" + item.getString("kind"),
                    "/v1/files/" + store.fileId() + "/prepared/" + item.getString("path").substring(PREFIX.length()));
        }
        rewrite(value, store.fileId(), mapping);
    }
    private static void rewrite(Object value, String fileId, Map<String, String> mapping) throws JSONException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            String part = part(object.optString("url"), fileId, null);
            String target = part == null ? null : mapping.get(part + "\n" + object.optString("kind"));
            if (target != null) object.put("url", target);
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) rewrite(object.get(keys.next()), fileId, mapping);
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) rewrite(array.get(i), fileId, mapping);
        }
    }
    static boolean decodable(File file, String kind) {
        if (!file.isFile() || file.length() == 0) return false;
        // WebView uses its own MP3 audio demux/decoder. Android's native extractor can
        // reject valid sub-100ms clips that Chromium plays, so only preflight video here.
        // Output integrity, MIME and full decoding were already verified by the server.
        if ("audio".equals(kind)) return true;
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(file.getAbsolutePath());
            MediaCodecList codecs = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
            boolean found = false;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.getString(MediaFormat.KEY_MIME);
                if (mime == null || !(mime.startsWith("video/") || mime.startsWith("audio/"))) continue;
                if ("audio".equals(kind) && !mime.startsWith("audio/")) continue;
                if (mime.startsWith(kind + "/")) found = true;
                if (codecs.findDecoderForFormat(format) == null) return false;
            }
            return found;
        } catch (Exception failure) { return false; }
        finally { extractor.release(); }
    }
}
