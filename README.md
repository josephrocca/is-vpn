# work in progress!

# `isVpn(ip)`
This repo holds a daily-updated VPN/datacenter/bot IP list for a binary, simple, low-accuracy "`isVpn`" check. It's based on these data sources:

* https://github.com/X4BNet/lists_vpn - VPN and datacenter IPs
* https://github.com/stamparm/ipsum - list of suspected malicious/bot IPs (I'm using >= 3 flags)
* Some daily-updated private data from my own analytics

**Do not rely on this data if you need highly-accurate detection**. Expect false negatives and false positives. If you need more accurate data, use a paid service like ip-api.com (I am not affiliated **at all**, I just like that their paid plan is cheap and unlimited, though I haven't tested their accuracy against other services). I'll update this repo soon with some "in the wild" accuracy tests of this repo's data, so you know roughly how likely this repo is to give a false negative (when compared against a paid API).

If you're looking for more than just a binary is/isn't, or want to know specifically whether it's a VPN vs bot vs datacenter, then this is not the repo for you. Please do not submit feature requests unless it's about a new, good data source. I'm keeping this repo very simple. 

## Example usage:
```js
import { isVpn } from "https://cdn.jsdelivr.net/gh/josephrocca/is-vpn@v0.0.1/mod.js";

let ip = "123.123.123.123";
if(isVpn(ip)) {
  // do something (but remember, it could be an inaccurate classification)
}
```
I will *never* change the location/format of `vpn-or-datacenter-ipv4-ranges.txt`, so you're welcome to use that file as part of an equivalent `isVpn` function for non-JS languages.

# Important
There are many valid reasons for people to use VPNs. Please do not use this to carelessly block VPN users when not required. In my case, for example, I use it to allow accepting anonymous votes as part of a ranking algorithm, which is better than forcing all users to sign up. Please try to keep the web usable for VPN users.


