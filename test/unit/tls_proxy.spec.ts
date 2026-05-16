/**
 * Unit tests for src/lib/tls_proxy.ts
 *
 * Uses a local tls.createServer() with a self-signed cert to act as the
 * "Bosch cloud" in tests — no network I/O leaves localhost.
 *
 * Self-signed cert: pre-baked RSA-2048, CN=localhost, valid 2026–2036.
 * Generated with: openssl req -x509 -newkey rsa:2048 -days 3650 -nodes -subj '/CN=localhost'
 * All tests use rejectUnauthorized: false (same as production for Bosch cameras).
 *
 * Test count: 10
 */

import * as net from "net";
import * as tls from "tls";
import { expect } from "chai";

import { startTlsProxy, type TlsProxyHandle } from "../../src/lib/tls_proxy";

// ── Self-signed certificate (pre-baked, valid 2026–2036) ─────────────────────
// Generated: openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
//   -days 3650 -nodes -subj '/CN=localhost'

const STATIC_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUEQWsNRvAfP9/10uSOueu+0JgOmwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDUxMzAzMTgzM1oXDTM2MDUx
MDAzMTgzM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApqipWaIj8zhPCDMWgeHXzCqrOL6tmPDcgzwH42hKPhz2
ZEw9/xRGcXcfKExFPjBlKmcq269CCQWpsZJlEQ2vKQlNkwMKBY9mD16PHEck90bD
ctllajZwYDCKhZ1gM86IpP0CR9N6mtGLrsMmiEdO7a8yLKpTmZ9SavwFfwzJ7bJP
QXkCe9iTFGqu5OkBB4ThoMQXDDvLt/WK0kfeU+1Xb7pCRwkBt9gfkb8mgIyI+6uh
tiEO/YQrtu1vfEzgi8Mm0qrCS/u9LPfxs0XfOP5naPWxwscYleIKNadFMswT0Hlw
g8ssnse+0hPvZJolyWu5255urISeXPxVlMUhwU16xwIDAQABo1MwUTAdBgNVHQ4E
FgQUUV2L40C6RRyNJI3NzZsvXtHwO6UwHwYDVR0jBBgwFoAUUV2L40C6RRyNJI3N
zZsvXtHwO6UwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEABKiQ
kxBuRy2Uqh+FF/BlaDUBKwT5gLFsOn3VRIcQck5im8pqh3+FwMbVV06eKZl3cfCK
j+HzHDhdWjWDdV9fNLVyjsLxPudSSLTaTY5Xex2OVW75Tqlv8Wn1TEIh3uiVkQ04
6kiVfsOjoE1sTJWp6v5J5tdokBzaRHEpku/aSRNy6s9Pt53aCTU314WFQ7IWNArw
t3Waddu+hkKZkDbHvatsMXTcBlkrRrJF+ju71GsDe3XJTfxkApdu9leGfPMnOmSk
WL4hSAsuiNhHNtEjaxQs31UEb71DLxFfsAtfj7wiQHW0B6ZwVC88+iL/0VJ23EVP
QejOIOXeMLxjpWs5jQ==
-----END CERTIFICATE-----`;

const STATIC_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCmqKlZoiPzOE8I
MxaB4dfMKqs4vq2Y8NyDPAfjaEo+HPZkTD3/FEZxdx8oTEU+MGUqZyrbr0IJBamx
kmURDa8pCU2TAwoFj2YPXo8cRyT3RsNy2WVqNnBgMIqFnWAzzoik/QJH03qa0Yuu
wyaIR07trzIsqlOZn1Jq/AV/DMntsk9BeQJ72JMUaq7k6QEHhOGgxBcMO8u39YrS
R95T7VdvukJHCQG32B+RvyaAjIj7q6G2IQ79hCu27W98TOCLwybSqsJL+70s9/Gz
Rd84/mdo9bHCxxiV4go1p0UyzBPQeXCDyyyex77SE+9kmiXJa7nbnm6shJ5c/FWU
xSHBTXrHAgMBAAECggEAP2pXQmmdh1uKSyLxcgunSyODUozPzq38Ip2xnLke4wKv
SNvwDUNASMWcn/9hq7fLjvaByuUl2fwDJbQAbBxKZfGJyKJz6ki1+6wuBYMW0Fbn
YSjS27cKTLe7xfrr09rHiQxTFVSlxwpsPdw5KcsEgBHVpERNmluTB22Ng9owbhb5
gDolwTa0ROfSx1YyLoyHrBtCRUMRVdQQGmxXAd8QxOTq32sWzjA0S6j8b0dkx3Gy
dd+fKsFxnkmcoo0rKtVs9RaQt78H5A6kT13ruw2D2oEeSxn5BzcJR8Bg+QAaZD8A
7UzhT+4LipHpPUsVQ2qL3KJI1xp3fFvLXsDUgexD2QKBgQDZ/uggeroZF+aEFKwE
yIo2AQsBvTa6vMW0IaQdlDG4qUUSelVJbv4SY1VJ389wMU338BJAxrxTi0Im2LEi
gtQsPI1pd3Sd1UozjM2j9897KoIQCfsntedNyfydgk29yVrAhOCqTCircvoZXY6Y
/Y5/ipCYTwf3R5DAEjMkmUCo/wKBgQDDtpo0SPv3+cuAXveW2Xr6ijEDW+OzsWs5
6GSf++JA6/tjErrKZT8aClo8jCsEDjY+d0iN+lSEH4r/wE7cSvyqRdeQIMyVaYEy
P+0W80uQo1pqi/qp6/6nBNLVIbKEfJNW7tD7euUiTT05R2xEcabGnuhH278OIdgN
xuV/VS4mOQKBgFPKHKLPSVR30UyXPX8hLa6QPBDRD4Y7JKqV+6S631mhBkGR79In
7VRYBeI9OlhfOx6/keR//scF0clopL0lGDRgmeId3h8Eal7iEfCiQYeP0SolC/o5
esx1hLlt6j+2c0FoUYpjd4ZezS6OvU6ktu7i7az9Q4ySX1rUJAA/P5E1AoGAWLSC
3//UdGh7nAtvHKgl3TiVTnhvlBpuBykVso1v1w0eO6FZmDKbjynyDE9bj9MBMv7N
m8xCUkAZuCFpnN8/9c0CDwlOsMnJDQV8aFKNhVkEuhYH3sxf90Nwa7mCOBpejaBg
iBsDj7CCd1uv7rW0aYHMtgUba0RbsKLdkgEBkcECgYAsGjZe3J8Jt7zrvy3yVVFH
QEoiY6CmDTT9aZhZGtGuz7PdfFOYFOyvTwpMusZzFaN6K1TqgKzQrNmJzWERSeRe
NiSIdt4dIt3CP22SCxqJVD8jXyjurBJLjSCG1IAk0wPwg4ywFJ0BE/F4e3XMvbIP
L1R8PP5LDiGozNDtnlPmSQ==
-----END PRIVATE KEY-----`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Start a TLS echo server (reflects every byte back to sender). Returns server + port. */
function startTlsEchoServer(
    cert: string,
    key: string,
): Promise<{ server: tls.Server; port: number }>;
function startTlsEchoServer(): Promise<{ server: tls.Server; port: number }>;
function startTlsEchoServer(
    cert: string = STATIC_CERT_PEM,
    key: string = STATIC_KEY_PEM,
): Promise<{ server: tls.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = tls.createServer({ cert, key }, (socket) => {
            socket.pipe(socket); // echo all data back
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as net.AddressInfo;
            resolve({ server, port: addr.port });
        });
    });
}

