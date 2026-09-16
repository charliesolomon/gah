---
title: Wireless at the North site (example article)
description: Example that shipped with the scaffold — shows the shape of a good article. Delete it once you have written your own.
status: draft
updated: 2026-01-01
tags: [example]
---

# Wireless at the North site

<!--
  THIS IS THE EXAMPLE THAT SHIPPED WITH `gah init-kb`. The facts are invented.
  It exists to show the shape; delete it once you have a real article.
  `kb-curate` will keep mentioning it until you do.
-->

Sixteen access points across two buildings, on their own VLAN, managed from the
controller at the main site. Two of them are deliberately not like the others —
see Exceptions, and read that section before changing anything here.

## Facts

| | |
|---|---|
| Access points | 16 (Building A: 11, Building B: 5) |
| Model | AcmeAP-350, except the two in Exceptions |
| VLAN | 40 (wireless clients), 41 (management) |
| Controller | at the main site; the North site has no local controller |
| SSIDs | staff, guest, devices |

Live inventory and firmware versions come from the controller — ask it rather
than trusting a list here. This article covers what the controller cannot tell
you: why anything is unusual.

## Exceptions

**The two access points in the Building B gym are AcmeAP-210s on firmware 6.9.**
They are not part of the 7.x fleet upgrade. The 350s lose their uplink when the
gym's older PoE switch negotiates at 2.5G, and replacing that switch is a
capital item nobody has funded. Upgrading these two to 7.x will take the gym
offline and the fault looks like an AP failure, not a switch one — which cost
someone a full afternoon in 2025 before anyone connected the two.

**Guest wireless at this site does not use the captive portal.** The portal
depends on a DNS redirect that the site's ISP router overrides. Guest traffic is
simply on an isolated VLAN with no internal routing. If someone asks why the
portal "is broken here", this is the answer: it was never enabled.

## How we do it here

- New APs are named `NORTH-<building>-<room>`, lowercase in the controller,
  uppercase on the physical label.
- Anything touching VLAN 41 goes through change control, because the management
  VLAN carries the door controllers too.
- The site contact is the office manager, not the principal. They hold the keys
  to the Building B comms cupboard.

## Related

- `articles/README.md` — how articles here are written
- Controller documentation, vendor portal (no credentials in this repository)

---
*Verified: invented for the scaffold, 2026-01-01. Replace this line with how and
when the facts were actually established.*
