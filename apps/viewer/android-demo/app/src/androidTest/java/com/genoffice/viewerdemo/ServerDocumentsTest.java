package com.genoffice.viewerdemo;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

public class ServerDocumentsTest extends AndroidTestSupport {
    private static final String ITEM = "{\"fileId\":\"" + new String(new char[64]).replace('\0', 'a')
            + "\",\"displayName\":\"课时计划.docx\",\"format\":\"docx\",\"size\":1234,\"createdAt\":\"2026-11-16T00:00:00.000Z\"}";
    public void testPagingCarriesAuthAndEncodesCursor() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.body = "{\"items\":[" + ITEM + "],\"next\":\"next_cursor\"}";
            ServerDocuments.Page first = new ServerDocuments().list(fixture.url() + "/prefix/", "secret", null);
            assertEquals(1, first.items.size()); assertEquals("课时计划.docx", first.items.get(0).displayName);
            assertEquals("next_cursor", first.next); assertTrue(fixture.request.contains("GET /prefix/v1/files?limit=20 "));
            assertTrue(fixture.request.toLowerCase(java.util.Locale.ROOT).contains("authorization: bearer secret"));
            fixture.body = "{\"items\":[]}";
            ServerDocuments.Page empty = new ServerDocuments().list(fixture.url(), "", "a+b&c");
            assertTrue(empty.items.isEmpty()); assertNull(empty.next);
            assertTrue(fixture.request.contains("cursor=a%2Bb%26c"));
            assertFalse(fixture.request.toLowerCase(java.util.Locale.ROOT).contains("authorization:"));
        }
    }
    public void testFailuresDoNotBecomeEmptyListsOrFollowRedirects() throws Exception {
        try (Fixture fixture = new Fixture()) {
            for (int code : new int[]{401, 403, 404, 500, 302}) {
                fixture.code = code; expectFailure(fixture, null);
            }
            fixture.code = 200; fixture.body = "{\"items\":{}}"; expectFailure(fixture, null);
            fixture.body = "{\"items\":[" + ITEM + "],\"next\":\"same\"}"; expectFailure(fixture, "same");
            fixture.body = "{\"items\":[],\"padding\":\"" + new String(new char[2 * 1024 * 1024]).replace('\0', 'x') + "\"}";
            expectFailure(fixture, null);
        }
    }
    public void testCancellationInterruptsAnOutstandingRead() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.hold = true;
            ServerDocuments client = new ServerDocuments(); ExecutorService executor = Executors.newSingleThreadExecutor();
            try {
                Future<?> work = executor.submit(() -> { try { client.list(fixture.url(), "", null); throw new AssertionError("cancelled request returned a page"); }
                    catch (IOException expected) { } });
                assertTrue(fixture.entered.await(5, TimeUnit.SECONDS)); client.cancel();
                work.get(5, TimeUnit.SECONDS);
            } finally { fixture.release.countDown(); executor.shutdownNow(); }
        }
    }
    private void expectFailure(Fixture fixture, String cursor) throws Exception {
        try { new ServerDocuments().list(fixture.url(), "secret", cursor); fail("expected an explicit failure"); }
        catch (IOException expected) { assertNotNull(expected.getMessage()); }
    }
    private static final class Fixture implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0); final Thread thread;
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        volatile int code = 200; volatile String body = "{\"items\":[]}", request = ""; volatile boolean hold;
        Fixture() throws IOException {
            thread = new Thread(() -> { while (!socket.isClosed()) try (Socket client = socket.accept()) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder text = new StringBuilder(); String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) text.append(line).append('\n');
                request = text.toString(); entered.countDown();
                if (hold) release.await(10, TimeUnit.SECONDS);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                OutputStream out = client.getOutputStream();
                out.write(("HTTP/1.1 " + code + " Result\r\nContent-Type: application/json\r\nLocation: http://127.0.0.1:1/never\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.write(bytes); out.flush();
            } catch (Exception ignored) { } }, "document-list-fixture"); thread.start();
        }
        String url() { return "http://127.0.0.1:" + socket.getLocalPort(); }
        @Override public void close() throws Exception { release.countDown(); socket.close(); thread.join(2000); }
    }
}
