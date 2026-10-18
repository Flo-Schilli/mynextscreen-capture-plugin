# NDI test source (fake camera)

Sends an NDI test picture (`testsrc2`) with a wall-clock overlay (`HH:MM:SS.mmm`) under the
name `TEST-CAM`. It lets you develop and test the capture path without a camera.

> **Lab and development only. Do not run it on a venue network.** On a real network it shows
> up as a foreign NDI source with a camera-like name and can be mistaken for a real camera.

Standalone dev tool with its own `package.json` (only `grandi`). It is not part of the plugin
image and not part of the plugin's npm project.

## Build

```bash
docker build -t mns-ndi-test-source tools/ndi-test-source
```

## Run

The plugin finds sources by address (`cameraHost`, handed to the NDI finder as an extra IP), so
the sender only has to be reachable from the plugin container. Use `--network host` for both.

```bash
docker run -d --name ndi-src --network host --entrypoint node mns-ndi-test-source sender.mjs
```

The default entrypoint additionally starts D-Bus and avahi inside the container (mDNS discovery,
`START_AVAHI=1`):

```bash
docker run --rm --network host -e TZ=Europe/Zurich mns-ndi-test-source
```

If the host already runs `avahi-daemon`, a second daemon in the container collides on UDP 5353.
Mount the host's D-Bus socket instead:

```bash
docker run --rm --network host -e START_AVAHI=0 -e TZ=Europe/Zurich \
  -v /run/dbus/system_bus_socket:/run/dbus/system_bus_socket \
  mns-ndi-test-source
```

## Configuration

| Variable      | Default    | Purpose                                         |
| ------------- | ---------- | ----------------------------------------------- |
| `NDI_NAME`    | `TEST-CAM` | NDI source name                                 |
| `WIDTH`       | `1280`     | Width in pixels                                 |
| `HEIGHT`      | `720`      | Height in pixels                                |
| `FPS`         | `30`       | Frame rate                                      |
| `START_AVAHI` | `1`        | `0` = use the host's avahi through the D-Bus socket |
| `TZ`          | UTC        | Time zone of the clock overlay                  |

The clock starts at the local time of the container start and then follows the stream
timestamps (`-re`). Restart the container before latency measurements that run for hours.

---

NDI® is a registered trademark of Vizrt NDI AB. https://ndi.video
