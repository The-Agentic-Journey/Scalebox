#!/usr/bin/env bash
set -euo pipefail

IMG_FILE="/var/lib/firecracker.img"
MOUNT_POINT="/var/lib/firecracker"

# Create and format only if image doesn't exist
if [[ ! -f "$IMG_FILE" ]]; then
  echo "Creating 50GB sparse file..."
  truncate -s 50G "$IMG_FILE"
  echo "Formatting as btrfs..."
  mkfs.btrfs "$IMG_FILE"
else
  echo "Image file already exists, skipping creation"
fi

# Mount only if not already mounted
mkdir -p "$MOUNT_POINT"
if ! mountpoint -q "$MOUNT_POINT"; then
  echo "Mounting btrfs filesystem..."
  mount -o loop "$IMG_FILE" "$MOUNT_POINT"
else
  echo "Already mounted, skipping"
fi

# Create subdirectories (idempotent)
mkdir -p "$MOUNT_POINT"/{templates,vms,kernel}

# Add to fstab only if not already present
if ! grep -q 'firecracker.img' /etc/fstab; then
  echo "Adding to /etc/fstab..."
  echo "$IMG_FILE $MOUNT_POINT btrfs loop,defaults 0 0" >> /etc/fstab
else
  echo "Already in /etc/fstab, skipping"
fi

echo "Storage setup complete"
