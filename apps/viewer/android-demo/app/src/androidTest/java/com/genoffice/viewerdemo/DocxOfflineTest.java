package com.genoffice.viewerdemo;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** DOCX replay stays wholly local and sealed model bytes remain immutable. */
public class DocxOfflineTest extends AndroidTestSupport {
    private File root;
    @Override protected void setUp() throws Exception {
        root = temporaryRoot("word-offline-test");
    }
    @Override protected void tearDown() { delete(root); }
    private BundleStore fixture() throws Exception {
        BundleStore store = new BundleStore(root, "word-test");
        String picture = "http://artifact.invalid/v1/files/word-test/parts/word/media/image.png?exp=old&sig=old";
        write(store.resourceFile("document.json"), new JSONObject().put("model", new JSONObject().put("format", "docx")
                .put("unitKind", "block-chunk").put("unitCount", 2)).put("fonts", new JSONArray()).toString());
        write(store.resourceFile("styles.json"), "{\"styles\":[],\"numbering\":[]}");
        for (int index = 0; index < 2; index++) write(store.unitFile(index), new JSONObject().put("blocks", new JSONArray()
                .put(new JSONObject().put("type", "image").put("dataUrl", picture))).toString());
        write(store.partFile("word/media/image.png"), "own-media");
        store.seal(new JSONObject().put("fileId", "word-test").put("format", "docx").put("unitCount", 2)
                .put("offlineScope", "complete").put("fonts", new JSONArray()).put("sourceVerified", true));
        return store;
    }
    public void testLocalWordContextCursorImagesAndHashIntegrity() throws Exception {
        BundleStore store = fixture(); store.verifyIntegrity();
        byte[] original = Files.readAllBytes(store.unitFile(0).toPath());
        LocalAssetServer server = new LocalAssetServer(getInstrumentation().getTargetContext().getAssets(), store);
        int port = server.startAndWait();
        String base = "http://127.0.0.1:" + port;
        try {
            JSONObject opened = new JSONObject(request(base + "/v1/sessions", "POST", "{}", 200));
            assertEquals("docx", opened.getJSONObject("model").getString("format"));
            assertTrue(new JSONObject(request(base + "/v1/sessions/local/styles", "GET", null, 200)).has("styles"));
            JSONObject listing = new JSONObject(request(base + "/v1/sessions/local/units?limit=1", "GET", null, 200));
            assertEquals("0", listing.getJSONArray("items").getJSONObject(0).getString("id"));
            assertEquals("1", listing.getString("next"));
            JSONObject last = new JSONObject(request(base + "/v1/sessions/local/units?cursor=1&limit=1", "GET", null, 200));
            assertEquals("1", last.getJSONArray("items").getJSONObject(0).getString("id")); assertFalse(last.has("next"));
            request(base + "/v1/sessions/local/units?cursor=-1", "GET", null, 400);
            String unit = request(base + "/v1/sessions/local/units/0", "GET", null, 200);
            assertFalse(unit.contains("artifact.invalid")); assertFalse(unit.contains("sig="));
            assertTrue(unit.contains("word/media/image.png") || unit.contains("word\\/media\\/image.png"));
            HttpURLConnection media = (HttpURLConnection) new URL(base + "/v1/files/word-test/parts/word/media/image.png").openConnection();
            media.setRequestProperty("Range", "bytes=0-2");
            try { assertEquals(206, media.getResponseCode()); assertEquals(3, read(media.getInputStream()).length); }
            finally { media.disconnect(); }
            assertTrue(java.util.Arrays.equals(original, Files.readAllBytes(store.unitFile(0).toPath())));
            store.verifyIntegrity();
        } finally { server.shutdown(); server.join(2000); }
    }
    public void testChangedWordChunkAndMissingStylesAreRejected() throws Exception {
        BundleStore store = fixture();
        write(store.unitFile(0), "{\"blocks\":[]}");
        try { store.verifyIntegrity(); fail("changed Word chunk must fail verification"); } catch (IOException expected) { }
        store = fixture(); store.resourceFile("styles.json").delete();
        try { store.verifyIntegrity(); fail("Word styles are required"); } catch (IOException expected) { }
    }
}
