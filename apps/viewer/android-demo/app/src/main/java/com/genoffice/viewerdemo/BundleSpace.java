package com.genoffice.viewerdemo;

import java.io.File;
import java.io.IOException;

/** Keep room for manifests, atomic replacement and unrelated filesystem activity. */
final class BundleSpace {
    static final long HEADROOM_BYTES = 64L * 1024 * 1024;
    interface Probe { long usableBytes(File directory); }
    private final File directory;
    private final Probe probe;

    BundleSpace(File directory) { this(directory, File::getUsableSpace); }
    BundleSpace(File directory, Probe probe) {
        this.directory = directory;
        this.probe = probe;
    }

    void require(long bytes) throws IOException {
        if (bytes < 0) throw new IOException("invalid required storage size");
        File existing = directory;
        while (existing != null && !existing.exists()) existing = existing.getParentFile();
        if (existing == null) throw new IOException("无法查询离线包存储空间");
        long free = probe.usableBytes(existing);
        // Subtract before comparing, avoiding overflow for hostile Content-Length values.
        if (free < HEADROOM_BYTES || bytes > free - HEADROOM_BYTES)
            throw new IOException("存储空间不足：离线包需保留至少 64 MiB 可用空间");
    }
}
