// Process-instance id of the running server: every restart yields a new value,
// so embed hosts and standalone/browser tabs can detect a swap under the same
// URL. Shared by the embed handshake and the /api/agent/running poll snapshot.
export const BOOT_ID = String(Date.now());
