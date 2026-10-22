# Compatibility fixture — 0.1.7

These source files are byte-for-byte copies from the commit in `provenance.json`. They are frozen test inputs, not production modules. The compatibility tests use the original desktop bridge and extension transport across a real loopback WebSocket, including their authentication and persistence dependencies. Do not update these files when changing the current candidate.

This fixture does not provide Chrome, Electron, Windows login, or provider DOM acceptance evidence.
