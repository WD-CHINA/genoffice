package com.genoffice.viewerdemo;

import android.test.InstrumentationTestCase;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Real HTTP/IO probes in a private cache; no user documents are modified. */
public class PdfOfflineTest extends InstrumentationTestCase {
    private File root;
    @Override protected void setUp() throws Exception {
        root = Files.createTempDirectory(getInstrumentation().getTargetContext().getCacheDir().toPath(), "pdf-offline-test").toFile();
    }
    @Override protected void tearDown() { delete(root); }
    private BundleDownloader download(Fixture server, BundleCache cache) {
        return new BundleDownloader(server.url(), "pdf-test-token", server.id, cache.resolve(server.id), stage -> {}, File::getUsableSpace, cache);
    }

    public void testVerifiedOriginalAndLocalRangeHeadReplay() throws Exception {
        try (Fixture server = new Fixture()) {
            BundleCache cache = new BundleCache(root);
            download(server, cache).run();
            BundleStore store = cache.resolve(server.id); store.verifyIntegrity();
            assertEquals(0, server.sessions); assertEquals(0, store.unitCount());
            assertEquals("pdf", store.manifest().getString("format"));
            assertEquals(server.id, BundleStore.digest(store.pdfFile()));
            assertTrue(store.manifest().getBoolean("sourceVerified"));
            assertTrue(cache.current(server.id) != null);
            LocalAssetServer local = new LocalAssetServer(getInstrumentation().getTargetContext().getAssets(), store);
            String base = "http://127.0.0.1:" + local.startAndWait();
            String path = base + "/v1/files/" + server.id + "/content";
            try {
                HttpURLConnection info = (HttpURLConnection) new URL(base + "/v1/files/" + server.id).openConnection();
                try {
                    assertEquals(200, info.getResponseCode());
                    JSONObject metadata = new JSONObject(new String(read(info.getInputStream()), StandardCharsets.UTF_8));
                    assertEquals(server.bytes.length, metadata.getLong("size")); assertEquals(server.id, metadata.getString("sha256"));
                } finally { info.disconnect(); }
                for (String asset : new String[]{"pdfjs/cmaps/78-EUC-H.bcmap", "pdfjs/standard_fonts/FoxitFixed.pfb", "pdfjs/wasm/jbig2.wasm"}) {
                    HttpURLConnection bundled = (HttpURLConnection) new URL(base + "/viewer/" + asset).openConnection();
                    try { assertEquals(200, bundled.getResponseCode()); assertTrue(read(bundled.getInputStream()).length > 0); }
                    finally { bundled.disconnect(); }
                }
                HttpURLConnection c = (HttpURLConnection) new URL(path).openConnection();
                c.setRequestProperty("Range", "bytes=2-17");
                try {
                    assertEquals(206, c.getResponseCode()); assertEquals("application/pdf", c.getContentType());
                    assertEquals("\"" + server.id + "\"", c.getHeaderField("ETag"));
                    assertTrue(Arrays.equals(Arrays.copyOfRange(server.bytes, 2, 18), read(c.getInputStream())));
                } finally { c.disconnect(); }
                c = (HttpURLConnection) new URL(path).openConnection(); c.setRequestMethod("HEAD");
                try { assertEquals(200, c.getResponseCode()); assertEquals(server.bytes.length, c.getContentLength()); assertEquals(0, read(c.getInputStream()).length); }
                finally { c.disconnect(); }
                c = (HttpURLConnection) new URL(path).openConnection(); c.setRequestProperty("Range", "bytes=" + server.bytes.length + "-");
                try { assertEquals(416, c.getResponseCode()); assertEquals("bytes */" + server.bytes.length, c.getHeaderField("Content-Range")); }
                finally { c.disconnect(); }
                c = (HttpURLConnection) new URL(path).openConnection(); c.setRequestProperty("Range", "bytes=2-17"); c.setRequestProperty("If-Range", "\"stale\"");
                try { assertEquals(200, c.getResponseCode()); assertEquals(server.bytes.length, read(c.getInputStream()).length); }
                finally { c.disconnect(); }
            } finally { local.shutdown(); local.join(2000); }
        }
    }

    public void testInterruptedOriginalResumesAndBadReplacementKeepsOldPointer() throws Exception {
        try (Fixture server = new Fixture()) {
            BundleCache cache = new BundleCache(root); server.abort = true;
            try { download(server, cache).run(); fail("truncation must fail"); } catch (IOException expected) { }
            assertNull(cache.current(server.id));
            server.abort = false;
            BundleDownloader resumed = download(server, cache); resumed.run();
            assertEquals(1, resumed.rangeResumes()); assertEquals(1, resumed.rangeResponses());
            String pointer = cache.current(server.id).toString();
            server.corrupt = true;
            try { download(server, cache).run(); fail("bad hash must fail"); } catch (IOException expected) { }
            assertEquals(pointer, cache.current(server.id).toString()); cache.resolve(server.id).verifyIntegrity();
            try (RandomAccessFile file = new RandomAccessFile(cache.resolve(server.id).pdfFile(), "rw")) { file.write(0); }
            try { cache.resolve(server.id).verifyIntegrity(); fail("same-size local corruption must fail"); } catch (IOException expected) { }
            assertEquals(0, server.sessions);
        }
    }

