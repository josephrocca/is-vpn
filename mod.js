class IntervalNode {
    constructor(interval) {
        this.interval = interval; // interval is an object like {start: x, end: y}
        this.max = interval.end;
        this.left = null;
        this.right = null;
    }
}

class IntervalTree {
    constructor() {
        this.root = null;
    }

    insert(interval) {
        if (!this.root) {
            this.root = new IntervalNode(interval);
            return;
        }

        let node = this.root;
        while (true) {
            node.max = Math.max(node.max, interval.end);

            if (interval.start < node.interval.start) {
                if (!node.left) {
                    node.left = new IntervalNode(interval);
                    break;
                }
                node = node.left;
            } else {
                if (!node.right) {
                    node.right = new IntervalNode(interval);
                    break;
                }
                node = node.right;
            }
        }
    }

    query(point) {
        let node = this.root;
        while (node) {
            if (point >= node.interval.start && point <= node.interval.end) {
                return true;
            }

            if (node.left && point <= node.left.max) {
                node = node.left;
            } else {
                node = node.right;
            }
        }
        return false;
    }
}

let itree;

async function updateList() {
    const timeoutMs = 20000; // Timeout for the fetch request
    try {
        console.log("Fetching IPv4 CIDR ranges...");
        const ipv4CidrRanges = await fetch("https://raw.githubusercontent.com/josephrocca/is-vpn/main/vpn-or-datacenter-ipv4-ranges.txt", {
            signal: AbortSignal.timeout(timeoutMs)
        })
            .then(r => r.text())
            .then(t => t.trim().split("\n"));

        // Rebuild the tree asynchronously with batching
        console.log("Start batch insertion into tree...");
        itree = new IntervalTree();
        await batchInsertRanges(ipv4CidrRanges); // Call batch insert
        console.log("Tree updated successfully.");

    } catch (error) {
        console.error("Error updating list:", error);
    }
}

// Function to insert ranges in batches asynchronously to avoid blocking
async function batchInsertRanges(ipv4CidrRanges, batchSize = 500) {
    const rangeCount = ipv4CidrRanges.length;
    let index = 0;

    while (index < rangeCount) {
        const batch = ipv4CidrRanges.slice(index, index + batchSize);

        // Process the batch asynchronously
        await new Promise(resolve => {
            setTimeout(() => {
                batch.map(ipv4CidrToRange).forEach(range => itree.insert(range));
                index += batchSize;
                resolve();
            }, 0); // Use `setTimeout` to break the task into smaller chunks
        });
    }
}

// Call updateList initially and every 12 hours
updateList().catch(error => console.error("Initial update failed:", error));
setInterval(() => {
    updateList().catch(error => console.error("Periodic update failed:", error));
}, 1000 * 60 * 60 * 12); // fetch updated ip range list every 12 hours

function ipToBinary(ip) {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
}

function ipv4CidrToRange(cidr) {
    const [baseIp, subnetMask] = cidr.split('/');
    const ipBinary = ipToBinary(baseIp);
    const rangeStart = ipBinary;
    const rangeEnd = ipBinary | ((1 << (32 - subnetMask)) - 1);
    return { start: rangeStart, end: rangeEnd };
}

export function isVpn(ip) {
    const ipBinary = ipToBinary(ip);
    return itree.query(ipBinary);
}
