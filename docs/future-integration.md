# Future native Sendspin lyrics: explicitly unavailable

V1 does **not** require Sendspin/spec PR #80 to merge. It uses Music Assistant's
existing track lyrics API and approximate queue timing.

As verified **2026-09-05**, [PR #80](https://github.com/Sendspin/spec/pull/80)
is **open, draft and unmerged**, with head
`4567666c60c40168c1455d7c8ab94037dd55c044`. No delivery date is promised.
The actual head proposes a single selected preferred format with a
`max_size_bytes` capability; the older two-channel description in the PR body
is not authoritative. CDG complexity, whole-file memory limits and
timestamp/seek/transition semantics remain concerns. This repository implements
no proposed binary IDs, packet decoder, unofficial lyrics role, or CDG engine.

`LyricsProvider` is the transport boundary. Its deliberately unavailable
`UnavailableSendspinLyricsProvider` returns `capability: "unsupported"` and an
explicit unsupported result. It is not selected at runtime, a fallback provider,
or a mock that can be mistaken for a functional native transport.

Current inspected Sendspin JS commit
`7d103075138dda5c8909045647bb42b33c2d44fc` advertises player, controller and
metadata roles in its hello. Using its core without audio output does not make
it a metadata-only client. MA 2.10.2 does support genuine metadata-only DISPLAY
clients, but joining one to an audio group changes membership and is not an
automatic/read-only subscription to the CAST. This app does not create such a
client or call grouping APIs.

## Gates before implementation

1. Re-read the **then-current merged specification and relevant discussion**.
   Do not carry packet identifiers/capabilities forward from this draft.
2. Confirm released SDK implementation, not only specification merge. Prove a
   metadata/lyrics-only client can select the exact existing CAST group without
   advertising audio playback. Any necessary pairing/group mutation must be
   explicit, documented and operator-approved.
3. Confirm released MA server/provider integration emits the required stream
   and its exact target/group association; a merged spec alone supplies neither.
4. Implement negotiated capability detection. Unsupported peer/version/format
   must produce an explicit unavailable state, not silent success or fabricated
   lyrics. Retain the existing MA provider as an explicitly selected mode.
5. Map server presentation clocks into a monotonic `PlaybackClock`. Verify
   pause, resume, seek, next, repeat, speed, scheduled transitions, reconnect,
   group movement and Wi-Fi buffering against **physical CAST output**.
6. Enforce negotiated file/packet limits before allocation. Design streaming
   or bounded storage based on the final transport. Do not add CDG without a
   separate complexity, memory, security and licensing review.
7. Extend contract fixtures using original synthetic lyrics, test stale
   generations and feature gating, then qualify on supported ARM64 Pi hardware
   and actual TV/CEC adapters. Change precision labels only when measured.

Sources:
[draft head](https://github.com/Sendspin/spec/blob/4567666c60c40168c1455d7c8ab94037dd55c044/README.md),
[JS hello](https://github.com/Sendspin/sendspin-js/blob/7d103075138dda5c8909045647bb42b33c2d44fc/src/core/protocol-handler.ts),
[MA role selection](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/providers/sendspin/provider.py),
[stock CAST Sendspin](https://github.com/ApolloAutomation/CAST-1/blob/8347dee74fc5b5f55d1ec7fda558a5f449f91a98/Integrations/ESPHome/Core.yaml).
