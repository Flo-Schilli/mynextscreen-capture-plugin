# NDI spike: receive, FFmpeg, Short-HLS

A feasibility and benchmark script for the capture pipeline. It finds an NDI source, receives
UYVY frames, pushes them through a bounded queue (depth 3, oldest frames are dropped) into
FFmpeg, and writes Short-HLS locally (1 s segments, 4 in the playlist, a keyframe every second).
At the end it prints a summary JSON with throughput, drops and CPU load.

It talks to `grandi` directly and does not go through the plugin's license gate. Use it for
development only. If the source resolution changes during a run, the script aborts with exit
code 3 (`abortReason` in the summary), because restarting FFmpeg would reset the HLS sequence.

## Run against the test source

The script imports `grandi` normally, so it needs a `node_modules/grandi` above it. The plugin
image has one in `/app/node_modules`; mount the script into `/app/tools/ndi-spike`:

```bash
docker build -t mns-ndi-test-source tools/ndi-test-source
docker run -d --name ndi-src --network host --entrypoint node mns-ndi-test-source sender.mjs

docker build -t mns-capture-plugin:dev .
docker run --rm --network host \
  -v "$PWD/tools/ndi-spike:/app/tools/ndi-spike:ro" \
  -e PRESET=720p30 -e NDI_EXTRA_IPS=127.0.0.1 -e OUT_DIR=/tmp/hls-out \
  --tmpfs /tmp --entrypoint node mns-capture-plugin:dev /app/tools/ndi-spike/spike.mjs

docker rm -f ndi-src
```

## Environment variables

| Variable        | Default               | Purpose                                                      |
| --------------- | --------------------- | ------------------------------------------------------------ |
| `NDI_SOURCE`    | `TEST-CAM`            | Substring of the NDI source name (15 s timeout)              |
| `PRESET`        | `720p30`              | `preview` (lowest bandwidth, source size), `720p30`, `1080p30` |
| `ENCODER`       | `libx264`             | `libx264`, `h264_vaapi`, `h264_v4l2m2m` (unsupported, arm64 dev only) |
| `NDI_EXTRA_IPS` | none                  | Comma-separated source IPs when mDNS discovery does not work |
| `DURATION_S`    | `20`                  | Run time in seconds                                          |
| `OUT_DIR`       | `./hls-out`           | Output directory (emptied first)                             |
| `VAAPI_DEVICE`  | `/dev/dri/renderD128` | Render node for `h264_vaapi`                                 |

## Reading the summary

- `avgFps`: received frames per second. Should be close to the source FPS.
- `framesDropped`: frames dropped in the queue because FFmpeg fell behind. Should be 0.
- `receiveTimeouts`: `receiver.video()` calls without a frame within 1 s (source gone or network).
- `segmentsProduced`: segments in total (media sequence plus listed). About 20 for a 20 s run.
- `nodeCpuPctOfCore` / `ffmpegCpuPctOfCore`: CPU as a percentage of one core (the Node process
  and FFmpeg, from `/proc/<pid>/stat`). Above 100 % means more than one core.
- `ffmpegExit.code`: 0 means the playlist was closed cleanly.

Every 2 s a line shows the receive FPS, drops, queue fill and FFmpeg's `speed` (below 1x means
the encoder is too slow).

## Measuring latency

The test source burns the time with milliseconds into the picture. Serve `index.m3u8` from
`OUT_DIR` over HTTP (for example `npx serve`), open it in an HLS player and film or photograph
a clock next to the screen. The difference between the overlay clock and the wall clock is the
latency from source to player. Sender and player need the same time zone (`TZ`).

## Tests

```bash
node --test tools/ndi-spike/
```

---

NDI® is a registered trademark of Vizrt NDI AB. https://ndi.video
