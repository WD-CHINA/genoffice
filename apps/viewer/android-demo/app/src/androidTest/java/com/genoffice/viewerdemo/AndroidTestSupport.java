package com.genoffice.viewerdemo;

import android.test.InstrumentationTestCase;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Shared transport and private-file utilities, without format-specific fixture semantics. */
public abstract class AndroidTestSupport extends InstrumentationTestCase {
    protected File temporaryRoot(String prefix) throws IOException {
        return Files.createTempDirectory(getInstrumentation().getTargetContext().getCacheDir().toPath(), prefix).toFile();
    }
    protected static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }
    protected static byte[] read(InputStream input) throws IOException {
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[65536]; int count;
            while ((count = source.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }
    protected static void write(File file, String value) throws IOException {
        File parent = file.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create test directory");
        Files.write(file.toPath(), value.getBytes(StandardCharsets.UTF_8));
    }
    protected static String request(String url, String method, String body, int expected) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method); connection.setConnectTimeout(5000); connection.setReadTimeout(5000);
        try {
            if (body != null) {
                connection.setDoOutput(true);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body.getBytes(StandardCharsets.UTF_8)); }
            }
            int status = connection.getResponseCode();
            if (status != expected) throw new IOException("unexpected local HTTP status " + status + ", expected " + expected);
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            return input == null ? "" : new String(read(input), StandardCharsets.UTF_8);
        } finally { connection.disconnect(); }
    }
}
