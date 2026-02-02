import type { Socket, TCPSocketListener } from "bun";

const proxies = new Map<string, TCPSocketListener<{ targetIp: string; targetPort: number }>>();

export function startProxy(
	vmId: string,
	localPort: number,
	targetIp: string,
	targetPort: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			const server = Bun.listen<{ targetIp: string; targetPort: number }>({
				hostname: "0.0.0.0",
				port: localPort,
				data: { targetIp, targetPort },
				socket: {
					open(clientSocket) {
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
									clientSocket.end();
								},
								error() {
									clientSocket.end();
								},
							},
						}).catch(() => {
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
						// Connection closed
					},
					error() {
						// Error on client socket
					},
				},
			});

			proxies.set(vmId, server);
			console.log(`[proxy] Started proxy on port ${localPort} -> ${targetIp}:${targetPort}`);
			resolve();
		} catch (err) {
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