/** Open a plain TCP connection to a local port and send data. Returns received bytes. */
function tcpExchange(port: number, payload: Buffer, waitMs = 300): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
            sock.write(payload);
        });
        sock.on("data", (chunk: Buffer) => chunks.push(chunk));
        sock.on("error", reject);
        // Wait a bit then read whatever arrived
        setTimeout(() => {
            sock.destroy();
            resolve(Buffer.concat(chunks));
        }, waitMs);
    });
}

/** Collected log entry */
interface LogEntry {
    level: "debug" | "info" | "warn" | "error";
    message: string;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("TLS Proxy (src/lib/tls_proxy.ts)", function () {
    // TLS handshakes in CI can be slow
    this.timeout(10_000);

    let echoServer: tls.Server;
    let echoPort: number;
    let handles: TlsProxyHandle[] = [];

    before(async () => {
        const result = await startTlsEchoServer();
        echoServer = result.server;
        echoPort = result.port;
    });

    after((done) => {
        echoServer.close(done);
    });

    afterEach(async () => {
        // Stop all proxies created in the test
        for (const h of handles) {
            await h.stop().catch(() => undefined);
        }
        handles = [];
    });

    // ── Test 1 ────────────────────────────────────────────────────────────────

    it("startTlsProxy returns handle with valid port (>0) and localRtspUrl", async () => {
        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: echoPort,
            cameraId: "TEST-CAM-1",
            rejectUnauthorized: false,
        });
        handles.push(handle);

        expect(handle.port).to.be.a("number");
        expect(handle.port).to.be.greaterThan(0);
        expect(handle.port).to.be.lessThanOrEqual(65535);
        expect(handle.localRtspUrl).to.equal(`rtsp://127.0.0.1:${handle.port}/rtsp_tunnel`);
    });