    public void testInvalidIdentityAndQuotaRejectBeforeDownloading() throws Exception {
        try (Fixture server = new Fixture()) {
            BundleCache cache = new BundleCache(root, 1024);
            try { download(server, cache).run(); fail("quota must fail"); } catch (IOException expected) { }
            assertEquals(0, server.contents); assertNull(cache.current(server.id));
            server.badMetadata = true;
            try { download(server, new BundleCache(root)).run(); fail("mismatched source must fail"); } catch (IOException expected) { }
            assertEquals(0, server.contents); assertEquals(0, server.sessions);
        }
    }

    public void testCancellationPreservesPublishedOriginal() throws Exception {
        try (Fixture server = new Fixture()) {
            BundleCache cache = new BundleCache(root); download(server, cache).run();
            String pointer = cache.current(server.id).toString();
            server.slow = true;
            BundleDownloader downloader = download(server, cache);
            AtomicReference<Throwable> failure = new AtomicReference<>();
            Thread task = new Thread(() -> { try { downloader.run(); } catch (Throwable error) { failure.set(error); } });
            task.start(); assertTrue(server.streaming.await(5, TimeUnit.SECONDS)); downloader.cancel(); task.join(5000);
            assertFalse(task.isAlive()); assertTrue(failure.get() != null); assertTrue(downloader.isCancelled());
            assertEquals(pointer, cache.current(server.id).toString()); cache.resolve(server.id).verifyIntegrity();
        }
    }

    private static final class Fixture implements AutoCloseable {
        final byte[] bytes = new byte[1024 * 1024];
        final String id;
        final ServerSocket socket = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
        final CountDownLatch streaming = new CountDownLatch(1);
        final Thread accept;
        volatile boolean abort, corrupt, badMetadata, slow;
        volatile int sessions, contents;
        Fixture() throws Exception {
            Arrays.fill(bytes, (byte) 65); System.arraycopy("%PDF-1.4\n".getBytes(StandardCharsets.US_ASCII), 0, bytes, 0, 9);
            StringBuilder hex = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hex.append(String.format(java.util.Locale.US, "%02x", b & 255));
            id = hex.toString();
            accept = new Thread(() -> {
                while (!socket.isClosed()) try {
                    Socket client = socket.accept();
                    new Thread(() -> { try (Socket close = client) { serve(close); } catch (Exception ignored) { } }).start();
                } catch (IOException closed) { break; }
            });
            accept.start();
        }
        String url() { return "http://127.0.0.1:" + socket.getLocalPort(); }
        void serve(Socket client) throws Exception {
            BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
            String first = in.readLine(); if (first == null) return;
            String path = first.split(" ")[1]; Map<String, String> headers = new HashMap<>(); String line;
            while ((line = in.readLine()) != null && !line.isEmpty()) { int colon = line.indexOf(':'); if (colon > 0) headers.put(line.substring(0, colon).toLowerCase(java.util.Locale.US), line.substring(colon + 1).trim()); }
            OutputStream out = client.getOutputStream();
            if (!"Bearer pdf-test-token".equals(headers.get("authorization"))) { respond(out, 401, 0, ""); return; }
            if (path.equals("/v1/files/" + id)) {
                byte[] meta = new JSONObject().put("fileId", id).put("format", "pdf").put("sha256", badMetadata ? String.format(java.util.Locale.US, "%064d", 0) : id).put("size", bytes.length).toString().getBytes(StandardCharsets.UTF_8);
                respond(out, 200, meta.length, ""); out.write(meta); return;
            }
            if (path.equals("/v1/files/" + id + "/content")) {
                contents++; int start = 0;
                if (headers.containsKey("range")) {
                    assertEquals("\"" + id + "\"", headers.get("if-range"));
                    start = Integer.parseInt(headers.get("range").substring(6).replace("-", ""));
                }
                respond(out, start > 0 ? 206 : 200, bytes.length - start, "ETag: \"" + id + "\"\r\n" + (start > 0 ? "Content-Range: bytes " + start + "-" + (bytes.length - 1) + "/" + bytes.length + "\r\n" : ""));
                int end = abort ? 65536 : bytes.length;
                for (int offset = start; offset < end; offset += 16384) {
                    byte[] part = Arrays.copyOfRange(bytes, offset, Math.min(end, offset + 16384));
                    if (corrupt && offset == 0) part[0] = 0;
                    out.write(part); out.flush();
                    if (slow) { streaming.countDown(); Thread.sleep(20); }
                }
                return;
            }
            if (path.contains("sessions")) sessions++;
            respond(out, 404, 0, "");
        }
        @Override public void close() throws Exception { socket.close(); accept.join(2000); }
    }
    private static void respond(OutputStream out, int status, int length, String headers) throws IOException {
        out.write(("HTTP/1.1 " + status + " Test\r\nContent-Length: " + length + "\r\n" + headers + "Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.flush();
    }
    private static byte[] read(InputStream in) throws IOException { try (InputStream source = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) { byte[] buffer = new byte[65536]; int n; while ((n = source.read(buffer)) != -1) out.write(buffer, 0, n); return out.toByteArray(); } }
    private static void delete(File file) { File[] files = file.listFiles(); if (files != null) for (File child : files) delete(child); file.delete(); }
}
