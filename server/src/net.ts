import { networkInterfaces } from 'node:os';

const VIRTUAL_IFACE = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|zt|tailscale|podman|cni|flannel)/i;

/** Best guess of this machine's address on the local network (for URLs a phone can open). */
export function detectLanAddress(): string | undefined {
  const candidates: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses || VIRTUAL_IFACE.test(name)) continue;
    for (const addr of addresses) {
      if (addr.family === 'IPv4' && !addr.internal) candidates.push(addr.address);
    }
  }
  // Prefer typical home/school ranges.
  return (
    candidates.find((a) => a.startsWith('192.168.')) ??
    candidates.find((a) => a.startsWith('10.')) ??
    candidates.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ??
    candidates[0]
  );
}
