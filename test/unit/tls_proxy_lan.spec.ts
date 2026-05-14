/**
 * Regression tests for TLS-proxy LAN-bind behaviour (forum #84538).
 *
 * Locks in:
 *   - Default bindHost === "127.0.0.1"  (existing behaviour preserved)
 *   - bindHost="0.0.0.0" listens on all interfaces
 *   - urlHost overrides the host embedded in handle.localRtspUrl
 *   - urlHost falls back to "127.0.0.1" when binding 0.0.0.0 with no override
 *     (we never want an unroutable "0.0.0.0" inside a published URL)
 */

import * as net from "net";
import { expect } from "chai";

import { startTlsProxy, type TlsProxyHandle } from "../../src/lib/tls_proxy";

describe("TLS proxy bindHost / urlHost (forum #84538)", () => {
    const handles: TlsProxyHandle[] = [];

    afterEach(async () => {
        for (const h of handles) {
            await h.stop().catch(() => undefined);
        }
        handles.length = 0;
    });

    it("default bindHost is 127.0.0.1 and embedded in URL", async () => {
        const h = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: 1, // unreachable — we never actually connect
            cameraId: "CAM-DEFAULT",
            rejectUnauthorized: false,
        });
        handles.push(h);
        expect(h.bindHost).to.equal("127.0.0.1");
        expect(h.localRtspUrl).to.equal(`rtsp://127.0.0.1:${h.port}/rtsp_tunnel`);
    });

    it("bindHost='0.0.0.0' listens on the wildcard address", async () => {
        const h = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: 1,
            cameraId: "CAM-LAN",
            bindHost: "0.0.0.0",
            rejectUnauthorized: false,
        });
        handles.push(h);
        expect(h.bindHost).to.equal("0.0.0.0");

        // Sanity: connecting via 127.0.0.1 still works (wildcard covers loopback)
        await new Promise<void>((resolve, reject) => {
            const sock = net.connect(h.port, "127.0.0.1", () => {
                sock.end();
                resolve();
            });
            sock.on("error", reject);
        });
    });

    it("urlHost overrides the host in localRtspUrl", async () => {
        const h = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: 1,
            cameraId: "CAM-URL-OVERRIDE",
            bindHost: "0.0.0.0",
            urlHost: "192.168.1.50",
            rejectUnauthorized: false,
        });
        handles.push(h);
        expect(h.localRtspUrl).to.equal(`rtsp://192.168.1.50:${h.port}/rtsp_tunnel`);
    });

    it("urlHost defaults to 127.0.0.1 when binding 0.0.0.0 without override", async () => {
        // Never publish a "0.0.0.0" URL — clients can't route to it.
        const h = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: 1,
            cameraId: "CAM-NO-OVERRIDE",
            bindHost: "0.0.0.0",
            rejectUnauthorized: false,
        });
        handles.push(h);
        expect(h.localRtspUrl).to.equal(`rtsp://127.0.0.1:${h.port}/rtsp_tunnel`);
    });

    it("localPort: requested port is honoured when free", async () => {
        // Grab a free port the OS hands out, release it, then ask the proxy
        // for the same port — that proves localPort sticks.
        const tmp = net.createServer();
        await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", () => r()));
        const requested = (tmp.address() as net.AddressInfo).port;
        await new Promise<void>((r) => tmp.close(() => r()));

        const h = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: 1,
            cameraId: "CAM-STICKY",
            localPort: requested,
            rejectUnauthorized: false,
        });
        handles.push(h);
        expect(h.port).to.equal(requested);
    });
});
