import { writeFile } from "node:fs/promises";
import { $ } from "bun";

// Bash script captured every 60s by the systemd timer. Output goes to
// /var/log/scalebox-health.log inside the guest, with built-in rotation at
// 20 MB. The file lives in the rootfs, so if the guest soft-hangs we can
// read it via a host-side rescue mount of the rootfs.
const HEALTH_SCRIPT = `#!/bin/bash
set +e
LOG=/var/log/scalebox-health.log
MAX_BYTES=$((20 * 1024 * 1024))

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -ge "$MAX_BYTES" ]; then
  mv -f "$LOG" "$LOG.1"
fi

ts=$(date -Iseconds)
{
  echo "=== $ts ==="
  echo "uptime: $(uptime)"
  echo "load: $(cat /proc/loadavg 2>/dev/null)"
  echo "mem_mb: $(free -m 2>/dev/null | awk '/^Mem:/ {print "total="$2" used="$3" free="$4" avail="$7}')"
  echo "swap_mb: $(free -m 2>/dev/null | awk '/^Swap:/ {print "total="$2" used="$3" free="$4}')"
  echo "mounts: $(wc -l < /proc/self/mountinfo 2>/dev/null)"
  echo "fds: $(awk '{print $1}' /proc/sys/fs/file-nr 2>/dev/null)"
  echo "procs: $(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"
  echo "slab_top:"
  awk 'NR>2 {print $1, $3*$4}' /proc/slabinfo 2>/dev/null | sort -k2 -rn | head -5 | awk '{printf "  %s %s\\n", $1, $2}'
  echo "top_rss:"
  ps -eo rss,pid,comm --sort=-rss --no-headers 2>/dev/null | head -5 | awk '{printf "  %sk %s %s\\n", $1, $2, $3}'
  echo "docker_running: $(ls /sys/fs/cgroup/system.slice/ 2>/dev/null | grep -c '^docker-' || echo 0)"
  echo "dmesg_tail:"
  dmesg 2>/dev/null | tail -3 | sed 's/^/  /'
} >> "$LOG"
`;

const HEALTH_SERVICE = `[Unit]
Description=Scalebox in-guest health snapshot
ConditionPathExists=/usr/local/bin/scalebox-health

[Service]
Type=oneshot
ExecStart=/usr/local/bin/scalebox-health
`;

const HEALTH_TIMER = `[Unit]
Description=Run Scalebox in-guest health snapshot every 60s

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
Unit=scalebox-health.service

[Install]
WantedBy=timers.target
`;

// Inject the agent into an already-mounted rootfs. Caller is responsible
// for mounting/unmounting. Skips silently with a warning if the guest has
// no systemd — non-systemd guests are not supported in v1.
export async function injectHealthAgent(mountPoint: string): Promise<void> {
	const probe = await $`test -x ${mountPoint}/usr/bin/systemctl`.nothrow().quiet();
	if (probe.exitCode !== 0) {
		console.warn(
			`[agent] no /usr/bin/systemctl at ${mountPoint}; skipping health agent injection (non-systemd guest)`,
		);
		return;
	}

	// Script
	const tempScript = `/tmp/scalebox_health_${Date.now()}`;
	await writeFile(tempScript, HEALTH_SCRIPT, { mode: 0o755 });
	await $`sudo mkdir -p ${mountPoint}/usr/local/bin`;
	await $`sudo cp ${tempScript} ${mountPoint}/usr/local/bin/scalebox-health`;
	await $`sudo chmod 755 ${mountPoint}/usr/local/bin/scalebox-health`;
	await $`rm -f ${tempScript}`;

	// Service + timer units
	await $`sudo mkdir -p ${mountPoint}/etc/systemd/system`;

	const tempService = `/tmp/scalebox_health_service_${Date.now()}`;
	await writeFile(tempService, HEALTH_SERVICE);
	await $`sudo cp ${tempService} ${mountPoint}/etc/systemd/system/scalebox-health.service`;
	await $`rm -f ${tempService}`;

	const tempTimer = `/tmp/scalebox_health_timer_${Date.now()}`;
	await writeFile(tempTimer, HEALTH_TIMER);
	await $`sudo cp ${tempTimer} ${mountPoint}/etc/systemd/system/scalebox-health.timer`;
	await $`rm -f ${tempTimer}`;

	// Enable via wants-symlink (can't run systemctl on an offline rootfs)
	await $`sudo mkdir -p ${mountPoint}/etc/systemd/system/timers.target.wants`;
	await $`sudo ln -sf /etc/systemd/system/scalebox-health.timer ${mountPoint}/etc/systemd/system/timers.target.wants/scalebox-health.timer`;
}
