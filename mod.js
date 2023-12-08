let ipv4BinaryRanges;

async function updateList() {
  const ipv4CidrRanges = await fetch("https://raw.githubusercontent.com/josephrocca/is-vpn/main/vpn-or-datacenter-ipv4-ranges.txt").then(r => r.text()).then(t => t.trim().split("\n"));
  ipv4BinaryRanges = ipv4CidrRanges.map(ipv4CidrToRange);
}

await updateList();
setInterval(updateList, 1000*60*60*12);

function ipToBinary(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
}

function ipv4CidrToRange(cidr) {
  const [baseIp, subnetMask] = cidr.split('/');
  const ipBinary = ipToBinary(baseIp);
  const rangeStart = ipBinary;
  const rangeEnd = ipBinary | ((1 << (32 - subnetMask)) - 1);
  return [rangeStart, rangeEnd];
}

// TODO: improve performance with interval tree
export function isVpn(ip) {
  const ipBinary = ipToBinary(ip);
  return ipv4BinaryRanges.some(([start, end]) => ipBinary >= start && ipBinary <= end);
}
