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
	log(
		`startProxy called: vmId=${vmId}, localPort=${localPort}, targetIp=${targetIp}, targetPort=${targetPort}`,
	);
	log(`Current proxy count before: ${proxies.size}`);
	return new Promise((resolve, reject) => {
		try {
			log(`Calling Bun.listen on port ${localPort}...`);
			const server = Bun.listen<ProxySocketData>({
				hostname: "0.0.0.0",
				port: localPort,
				socket: {
					open(clientSocket) {
						log(`Client connected to port ${localPort}, forwarding to ${targetIp}:${targetPort}`);

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
									log(`Connected to VM at ${targetIp}:${targetPort}`);
									// Store reference to client socket
									vmSocket.data = { clientSocket };
									// Store VM socket reference and mark as connected
									clientSocket.data.vmSocket = vmSocket;
									clientSocket.data.vmConnected = true;

									// Flush any pending data that arrived before VM connection
									if (clientSocket.data.pendingData.length > 0) {
										log(`Flushing ${clientSocket.data.pendingData.length} pending chunks to VM`);
										for (const chunk of clientSocket.data.pendingData) {
											vmSocket.write(chunk);
										}
										clientSocket.data.pendingData = [];
									}
								},
								close(vmSocket) {
									log("VM socket closed");
									vmSocket.data.clientSocket.end();
								},
								error(vmSocket, err) {
									log(`VM socket error: ${err}`);
									vmSocket.data.clientSocket.end();
								},
							},
						}).catch((err) => {
							log(`Failed to connect to VM at ${targetIp}:${targetPort}: ${err}`);
							clientSocket.end();
						});
					},
					data(clientSocket, data) {
						// Forward data from client to VM
						if (clientSocket.data.vmConnected && clientSocket.data.vmSocket) {
							clientSocket.data.vmSocket.write(data);
						} else {
							// Buffer data until VM connection is ready
							log("Buffering client data until VM connected...");
							clientSocket.data.pendingData.push(new Uint8Array(data));
						}
					},
					close(clientSocket) {
						log("Client socket closed");
						if (clientSocket.data.vmSocket) {
							clientSocket.data.vmSocket.end();
						}
					},
					error(clientSocket, err) {
						log(`Client socket error: ${err}`);
						if (clientSocket.data.vmSocket) {
							clientSocket.data.vmSocket.end();
						}
					},
				},
			});

			proxies.set(vmId, server);
			log(`SUCCESS: Proxy started on port ${localPort} -> ${targetIp}:${targetPort}`);
			log(`Server hostname: ${server.hostname}, port: ${server.port}`);
			log(`Current proxy count after: ${proxies.size}`);
			log(`Active proxies: ${Array.from(proxies.keys()).join(", ")}`);
			resolve();
		} catch (err) {
			log(`ERROR: Bun.listen failed on port ${localPort}: ${err}`);
			log(`Error type: ${typeof err}`);
			log(`Error details: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
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
