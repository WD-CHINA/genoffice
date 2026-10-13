# Media fixture

`test-video.webm` is a generated four-second 160×90 VP8 test pattern (no audio),
created for the Viewer playback regression:

```sh
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=10 -t 4 -an -c:v libvpx -b:v 50k test-video.webm
```

`tests/media-fixture.ts` inserts this clip, synthetic silent PCM audio and a
malformed media part into a fresh copy of an existing engine fixture.
All generated PowerPoint files and screenshots go into `apps/viewer/test-results`.
