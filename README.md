# `isVpn(ip)`
This repo holds a daily-updated VPN/datacenter/bot IP list for a binary, simple, `isVpn` check. I recommend testing it against your own data/traffic, and comparing it to paid services to see if it's accurate enough for your use case.

It's based on these data sources:

* https://github.com/X4BNet/lists_vpn - VPN and datacenter IPs
* https://github.com/stamparm/ipsum - list of suspected malicious/bot IPs (I'm using >= 3 flags as threshold)
* Some daily-updated private data from my own analytics (double-checked against paid API)

**Do not rely on this data if you need highly-accurate detection**. Expect false negatives. But there should ideally be very few false positives - i.e. if `isVpn` returns `true`, then you can be kinda confident-ish that it is indeed a VPN. If it returns `false`, then you should *not* be confident in that assessment - VPNs will sometimes slip through the cracks. 

If you need more accurate data, use a paid service like ip-api.com (I am not affiliated **at all**, I just like that their paid plan is cheap and unlimited, though I haven't tested their accuracy against other services). 

If you're looking for more than just a binary is/isn't, or want to know specifically whether it's a VPN vs bot vs datacenter, then this is not the repo for you. Please do not submit feature requests unless it's about a new, good data source. I'm keeping this repo very simple.

## Example usage:
You can just use the lists in this repo directly, but if you're looking for an efficient JavaScript `isVpn`, then you can use this:
```js
import { isVpn } from "https://cdn.jsdelivr.net/gh/josephrocca/is-vpn@v0.0.2/mod.js";
// let { isVpn } = await import("https://cdn.jsdelivr.net/gh/josephrocca/is-vpn@v0.0.2/mod.js");

let ip = "123.123.123.123";
if(isVpn(ip)) {
  // do something (but remember, it could be an inaccurate classification)
}
```
I will *never* change the location/format of [`vpn-or-datacenter-ipv4-ranges.txt`](https://raw.githubusercontent.com/josephrocca/is-vpn/main/vpn-or-datacenter-ipv4-ranges.txt), so you're welcome to use that file as part of an equivalent `isVpn` function for other languages.

Note that `mod.js` fetches the updated IP list from this repo automatically once during init, and then every 12 hours via a `setInterval`. If you don't want that, just copy `mod.js` into your project and make whatever edits you want - it's just a single file.

## Performance
As you can see in `mod.js`, an interval tree is used to get decent performance, given that the IP range list is quite large. On my laptop, queries take about 0.2ms. If you expect many queries from the same IP, you should cache the result in a `Map`, which will give you a ~10x performance boost. Maybe something like:
```js
let isVpnCache = new Map();
function isVpnCached(ip) {
  if(isVpnCache.has(ip)) return isVpnCache.get(ip);
  let result = isVpn(ip);
  isVpnCache.set(ip, result);
  if(isVpnCache.size > 1_000_000) isVpnCache = new Map();
  return result;
}
```

# Do Not Needlessly Block VPN Users
There are many valid reasons for people to use VPNs. Please do not use this to carelessly block VPN users when not required. In my case, for example, I use it to allow accepting anonymous votes as part of a ranking algorithm, which is better than forcing all users to sign up. If I were to allow anonymous votes from VPNs, then voting manipulation would be much easier. Please try to keep the web usable for VPN users.


