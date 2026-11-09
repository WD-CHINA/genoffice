package com.genoffice.viewerdemo;

import android.test.InstrumentationTestCase;
import android.util.Log;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Exercises real Android IO in a private test cache, without changing saved bundles. */
public class BundleDownloaderTest extends InstrumentationTestCase {
    private File root;
    @Override protected void setUp() throws Exception {
        root = new File(getInstrumentation().getTargetContext().getCacheDir(), "bundle-download-test");
        root.mkdirs();
    }
    @Override protected void tearDown() { delete(root); }
    private static void delete(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File child : children) delete(child);
        f.delete();
    }
    public void testOneGiBAndFailedReplacement() throws Exception {
        long bytes = 1024L * 1024 * 1024;
        assertTrue("Need 2 GiB free", root.getUsableSpace() > 2 * bytes);
        try (Fixture server = new Fixture(bytes)) {
            BundleStore store = new BundleStore(root, "test-file");
            long before = usedHeap();
            new BundleDownloader(server.url(), "", "test-file", store, text -> {}).run();
            assertTrue(store.isComplete());
            File media = store.partFile("ppt/media/video.mp4");
            assertEquals(bytes, media.length());
            try (RandomAccessFile file = new RandomAccessFile(media, "r")) {
                assertEquals(90, file.read()); file.seek(bytes - 1); assertEquals(90, file.read());
            }
            assertTrue("session closed", server.deleted);
            Log.i("BundleDownloaderTest", "bytes=" + bytes + " heapBefore=" + before
                + " heapAfter=" + usedHeap() + " maxHeap=" + Runtime.getRuntime().maxMemory());
            server.failPart = true;
            server.deleted = false;
            try {
                new BundleDownloader(server.url(), "", "test-file", store, text -> {}).run();
                fail("must reject truncated media");
            } catch (IOException expected) {
                assertTrue(store.isComplete());
                assertEquals(bytes, media.length());
                assertTrue("failed session closed", server.deleted);
            }
            server.fail = true;
            try {
                new BundleDownloader(server.url(), "", "test-file", store, text -> {}).run();
                fail("must reject HTTP failure");
            } catch (IOException expected) {
                assertTrue("old bundle preserved", store.isComplete());
                assertEquals(bytes, media.length());
            }
        }
    }
    public void testAsyncReadinessBeforeDownloading() throws Exception {
        try (Fixture server = new Fixture(1024)) {
            server.async = true;
            BundleStore store = new BundleStore(root, "test-file");
            java.util.List<String> stages = new java.util.ArrayList<>();
            new BundleDownloader(server.url(), "", "test-file", store, stages::add).run();
            assertTrue(store.isComplete());
            assertEquals(2, server.polls);
            assertEquals(0, server.v1Posts);
            assertEquals("/v2/sessions/test", server.deletedApi);
            assertTrue(stages.contains("正在排队等待解析…"));
            assertTrue(stages.contains("正在解析文档…"));
        }
    }
    public void testFallbackDoesNotBypassQueueAdmission() throws Exception {
        try (Fixture server = new Fixture(1024)) {
            server.rejectV2 = true;
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(server.url(), "", "test-file", store, text -> {}).run();
            assertTrue(store.isComplete());
            assertEquals(1, server.v1Posts);
            assertEquals("/v1/sessions/test", server.deletedApi);
            server.rejectV2 = false;
            server.queueFull = true;
            try {
                new BundleDownloader(server.url(), "", "test-file", store, text -> {}).run();
                fail("must preserve queue rejection");
            } catch (IOException expected) {
                assertTrue(store.isComplete());
                assertEquals(1, server.v1Posts);
            }
        }
    }
    public void testFailedAsyncJobPreservesPreviousBundle() throws Exception {
        try (Fixture server = new Fixture(1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(server.url(), "", "test-file", store, text -> {}).run();
            int before = server.layoutRequests;
            server.async = true;
            server.failAsync = true;
            server.deleted = false;
            try {
                new BundleDownloader(server.url(), "", "test-file", store, text -> {}).run();
                fail("must reject failed parse");
            } catch (IOException expected) {
                assertTrue(store.isComplete());
                assertTrue(server.deleted);
                assertEquals(before, server.layoutRequests);
                assertEquals(1024, store.partFile("ppt/media/video.mp4").length());
            }
        }
    }
    public void testIntegrityRejectsSameSizeCorruptionAndMissingModel() throws Exception {
        try (Fixture fixture = new Fixture(4096)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            store.verifyIntegrity();
            assertEquals(1, store.manifest().getInt("bundleSchemaVersion"));
            assertTrue(store.manifest().getJSONArray("resources").length() >= 3);
            File media = store.partFile("ppt/media/video.mp4");
            try (RandomAccessFile file = new RandomAccessFile(media, "rw")) { file.write(0); }
            try { store.verifyIntegrity(); fail("same-length corruption must fail SHA-256"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("checksum")); }
            try (RandomAccessFile file = new RandomAccessFile(media, "rw")) { file.write(90); }
            store.verifyIntegrity();
            assertTrue(store.layoutSlideFile(0).delete());
            assertFalse(store.isComplete());
            try { store.verifyIntegrity(); fail("missing slide must fail"); }
            catch (IOException expected) { }
        }
    }

    public void testManifestSealAndVersionAreRequired() throws Exception {
        try (Fixture fixture = new Fixture(1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            org.json.JSONObject manifest = store.manifest();
            manifest.put("unitCount", 2);
            try (FileOutputStream output = new FileOutputStream(store.manifestFile())) {
                output.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
            }
            assertFalse(store.isComplete());
            manifest.put("unitCount", 1);
            manifest.put("bundleSchemaVersion", 99);
            try (FileOutputStream output = new FileOutputStream(store.manifestFile())) {
                output.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
            }
            try { store.markComplete(); fail("unsupported schema must fail"); }
            catch (IOException expected) { }
        }
    }

    public void testPreviousBundleIsRecoveredAfterInterruptedPublish() throws Exception {
        try (Fixture fixture = new Fixture(1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            File backup = new File(store.dir().getPath() + ".previous");
            assertTrue(store.dir().renameTo(backup));
            BundleStore restarted = new BundleStore(root, "test-file");
            restarted.verifyIntegrity();
            assertTrue(restarted.isComplete());
            assertFalse(backup.exists());
        }
    }

    public void testIncompleteBundleCannotCreateReplaySession() throws Exception {
        try (Fixture fixture = new Fixture(1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            assertTrue(new File(store.dir(), "complete").delete());
            LocalAssetServer replay = new LocalAssetServer(getInstrumentation().getTargetContext().getAssets(), store);
            try {
                int port = replay.startAndWait();
                HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/v1/sessions").openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write("{\"fileId\":\"test-file\"}".getBytes(StandardCharsets.UTF_8));
                }
                try { assertEquals(404, connection.getResponseCode()); }
                finally { connection.disconnect(); }
            } finally { replay.shutdown(); replay.join(2000); }
        }
    }

    public void testManifestCannotSealEscapingResourcePath() throws Exception {
        assertEquals("x", BundleStore.safe(".."));
        assertEquals("x", BundleStore.safe("."));
        try (Fixture fixture = new Fixture(1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            org.json.JSONObject manifest = store.manifest();
            manifest.getJSONArray("resources").getJSONObject(0).put("path", "../outside.bin");
            try (FileOutputStream output = new FileOutputStream(store.manifestFile())) {
                output.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
            }
            try { store.markComplete(); fail("resource traversal must fail"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("path")); }
        }
    }

    public void testCancellationWhileQueuedClosesWaiterAndPreservesOldBundle() throws Exception {
        try (Fixture fixture = new Fixture(1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            fixture.async = true;
            fixture.deleted = false;
            final BundleDownloader[] holder = new BundleDownloader[1];
            holder[0] = new BundleDownloader(fixture.url(), "", "test-file", store, text -> {
                if (text.equals("正在排队等待解析…")) holder[0].cancel();
            });
            try { holder[0].run(); fail("queued download must cancel"); }
            catch (IOException expected) { assertTrue(holder[0].isCancelled()); }
            finally { Thread.interrupted(); }
            assertTrue(fixture.deleted);
            assertEquals("/v2/sessions/test", fixture.deletedApi);
            assertEquals(0, fixture.polls);
            assertFalse(store.staging().dir().exists());
            store.verifyIntegrity();
        }
    }

    public void testCancellationDisconnectsActiveMediaAndPreservesOldBundle() throws Exception {
        try (Fixture fixture = new Fixture(16 * 1024 * 1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            fixture.slowPart = true;
            fixture.deleted = false;
            BundleDownloader download = new BundleDownloader(fixture.url(), "", "test-file", store, text -> {});
            java.util.concurrent.atomic.AtomicReference<Exception> failure = new java.util.concurrent.atomic.AtomicReference<>();
            Thread worker = new Thread(() -> {
                try { download.run(); } catch (Exception error) { failure.set(error); }
            });
            worker.start();
            assertTrue(fixture.partStarted.await(5, java.util.concurrent.TimeUnit.SECONDS));
            download.cancel();
            worker.join(5000);
            assertFalse("cancel must not wait for the 120-second read timeout", worker.isAlive());
            assertNotNull(failure.get());
            assertTrue(download.isCancelled());
            assertTrue(fixture.deleted);
            assertFalse(store.staging().dir().exists());
            store.verifyIntegrity();
        }
    }

    public void testCancellationBeforeSealingDoesNotReplaceThePreviousManifest() throws Exception {
        try (Fixture fixture = new Fixture(1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            String previous = store.manifest().toString();
            final BundleDownloader[] holder = new BundleDownloader[1];
            holder[0] = new BundleDownloader(fixture.url(), "", "test-file", store, text -> {
                if (text.equals("正在校验离线资源…")) holder[0].cancel();
            });
            try { holder[0].run(); fail("cancel before sealing must stop publication"); }
            catch (IOException expected) { assertTrue(holder[0].isCancelled()); }
            finally { Thread.interrupted(); }
            assertEquals(previous, store.manifest().toString());
            store.verifyIntegrity();
            assertFalse(store.staging().dir().exists());
        }
    }

    public void testCancelButtonStopsQueuedDownload() throws Exception {
        android.content.Context context = getInstrumentation().getTargetContext();
        android.content.SharedPreferences preferences = context.getSharedPreferences("viewer-demo", 0);
        String oldServer = preferences.getString("server", null);
        String oldFile = preferences.getString("fileId", null);
        String oldToken = preferences.getString("token", null);
        String fileId = "instrumentation-cancel-" + java.util.UUID.randomUUID();
        try (Fixture fixture = new Fixture(1024)) {
            fixture.async = true;
            fixture.alwaysQueued = true;
            android.content.Intent intent = new android.content.Intent(context, MainActivity.class)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra("server", fixture.url()).putExtra("fileId", fileId).putExtra("download", true);
            MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(intent);
            try {
                assertTrue(fixture.waitingStarted.await(5, java.util.concurrent.TimeUnit.SECONDS));
                awaitText(activity, "正在排队等待解析…");
                getInstrumentation().runOnMainSync(() -> {
                    android.widget.Button button = (android.widget.Button) findText(activity.findViewById(android.R.id.content), "取消下载");
                    assertNotNull(button);
                    assertTrue(button.isEnabled());
                    button.performClick();
                });
                assertTrue(fixture.sessionDeleted.await(5, java.util.concurrent.TimeUnit.SECONDS));
                awaitText(activity, "下载已取消");
                assertFalse(new BundleStore(context.getFilesDir(), fileId).staging().dir().exists());
            } finally {
                getInstrumentation().runOnMainSync(activity::finish);
                getInstrumentation().waitForIdleSync();
                new BundleStore(context.getFilesDir(), fileId).reset();
            }
        } finally {
            preferences.edit().putString("server", oldServer).putString("fileId", oldFile).putString("token", oldToken).commit();
        }
    }

    private void awaitText(MainActivity activity, String text) {
        java.util.concurrent.atomic.AtomicBoolean found = new java.util.concurrent.atomic.AtomicBoolean();
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (!found.get() && android.os.SystemClock.uptimeMillis() < deadline) {
            getInstrumentation().runOnMainSync(() -> found.set(findText(activity.findViewById(android.R.id.content), text) != null));
            android.os.SystemClock.sleep(10);
        }
        assertTrue("UI must show: " + text, found.get());
    }

    private static android.view.View findText(android.view.View view, String text) {
        if (view instanceof android.widget.TextView && text.contentEquals(((android.widget.TextView) view).getText())) return view;
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                android.view.View found = findText(group.getChildAt(index), text);
                if (found != null) return found;
            }
        }
        return null;
    }

    public void testKnownMediaSizeIsRejectedBeforeWritingWhenSpaceIsInsufficient() throws Exception {
        try (Fixture fixture = new Fixture(256 * 1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            String previous = store.manifest().toString();
            fixture.deleted = false;
            BundleDownloader download = new BundleDownloader(fixture.url(), "", "test-file", store,
                    text -> {}, directory -> BundleSpace.HEADROOM_BYTES + 128 * 1024);
            try { download.run(); fail("declared media size must fit free space before writing"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("存储空间不足")); }
            assertTrue(fixture.deleted);
            assertFalse(store.staging().dir().exists());
            assertEquals(previous, store.manifest().toString());
            store.verifyIntegrity();
        }
    }

    public void testUnknownLengthMediaRechecksSpaceAfterPartialWriteAndPreservesOldBundle() throws Exception {
        try (Fixture fixture = new Fixture(2 * 1024 * 1024)) {
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            String previous = store.manifest().toString();
            fixture.unknownPartLength = true;
            fixture.deleted = false;
            File partial = new File(store.staging().partFile("ppt/media/video.mp4").getPath() + ".tmp");
            java.util.concurrent.atomic.AtomicLong observed = new java.util.concurrent.atomic.AtomicLong();
            BundleDownloader download = new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}, directory -> {
                if (partial.length() > 0) { observed.set(partial.length()); return 0; }
                return root.getUsableSpace();
            });
            try { download.run(); fail("unknown-length transfer must recheck free space"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("存储空间不足")); }
            assertTrue("failure must occur after a real partial write", observed.get() > 0);
            assertTrue(fixture.deleted);
            assertFalse(store.staging().dir().exists());
            assertEquals(previous, store.manifest().toString());
            store.verifyIntegrity();
        }
    }

    public void testDeclaredBundleDownloadsUnusedResourcesAndVerifiesSourceHashes() throws Exception {
        try (Fixture fixture = new Fixture(4096)) {
            fixture.declaredBundle = true;
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            store.verifyIntegrity();
            assertTrue(store.manifest().getBoolean("sourceVerified"));
            assertEquals(2, store.manifest().getInt("modelSchemaVersion"));
            assertEquals(0, fixture.layoutRequests);
            assertEquals(3, fixture.bundleResourceRequests);
            assertEquals(4096, store.partFile("ppt/media/video.mp4").length());
        }
    }

    public void testDeclaredHashMismatchAndQueueErrorCannotFallBackOrReplaceOldCache() throws Exception {
        try (Fixture fixture = new Fixture(4096)) {
            fixture.declaredBundle = true;
            BundleStore store = new BundleStore(root, "test-file");
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            String previous = store.manifest().toString();
            fixture.corruptBundleBytes = true;
            fixture.deleted = false;
            try { new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run(); fail("source hash must match"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("SHA-256")); }
            assertTrue(fixture.deleted);
            assertEquals(previous, store.manifest().toString());
            store.verifyIntegrity();
            fixture.corruptBundleBytes = false;
            fixture.bundleStatus = 429;
            try { new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run(); fail("manifest rejection must not fall back"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("429")); }
            assertEquals(0, fixture.layoutRequests);
            assertEquals(previous, store.manifest().toString());
            assertFalse(store.staging().dir().exists());
        }
    }

    public void testDeclaredWholeBundleSpaceCheckPrecedesResourceDownloads() throws Exception {
        try (Fixture fixture = new Fixture(4096)) {
            fixture.declaredBundle = true;
            BundleStore store = new BundleStore(root, "test-file");
            try {
                new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}, directory -> BundleSpace.HEADROOM_BYTES + 4096).run();
                fail("whole bundle preflight must include metadata and all resources");
            } catch (IOException expected) { assertTrue(expected.getMessage().contains("存储空间不足")); }
            assertEquals(0, fixture.bundleResourceRequests);
            assertTrue(fixture.deleted);
            assertFalse(store.isComplete());
            assertFalse(store.staging().dir().exists());
        }
    }

    public void testDeclaredUnsupportedVersionAndExternalMediaAreNotMarkedOfflineReady() throws Exception {
        try (Fixture fixture = new Fixture(1024)) {
            fixture.declaredBundle = true;
            fixture.bundleVersion = 99;
            BundleStore store = new BundleStore(root, "test-file");
            try { new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run(); fail("unsupported schema must fail"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("版本")); }
            fixture.bundleVersion = 1;
            fixture.externalBundleMedia = true;
            try { new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run(); fail("external media cannot promise full offline"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("外部媒体")); }
            assertEquals(0, fixture.bundleResourceRequests);
            assertEquals(0, fixture.layoutRequests);
            assertFalse(store.isComplete());
        }
    }

    // ── resumable downloads ─────────────────────────────────────────────────

    private static final String DECLARED_MEDIA = "parts/ppt/media/video.mp4";

    /** Interrupt the first transfer and leave its bytes in the bounded resume store. */
    private void seedPartial(Fixture fixture, BundleStore store, int abortAfter) throws Exception {
        fixture.abortAfterBytes = abortAfter;
        try {
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            fail("truncated transfer must fail");
        } catch (IOException expected) { /* partial bytes survive in .resume */ }
        fixture.abortAfterBytes = 0;
        assertFalse(store.staging().dir().exists());
    }

    public void testResumeContinuesAfterTruncatedTransferWithStrictRangeValidation() throws Exception {
        try (Fixture fixture = new Fixture(64 * 1024)) {
            fixture.declaredBundle = true;
            BundleStore store = new BundleStore(root, "test-file");
            seedPartial(fixture, store, 16 * 1024);
            BundleResume resume = new BundleResume(store.dir());
            long offset = resume.part(BundleResume.key(DECLARED_MEDIA)).length();
            assertEquals(16 * 1024, offset);
            byte[] expected = new byte[64 * 1024];
            Arrays.fill(expected, (byte) 90);
            int fullBefore = fixture.fullRequests;
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            assertTrue(store.isComplete());
            store.verifyIntegrity();
            assertEquals(64 * 1024, store.partFile("ppt/media/video.mp4").length());
            assertEquals(1, fixture.rangeRequests);
            assertEquals("bytes=" + offset + "-", fixture.lastRange);
            assertEquals("\"" + BundleResume.sha256Hex(expected) + "\"", fixture.lastIfRange);
            assertTrue("other resources are re-fetched", fixture.fullRequests > fullBefore);
            assertFalse("published bundle clears resume state", resume.dir().exists());
        }
    }

    public void testResumeRestartsFromZeroWhenServerIgnoresRange() throws Exception {
        try (Fixture fixture = new Fixture(64 * 1024)) {
            fixture.declaredBundle = true;
            BundleStore store = new BundleStore(root, "test-file");
            seedPartial(fixture, store, 16 * 1024);
            fixture.ignoreRange = true;
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            assertTrue(store.isComplete());
            store.verifyIntegrity();
            assertEquals(1, fixture.rangeRequests);
            assertEquals(64 * 1024, store.partFile("ppt/media/video.mp4").length());
            assertFalse(new BundleResume(store.dir()).dir().exists());
        }
    }

    public void testResumeRejectsMismatchedETagOrContentRange() throws Exception {
        try (Fixture fixture = new Fixture(64 * 1024)) {
            fixture.declaredBundle = true;
            BundleStore store = new BundleStore(root, "test-file");
            BundleResume resume = new BundleResume(store.dir());
            seedPartial(fixture, store, 16 * 1024);
            fixture.wrongEtag = true;
            try {
                new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
                fail("mismatched ETag must not splice an older generation");
            } catch (IOException expected) { assertTrue(expected.getMessage().contains("ETag")); }
            assertFalse(store.isComplete());
            assertEquals(0, resume.usedBytes());

            fixture.wrongEtag = false;
            seedPartial(fixture, store, 16 * 1024);
            fixture.wrongContentRange = true;
            try {
                new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
                fail("mismatched Content-Range must not splice an older generation");
            } catch (IOException expected) { assertTrue(expected.getMessage().contains("范围")); }
            assertEquals(0, resume.usedBytes());
        }
    }

    public void testResumeDiscardsPartialWhenBundleIdentityChanges() throws Exception {
        try (Fixture fixture = new Fixture(64 * 1024)) {
            fixture.declaredBundle = true;
            BundleStore store = new BundleStore(root, "test-file");
            seedPartial(fixture, store, 16 * 1024);
            BundleResume resume = new BundleResume(store.dir());
            File meta = resume.meta(BundleResume.key(DECLARED_MEDIA));
            org.json.JSONObject record = new org.json.JSONObject(readText(meta));
            record.put("artifactKey", "stale-generation");
            try (FileOutputStream out = new FileOutputStream(meta)) {
                out.write(record.toString().getBytes(StandardCharsets.UTF_8));
            }
            int rangesBefore = fixture.rangeRequests;
            new BundleDownloader(fixture.url(), "", "test-file", store, text -> {}).run();
            assertTrue(store.isComplete());
            assertEquals("stale bytes must not be resumed", rangesBefore, fixture.rangeRequests);
            assertEquals(64 * 1024, store.partFile("ppt/media/video.mp4").length());
            assertFalse(resume.dir().exists());
        }
    }

    public void testResumeBudgetTrimsOldestPartial() throws Exception {
        File bundle = new File(root, "resume-budget-bundle");
        BundleResume resume = new BundleResume(bundle, 1024);
        byte[] data = new byte[600];
        Arrays.fill(data, (byte) 7);
        String[] paths = {"parts/a.bin", "parts/b.bin", "parts/c.bin"};
        for (int index = 0; index < paths.length; index++) {
            File part = resume.part(BundleResume.key(paths[index]));
            assertTrue(part.getParentFile().isDirectory() || part.getParentFile().mkdirs());
            try (FileOutputStream out = new FileOutputStream(part)) { out.write(data); }
            assertTrue(part.setLastModified(1000L * (index + 1)));
            resume.record(paths[index], data.length, BundleResume.sha256Hex(data), "artifact");
        }
        assertEquals(600, resume.usedBytes());
        assertFalse(resume.part(BundleResume.key(paths[0])).exists());
        assertFalse(resume.part(BundleResume.key(paths[1])).exists());
        assertTrue(resume.part(BundleResume.key(paths[2])).exists());
        assertNotNull(resume.acquire(paths[2], 600, BundleResume.sha256Hex(data), "artifact"));
        assertNull(resume.acquire(paths[0], 600, BundleResume.sha256Hex(data), "artifact"));
        assertNull("identity mismatch is never reused",
                resume.acquire(paths[2], 600, BundleResume.sha256Hex(data), "another-generation"));
        resume.clear();
        assertFalse(resume.dir().exists());
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

    private static long usedHeap() {
        return Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory();
    }
    private static final class Fixture implements AutoCloseable {
        final ServerSocket socket;
        final Thread thread;
        final long bytes;
        volatile boolean deleted, fail, failPart, async, rejectV2, queueFull, failAsync, slowPart, alwaysQueued, unknownPartLength;
        final java.util.concurrent.CountDownLatch waitingStarted = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch sessionDeleted = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch partStarted = new java.util.concurrent.CountDownLatch(1);
        volatile boolean declaredBundle, corruptBundleBytes, externalBundleMedia;
        volatile boolean ignoreRange, wrongEtag, wrongContentRange;
        volatile int abortAfterBytes, rangeRequests, fullRequests;
        volatile String lastRange, lastIfRange;
        volatile int bundleStatus = 200, bundleVersion = 1;
        volatile int polls, v1Posts, layoutRequests, bundleResourceRequests;
        volatile String deletedApi;
        static final String WRONG_ETAG = "\"0000000000000000000000000000000000000000000000000000000000000000\"";
        Fixture(long bytes) throws IOException {
            this.bytes = bytes;
            socket = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
            thread = new Thread(() -> {
                while (!socket.isClosed()) {
                    try (Socket client = socket.accept()) { serve(client); }
                    catch (IOException ignored) { }
                }
            });
            thread.start();
        }
        String url() { return "http://127.0.0.1:" + socket.getLocalPort(); }
        void serve(Socket client) throws IOException {
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            String first = reader.readLine(); if (first == null) return;
            String[] request = first.split(" ");
            int length = 0; String line;
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                String lower = line.toLowerCase(java.util.Locale.US);
                if (lower.startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                int colon = line.indexOf(':');
                if (colon > 0) headers.put(lower.substring(0, colon), line.substring(colon + 1).trim());
            }
            while (length-- > 0) reader.read();
            OutputStream out = new BufferedOutputStream(client.getOutputStream());
            String path = request[1];
            if (fail) { json(out, 500, "failed"); return; }
            if (request[0].equals("DELETE")) { deleted = true; deletedApi = path; json(out, 200, "{}"); sessionDeleted.countDown(); }
            else if (path.equals("/v2/sessions") && rejectV2) { json(out, 404, "{}"); }
            else if (path.equals("/v2/sessions") && queueFull) { json(out, 429, "{}"); }
            else if (path.equals("/v2/sessions") && async) { waitingStarted.countDown(); json(out, 202, "{\"sessionId\":\"test\",\"state\":\"queued\",\"pollAfterMs\":1}"); }
            else if (path.equals("/v2/sessions/test") && async) {
                polls++;
                String state = alwaysQueued ? "queued" : polls == 1 ? "building" : failAsync ? "failed" : "ready";
                json(out, 200, "{\"sessionId\":\"test\",\"state\":\"" + state + "\",\"pollAfterMs\":1,\"fonts\":[],\"error\":{\"message\":\"parse failed\"}}");
            }
            else if (path.endsWith("/bundle")) {
                if (!declaredBundle) json(out, 404, "{}");
                else if (bundleStatus != 200) json(out, bundleStatus, "{}");
                else json(out, 200, declaredManifest());
            }
            else if (path.contains("/bundle/resources/")) {
                bundleResourceRequests++;
                String relative = URLDecoder.decode(path.substring(path.indexOf("/bundle/resources/") + 18), "UTF-8");
                byte[] data = declaredResource(relative);
                if (corruptBundleBytes && relative.startsWith("parts/")) data[0] ^= 1;
                String etag = "\"" + BundleResume.sha256Hex(data) + "\"";
                String range = headers.get("range");
                if (declaredBundle && range != null && range.startsWith("bytes=") && range.endsWith("-")) {
                    rangeRequests++;
                    lastRange = range;
                    lastIfRange = headers.get("if-range");
                    long start = Long.parseLong(range.substring(6, range.length() - 1));
                    if (ignoreRange) {
                        fullRequests++;
                        respond(out, 200, data.length, "ETag: " + etag, "Accept-Ranges: bytes");
                        out.write(data); out.flush(); return;
                    }
                    if (start >= data.length) {
                        respond(out, 416, 0, "Content-Range: bytes */" + data.length, "ETag: " + etag);
                        out.flush(); return;
                    }
                    String contentRange = wrongContentRange
                            ? "bytes " + (start + 1) + "-" + (data.length - 1) + "/" + data.length
                            : "bytes " + start + "-" + (data.length - 1) + "/" + data.length;
                    String responseEtag = wrongEtag ? WRONG_ETAG : etag;
                    int remaining = data.length - (int) start;
                    int actual = abortAfterBytes > 0 ? Math.min(abortAfterBytes, remaining) : remaining;
                    respond(out, 206, remaining, "Content-Range: " + contentRange,
                            "ETag: " + responseEtag, "Accept-Ranges: bytes");
                    if (actual > 0) out.write(data, (int) start, actual);
                    out.flush(); return;
                }
                fullRequests++;
                respond(out, 200, data.length, "ETag: " + etag, "Accept-Ranges: bytes");
                if (abortAfterBytes > 0 && data.length > abortAfterBytes) out.write(data, 0, abortAfterBytes);
                else out.write(data);
                out.flush();
            }
            else if (path.equals("/v1/sessions")) { v1Posts++; json(out, 200, "{\"sessionId\":\"test\",\"fonts\":[]}"); }
            else if (path.endsWith("/layout/slides/0")) {
                json(out, 200, "{\"media\":[[\"video\",\"" + url() + "/v1/files/test-file/parts/ppt/media/video.mp4\"]]}");
            } else if (path.endsWith("/layout")) { layoutRequests++; json(out, 200, "{\"slideCount\":1,\"fonts\":[]}"); }
            else if (path.contains("/parts/")) {
                if (unknownPartLength) out.write("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                else header(out, 200, bytes);
                if (failPart) { out.write(new byte[64]); out.flush(); return; }
                byte[] buffer = new byte[65536]; Arrays.fill(buffer, (byte) 90);
                long remaining = bytes;
                while (remaining > 0) {
                    int n = (int) Math.min(buffer.length, remaining); out.write(buffer, 0, n); remaining -= n;
                    if (slowPart) {
                        out.flush(); partStarted.countDown();
                        try { Thread.sleep(20); } catch (InterruptedException interrupted) { throw new IOException(interrupted); }
                    }
                }
                out.flush();
            } else { json(out, 200, "{\"sessionId\":\"test\",\"fonts\":[]}"); }
        }
        byte[] declaredResource(String path) throws IOException {
            if (path.equals("layout.json")) return "{\"slideCount\":1,\"fonts\":[]}".getBytes(StandardCharsets.UTF_8);
            if (path.equals("layout/0.json")) return "{\"media\":[],\"mediaRefs\":[]}".getBytes(StandardCharsets.UTF_8);
            if (path.equals("parts/ppt/media/video.mp4") && bytes <= 1024 * 1024) {
                byte[] data = new byte[(int) bytes]; Arrays.fill(data, (byte) 90); return data;
            }
            throw new IOException("unknown declared resource: " + path);
        }
        String declaredManifest() throws IOException {
            try {
                org.json.JSONArray resources = new org.json.JSONArray();
                long total = 0;
                for (String path : new String[] { "layout.json", "layout/0.json", "parts/ppt/media/video.mp4" }) {
                    byte[] data = declaredResource(path);
                    byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(data);
                    StringBuilder hash = new StringBuilder();
                    for (byte value : digest) hash.append(String.format(java.util.Locale.US, "%02x", value & 255));
                    resources.put(new org.json.JSONObject().put("path", path).put("size", data.length).put("sha256", hash.toString()).put("href", "http://untrusted.example/resource"));
                    total += data.length;
                }
                char[] key = new char[64]; Arrays.fill(key, 'a');
                org.json.JSONArray external = new org.json.JSONArray();
                if (externalBundleMedia) external.put("https://example.test/external.mp4");
                return new org.json.JSONObject().put("bundleSchemaVersion", bundleVersion).put("modelSchemaVersion", 2)
                    .put("fileId", "test-file").put("artifactKey", new String(key)).put("modelArtifactKey", new String(key)).put("format", "pptx")
                    .put("parserVersion", "fixture").put("parserFingerprint", "fixture-build").put("inventory", "ppt-media-v1")
                    .put("unitCount", 1).put("fonts", new org.json.JSONArray()).put("totalBytes", total)
                    .put("resources", resources).put("externalResources", external).toString();
            } catch (Exception failure) { throw new IOException(failure); }
        }
        static void header(OutputStream out, int code, long bytes) throws IOException {
            respond(out, code, bytes);
        }
        static void respond(OutputStream out, int code, long bytes, String... extras) throws IOException {
            StringBuilder head = new StringBuilder("HTTP/1.1 " + code + " OK\r\nContent-Length: "
                    + bytes + "\r\nConnection: close\r\n");
            for (String extra : extras) head.append(extra).append("\r\n");
            head.append("\r\n");
            out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        }
        static void json(OutputStream out, int code, String body) throws IOException {
            byte[] data = body.getBytes(StandardCharsets.UTF_8); header(out, code, data.length);
            out.write(data); out.flush();
        }
        public void close() throws Exception { socket.close(); thread.join(5000); }
    }
}
