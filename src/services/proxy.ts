import type { Socket, TCPSocketListener } from "bun";
import {
	recordConnectionAccepted,
	recordConnectionClosed,
	recordPendingBytes,
	recordVmConnectFailure,
	recordVmConnectSuccess,
} from "./metrics";

interface ProxySocketData {
	targetIp: string;
	targetPort: number;
	vmSocket?: Socket<{ clientSocket: Socket<ProxySocketData> }>;
	pendingData: Uint8Array[];
	vmConnected: boolean;
}

const proxies = new Map<string, TCPSocketListener<ProxySocketData>>();

function log(msg: string): void {
	const line = `[proxy] ${msg}`;
	console.log(line);
}

function pendingTotal(buf: Uint8Array[]): number {
	let total = 0;
	for (const b of buf) total += b.byteLength;
	return total;
}

export function startProxy(
	vmId: string,
	localPort: number,
	targetIp: string,
	targetPort: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			const server = Bun.listen<ProxySocketData>({
				hostname: "0.0.0.0",
				port: localPort,
				socket: {
					open(clientSocket) {
						clientSocket.data = {
							targetIp,
							targetPort,
							pendingData: [],
							vmConnected: false,
						};
						recordConnectionAccepted(vmId);

						// Connect to the VM
						Bun.connect<{ clientSocket: Socket<ProxySocketData> }>({
							hostname: targetIp,
							port: targetPort,
							socket: {
								data(vmSocket, data) {
									vmSocket.data.clientSocket.write(data);
								},
								open(vmSocket) {
									vmSocket.data = { clientSocket };
									clientSocket.data.vmSocket = vmSocket;
									clientSocket.data.vmConnected = true;
									recordVmConnectSuccess(vmId);

									// Flush any pending data that arrived before VM connection
									if (clientSocket.data.pendingData.length > 0) {
										const flushed = pendingTotal(clientSocket.data.pendingData);
										for (const chunk of clientSocket.data.pendingData) {
											vmSocket.write(chunk);
										}
										clientSocket.data.pendingData = [];
										if (flushed > 0) recordPendingBytes(vmId, -flushed);
									}
								},
								close(vmSocket) {
									vmSocket.data.clientSocket.end();
								},
								error(vmSocket, err) {
									log(`VM connection error: ${err}`);
									vmSocket.data.clientSocket.end();
								},
							},
						}).catch((err) => {
							log(`Failed to connect to VM: ${err}`);
							const crossed = recordVmConnectFailure(vmId);
							if (crossed) {
								console.error(
									`[proxy] VM ${vmId} DEGRADED: 10 consecutive connect failures to ${targetIp}:${targetPort}`,
								);
							}
							clientSocket.end();
						});
					},
					data(clientSocket, data) {
						if (clientSocket.data.vmConnected && clientSocket.data.vmSocket) {
							clientSocket.data.vmSocket.write(data);
						} else {
							const copy = new Uint8Array(data);
							clientSocket.data.pendingData.push(copy);
							recordPendingBytes(vmId, copy.byteLength);
						}
					},
					close(clientSocket) {
						const remaining = pendingTotal(clientSocket.data.pendingData);
						if (remaining > 0) recordPendingBytes(vmId, -remaining);
						recordConnectionClosed(vmId);
						if (clientSocket.data.vmSocket) {
							clientSocket.data.vmSocket.end();
						}
					},
					error(clientSocket, err) {
						log(`Client connection error: ${err}`);
						const remaining = pendingTotal(clientSocket.data.pendingData);
						if (remaining > 0) recordPendingBytes(vmId, -remaining);
						if (clientSocket.data.vmSocket) {
							clientSocket.data.vmSocket.end();
						}
					},
				},
			});

			proxies.set(vmId, server);
			log(`Proxy started on port ${localPort} -> ${targetIp}:${targetPort}`);
			resolve();
		} catch (err) {
			log(`Failed to start proxy on port ${localPort}: ${err}`);
			reject(err);
		}
	});
}

export function stopProxy(vmId: string): void {
	const server = proxies.get(vmId);
	if (server) {
		server.stop();
		proxies.delete(vmId);
	}
}
