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
    private static long usedHeap() {
        return Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory();
    }
    private static final class Fixture implements AutoCloseable {
        final ServerSocket socket;
        final Thread thread;
        final long bytes;
        volatile boolean deleted, fail, failPart;
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
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
            }
            while (length-- > 0) reader.read();
            OutputStream out = new BufferedOutputStream(client.getOutputStream());
            String path = request[1];
            if (fail) { json(out, 500, "failed"); return; }
            if (request[0].equals("DELETE")) { deleted = true; json(out, 200, "{}"); }
            else if (path.endsWith("/layout/slides/0")) {
                json(out, 200, "{\"media\":[[\"video\",\"" + url() + "/v1/files/test-file/parts/ppt/media/video.mp4\"]]}");
            } else if (path.endsWith("/layout")) { json(out, 200, "{\"slideCount\":1,\"fonts\":[]}"); }
            else if (path.contains("/parts/")) {
                header(out, 200, bytes);
                if (failPart) { out.write(new byte[64]); out.flush(); return; }
                byte[] buffer = new byte[65536]; Arrays.fill(buffer, (byte) 90);
                long remaining = bytes;
                while (remaining > 0) { int n = (int) Math.min(buffer.length, remaining); out.write(buffer, 0, n); remaining -= n; }
                out.flush();
            } else { json(out, 200, "{\"sessionId\":\"test\",\"fonts\":[]}"); }
        }
        static void header(OutputStream out, int code, long bytes) throws IOException {
            out.write(("HTTP/1.1 " + code + " OK\r\nContent-Length: " + bytes + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        }
        static void json(OutputStream out, int code, String body) throws IOException {
            byte[] data = body.getBytes(StandardCharsets.UTF_8); header(out, code, data.length);
            out.write(data); out.flush();
        }
        public void close() throws Exception { socket.close(); thread.join(5000); }
    }
}
