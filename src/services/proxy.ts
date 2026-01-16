import * as net from "node:net";

const proxies = new Map<string, net.Server>();
const connections = new Map<string, Set<net.Socket>>();

export function startProxy(
	vmId: string,
	localPort: number,
	targetIp: string,
	targetPort: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const sockets = new Set<net.Socket>();
		connections.set(vmId, sockets);

		const server = net.createServer((clientSocket) => {
			sockets.add(clientSocket);

			const vmSocket = net.createConnection(targetPort, targetIp);
			sockets.add(vmSocket);

			clientSocket.pipe(vmSocket);
			vmSocket.pipe(clientSocket);

			clientSocket.on("error", () => {
				vmSocket.destroy();
				sockets.delete(clientSocket);
				sockets.delete(vmSocket);
			});

			vmSocket.on("error", () => {
				clientSocket.destroy();
				sockets.delete(clientSocket);
				sockets.delete(vmSocket);
			});

			clientSocket.on("close", () => {
				vmSocket.destroy();
				sockets.delete(clientSocket);
				sockets.delete(vmSocket);
			});

			vmSocket.on("close", () => {
				clientSocket.destroy();
				sockets.delete(clientSocket);
				sockets.delete(vmSocket);
			});
		});

		server.on("error", reject);
		server.listen(localPort, "0.0.0.0", () => {
			proxies.set(vmId, server);
			resolve();
		});
	});
}

export function stopProxy(vmId: string): void {
	// Close all connections
	const sockets = connections.get(vmId);
	if (sockets) {
		for (const socket of sockets) {
			socket.destroy();
		}
		connections.delete(vmId);
	}

	// Close server
	const server = proxies.get(vmId);
	if (server) {
		server.close();
		proxies.delete(vmId);
	}
}
