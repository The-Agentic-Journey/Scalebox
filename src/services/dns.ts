import dns2 from "dns2";
import { config } from "../config";

const { Packet } = dns2;

// In-memory store for ACME challenge TXT records
// Key: FQDN (e.g., "_acme-challenge.vm.scalebox.example.com.")
// Value: TXT record value
const acmeTxtRecords = new Map<string, string>();

export function setAcmeTxtRecord(fqdn: string, value: string): void {
	acmeTxtRecords.set(fqdn, value);
}

export function deleteAcmeTxtRecord(fqdn: string): void {
	acmeTxtRecords.delete(fqdn);
}

export async function startDnsServer(): Promise<void> {
	if (!config.baseDomain) return;

	// config.hostIp is guaranteed non-empty at startup (Plan 025)
	const hostIp = config.hostIp;
	const zone = config.baseDomain.toLowerCase();

	const server = dns2.createServer({
		udp: true,
		tcp: true,
		handle: (request, send) => {
			const response = Packet.createResponseFromRequest(request);
			response.header.aa = true; // Authoritative answer

			const [question] = request.questions;
			if (!question) {
				send(response);
				return;
			}

			const { name, type } = question;
			const nameLower = name.toLowerCase();

			// Only handle queries for our zone (exact match or proper subdomain with dot prefix)
			if (nameLower !== zone && !nameLower.endsWith(`.${zone}`)) {
				response.header.rcode = 3; // NXDOMAIN
				send(response);
				return;
			}

			switch (type) {
				case Packet.TYPE.A:
					// All subdomains resolve to host IP
					response.answers.push({
						name,
						type: Packet.TYPE.A,
						class: Packet.CLASS.IN,
						ttl: 300,
						address: hostIp,
					});
					break;

				case Packet.TYPE.TXT: {
					// Normalize FQDN: ensure trailing dot for lookup
					const fqdn = nameLower.endsWith(".") ? nameLower : `${nameLower}.`;
					const fqdnNoDot = nameLower.endsWith(".") ? nameLower.slice(0, -1) : nameLower;
					const value = acmeTxtRecords.get(fqdn) || acmeTxtRecords.get(fqdnNoDot);
					if (value) {
						response.answers.push({
							name,
							type: Packet.TYPE.TXT,
							class: Packet.CLASS.IN,
							ttl: 60,
							data: value,
						});
					}
					break;
				}

				case Packet.TYPE.SOA:
					response.answers.push({
						name: zone,
						type: Packet.TYPE.SOA,
						class: Packet.CLASS.IN,
						ttl: 3600,
						primary: zone,
						admin: `admin.${zone}`,
						serial: Math.floor(Date.now() / 1000),
						refresh: 3600,
						retry: 600,
						expiration: 604800,
						minimum: 60,
					});
					break;

				case Packet.TYPE.NS:
					response.answers.push({
						name: zone,
						type: Packet.TYPE.NS,
						class: Packet.CLASS.IN,
						ttl: 3600,
						ns: zone,
					});
					// Glue record in additional section
					response.additionals.push({
						name: zone,
						type: Packet.TYPE.A,
						class: Packet.CLASS.IN,
						ttl: 3600,
						address: hostIp,
					});
					break;

				default:
					// Empty response for unsupported types
					break;
			}

			send(response);
		},
	});

	server.on("requestError", (error: Error) => {
		console.error("DNS request error:", error);
	});

	try {
		await server.listen({
			udp: { port: 53, address: "0.0.0.0" },
			tcp: { port: 53, address: "0.0.0.0" },
		});
		console.log("DNS server listening on port 53 (UDP+TCP)");
	} catch (error) {
		console.error("Warning: DNS server failed to start on port 53:", error);
		console.error("HTTPS certificate issuance via DNS-01 will not work.");
	}
}
