import type { Socket, TCPSocketListener } from "bun";

const proxies = new Map<string, TCPSocketListener<{ targetIp: string; targetPort: number }>>();

export function startProxy(
	vmId: string,
	localPort: number,
	targetIp: string,
	targetPort: number,
): Promise<void> {
	console.log(
		`[proxy] startProxy called: vmId=${vmId}, localPort=${localPort}, targetIp=${targetIp}, targetPort=${targetPort}`,
	);
	return new Promise((resolve, reject) => {
		try {
			console.log(`[proxy] Calling Bun.listen on port ${localPort}...`);
			const server = Bun.listen<{ targetIp: string; targetPort: number }>({
				hostname: "0.0.0.0",
				port: localPort,
				data: { targetIp, targetPort },
				socket: {
					open(clientSocket) {
						console.log(
							`[proxy] Client connected to port ${localPort}, forwarding to ${targetIp}:${targetPort}`,
						);
						// Connect to the VM
						Bun.connect({
							hostname: clientSocket.data.targetIp,
							port: clientSocket.data.targetPort,
							socket: {
								data(_vmSocket, data) {
									// Forward data from VM to client
									clientSocket.write(data);
								},
								open(vmSocket) {
									console.log(
										`[proxy] Connected to VM at ${clientSocket.data.targetIp}:${clientSocket.data.targetPort}`,
									);
									// Store the VM socket reference on the client socket
									(
										clientSocket as Socket<{
											targetIp: string;
											targetPort: number;
											vmSocket?: Socket<unknown>;
										}>
									).data.vmSocket = vmSocket;
								},
								close() {
									console.log("[proxy] VM socket closed");
									clientSocket.end();
								},
								error(_vmSocket, err) {
									console.error("[proxy] VM socket error:", err);
									clientSocket.end();
								},
							},
						}).catch((err) => {
							console.error(`[proxy] Failed to connect to VM at ${targetIp}:${targetPort}:`, err);
							clientSocket.end();
						});
					},
					data(clientSocket, data) {
						// Forward data from client to VM
						const vmSocket = (
							clientSocket as Socket<{
								targetIp: string;
								targetPort: number;
								vmSocket?: Socket<unknown>;
							}>
						).data.vmSocket;
						if (vmSocket) {
							vmSocket.write(data);
						}
					},
					close() {
						console.log("[proxy] Client socket closed");
					},
					error(_socket, err) {
						console.error("[proxy] Client socket error:", err);
					},
				},
			});

			proxies.set(vmId, server);
			console.log(
				`[proxy] SUCCESS: Proxy started on port ${localPort} -> ${targetIp}:${targetPort}`,
			);
			console.log("[proxy] Server object:", server);
			resolve();
		} catch (err) {
			console.error(`[proxy] ERROR: Bun.listen failed on port ${localPort}:`, err);
			console.error("[proxy] Error type:", typeof err);
			console.error(
				"[proxy] Error details:",
				JSON.stringify(err, Object.getOwnPropertyNames(err as object)),
			);
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
