package com.genoffice.viewerdemo;

import android.test.InstrumentationTestCase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

public class PreparedMediaTest extends InstrumentationTestCase {
    private static String repeat(char c) { char[] chars = new char[64]; java.util.Arrays.fill(chars, c); return new String(chars); }
    public void testPartBoundary() {
        String prefix = "/v1/files/test/parts/";
        assertEquals("ppt/media/a+b.wmv", PreparedMedia.part(prefix + "ppt%2Fmedia%2Fa+b.wmv", "test", null));
        assertNull(PreparedMedia.part("https://evil.test" + prefix + "ppt/media/a.mp4", "test", "https://parse.test"));
        assertNull(PreparedMedia.part(prefix + "ppt/media/%2e%2e/a.mp4", "test", null));
        assertNull(PreparedMedia.part("//evil.test" + prefix + "ppt/media/a.mp4", "test", "https://parse.test"));
    }
    public void testInventoryIncludesUnreferencedTransitionAudio() throws Exception {
        File root = Files.createTempDirectory(getInstrumentation().getTargetContext().getCacheDir().toPath(), "inventory-test").toFile();
        try {
            BundleStore store = new BundleStore(root, "test");
            File model = store.layoutSlideFile(0); model.getParentFile().mkdirs();
            Files.write(model.toPath(), "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            JSONArray resources = new JSONArray().put(new JSONObject().put("path", "parts/ppt/media/transition.wav"))
                    .put(new JSONObject().put("path", "parts/ppt/media/picture.png"))
                    .put(new JSONObject().put("path", "parts/ppt/media/unknown.bin"));
            java.util.Map<String, JSONObject> requests = PreparedMedia.requests(store, 1, "https://parse.test", resources);
            assertEquals(1, requests.size());
            assertEquals("audio", requests.get("ppt/media/transition.wav\naudio").getString("kind"));
        } finally { delete(root); }
    }
    public void testVerifiedMappingAndIndependentAudioVideoRoles() throws Exception {
        String source = repeat('a'), sha = repeat('b'), profile = repeat('c');
        JSONArray mappings = new JSONArray();
        JSONArray resources = new JSONArray().put(new JSONObject().put("path", "parts/ppt/media/a.wmv").put("sha256", source).put("size", 3));
        for (String kind : new String[]{"audio", "video"}) {
            String path = PreparedMedia.PREFIX + sha + (kind.equals("video") ? ".mp4" : ".mp3");
            resources.put(new JSONObject().put("path", path).put("size", 4).put("sha256", sha));
            mappings.put(new JSONObject().put("part", "ppt/media/a.wmv").put("kind", kind).put("path", path)
                    .put("size", 4).put("sha256", sha).put("sourceSha256", source).put("profile", profile));
        }
        JSONObject manifest = new JSONObject().put("sourceArtifactKey", source).put("resources", resources)
                .put("preparedMedia", mappings).put("artifactKey", PreparedMedia.version(source, mappings));
        PreparedMedia.validate(manifest);
        File root = Files.createTempDirectory(getInstrumentation().getTargetContext().getCacheDir().toPath(), "mapping-test").toFile();
        try {
            BundleStore store = new BundleStore(root, "test");
            store.dir().mkdirs();
            Files.write(store.manifestFile().toPath(), manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            JSONObject model = new JSONObject("{\"refs\":[{\"kind\":\"video\",\"url\":\"/v1/files/test/parts/ppt/media/a.wmv\"},{\"kind\":\"audio\",\"url\":\"/v1/files/test/parts/ppt/media/a.wmv\"}]}");
            PreparedMedia.rewrite(model, store);
            assertTrue(model.getJSONArray("refs").getJSONObject(0).getString("url").endsWith(".mp4"));
            assertTrue(model.getJSONArray("refs").getJSONObject(1).getString("url").endsWith(".mp3"));
            mappings.getJSONObject(0).put("sourceSha256", sha);
            try { PreparedMedia.validate(manifest); fail("changed source must be rejected"); } catch (IOException expected) { }
            mappings.getJSONObject(0).put("sourceSha256", source).put("profile", repeat('d'));
            try { PreparedMedia.validate(manifest); fail("changed preparation profile must change the version"); } catch (IOException expected) { }
        } finally { delete(root); }
    }
    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }
}
