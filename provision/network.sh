#!/usr/bin/env bash
set -euo pipefail

# Detect primary network interface (works on GCP, Hetzner, etc.)
PRIMARY_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
echo "Detected primary interface: $PRIMARY_IFACE"

# Create bridge (if not exists)
if ! ip link show br0 &>/dev/null; then
  ip link add br0 type bridge
fi
ip addr add 172.16.0.1/16 dev br0 2>/dev/null || true
ip link set br0 up

# Enable forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward
grep -q 'net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

# NAT for outbound (using detected interface)
iptables -t nat -C POSTROUTING -s 172.16.0.0/16 -o "$PRIMARY_IFACE" -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -o "$PRIMARY_IFACE" -j MASQUERADE
iptables -C FORWARD -i br0 -o "$PRIMARY_IFACE" -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i br0 -o "$PRIMARY_IFACE" -j ACCEPT
iptables -C FORWARD -i "$PRIMARY_IFACE" -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i "$PRIMARY_IFACE" -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT

# Persist bridge config via systemd-networkd
mkdir -p /etc/systemd/network
cat > /etc/systemd/network/br0.netdev <<EOF
[NetDev]
Name=br0
Kind=bridge
EOF

cat > /etc/systemd/network/br0.network <<EOF
[Match]
Name=br0

[Network]
Address=172.16.0.1/16
EOF

# Persist iptables rules
apt-get install -y iptables-persistent
netfilter-persistent save

echo "Network setup complete"
