import type { Socket, TCPSocketListener } from "bun";

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
						// Initialize socket data with pending buffer
						clientSocket.data = {
							targetIp,
							targetPort,
							pendingData: [],
							vmConnected: false,
						};

						// Connect to the VM
						Bun.connect<{ clientSocket: Socket<ProxySocketData> }>({
							hostname: targetIp,
							port: targetPort,
							socket: {
								data(vmSocket, data) {
									// Forward data from VM to client
									vmSocket.data.clientSocket.write(data);
								},
								open(vmSocket) {
									// Store reference to client socket
									vmSocket.data = { clientSocket };
									// Store VM socket reference and mark as connected
									clientSocket.data.vmSocket = vmSocket;
									clientSocket.data.vmConnected = true;

									// Flush any pending data that arrived before VM connection
									if (clientSocket.data.pendingData.length > 0) {
										for (const chunk of clientSocket.data.pendingData) {
											vmSocket.write(chunk);
										}
										clientSocket.data.pendingData = [];
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
							clientSocket.end();
						});
					},
					data(clientSocket, data) {
						// Forward data from client to VM
						if (clientSocket.data.vmConnected && clientSocket.data.vmSocket) {
							clientSocket.data.vmSocket.write(data);
						} else {
							// Buffer data until VM connection is ready
							clientSocket.data.pendingData.push(new Uint8Array(data));
						}
					},
					close(clientSocket) {
						if (clientSocket.data.vmSocket) {
							clientSocket.data.vmSocket.end();
						}
					},
					error(clientSocket, err) {
						log(`Client connection error: ${err}`);
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