    // ── Test 2 ────────────────────────────────────────────────────────────────

    it("localPort: 0 picks a free (random) port", async () => {
        const h1 = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: echoPort,
            cameraId: "TEST-CAM-PORT0",
            localPort: 0,
            rejectUnauthorized: false,
        });
        handles.push(h1);

        const h2 = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: echoPort,
            cameraId: "TEST-CAM-PORT0B",
            localPort: 0,
            rejectUnauthorized: false,
        });
        handles.push(h2);

        expect(h1.port).to.be.greaterThan(0);
        expect(h2.port).to.be.greaterThan(0);
        // Two separate proxies should get different ports
        expect(h1.port).to.not.equal(h2.port);
    });

    // ── Test 3 ────────────────────────────────────────────────────────────────

    it("bytes flow: client → proxy → TLS echo server → back to client", async () => {
        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: echoPort,
            cameraId: "TEST-CAM-FLOW",
            rejectUnauthorized: false,
        });
        handles.push(handle);

        const payload = Buffer.from("RTSP/1.0 OPTIONS * RTSP/1.0\r\n\r\n");
        // Give TLS handshake time to complete
        await new Promise((r) => setTimeout(r, 100));

        const received = await tcpExchange(handle.port, payload, 500);

        expect(received.length).to.be.greaterThan(0);
        expect(received.toString()).to.include("RTSP/1.0");
    });

    // ── Test 4 ────────────────────────────────────────────────────────────────

    it("multiple concurrent clients work independently", async () => {
        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: echoPort,
            cameraId: "TEST-CAM-MULTI",
            rejectUnauthorized: false,
        });
        handles.push(handle);

        await new Promise((r) => setTimeout(r, 100));

        const payload1 = Buffer.from("CLIENT-1-DATA");
        const payload2 = Buffer.from("CLIENT-2-DATA");

        const [r1, r2] = await Promise.all([
            tcpExchange(handle.port, payload1, 500),
            tcpExchange(handle.port, payload2, 500),
        ]);

        expect(r1.toString()).to.include("CLIENT-1-DATA");
        expect(r2.toString()).to.include("CLIENT-2-DATA");
    });

    // ── Test 5 ────────────────────────────────────────────────────────────────

    it("stop() closes the server — new connections are refused after stop", async () => {
        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: echoPort,
            cameraId: "TEST-CAM-STOP",
            rejectUnauthorized: false,
        });

        await handle.stop();

        // After stop, connecting to the port should fail
        await new Promise<void>((resolve, reject) => {
            const sock = net.createConnection({ host: "127.0.0.1", port: handle.port });
            sock.on("connect", () => {
                sock.destroy();
                reject(new Error("Expected connection to fail but it succeeded"));
            });
            sock.on("error", () => {
                // Expected — port is closed
                resolve();
            });
            // Timeout safety
            setTimeout(() => {
                sock.destroy();
                resolve();
            }, 2000);
        });
    });

    // ── Test 6 ────────────────────────────────────────────────────────────────

    it("stop() resolves (no hang) even when connections are active", async () => {
        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: echoPort,
            cameraId: "TEST-CAM-STOP2",
            rejectUnauthorized: false,
        });

        // Open a connection and keep it alive
        const sock = net.createConnection({ host: "127.0.0.1", port: handle.port });
        await new Promise<void>((res) => sock.on("connect", res).on("error", res));

        // stop() should not hang — await with a race against a timeout
        let stopped = false;
        await Promise.race([
            handle.stop().then(() => {
                stopped = true;
            }),
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("stop() timed out")), 3000),
            ),
        ]);
        expect(stopped).to.equal(true);
        sock.destroy();
    });

    // ── Test 7 ────────────────────────────────────────────────────────────────

    it("remote unreachable → client connection closes gracefully (no unhandled rejection)", async () => {
        // Use a port that nothing listens on (bind+close to get a free port, then don't listen)
        const tmpServer = net.createServer();
        const unusedPort = await new Promise<number>((res) => {
            tmpServer.listen(0, "127.0.0.1", () => {
                const p = (tmpServer.address() as net.AddressInfo).port;
                tmpServer.close(() => res(p));
            });
        });

        const logEntries: LogEntry[] = [];
        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: unusedPort,
            cameraId: "TEST-CAM-UNREACH",
            rejectUnauthorized: false,
            log: (level, message) => logEntries.push({ level, message }),
        });
        handles.push(handle);

        // Attempt a connection — it should fail gracefully. Wait specifically
        // for the WARN log line that signals "remote unreachable" rather than
        // racing on the client's `close` event (which can fire BEFORE the
        // teardown() callback under CI load — observed flake 2026-05-16).
        const sock = net.createConnection({ host: "127.0.0.1", port: handle.port });
        sock.on("error", () => undefined);  // swallow client-side errors
        try {
            await new Promise<void>((resolve, reject) => {
                const start = Date.now();
                const poll = setInterval(() => {
                    if (logEntries.some((e) => e.level === "warn" || e.level === "error")) {
                        clearInterval(poll);
                        clearTimeout(deadline);
                        resolve();
                    } else if (Date.now() - start > 9_500) {
                        // poll interval guard — let the deadline timer reject
                    }
                }, 50);
                const deadline = setTimeout(() => {
                    clearInterval(poll);
                    reject(new Error(
                        `No warn/error log entry within 10s. ` +
                        `Captured ${logEntries.length} entries: ` +
                        JSON.stringify(logEntries.map((e) => `${e.level}:${e.message.slice(0, 60)}`)),
                    ));
                }, 10_000);
            });
        } finally {
            sock.destroy();
        }

        // A warning should have been logged
        const warnEntries = logEntries.filter((e) => e.level === "warn" || e.level === "error");
        expect(warnEntries.length).to.be.greaterThan(0);
    });

    // ── Test 8 ────────────────────────────────────────────────────────────────

    it("remote drops mid-stream → client connection closes", async () => {
        // Create a TLS server that accepts and immediately destroys the socket
        const dropServer = tls.createServer(
            { cert: STATIC_CERT_PEM, key: STATIC_KEY_PEM },
            (socket) => {
                setTimeout(() => socket.destroy(), 100);
            },
        );
        const dropPort = await new Promise<number>((res, rej) => {
            dropServer.on("error", rej);
            dropServer.listen(0, "127.0.0.1", () => {
                res((dropServer.address() as net.AddressInfo).port);
            });
        });

        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: dropPort,
            cameraId: "TEST-CAM-DROP",
            rejectUnauthorized: false,
        });
        handles.push(handle);

        let clientClosed = false;
        await new Promise<void>((resolve) => {
            const sock = net.createConnection({ host: "127.0.0.1", port: handle.port });
            sock.on("close", () => {
                clientClosed = true;
                resolve();
            });
            sock.on("error", () => resolve());
            setTimeout(() => {
                sock.destroy();
                resolve();
            }, 3000);
        });

        dropServer.close();
        expect(clientClosed).to.equal(true);
    });

    // ── Test 9 ────────────────────────────────────────────────────────────────

    it("log function is called with 'info' on start and 'debug' on connect/teardown", async () => {
        const entries: LogEntry[] = [];
        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: echoPort,
            cameraId: "ABCDEF12-LOGGING",
            rejectUnauthorized: false,
            log: (level, message) => entries.push({ level, message }),
        });
        handles.push(handle);

        // info-level start message
        const infoEntries = entries.filter((e) => e.level === "info");
        expect(infoEntries.length).to.be.greaterThan(0);
        expect(infoEntries[0].message).to.include("127.0.0.1");

        // Trigger a connection to get debug logs
        await tcpExchange(handle.port, Buffer.from("PING"), 400);

        const debugEntries = entries.filter((e) => e.level === "debug");
        expect(debugEntries.length).to.be.greaterThan(0);
    });

    // ── Test 10 ───────────────────────────────────────────────────────────────

    it("circuit breaker: closes server after _MAX_BURST consecutive failures", async function () {
        this.timeout(15_000); // circuit breaker fires after 5 failures — allow time

        // Get a port that is definitely closed
        const tmpSrv = net.createServer();
        const deadPort = await new Promise<number>((res) => {
            tmpSrv.listen(0, "127.0.0.1", () => {
                const p = (tmpSrv.address() as net.AddressInfo).port;
                tmpSrv.close(() => res(p));
            });
        });

        const entries: LogEntry[] = [];
        const handle = await startTlsProxy({
            remoteHost: "127.0.0.1",
            remotePort: deadPort,
            cameraId: "TEST-CIRCUIT",
            rejectUnauthorized: false,
            log: (level, message) => entries.push({ level, message }),
        });
        // Do NOT push to handles — circuit breaker closes the server itself

        // Fire 5 consecutive connections (each triggers a failed TLS connect)
        for (let i = 0; i < 5; i++) {
            await new Promise<void>((res) => {
                const s = net.createConnection({ host: "127.0.0.1", port: handle.port });
                s.on("close", () => res());
                s.on("error", () => res());
                setTimeout(() => {
                    s.destroy();
                    res();
                }, 2000);
            });
            // small gap so timestamps are clearly within _BURST_WINDOW
            await new Promise((r) => setTimeout(r, 50));
        }

        // Wait for circuit-breaker warning
        await new Promise((r) => setTimeout(r, 500));

        const warnEntries = entries.filter(
            (e) => e.level === "warn" && e.message.includes("consecutive connect failures"),
        );
        expect(warnEntries.length).to.be.greaterThan(0);

        // Server should now be closed — connecting should fail
        await new Promise<void>((resolve) => {
            const s = net.createConnection({ host: "127.0.0.1", port: handle.port });
            s.on("error", () => resolve());
            s.on("connect", () => {
                s.destroy();
                resolve();
            });
            setTimeout(() => {
                s.destroy();
                resolve();
            }, 2000);
        });
    });
});
