# work in progress!

# `isVpn(ip)`
This repo holds a daily-updated VPN/datacenter/bot IP list for a binary `isVpn` type check. It's based on these data sources:

* https://github.com/X4BNet/lists_vpn - VPN and datacenter IPs
* https://github.com/stamparm/ipsum - list of malicious/bot IPs
* Some daily-updated data from my own server analytics

If you're looking for more than just a binary is/isn't, or want to know specifically whether it's a VPN vs bot vs datacenter, then this is not the repo for you. Please do not submit feature requests unless it's about a new, good data source. I'm keeping this repo very simple. 

Also, do not rely on this data if you need highly-accurate detection. If you need more accurate data, use a paid service like ip-api.com (I am not affiliated **at all**, I just like that their paid plan is cheap and unlimited). I'll update this repo soon with some "in the wild" accuracy tests, so you know roughly how likely this repo is to give a false negative.

This isn't published as an NPM package or anything like that because it's so simple. As shown in this example, just download the IP list, put it in a `Set`, and then just check IPs against that set:
```js
let vpnIps = await fetch(`https://raw.githubusercontent.com/josephrocca/is-vpn/main/vpn-or-datacenter-ips.txt`, {signal:AbortSignal.timeout(10000)}).then(r => r.text()).then(t => new Set(t.trim().split("\n"))).catch(e => (console.error(e), ""));

let ip = "123.123.123.123";
if(vpnIps.has(ip)) {
  // do something
}
```
I will *never* change the location/format of `vpn-or-datacenter-ips.txt`.

# Important
There are many valid reasons for people to use VPNs. Please do not use this to carelessly block VPN users when not required. In my case, for example, I use it to allow accepting anonymous votes as part of a ranking algorithm, which is better than forcing all users to sign up. Please try to keep the web usable for VPN users.


